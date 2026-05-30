/*
 * SSH helpers for talking to Coolify-managed servers.
 *
 * Why this exists: Coolify v4 does not expose a private-registries API
 * (verified against openapi.yaml v4.x and a live v4.0.0-beta.469 server;
 * the historical `/api/v1/private-registries` path returns 404). The
 * canonical pattern per the Coolify "Custom Docker Registry" docs is to
 * SSH into each managed host and run `docker login`. Coolify's docker
 * daemon then reads `~/.docker/config.json` on every subsequent pull.
 *
 * This module wraps the SSH + docker-login mechanics so the GHCR flow
 * in `deploy/ghcr.ts` and the rollback flow in `deploy/rollback.ts`
 * share one safe implementation:
 *
 *   · Token is piped via stdin (`docker login --password-stdin`), never
 *     placed in argv or an env var — argv leaks through `ps`, env vars
 *     leak through `/proc/<pid>/environ`.
 *   · `BatchMode=yes` so a misconfigured key never falls through to an
 *     interactive password prompt that would hang in CI.
 *   · `StrictHostKeyChecking=accept-new` so freshly-provisioned
 *     hatchkit-managed boxes don't trip on first-time fingerprint
 *     prompts.
 *   · `ConnectTimeout=5` so unreachable hosts fail fast.
 *
 * Host resolution: Coolify reports `host.docker.internal` as the IP for
 * the box it itself runs on (Coolify lives in a container). Outside
 * that container, that hostname is meaningless — callers have to fall
 * back to the Coolify panel URL's hostname for the SSH target. That
 * fallback is in `resolveSshTarget` here.
 */

import { spawn } from "node:child_process";

import type { CoolifyServer } from "./coolify-api.js";

export interface CoolifyServerSshTarget {
  /** Stable Coolify UUID (falls back to the numeric id stringified when
   *  the API didn't return a uuid). */
  uuid: string;
  /** SSH user, e.g. `root`. */
  user: string;
  /** Hostname or IP, already resolved (i.e. never
   *  `host.docker.internal`). */
  host: string;
  /** SSH port. */
  port: number;
}

/** SSH options that prevent surprises:
 *   · BatchMode=yes — no interactive password prompt; fail fast if key
 *     auth doesn't work
 *   · StrictHostKeyChecking=accept-new — accept first-time fingerprints
 *     for freshly-provisioned hatchkit hosts
 *   · UserKnownHostsFile=~/.ssh/known_hosts — explicit, in case the
 *     user's ssh_config disabled it
 *   · ConnectTimeout — fail fast on unreachable hosts
 *   · ServerAliveInterval/CountMax — kill hung SSH sessions instead of
 *     waiting indefinitely on a half-open TCP connection
 */
function sshArgs(target: CoolifyServerSshTarget, connectTimeoutSec = 5): string[] {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    `ConnectTimeout=${connectTimeoutSec}`,
    "-o",
    "ServerAliveInterval=10",
    "-o",
    "ServerAliveCountMax=2",
    "-p",
    String(target.port),
    `${target.user}@${target.host}`,
  ];
}

/** Probe SSH reachability. Runs `true` over a non-interactive SSH
 *  session. Returns true iff key auth + connect succeed in under
 *  `connectTimeoutSec` seconds. Never falls through to a password
 *  prompt (BatchMode=yes). */
export async function sshProbe(
  target: CoolifyServerSshTarget,
  connectTimeoutSec = 5,
): Promise<{ ok: boolean; stderr: string }> {
  const r = await sshExec(target, "true", { connectTimeoutSec });
  return { ok: r.exitCode === 0, stderr: r.stderr };
}

/** Run a remote command over SSH. stdin is piped from the caller —
 *  this is the safe way to hand a token to `docker login
 *  --password-stdin` without ever placing it in argv (visible via `ps`)
 *  or an environment variable (visible via `/proc/<pid>/environ`).
 *
 *  Implementation notes:
 *  · Uses `spawn` (not `execa`) so we can write to stdin without
 *    routing through a shell that might log the data.
 *  · `command` is passed as a single argument to `ssh`, which means it
 *    runs through the remote login shell. Callers must shell-quote
 *    anything inside that the shell would otherwise re-interpret.
 *  · `timeoutMs` SIGKILLs the child if exceeded.
 */
export async function sshExec(
  target: CoolifyServerSshTarget,
  command: string,
  opts: { stdin?: string; timeoutMs?: number; connectTimeoutSec?: number } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const args = [...sshArgs(target, opts.connectTimeoutSec ?? 5), command];
  return new Promise((resolve) => {
    const child = spawn("ssh", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        if (!settled) {
          // SIGKILL — SSH ignores SIGTERM if it's mid-handshake.
          child.kill("SIGKILL");
        }
      }, opts.timeoutMs);
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr: stderr || err.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ exitCode: typeof code === "number" ? code : 1, stdout, stderr });
    });

    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();
  });
}

/** Resolve an SSH target from a Coolify server payload + the Coolify
 *  panel URL. Handles the `host.docker.internal` self-reference: for
 *  the box Coolify itself runs on, the API returns
 *  `ip: "host.docker.internal"`, which is meaningless outside Coolify's
 *  container. The actual SSHable address is the Coolify panel
 *  hostname.
 *
 *  Returns null when there's no usable address at all (e.g. a server
 *  with no IP and a panelUrl we can't parse). */
export function resolveSshTarget(
  server: CoolifyServer,
  panelUrl: string,
): CoolifyServerSshTarget | null {
  // host.docker.internal is Docker-DNS-only; outside Coolify's
  // container it doesn't resolve. Fall back to the panel URL's
  // hostname for the Coolify-host self-reference case.
  let host = server.ip;
  if (host === "host.docker.internal" || host === "localhost" || host === "127.0.0.1") {
    const parsedHost = hostnameFromUrl(panelUrl);
    if (!parsedHost) return null;
    host = parsedHost;
  }
  if (!host) return null;

  return {
    uuid: server.uuid ?? String(server.id),
    user: server.user || "root",
    host,
    port: typeof server.port === "number" && server.port > 0 ? server.port : 22,
  };
}

function hostnameFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/** Check whether `~/.docker/config.json` on the remote already contains
 *  an auth entry for `registry`. Cheap idempotency probe — if the entry
 *  is there we can skip the login round-trip entirely. */
export async function dockerLoginAlreadyOk(
  target: CoolifyServerSshTarget,
  registry: string,
): Promise<boolean> {
  // grep instead of jq because jq isn't guaranteed to be installed on
  // a vanilla Coolify host. The exact registry string appears inside
  // the JSON's auths.<registry> key, so a literal grep is enough.
  const r = await sshExec(target, `grep -q '"${registry}"' ~/.docker/config.json`, {
    timeoutMs: 10_000,
  });
  return r.exitCode === 0;
}

/** Run `docker login <registry>` on the remote, piping `password` via
 *  stdin. NEVER place the password in argv or an env var.
 *
 *  Returns the docker exit code + captured stderr. Caller decides how
 *  to render success/failure — this helper stays IO-free aside from
 *  the SSH child it spawns. */
export async function dockerLoginViaSsh(params: {
  target: CoolifyServerSshTarget;
  registry: string;
  username: string;
  password: string;
}): Promise<{ exitCode: number; stderr: string }> {
  const { target, registry, username, password } = params;
  // Single-quote `username` defensively even though gh logins are
  // [A-Za-z0-9-]+ — keeps the shell command shape uniform with the
  // logout/inspect helpers below.
  const remote = `docker login ${shQuote(registry)} -u ${shQuote(username)} --password-stdin`;
  const r = await sshExec(target, remote, {
    stdin: password,
    timeoutMs: 30_000,
  });
  return { exitCode: r.exitCode, stderr: r.stderr.trim() };
}

/** Run `docker logout <registry>` on the remote. Idempotent: docker
 *  logout exits 0 even when no entry existed for that registry. */
export async function dockerLogoutViaSsh(
  target: CoolifyServerSshTarget,
  registry: string,
): Promise<{ exitCode: number; stderr: string }> {
  const r = await sshExec(target, `docker logout ${shQuote(registry)}`, {
    timeoutMs: 15_000,
  });
  return { exitCode: r.exitCode, stderr: r.stderr.trim() };
}

/** Probe a remote `docker manifest inspect <image>` — used by doctor to
 *  verify the credential on the host still authorizes pulls. Returns
 *  exit 0 + minimal stderr on success. The `image` should be a fully
 *  qualified reference like `ghcr.io/owner/name:tag`. */
export async function dockerManifestInspectViaSsh(
  target: CoolifyServerSshTarget,
  image: string,
): Promise<{ exitCode: number; stderr: string }> {
  const r = await sshExec(target, `docker manifest inspect ${shQuote(image)} >/dev/null`, {
    timeoutMs: 30_000,
  });
  return { exitCode: r.exitCode, stderr: r.stderr.trim() };
}

/** Single-quote a string for safe embedding inside the bash command
 *  string we hand to `ssh`. Mirrors `shellEscape` in
 *  deploy/rollback.ts — duplicated here to keep this module
 *  dependency-free. */
function shQuote(s: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
