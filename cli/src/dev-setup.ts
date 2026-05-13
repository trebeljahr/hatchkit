/*
 * `hatchkit dev-setup` — opt-in Tailscale-served dev URLs.
 *
 * Goal: every scaffolded project reachable from any Tailscale peer at
 * https://<slug>.local.<project-domain>/ with no per-project DNS work,
 * no port juggling, no app-side base/basePath config, and zero
 * collisions between projects.
 *
 * Architecture (host-wide one-time setup):
 *
 *   phone ──HTTPS──▶ <slug>.local.<project-domain>:443
 *                          │ DNS A → laptop's 100.x tailnet IP
 *                          ▼
 *                  tailscale serve --tcp=443 (raw TCP passthrough)
 *                          ▼
 *                  localhost:<caddy-port>  (Caddy, wildcard TLS terminator)
 *                          │ reverse_proxy by Host header
 *                          ▼
 *                  localhost:<dev-port>    (vite/next dev server)
 *
 * Shared runtime bits (fragment writer, tailscale probes, paths, slug
 * resolution) live in @hatchkit/dev-shared so the dev plugins
 * (@hatchkit/dev-plugin-{vite,next}) can reuse them without depending on
 * the CLI. This module holds the CLI-only orchestration: plist
 * generation, launchctl wiring, port picking, doctor checks, docs
 * renderer.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CADDYFILE_PATH,
  DEV_CONFIG_DIR,
  LOCAL_DEV_DOMAIN,
  LOCAL_DEV_DOMAIN_WILDCARD,
  MANAGED_MARKER,
  PROJECTS_DIR,
  type TailscaleIdentity,
  isLocalDevActive,
  localDevDomainFromProjectDomain,
  localDevUrl,
  normaliseLocalDevDomain,
  projectFragmentPath,
  readCaddyLocalDevDomain,
  readCaddyPort,
  removeProjectFragment,
  tailscaleIdentity,
  tailscaleServeTcpTarget,
  writeProjectFragment,
} from "@hatchkit/dev-shared";
import { exec, execOk } from "./utils/exec.js";

export {
  CADDYFILE_PATH,
  DEV_CONFIG_DIR,
  LOCAL_DEV_DOMAIN,
  LOCAL_DEV_DOMAIN_WILDCARD,
  MANAGED_MARKER,
  PROJECTS_DIR,
  isLocalDevActive,
  readCaddyLocalDevDomain,
  readCaddyPort,
  tailscaleIdentity,
  tailscaleServeTcpTarget,
};
export type { TailscaleIdentity };

export const CADDY_LOG_PATH = join(DEV_CONFIG_DIR, "caddy.log");
export const CADDY_ERR_LOG_PATH = join(DEV_CONFIG_DIR, "caddy.err.log");
export const CADDY_WRAPPER_PATH = join(DEV_CONFIG_DIR, "caddy-wrapper.sh");
export const LAUNCHD_LABEL = "com.hatchkit.dev-caddy";
export const LAUNCHD_PLIST_PATH = join(
  homedir(),
  "Library",
  "LaunchAgents",
  `${LAUNCHD_LABEL}.plist`,
);

/** Default keychain pair used when the Caddy ACME token lives outside
 *  the launchd plist. When this entry exists, `dev-setup init` writes a
 *  wrapper-style plist that exec's a small shell script which pulls the
 *  token from keychain on demand — no plaintext secret in
 *  `~/Library/LaunchAgents/`. Override via
 *  `DevSetupInitOptions.caddyTokenKeychain`. */
export const DEFAULT_CADDY_KEYCHAIN_SERVICE = "caddy-dev";
export const DEFAULT_CADDY_KEYCHAIN_ACCOUNT = "cloudflare-acme";

const DEFAULT_CADDY_PORT = 9443;
const CADDY_PORT_BUMP_LIMIT = 50;

export interface CheckResult {
  name: string;
  status: "ok" | "fail" | "skip";
  detail?: string;
  hint?: string[];
}

// ---------------------------------------------------------------------------
// Caddyfile + launchd plist contents
// ---------------------------------------------------------------------------

export function caddyfileContents(caddyPort: number, localDevDomain = LOCAL_DEV_DOMAIN): string {
  const domain = normaliseLocalDevDomain(localDevDomain) ?? LOCAL_DEV_DOMAIN;
  const wildcard = `*.${domain}`;
  return `${MANAGED_MARKER}. Edit at your own risk — re-running
# \`hatchkit dev-setup init\` will overwrite this file (delete the marker
# line above to keep your edits across re-runs; doctor will then skip
# the Local-dev checks until you opt back in).

{
  acme_dns cloudflare {env.CLOUDFLARE_API_TOKEN}
  https_port ${caddyPort}
  # Disable the automatic HTTP→HTTPS redirect listener: it tries to bind
  # privileged port 80, which a launchd user-session daemon can't open
  # without root or a port-grant entitlement. DNS-01 ACME doesn't need
  # port 80 either, so the redirect server has nothing to do here.
  auto_https disable_redirects
}

https://${wildcard}:${caddyPort} {
  bind 127.0.0.1
  # No explicit \`tls\` directive: the site address already names the
  # wildcard subject, and the global \`acme_dns cloudflare\` block
  # drives DNS-01 issuance. Adding an explicit wildcard \`tls\` arg here
  # would be parsed as the email-or-keyword form and Caddy 2 rejects
  # it ("single argument must either be 'internal', 'force_automate',
  # or an email address").
  import ${PROJECTS_DIR}/*.caddy
}
`;
}

function launchdPlistContents(caddyBinPath: string, cloudflareToken: string | null): string {
  const env = cloudflareToken
    ? `  <key>EnvironmentVariables</key>
  <dict>
    <key>CLOUDFLARE_API_TOKEN</key>
    <string>${escapeXml(cloudflareToken)}</string>
  </dict>
`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${caddyBinPath}</string>
    <string>run</string>
    <string>--watch</string>
    <string>--config</string>
    <string>${CADDYFILE_PATH}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${CADDY_LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${CADDY_ERR_LOG_PATH}</string>
${env}</dict>
</plist>
`;
}

/** Wrapper-style plist: launchd runs a tiny shell script that pulls
 *  CLOUDFLARE_API_TOKEN from keychain on each Caddy start and then
 *  exec's the real caddy binary. Keeps the token out of the plist
 *  (and therefore out of Time Machine backups, etc.). */
function launchdPlistContentsWrapped(wrapperPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${wrapperPath}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${CADDY_LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${CADDY_ERR_LOG_PATH}</string>
</dict>
</plist>
`;
}

function caddyWrapperContents(
  caddyBinPath: string,
  keychainService: string,
  keychainAccount: string,
): string {
  return `#!/bin/zsh
# Managed by hatchkit dev-setup. Edit at your own risk — re-running
# \`hatchkit dev-setup init\` rewrites this file.
#
# Fetches the Cloudflare ACME token from the macOS Keychain at startup
# so the launchd plist doesn't have to embed a plaintext secret. launchd
# re-exec's this script every time Caddy restarts, so token rotation in
# keychain is picked up on the next reload.

set -euo pipefail
token=$(/usr/bin/security find-generic-password -s ${shellQuote(keychainService)} -a ${shellQuote(keychainAccount)} -w 2>/dev/null || true)
if [ -z "$token" ]; then
  echo "caddy-wrapper: missing keychain entry ${keychainService}/${keychainAccount}." >&2
  echo "  Store the Cloudflare ACME token with:" >&2
  echo "    security add-generic-password -s ${keychainService} -a ${keychainAccount} -w '<token>' -U" >&2
  exit 78
fi
export CLOUDFLARE_API_TOKEN="$token"
exec ${shellQuote(caddyBinPath)} run --watch --config ${shellQuote(CADDYFILE_PATH)}
`;
}

function shellQuote(s: string): string {
  // POSIX single-quote escape: a single literal apostrophe inside
  // single-quoted text is impossible, so we close-quote, insert an
  // escaped apostrophe, and re-open. Inputs here (paths, keychain
  // service/account) shouldn't contain quotes in practice, but the
  // round-trip stays safe if they ever do.
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Port probing
// ---------------------------------------------------------------------------

export async function pickFreeCaddyPort(): Promise<number | null> {
  for (let p = DEFAULT_CADDY_PORT; p < DEFAULT_CADDY_PORT + CADDY_PORT_BUMP_LIMIT; p++) {
    if (await isPortFree(p)) return p;
  }
  return null;
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => {
      resolve(false);
    });
    srv.once("listening", () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, "127.0.0.1");
  });
}

// ---------------------------------------------------------------------------
// Doctor checks
// ---------------------------------------------------------------------------

export async function checkLocalDevHost(): Promise<CheckResult[]> {
  if (!isLocalDevActive()) return [];

  const out: CheckResult[] = [];
  const caddyPort = readCaddyPort();

  const tsId = await tailscaleIdentity();
  if (!tsId) {
    out.push({
      name: "Local-dev / Tailscale daemon",
      status: "fail",
      detail: "tailscale CLI missing or daemon offline",
      hint: [
        "Install Tailscale and sign in once: https://tailscale.com/download",
        "Then run `tailscale status` and confirm it reports your tailnet identity.",
      ],
    });
  } else {
    out.push({
      name: "Local-dev / Tailscale daemon",
      status: "ok",
      detail: `${tsId.fullName} (${tsId.ip})`,
    });
  }

  const caddyAvailable = await execOk("caddy", ["version"]);
  if (!caddyAvailable) {
    out.push({
      name: "Local-dev / Caddy installed",
      status: "fail",
      detail: "caddy CLI not on PATH",
      hint: [
        "Install: `brew install caddy` (macOS).",
        "Caddy needs the caddy-dns/cloudflare plugin compiled in for DNS-01 ACME.",
        "Brew's stock Caddy includes it on recent versions; otherwise rebuild via xcaddy.",
      ],
    });
  } else {
    out.push({ name: "Local-dev / Caddy installed", status: "ok" });
  }

  if (caddyAvailable) {
    const modules = await exec("caddy", ["list-modules"], { silent: true });
    const hasPlugin = /dns\.providers\.cloudflare/i.test(modules.stdout);
    if (!hasPlugin) {
      out.push({
        name: "Local-dev / Caddy cloudflare plugin",
        status: "fail",
        detail: "dns.providers.cloudflare module not loaded",
        hint: [
          "Rebuild Caddy with the Cloudflare DNS plugin:",
          "  go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest",
          "  xcaddy build --with github.com/caddy-dns/cloudflare",
          "Replace the brew binary (or put the xcaddy output earlier on PATH) and reload Caddy.",
        ],
      });
    } else {
      out.push({ name: "Local-dev / Caddy cloudflare plugin", status: "ok" });
    }
  }

  const plistOk = existsSync(LAUNCHD_PLIST_PATH);
  if (!plistOk) {
    out.push({
      name: "Local-dev / launchd plist",
      status: "fail",
      detail: `${LAUNCHD_PLIST_PATH} not found`,
      hint: ["Run `hatchkit dev-setup init` to write the launchd plist."],
    });
  } else {
    // Two valid plist shapes:
    //   1. Inline env: `EnvironmentVariables` dict contains CLOUDFLARE_API_TOKEN.
    //   2. Wrapper:    ProgramArguments points at CADDY_WRAPPER_PATH; token
    //                  lives in keychain.
    // Probe accordingly so doctor doesn't false-flag the wrapper path.
    const plist = readFileSync(LAUNCHD_PLIST_PATH, "utf-8");
    const usesWrapper = plist.includes(CADDY_WRAPPER_PATH);
    if (usesWrapper) {
      if (!existsSync(CADDY_WRAPPER_PATH)) {
        out.push({
          name: "Local-dev / Caddy wrapper script",
          status: "fail",
          detail: `${CADDY_WRAPPER_PATH} referenced by plist but missing on disk`,
          hint: ["Re-run `hatchkit dev-setup init` to regenerate the wrapper."],
        });
      } else {
        const wrapper = readFileSync(CADDY_WRAPPER_PATH, "utf-8");
        const m = wrapper.match(/security find-generic-password -s '([^']+)' -a '([^']+)'/);
        const service = m?.[1] ?? DEFAULT_CADDY_KEYCHAIN_SERVICE;
        const account = m?.[2] ?? DEFAULT_CADDY_KEYCHAIN_ACCOUNT;
        if (!(await keychainEntryExists(service, account))) {
          out.push({
            name: "Local-dev / Cloudflare ACME token in keychain",
            status: "fail",
            detail: `keychain entry ${service}/${account} not found`,
            hint: [
              "Store the Cloudflare ACME token in the keychain:",
              `  security add-generic-password -s ${service} -a ${account} -w '<token>' -U`,
              "Then reload Caddy:",
              `  launchctl unload ${LAUNCHD_PLIST_PATH} && launchctl load -w ${LAUNCHD_PLIST_PATH}`,
            ],
          });
        } else {
          out.push({
            name: "Local-dev / Cloudflare ACME token in keychain",
            status: "ok",
            detail: `${service}/${account}`,
          });
        }
      }
    } else {
      const hasToken = /<key>CLOUDFLARE_API_TOKEN<\/key>\s*<string>[^<]+<\/string>/.test(plist);
      if (!hasToken) {
        out.push({
          name: "Local-dev / Cloudflare API token in plist",
          status: "fail",
          detail: "launchd plist has no CLOUDFLARE_API_TOKEN entry",
          hint: [
            "Configure DNS first: `hatchkit config add dns` (Cloudflare token with Zone:DNS:Edit).",
            "Then re-run: `hatchkit dev-setup init` to refresh the plist.",
            "Or switch to keychain-backed storage:",
            `  security add-generic-password -s ${DEFAULT_CADDY_KEYCHAIN_SERVICE} -a ${DEFAULT_CADDY_KEYCHAIN_ACCOUNT} -w '<token>' -U`,
            "then re-run `dev-setup init` (it'll generate a wrapper-style plist).",
          ],
        });
      } else {
        out.push({ name: "Local-dev / Cloudflare API token in plist", status: "ok" });
      }
    }
  }

  const launchctlList = await exec("launchctl", ["list", LAUNCHD_LABEL], { silent: true });
  if (launchctlList.exitCode !== 0) {
    out.push({
      name: "Local-dev / Caddy launchd job",
      status: "fail",
      detail: `launchctl reports ${LAUNCHD_LABEL} not loaded`,
      hint: [
        "Load it:",
        `  launchctl load -w ${LAUNCHD_PLIST_PATH}`,
        "Or re-run: `hatchkit dev-setup init` (idempotent).",
      ],
    });
  } else {
    out.push({
      name: "Local-dev / Caddy launchd job",
      status: "ok",
      detail: `${LAUNCHD_LABEL} loaded`,
    });
  }

  if (tsId) {
    // DNS A record probe. Skipped silently when no Cloudflare token is
    // reachable (manual DNS setups) — that's a separate failure mode
    // that the user already knows about, not a regression we should
    // re-surface every doctor run.
    const dnsCheck = await checkLocalDevDnsRecord(tsId.ip);
    if (dnsCheck) out.push(dnsCheck);
  }

  if (!caddyPort) {
    out.push({
      name: "Local-dev / Tailscale serve bridge",
      status: "fail",
      detail: "couldn't parse https_port from Caddyfile",
      hint: ["Re-run `hatchkit dev-setup init` to rewrite the Caddyfile."],
    });
  } else if (!tsId) {
    out.push({ name: "Local-dev / Tailscale serve bridge", status: "skip" });
  } else {
    const tcpTarget = await tailscaleServeTcpTarget();
    if (tcpTarget === null) {
      out.push({
        name: "Local-dev / Tailscale serve bridge",
        status: "fail",
        detail: "no tcp:443 serve entry registered",
        hint: [
          "Register the one-shot host bridge:",
          `  tailscale serve --bg --tcp=443 tcp://localhost:${caddyPort}`,
          "Or re-run: `hatchkit dev-setup init` (registers it automatically).",
        ],
      });
    } else if (tcpTarget !== caddyPort) {
      out.push({
        name: "Local-dev / Tailscale serve bridge",
        status: "fail",
        detail: `tcp:443 points at localhost:${tcpTarget} but Caddyfile binds ${caddyPort}`,
        hint: [
          "Re-register the bridge against the current Caddy port:",
          "  tailscale serve reset",
          `  tailscale serve --bg --tcp=443 tcp://localhost:${caddyPort}`,
          "Or re-run: `hatchkit dev-setup init` to reconcile.",
        ],
      });
    } else {
      out.push({
        name: "Local-dev / Tailscale serve bridge",
        status: "ok",
        detail: `tcp:443 → localhost:${caddyPort}`,
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// `hatchkit dev-setup init` — auto-write Caddyfile + plist, register bridge
// ---------------------------------------------------------------------------

export interface DevSetupInitOptions {
  force?: boolean;
  /** Local-dev host suffix, e.g. `local.example.com`. */
  localDevDomain?: string;
  skipLaunchd?: boolean;
  skipServe?: boolean;
  caddyBinPath?: string;
  cloudflareToken?: string | null;
  /** Pull the Cloudflare ACME token from a macOS Keychain entry at
   *  Caddy start time instead of embedding it in the launchd plist.
   *  When set (or when the `caddy-dev/cloudflare-acme` default entry
   *  exists), `init` writes a wrapper script and a plist that exec's
   *  the wrapper — the secret never lands on disk in plaintext. Pass
   *  `false` to force inline-env mode even if the default entry exists. */
  caddyTokenKeychain?: { service: string; account: string } | false;
}

export interface DevSetupInitResult {
  localDevDomain: string;
  caddyPort: number;
  wroteCaddyfile: boolean;
  wrotePlist: boolean;
  /** True when the wrapper script at CADDY_WRAPPER_PATH was created or
   *  rewritten. Only set in wrapper-mode runs. */
  wroteWrapper: boolean;
  loadedLaunchd: boolean;
  registeredServe: boolean;
  /** State of the local-dev wildcard DNS A record that points at
   *  the laptop's tailnet IP. `null` when no Cloudflare token is
   *  reachable (manual DNS setup expected); a status string when
   *  hatchkit managed the record itself. */
  dnsRecord:
    | "created"
    | "updated"
    | "unchanged"
    | "skipped-no-token"
    | "skipped-existing"
    | "failed"
    | null;
  notes: string[];
}

export function localDevDomainSafetyIssue(input: string | undefined): string | null {
  const domain = normaliseLocalDevDomain(input);
  if (!domain) return "Local-dev domain is invalid. Use a domain like local.example.com.";
  const labels = domain.split(".");
  if (labels.length < 3 || labels[0] !== "local") {
    const suggested = domain.startsWith("local.") ? domain : `local.${domain}`;
    return (
      `Unsafe local-dev domain "${domain}". Use a dedicated local-dev subdomain, ` +
      `for example "${suggested}", so Hatchkit manages "*.local..." DNS instead ` +
      "of a production wildcard."
    );
  }
  return null;
}

export function isTailscaleIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return false;
  }
  const n = ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
  // Tailscale IPv4s live in CGNAT space 100.64.0.0/10.
  return n >= 0x64400000 && n <= 0x647fffff;
}

export async function runDevSetupInit(opts: DevSetupInitOptions = {}): Promise<DevSetupInitResult> {
  if (!existsSync(PROJECTS_DIR)) mkdirSync(PROJECTS_DIR, { recursive: true });
  const localDevDomain =
    normaliseLocalDevDomain(opts.localDevDomain) ??
    (isLocalDevActive() ? readCaddyLocalDevDomain() : LOCAL_DEV_DOMAIN);
  const domainSafetyIssue = localDevDomainSafetyIssue(localDevDomain);
  if (domainSafetyIssue) throw new Error(domainSafetyIssue);

  let caddyPort = opts.force ? null : readCaddyPort();
  if (caddyPort === null) {
    caddyPort = await pickFreeCaddyPort();
    if (caddyPort === null) {
      throw new Error(
        `No free port found in [${DEFAULT_CADDY_PORT}, ${DEFAULT_CADDY_PORT + CADDY_PORT_BUMP_LIMIT})`,
      );
    }
  }

  const notes: string[] = [];

  // Caddyfile. Refuse to clobber a hand-rolled (unmanaged) Caddyfile
  // unless --force is set; the user may be running their own dev domain
  // setup we shouldn't trample on first encounter.
  let wroteCaddyfile = false;
  const nextCaddyfile = caddyfileContents(caddyPort, localDevDomain);
  if (existsSync(CADDYFILE_PATH)) {
    const existing = readFileSync(CADDYFILE_PATH, "utf-8");
    if (!existing.includes(MANAGED_MARKER) && !opts.force) {
      throw new Error(
        `${CADDYFILE_PATH} exists but is not hatchkit-managed (no marker line). ` +
          `Re-run with --force to overwrite, or delete the file first.`,
      );
    }
    if (existing !== nextCaddyfile) {
      writeFileSync(CADDYFILE_PATH, nextCaddyfile);
      wroteCaddyfile = true;
    }
  } else {
    if (!existsSync(DEV_CONFIG_DIR)) mkdirSync(DEV_CONFIG_DIR, { recursive: true });
    writeFileSync(CADDYFILE_PATH, nextCaddyfile);
    wroteCaddyfile = true;
  }

  let wrotePlist = false;
  let wroteWrapper = false;
  const caddyBinPath = opts.caddyBinPath ?? (await resolveCaddyBin());

  // Wrapper-mode resolution. Explicit `false` opts out. Explicit pair
  // opts in. Undefined falls back to auto-detect: if the default
  // keychain pair is reachable via `security`, prefer wrapper mode so
  // the secret stays off the launchd plist.
  let keychainPair: { service: string; account: string } | null = null;
  if (opts.caddyTokenKeychain === false) {
    keychainPair = null;
  } else if (opts.caddyTokenKeychain) {
    keychainPair = opts.caddyTokenKeychain;
  } else {
    const exists = await keychainEntryExists(
      DEFAULT_CADDY_KEYCHAIN_SERVICE,
      DEFAULT_CADDY_KEYCHAIN_ACCOUNT,
    );
    if (exists) {
      keychainPair = {
        service: DEFAULT_CADDY_KEYCHAIN_SERVICE,
        account: DEFAULT_CADDY_KEYCHAIN_ACCOUNT,
      };
    }
  }

  if (!caddyBinPath) {
    notes.push("caddy CLI not on PATH — skipping plist write. Install caddy then re-run.");
  } else if (keychainPair) {
    // Wrapper-style plist + helper script. Token stays in keychain.
    const nextWrapper = caddyWrapperContents(
      caddyBinPath,
      keychainPair.service,
      keychainPair.account,
    );
    if (
      !existsSync(CADDY_WRAPPER_PATH) ||
      readFileSync(CADDY_WRAPPER_PATH, "utf-8") !== nextWrapper
    ) {
      writeFileSync(CADDY_WRAPPER_PATH, nextWrapper);
      const { chmodSync } = await import("node:fs");
      chmodSync(CADDY_WRAPPER_PATH, 0o700);
      wroteWrapper = true;
    }
    const nextPlist = launchdPlistContentsWrapped(CADDY_WRAPPER_PATH);
    if (
      !existsSync(LAUNCHD_PLIST_PATH) ||
      readFileSync(LAUNCHD_PLIST_PATH, "utf-8") !== nextPlist
    ) {
      writeFileSync(LAUNCHD_PLIST_PATH, nextPlist);
      wrotePlist = true;
    }
    notes.push(
      `Cloudflare ACME token will be read from keychain ${keychainPair.service}/${keychainPair.account} at Caddy startup.`,
    );
  } else {
    // Legacy inline-env path: read token from hatchkit's DNS config and
    // embed in the plist's EnvironmentVariables. Preserved for users who
    // haven't set up the keychain entry yet.
    const token =
      opts.cloudflareToken === undefined
        ? await readCloudflareTokenFromConfig()
        : opts.cloudflareToken;
    if (!token) {
      notes.push(
        "No Cloudflare API token in hatchkit's DNS config — plist will lack CLOUDFLARE_API_TOKEN.",
      );
      notes.push(
        `For keychain-backed storage: \`security add-generic-password -s ${DEFAULT_CADDY_KEYCHAIN_SERVICE} -a ${DEFAULT_CADDY_KEYCHAIN_ACCOUNT} -w '<token>' -U\` then re-run \`dev-setup init\`.`,
      );
    }
    const nextPlist = launchdPlistContents(caddyBinPath, token ?? null);
    if (
      !existsSync(LAUNCHD_PLIST_PATH) ||
      readFileSync(LAUNCHD_PLIST_PATH, "utf-8") !== nextPlist
    ) {
      writeFileSync(LAUNCHD_PLIST_PATH, nextPlist);
      wrotePlist = true;
    }
  }

  let loadedLaunchd = false;
  if (!opts.skipLaunchd && wrotePlist) {
    await exec("launchctl", ["unload", LAUNCHD_PLIST_PATH], { silent: true });
    const loadRes = await exec("launchctl", ["load", "-w", LAUNCHD_PLIST_PATH], { silent: true });
    loadedLaunchd = loadRes.exitCode === 0;
    if (!loadedLaunchd) notes.push(`launchctl load failed: ${loadRes.stderr || loadRes.stdout}`);
  }

  let registeredServe = false;
  if (!opts.skipServe) {
    const current = await tailscaleServeTcpTarget();
    if (current !== caddyPort) {
      const serveRes = await exec(
        "tailscale",
        ["serve", "--bg", "--tcp=443", `tcp://localhost:${caddyPort}`],
        { silent: true },
      );
      registeredServe = serveRes.exitCode === 0;
      if (!registeredServe) {
        notes.push(`tailscale serve register failed: ${serveRes.stderr || serveRes.stdout}`);
      }
    } else {
      registeredServe = true;
    }
  }

  // DNS: ensure the local-dev wildcard → laptop's tailnet IP (A record,
  // DNS-only). Without this every project URL hits whatever the parent
  // zone's wildcard says (typically the Coolify host IP, proxied — which
  // doesn't reach the tailnet) and phone requests die at the TLS
  // handshake. CNAMEing to the .ts.net MagicDNS name would also work,
  // but only when each peer has Tailscale's resolver in front of its
  // public DNS — fragile on iOS, where stub resolvers cache the
  // intermediate NXDOMAIN. Direct A record is the bulletproof shape.
  const dnsRecord = await ensureLocalDevDnsRecord({ ...opts, localDevDomain }, notes);

  return {
    localDevDomain,
    caddyPort,
    wroteCaddyfile,
    wrotePlist,
    wroteWrapper,
    loadedLaunchd,
    registeredServe,
    dnsRecord,
    notes,
  };
}

/** Upsert the local-dev wildcard A record to the laptop's current
 *  tailnet IP. Idempotent. Returns the action taken (or a reason it
 *  was skipped). All failures are non-fatal — they only nudge the
 *  user toward the manual command. */
async function ensureLocalDevDnsRecord(
  opts: DevSetupInitOptions,
  notes: string[],
): Promise<DevSetupInitResult["dnsRecord"]> {
  const localDevDomain = normaliseLocalDevDomain(opts.localDevDomain) ?? LOCAL_DEV_DOMAIN;
  const wildcard = `*.${localDevDomain}`;
  const identity = await tailscaleIdentity();
  if (!identity) {
    notes.push("DNS record skipped: tailscale daemon offline (no IP to point the record at).");
    return null;
  }

  // Token resolution order:
  //   1. Explicit (opts.cloudflareToken) — same field plist embedding uses.
  //   2. hatchkit's DNS config (`hatchkit config add dns`).
  //   3. The Caddy ACME keychain entry the wrapper script reads — same
  //      Zone:DNS:Edit scope, no need for a second token in keychain.
  let token: string | null;
  if (opts.cloudflareToken !== undefined) {
    token = opts.cloudflareToken;
  } else {
    token = (await readCloudflareTokenFromConfig()) ?? (await readCloudflareTokenFromKeychain());
  }
  if (!token) {
    notes.push(
      "DNS record skipped: no Cloudflare token reachable. Configure via `hatchkit config add dns` or set keychain entry caddy-dev/cloudflare-acme.",
    );
    return "skipped-no-token";
  }

  try {
    const { CloudflareApi } = await import("./utils/cloudflare-api.js");
    const cf = new CloudflareApi({ token });
    const zone = await resolveZoneForName(cf, wildcard);
    if (!zone) {
      notes.push(
        `DNS record skipped: no Cloudflare zone found for ${localDevDomain}. The token may lack Zone:Zone:Read scope.`,
      );
      return "failed";
    }
    const existing = await findLocalDevWildcardRecords(cf, zone.id, wildcard);
    const conflict = existing.find((r) => r.type !== "A" || !isTailscaleIpv4(r.content));
    if (conflict) {
      notes.push(
        `DNS record skipped: ${formatRecord(conflict)} already exists. Hatchkit will not overwrite non-Tailscale wildcard DNS; choose --domain local.<your-domain> or change the record manually.`,
      );
      return "skipped-existing";
    }
    if (existing.length > 1) {
      notes.push(
        `DNS record skipped: ${wildcard} has multiple local-dev-looking records. Clean them up manually before re-running.`,
      );
      return "skipped-existing";
    }

    const current = existing[0];
    if (current && current.content === identity.ip && !current.proxied) return "unchanged";

    const upsert = await cf.upsertRecord(zone.id, {
      type: "A",
      name: wildcard,
      content: identity.ip,
      proxied: false,
      ttl: 60,
    });
    if (upsert.created) return "created";
    if (upsert.updated) return "updated";
    return "unchanged";
  } catch (err) {
    notes.push(`DNS record failed: ${(err as Error).message}`);
    return "failed";
  }
}

async function findLocalDevWildcardRecords(
  cf: import("./utils/cloudflare-api.js").CloudflareApi,
  zoneId: string,
  wildcard: string,
): Promise<Array<{ type: string; name: string; content: string; proxied: boolean }>> {
  const [a, aaaa, cname] = await Promise.all([
    cf.findRecordsByName(zoneId, wildcard, "A"),
    cf.findRecordsByName(zoneId, wildcard, "AAAA"),
    cf.findRecordsByName(zoneId, wildcard, "CNAME"),
  ]);
  return [...a, ...aaaa, ...cname];
}

function formatRecord(record: { type: string; name: string; content: string; proxied: boolean }) {
  return `${record.type} ${record.name} -> ${record.content}${record.proxied ? " (proxied)" : ""}`;
}

/** Walk the candidate label chain looking for a Cloudflare zone we can
 *  manage. For `*.local.example.com` this tries `local.example.com`
 *  first (in case the user has it delegated as its own zone), then
 *  `example.com`, then `com` (which won't be ours but completes the
 *  chain symmetrically). Returns the first hit. */
async function resolveZoneForName(
  cf: import("./utils/cloudflare-api.js").CloudflareApi,
  name: string,
): Promise<{ id: string; name: string } | null> {
  const labels = name.replace(/^\*\./, "").split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join(".");
    const zone = await cf.getZoneByName(candidate);
    if (zone) return { id: zone.id, name: zone.name };
  }
  return null;
}

/** Probe the live local-dev wildcard Cloudflare record. Returns
 *  null when there's no token to check with — that's a configuration
 *  state, not a failure. Otherwise reports drift between the record
 *  and the laptop's current tailnet IP. */
async function checkLocalDevDnsRecord(currentIp: string): Promise<CheckResult | null> {
  const localDevDomain = readCaddyLocalDevDomain();
  const domainSafetyIssue = localDevDomainSafetyIssue(localDevDomain);
  if (domainSafetyIssue) {
    return {
      name: "Local-dev / DNS domain",
      status: "fail",
      detail: domainSafetyIssue,
      hint: [
        "Re-run `hatchkit dev-setup init --domain local.<your-domain>`.",
        "This prevents Hatchkit from managing a production wildcard such as *.example.com.",
      ],
    };
  }
  const wildcard = `*.${localDevDomain}`;
  const token =
    (await readCloudflareTokenFromConfig()) ?? (await readCloudflareTokenFromKeychain());
  if (!token) return null;
  try {
    const { CloudflareApi } = await import("./utils/cloudflare-api.js");
    const cf = new CloudflareApi({ token });
    const zone = await resolveZoneForName(cf, wildcard);
    if (!zone) {
      return {
        name: `Local-dev / DNS A record`,
        status: "fail",
        detail: `no Cloudflare zone found for ${localDevDomain}`,
        hint: [
          "Token may lack Zone:Zone:Read on the parent zone, or the zone isn't on Cloudflare.",
          "Add the record manually if you're using a different DNS provider:",
          `  ${wildcard}  A  ${currentIp}  (DNS-only / unproxied, TTL 60)`,
        ],
      };
    }
    const existing = await findLocalDevWildcardRecords(cf, zone.id, wildcard);
    const conflict = existing.find((r) => r.type !== "A" || !isTailscaleIpv4(r.content));
    if (conflict) {
      return {
        name: "Local-dev / DNS A record",
        status: "fail",
        detail: `existing non-local-dev wildcard record: ${formatRecord(conflict)}`,
        hint: [
          "Hatchkit will not overwrite this record automatically.",
          "Use a dedicated local-dev suffix such as local.<your-domain>, or change DNS manually.",
        ],
      };
    }
    if (existing.length > 1) {
      return {
        name: "Local-dev / DNS A record",
        status: "fail",
        detail: `${wildcard} has multiple A/AAAA/CNAME records`,
        hint: [
          "Clean up duplicate wildcard records manually, then re-run `hatchkit dev-setup init`.",
        ],
      };
    }
    const record = existing[0];
    if (!record) {
      return {
        name: "Local-dev / DNS A record",
        status: "fail",
        detail: `no A record for ${wildcard} in zone ${zone.name}`,
        hint: ["Run `hatchkit dev-setup init` to create it automatically."],
      };
    }
    if (record.content !== currentIp) {
      return {
        name: "Local-dev / DNS A record",
        status: "fail",
        detail: `record points at ${record.content} but tailnet IP is ${currentIp}`,
        hint: [
          "Tailnet IP changed (new node, reinstall). Re-run `hatchkit dev-setup init` to update.",
        ],
      };
    }
    if (record.proxied) {
      return {
        name: "Local-dev / DNS A record",
        status: "fail",
        detail: "record is Cloudflare-proxied (orange-cloud) — must be DNS-only",
        hint: [
          "Proxied records terminate TLS at Cloudflare and can't reach the tailnet.",
          "Turn off the orange cloud on this record, or re-run `hatchkit dev-setup init` (it'll recreate as DNS-only).",
        ],
      };
    }
    return {
      name: "Local-dev / DNS A record",
      status: "ok",
      detail: `${wildcard} → ${currentIp} (DNS-only)`,
    };
  } catch (err) {
    return {
      name: "Local-dev / DNS A record",
      status: "fail",
      detail: (err as Error).message.split("\n")[0],
      hint: ["Cloudflare API call failed — token may be invalid or revoked."],
    };
  }
}

async function readCloudflareTokenFromKeychain(): Promise<string | null> {
  const res = await exec(
    "security",
    [
      "find-generic-password",
      "-s",
      DEFAULT_CADDY_KEYCHAIN_SERVICE,
      "-a",
      DEFAULT_CADDY_KEYCHAIN_ACCOUNT,
      "-w",
    ],
    { silent: true },
  );
  if (res.exitCode !== 0) return null;
  const out = res.stdout.trim();
  return out.length > 0 ? out : null;
}

async function keychainEntryExists(service: string, account: string): Promise<boolean> {
  // `security find-generic-password` exits 0 when the entry exists. We
  // don't ask for the value (`-w`) — existence is enough. Suppress
  // stderr so the "not found" line doesn't show up in normal runs.
  const res = await exec("security", ["find-generic-password", "-s", service, "-a", account], {
    silent: true,
  });
  return res.exitCode === 0;
}

async function resolveCaddyBin(): Promise<string | null> {
  const res = await exec("which", ["caddy"], { silent: true });
  if (res.exitCode !== 0) return null;
  const path = res.stdout.trim();
  return path || null;
}

async function readCloudflareTokenFromConfig(): Promise<string | null> {
  try {
    const { getDnsConfig } = await import("./config.js");
    const cfg = await getDnsConfig();
    return cfg?.apiToken ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-project enable/disable — shared by the scaffold postinit hook
// and the `hatchkit dev-setup enable` subcommand for retrofitting
// existing projects.
// ---------------------------------------------------------------------------

export { projectFragmentPath, removeProjectFragment, writeProjectFragment };

/** Version range we write into scaffolded `package.json` for the dev
 *  plugins. Locks to the CLI's own version (the release pipeline bumps
 *  every `@hatchkit/dev-*` package in lockstep with the CLI), so a
 *  user who installed `hatchkit@x.y.z` gets a scaffold that pulls
 *  `@hatchkit/dev-plugin-{next,vite}@^x.y.z` — guaranteed to exist on
 *  npm. Local-workspace development inside this monorepo bypasses the
 *  range via pnpm's workspace resolution. */
async function pluginVersionRange(): Promise<string> {
  const { getCliVersion } = await import("./utils/version.js");
  return `^${getCliVersion()}`;
}

export interface EnableProjectLocalDevInput {
  /** Absolute path to the project root (contains `.hatchkit.json`). */
  projectDir: string;
  slug: string;
  /** Local-dev host suffix, e.g. `local.example.com`. */
  localDevDomain?: string;
  /** Dev port the Caddy fragment should reverse-proxy to. For client-
   *  bearing projects this is the client port; for server-only, the
   *  server port. The dev plugin will overwrite the fragment with the
   *  live port at the next `pnpm dev` if this guess is wrong. */
  devPort: number;
  /** When false, skip the framework-config patch (next.config.ts).
   *  Useful for `hatchkit dev-setup enable` invocations on projects
   *  whose Next config has been hand-edited beyond the auto-patch
   *  comfort zone — the user can wire the plugin themselves. */
  patchNextConfig?: boolean;
  /** When false, skip the package.json dep injection. Same rationale. */
  patchPackageJson?: boolean;
}

export interface EnableProjectLocalDevResult {
  wroteFragment: "created" | "updated" | "unchanged";
  wroteDocs: boolean;
  /** Which framework the patcher detected (or `none` when neither a
   *  Next nor a Vite config is reachable from the project). Drives
   *  which plugin package is injected. */
  framework: "next" | "vite" | "none";
  patchedConfig:
    | "added"
    | "already-wrapped"
    | "no-file"
    | "unsupported-shape"
    | "manual-wire-required"
    | "skipped";
  patchedPackageJson: "added" | "already-present" | "no-file" | "skipped";
}

/** Wire a single project for Tailscale-served local dev. Idempotent —
 *  safe to call from scaffold (first run) AND from `dev-setup enable`
 *  on an already-wired project. */
export async function enableProjectLocalDev(
  input: EnableProjectLocalDevInput,
): Promise<EnableProjectLocalDevResult> {
  const manifest = await (async () => {
    try {
      const { readManifest } = await import("./scaffold/manifest.js");
      return readManifest(input.projectDir);
    } catch {
      return null;
    }
  })();
  const localDevDomain =
    normaliseLocalDevDomain(input.localDevDomain) ??
    normaliseLocalDevDomain(manifest?.localDev?.domain) ??
    localDevDomainFromProjectDomain(manifest?.domain) ??
    LOCAL_DEV_DOMAIN;
  const domainSafetyIssue = localDevDomainSafetyIssue(localDevDomain);
  if (domainSafetyIssue) throw new Error(domainSafetyIssue);
  const wroteFragment = writeProjectFragment(input.slug, input.devPort, localDevDomain);

  const docsPath = join(input.projectDir, "docs", "dev-setup.md");
  const docsContent = renderDevSetupDocs({
    slug: input.slug,
    localDevDomain,
    tailscale: await tailscaleIdentity(),
  });
  let wroteDocs = false;
  if (!existsSync(docsPath) || readFileSync(docsPath, "utf-8") !== docsContent) {
    const docsDir = join(input.projectDir, "docs");
    if (!existsSync(docsDir)) mkdirSync(docsDir, { recursive: true });
    writeFileSync(docsPath, docsContent);
    wroteDocs = true;
  }

  // Framework detection: prefer Next when a next.config is reachable —
  // the patcher handles ESM `export default` shapes automatically.
  // Otherwise fall back to Vite. Vite configs come in too many shapes
  // (defineConfig fn, plugin arrays in different positions, env-gated
  // builds) for safe automated patching, so we inject the dep and
  // surface a `manual-wire-required` flag for the caller to print
  // instructions. Projects that are neither (server-only, exotic) get
  // `none` and we skip the patch step entirely.
  const framework: EnableProjectLocalDevResult["framework"] = findNextConfig(input.projectDir)
    ? "next"
    : findViteConfig(input.projectDir)
      ? "vite"
      : "none";

  let patchedConfig: EnableProjectLocalDevResult["patchedConfig"];
  let patchedPackageJson: EnableProjectLocalDevResult["patchedPackageJson"];

  if (input.patchNextConfig === false) {
    patchedConfig = "skipped";
  } else if (framework === "next") {
    patchedConfig = patchNextConfigWithLocalDev(input.projectDir, input.slug);
  } else if (framework === "vite") {
    patchedConfig = "manual-wire-required";
  } else {
    patchedConfig = "no-file";
  }

  if (input.patchPackageJson === false) {
    patchedPackageJson = "skipped";
  } else {
    const versionRange = await pluginVersionRange();
    if (framework === "next") {
      patchedPackageJson = patchPluginPackageJsonDep(input.projectDir, versionRange, "next");
    } else if (framework === "vite") {
      patchedPackageJson = patchPluginPackageJsonDep(input.projectDir, versionRange, "vite");
    } else {
      patchedPackageJson = "no-file";
    }
  }

  return { wroteFragment, wroteDocs, framework, patchedConfig, patchedPackageJson };
}

/** Remove the project's Caddy fragment + the docs file. Leaves the
 *  next.config wrapper + the plugin dep in place — they're inert when
 *  `~/.config/dev/projects/<slug>.caddy` is gone, and ripping them
 *  back out risks colliding with user edits to either file. */
export function disableProjectLocalDev(
  projectDir: string,
  slug: string,
): {
  removedFragment: boolean;
  removedDocs: boolean;
} {
  const removedFragment = removeProjectFragment(slug);
  const docsPath = join(projectDir, "docs", "dev-setup.md");
  let removedDocs = false;
  if (existsSync(docsPath)) {
    rmSync(docsPath);
    removedDocs = true;
  }
  return { removedFragment, removedDocs };
}

/** Subdirectories scanned for a Next config (in order). The first
 *  match wins. Covers standard hatchkit layout (`packages/client`),
 *  flat layout (project root), and common monorepo conventions for
 *  the next-bearing package (`showcase`, `web`, `site`, `app`, `docs`,
 *  `apps/web`). Caller can short-circuit by passing the exact path
 *  via the patcher's caller — this scan is the fallback. */
const FRAMEWORK_CONFIG_SUBDIRS = [
  "packages/client",
  "",
  "showcase",
  "web",
  "site",
  "app",
  "docs",
  "apps/web",
  "apps/site",
];
const NEXT_CONFIG_FILENAMES = ["next.config.ts", "next.config.mjs", "next.config.js"];
const VITE_CONFIG_FILENAMES = ["vite.config.ts", "vite.config.mjs", "vite.config.js"];

/** Locate the project's Next config file. Returns the absolute path of
 *  the first hit found by walking `FRAMEWORK_CONFIG_SUBDIRS × NEXT_CONFIG_FILENAMES`,
 *  or null when nothing matches. Exposed so the package.json patcher
 *  can target the sibling `package.json` rather than a different layout. */
function findNextConfig(projectDir: string): string | null {
  for (const sub of FRAMEWORK_CONFIG_SUBDIRS) {
    for (const name of NEXT_CONFIG_FILENAMES) {
      const candidate = join(projectDir, sub, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Locate the project's Vite config file. Mirrors `findNextConfig`. */
function findViteConfig(projectDir: string): string | null {
  for (const sub of FRAMEWORK_CONFIG_SUBDIRS) {
    for (const name of VITE_CONFIG_FILENAMES) {
      const candidate = join(projectDir, sub, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Wrap the project's Next config with `withLocalDev` from
 *  @hatchkit/dev-plugin-next. Idempotent: detects an existing import
 *  and bails before touching the file.
 *
 *  Strategy is intentionally surgical — replace the
 *  `export default nextConfig;` line with the wrap + add a top-of-file
 *  import. We do NOT try to handle exotic config shapes
 *  (functional configs, conditional defaults). Returns `"no-file"`
 *  when no next.config can be located (server-only surfaces, unusual
 *  layouts) and `"unsupported-shape"` when the file exists but doesn't
 *  match an ESM `export default` pattern — most commonly CJS
 *  `module.exports = …`. */
function patchNextConfigWithLocalDev(
  projectDir: string,
  slug: string,
): "added" | "already-wrapped" | "no-file" | "unsupported-shape" {
  const path = findNextConfig(projectDir);
  if (!path) return "no-file";

  const content = readFileSync(path, "utf-8");
  if (content.includes("@hatchkit/dev-plugin-next")) return "already-wrapped";

  // CJS configs use `module.exports = …`; we can't add a top-of-file
  // ESM `import` to those. Caller surfaces the gap so the user can
  // either migrate to ESM or wrap by hand.
  if (/^\s*module\.exports\s*=/m.test(content)) return "unsupported-shape";

  // Find the last `export default …;` and wrap whatever identifier it
  // exports. The common shape is `export default nextConfig;` but some
  // configs do `export default { … };` inline — we handle both by
  // hoisting the expression into a const first when needed.
  const exportMatch = content.match(/^\s*export\s+default\s+([^;]+);?\s*$/m);
  if (!exportMatch) return "unsupported-shape";

  const expression = exportMatch[1].trim();
  const isIdentifier = /^[a-zA-Z_$][\w$]*$/.test(expression);
  const importLine = `import { withLocalDev } from "@hatchkit/dev-plugin-next";\n`;
  let next = content;
  if (isIdentifier) {
    next = next.replace(
      exportMatch[0],
      `\nexport default withLocalDev(${expression}, { slug: "${slug}" });\n`,
    );
  } else {
    // Inline expression — hoist into a const so we can wrap it cleanly.
    next = next.replace(
      exportMatch[0],
      `\nconst __hatchkitLocalDevConfig = ${expression};\nexport default withLocalDev(__hatchkitLocalDevConfig, { slug: "${slug}" });\n`,
    );
  }
  next = `${importLine}${next}`;
  writeFileSync(path, next);
  return "added";
}

/** Inject the right `@hatchkit/dev-plugin-{next,vite}` package into the
 *  client package.json's dependencies (or devDependencies, matching where
 *  the framework's own dep already lives). Targets the package.json
 *  sibling of the framework config we found, so monorepo subdirs
 *  (gamedev's `showcase/`, conv3d's `docs/`) get patched correctly.
 *  Idempotent. */
function patchPluginPackageJsonDep(
  projectDir: string,
  versionRange: string,
  framework: "next" | "vite",
): "added" | "already-present" | "no-file" {
  const configPath = framework === "next" ? findNextConfig(projectDir) : findViteConfig(projectDir);
  const path = configPath ? join(configPath, "..", "package.json") : null;
  if (!path || !existsSync(path)) return "no-file";

  const frameworkDep = framework;
  const pluginPackage = `@hatchkit/dev-plugin-${framework}`;
  const pkg = (() => {
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        [key: string]: unknown;
      };
    } catch {
      return null;
    }
  })();
  if (!pkg) return "no-file";
  if (!pkg.dependencies?.[frameworkDep] && !pkg.devDependencies?.[frameworkDep]) {
    return "no-file";
  }

  const alreadyIn = pkg.dependencies?.[pluginPackage] ?? pkg.devDependencies?.[pluginPackage];
  if (alreadyIn) return "already-present";

  // Mirror the framework's own bucket. Projects that keep tooling in
  // devDependencies (e.g. scaffolds generated by `create-next-app
  // --use-pnpm`, or Vite's `npm create vite@latest`) shouldn't get
  // their dev plugin shoved into runtime deps just because we have a
  // default. Falls back to dependencies if the framework dep isn't in
  // devDeps but appears in deps.
  const bucket: "dependencies" | "devDependencies" = pkg.devDependencies?.[frameworkDep]
    ? "devDependencies"
    : "dependencies";
  pkg[bucket] = pkg[bucket] ?? {};
  (pkg[bucket] as Record<string, string>)[pluginPackage] = versionRange;
  pkg[bucket] = Object.fromEntries(
    Object.entries(pkg[bucket] as Record<string, string>).sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  return "added";
}

// ---------------------------------------------------------------------------
// Per-project docs/dev-setup.md renderer
// ---------------------------------------------------------------------------

export interface DevSetupDocsInput {
  slug: string;
  localDevDomain?: string;
  tailscale?: TailscaleIdentity | null;
}

export function renderDevSetupDocs(input: DevSetupDocsInput): string {
  const localDevDomain = normaliseLocalDevDomain(input.localDevDomain) ?? LOCAL_DEV_DOMAIN;
  const wildcard = `*.${localDevDomain}`;
  const tailnetHostname = input.tailscale?.fullName ?? "<your-machine>.<tailnet>.ts.net";
  const url = localDevUrl(input.slug, localDevDomain);
  return `# Dev URL setup (\`${url}\`)

This project ships with the **hatchkit local-dev** integration: when you run
\`pnpm dev\`, the dev server is reachable from any Tailscale peer (phone,
tablet, other laptop) at:

\`\`\`
${url}
\`\`\`

Caddy on your host terminates TLS with a real Cloudflare-issued wildcard
cert, and tailscale serve forwards inbound port-443 traffic from the
tailnet to Caddy. No per-project DNS work, no port juggling, no
framework \`base\` / \`basePath\` config.

## One-time host setup

Do this **once per machine**, not per project. New hatchkit projects opt in by
default, so after the host is wired they just work.

\`\`\`
hatchkit dev-setup init --domain ${localDevDomain}
\`\`\`

### 1. Cloudflare DNS — auto-managed

\`hatchkit dev-setup init\` creates a DNS-only A record:

\`\`\`
${wildcard}   A   <your-tailnet-ip>   (DNS-only, TTL 60)
\`\`\`

It uses your hatchkit DNS token (or the \`caddy-dev/cloudflare-acme\`
keychain entry as a fallback) — the same token Caddy already needs for
DNS-01 ACME. Required permissions: \`Zone:DNS:Edit\` + \`Zone:Zone:Read\`
on the parent zone.

**Why a direct A record instead of a CNAME to ${tailnetHostname}?**
A CNAME to a \`.ts.net\` name only resolves when each peer has
Tailscale's MagicDNS resolver in front of its public DNS. iOS's stub
resolver caches NXDOMAIN for the intermediate lookup, so phone requests
silently fail. Pointing the wildcard at the laptop's tailnet IP makes
the resolution a single hop — tailnet peers reach the laptop, anyone
else gets a useless 100.x address (intended).

If you're using a non-Cloudflare DNS provider, add the record yourself:

\`\`\`
${wildcard}   A   <your-tailnet-ip>   (DNS-only)
\`\`\`

### 2. Cloudflare API token

Caddy needs a Cloudflare token to fetch the wildcard cert via DNS-01
ACME. \`hatchkit config add dns\` already prompts for one — if you ran
\`hatchkit setup\`, you've got it. Otherwise:

\`\`\`
hatchkit config add dns
\`\`\`

Permissions: \`Zone:DNS:Edit\` + \`Zone:Zone:Read\` scoped to
\`${localDevDomain}\`. For the cleanest setup, keep the token in Keychain:

\`\`\`
security add-generic-password -s caddy-dev -a cloudflare-acme -w '<token>' -U
\`\`\`

When that keychain entry exists, \`dev-setup init\` writes a tiny Caddy
wrapper that reads the token at startup, so the launchd plist never stores
the token in plaintext. Without the keychain entry, hatchkit falls back to
embedding the DNS token from \`hatchkit config add dns\` in the plist.

### 3. Caddy with the Cloudflare DNS plugin

\`\`\`
brew install caddy
caddy list-modules | grep cloudflare
\`\`\`

If \`dns.providers.cloudflare\` isn't in the module list, rebuild with
xcaddy:

\`\`\`
go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest
xcaddy build --with github.com/caddy-dns/cloudflare
\`\`\`

### 4. Wire it all up

\`\`\`
hatchkit dev-setup init
\`\`\`

This writes \`~/.config/dev/Caddyfile\`, writes/loads a launchd job that runs
Caddy on a free port (default 9443, auto-bumps if taken), registers
\`tailscale serve --tcp=443 → localhost:<caddyPort>\`, and upserts the
\`${wildcard}\` DNS-only A record when Cloudflare credentials are
available. Idempotent — safe to re-run.

### 5. Verify

\`\`\`
hatchkit doctor
\`\`\`

Look for the **Local-dev** rows. They should be green:

- Tailscale daemon
- Caddy installed
- Caddy cloudflare plugin
- Cloudflare ACME token in keychain, or Cloudflare API token in plist
- Caddy launchd job
- DNS A record
- Tailscale serve bridge

## Per-project bits

This project's slug is **\`${input.slug}\`**, recorded in
\`.hatchkit.json\` under \`localDev.slug\`. When \`pnpm dev\` starts, the
hatchkit dev plugin:

1. Reads the slug + the live dev port from the running server.
2. Writes/updates \`~/.config/dev/projects/${input.slug}.caddy\` pointing at
   that port. Caddy's \`--watch\` picks it up without a restart.
3. Probes \`tailscale serve status\` for the TCP=443 bridge.
4. Prints a banner:

\`\`\`
➜  Local:     http://localhost:<port>/
➜  Tailscale: ${url}
\`\`\`

\`HATCHKIT_LOCAL_DEV=0\` in the environment disables the plugin entirely;
the dev server falls back to its default banner.

## Mobile/devices

For browser testing on a phone or tablet, install Tailscale on the device,
sign in to the same tailnet, and open:

\`\`\`
${url}
\`\`\`

For the native Capacitor loop, the scaffolded \`pnpm dev:ios\` and
\`pnpm dev:android\` scripts run the WebView against \`CAP_DEV_URL\`.
The iOS script targets the Simulator; the Android script targets an emulator
or attached device. Simulators/emulators use local host routes automatically.
Android physical devices auto-pick this Tailscale URL when \`.hatchkit.json\`
has \`localDev.slug\`; otherwise Android devices can use either:

\`\`\`
LAN_IP=<your-lan-ip> pnpm dev:android
\`\`\`

or, when the device is on Tailscale and this host setup is green:

\`\`\`
CAP_DEV_URL=${url} pnpm dev:android
\`\`\`

For a real iPhone, set \`CAP_DEV_URL=${url}\`, run \`npx cap sync ios\`,
then launch from Xcode via \`npx cap open ios\`.

## Cleanup

If you tear down this project:

\`\`\`
hatchkit destroy
\`\`\`

…also removes \`~/.config/dev/projects/${input.slug}.caddy\`. Other projects'
fragments stay put.
`;
}

// ---------------------------------------------------------------------------
// `hatchkit dev-setup` CLI entry — thin wrapper around the init runner.
// ---------------------------------------------------------------------------

export async function runDevSetupCli(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "enable") {
    await runDevSetupEnableCli(args.slice(1));
    return;
  }
  if (sub === "disable") {
    await runDevSetupDisableCli(args.slice(1));
    return;
  }
  if (sub === "init") {
    const force = args.includes("--force");
    const domainFlagIdx = args.findIndex((a) => a === "--domain" || a.startsWith("--domain="));
    const rawDomain =
      domainFlagIdx === -1
        ? undefined
        : args[domainFlagIdx].includes("=")
          ? args[domainFlagIdx].slice("--domain=".length)
          : args[domainFlagIdx + 1];
    let localDevDomain = rawDomain ? normaliseLocalDevDomain(rawDomain) : undefined;
    if (rawDomain && !localDevDomain) {
      console.log("Usage: --domain <local-dev-domain> (for example: local.example.com)");
      process.exit(1);
    }
    if (!localDevDomain) {
      const { resolve } = await import("node:path");
      const { readManifest } = await import("./scaffold/manifest.js");
      const manifest = readManifest(resolve("."));
      localDevDomain =
        normaliseLocalDevDomain(manifest?.localDev?.domain) ??
        localDevDomainFromProjectDomain(manifest?.domain) ??
        undefined;
    }
    const domainSafetyIssue = localDevDomainSafetyIssue(localDevDomain ?? LOCAL_DEV_DOMAIN);
    if (domainSafetyIssue) {
      const chalk = (await import("chalk")).default;
      console.log(chalk.red(`  ${domainSafetyIssue}`));
      process.exit(1);
    }
    // --caddy-token-keychain <service>:<account>   → wrapper mode with custom pair
    // --no-caddy-token-keychain                    → force inline-env mode
    // (default)                                     → auto-detect default pair
    let caddyTokenKeychain: DevSetupInitOptions["caddyTokenKeychain"];
    if (args.includes("--no-caddy-token-keychain")) {
      caddyTokenKeychain = false;
    } else {
      const flagIdx = args.findIndex(
        (a) => a === "--caddy-token-keychain" || a.startsWith("--caddy-token-keychain="),
      );
      if (flagIdx !== -1) {
        const raw = args[flagIdx].includes("=")
          ? args[flagIdx].slice("--caddy-token-keychain=".length)
          : args[flagIdx + 1];
        const [service, account] = (raw ?? "").split(":");
        if (!service || !account) {
          console.log("Usage: --caddy-token-keychain <service>:<account>");
          process.exit(1);
        }
        caddyTokenKeychain = { service, account };
      }
    }
    const result = await runDevSetupInit({ force, caddyTokenKeychain, localDevDomain });
    const chalk = (await import("chalk")).default;
    console.log(chalk.bold("\n  hatchkit dev-setup init\n"));
    console.log(`  Local-dev domain:     ${chalk.cyan(result.localDevDomain)}`);
    console.log(`  Caddy port:           ${chalk.cyan(result.caddyPort)}`);
    console.log(
      `  Caddyfile:            ${result.wroteCaddyfile ? chalk.green("wrote") : chalk.dim("unchanged")} ${chalk.dim(CADDYFILE_PATH)}`,
    );
    if (result.wroteWrapper) {
      console.log(
        `  caddy wrapper:        ${chalk.green("wrote")} ${chalk.dim(CADDY_WRAPPER_PATH)}`,
      );
    }
    console.log(
      `  launchd plist:        ${result.wrotePlist ? chalk.green("wrote") : chalk.dim("unchanged")} ${chalk.dim(LAUNCHD_PLIST_PATH)}`,
    );
    console.log(
      `  launchctl load:       ${result.loadedLaunchd ? chalk.green("ok") : chalk.dim("skipped")}`,
    );
    console.log(
      `  tailscale serve TCP:  ${result.registeredServe ? chalk.green(`tcp:443 → localhost:${result.caddyPort}`) : chalk.yellow("not registered")}`,
    );
    if (result.dnsRecord !== null) {
      const dnsLabel =
        result.dnsRecord === "created" || result.dnsRecord === "updated"
          ? chalk.green(result.dnsRecord)
          : result.dnsRecord === "unchanged"
            ? chalk.dim("unchanged")
            : result.dnsRecord === "skipped-existing"
              ? chalk.yellow("skipped (existing wildcard)")
              : result.dnsRecord === "failed"
                ? chalk.red("failed")
                : chalk.dim("skipped (no CF token)");
      console.log(
        `  DNS A record:         ${dnsLabel}  ${chalk.dim(`*.${result.localDevDomain}`)}`,
      );
    }
    if (result.notes.length > 0) {
      console.log(chalk.bold("\n  Notes:"));
      for (const n of result.notes) console.log(`    ${chalk.yellow("·")} ${n}`);
    }
    console.log(
      `\n  Verify with: ${chalk.cyan("hatchkit doctor")} (look for the Local-dev / … checks).\n`,
    );
    return;
  }
  if (sub === "status") {
    const checks = await checkLocalDevHost();
    if (checks.length === 0) {
      console.log("Feature not active. Run `hatchkit dev-setup init` once to enable it.");
      return;
    }
    const chalk = (await import("chalk")).default;
    for (const r of checks) {
      const icon =
        r.status === "ok"
          ? chalk.green("✓")
          : r.status === "fail"
            ? chalk.red("✗")
            : chalk.dim("·");
      console.log(`  ${icon} ${r.name}${r.detail ? chalk.dim(` — ${r.detail}`) : ""}`);
    }
    return;
  }
  console.log("Usage: hatchkit dev-setup <init|status|enable|disable> [flags]");
  console.log(
    "\n  init [--domain]  Auto-write ~/.config/dev/Caddyfile, launchd plist, register tailscale TCP bridge.",
  );
  console.log("  status           Run the same checks doctor runs, but only the Local-dev rows.");
  console.log(
    "  enable [--slug]  Wire the project in cwd for Tailscale dev URLs (writes Caddy fragment,",
  );
  console.log("                   docs/dev-setup.md, patches next.config, adds plugin dep).");
  console.log(
    "  disable          Reverse `enable` for the project in cwd. Leaves next.config + dep in place.",
  );
}

async function runDevSetupEnableCli(args: string[]): Promise<void> {
  const chalk = (await import("chalk")).default;
  const { resolve } = await import("node:path");
  const { readManifest, writeManifest } = await import("./scaffold/manifest.js");
  const { sanitiseSlug } = await import("@hatchkit/dev-shared");
  const { input, confirm: askConfirm } = await import("@inquirer/prompts");

  const slugFlagIdx = args.findIndex((a) => a === "--slug" || a.startsWith("--slug="));
  const slugFlag =
    slugFlagIdx === -1
      ? undefined
      : args[slugFlagIdx].includes("=")
        ? args[slugFlagIdx].slice("--slug=".length)
        : args[slugFlagIdx + 1];
  const portFlagIdx = args.findIndex((a) => a === "--port" || a.startsWith("--port="));
  const portFlag =
    portFlagIdx === -1
      ? undefined
      : args[portFlagIdx].includes("=")
        ? args[portFlagIdx].slice("--port=".length)
        : args[portFlagIdx + 1];
  const projectDirFlagIdx = args.findIndex(
    (a) => a === "--project-dir" || a.startsWith("--project-dir="),
  );
  const projectDirFlag =
    projectDirFlagIdx === -1
      ? undefined
      : args[projectDirFlagIdx].includes("=")
        ? args[projectDirFlagIdx].slice("--project-dir=".length)
        : args[projectDirFlagIdx + 1];
  const domainFlagIdx = args.findIndex((a) => a === "--domain" || a.startsWith("--domain="));
  const rawLocalDevDomain =
    domainFlagIdx === -1
      ? undefined
      : args[domainFlagIdx].includes("=")
        ? args[domainFlagIdx].slice("--domain=".length)
        : args[domainFlagIdx + 1];

  const projectDir = projectDirFlag ? resolve(projectDirFlag) : resolve(".");

  const manifest = readManifest(projectDir);
  if (!manifest) {
    console.log(chalk.red(`  No .hatchkit.json found at ${projectDir}.`));
    console.log(
      chalk.dim(`  Run from a hatchkit-managed project root, or pass --project-dir <path>.`),
    );
    process.exit(1);
  }
  const localDevDomain =
    normaliseLocalDevDomain(rawLocalDevDomain) ??
    normaliseLocalDevDomain(manifest.localDev?.domain) ??
    localDevDomainFromProjectDomain(manifest.domain) ??
    LOCAL_DEV_DOMAIN;
  if (rawLocalDevDomain && !normaliseLocalDevDomain(rawLocalDevDomain)) {
    console.log(chalk.red(`  --domain ${rawLocalDevDomain} is not a valid local-dev domain.`));
    process.exit(1);
  }
  const domainSafetyIssue = localDevDomainSafetyIssue(localDevDomain);
  if (domainSafetyIssue) {
    console.log(chalk.red(`  ${domainSafetyIssue}`));
    process.exit(1);
  }

  // Slug: flag → manifest.localDev → manifest.name → prompt.
  let slug = slugFlag ? sanitiseSlug(slugFlag) : manifest.localDev?.slug;
  if (!slug) {
    const defaultSlug = sanitiseSlug(manifest.name);
    slug = await input({
      message: `Slug for this project (${localDevUrl("<slug>", localDevDomain)}):`,
      default: defaultSlug,
      validate: (v) => {
        const s = sanitiseSlug(v);
        if (s.length === 0) return "Slug must contain at least one [a-z0-9-] character.";
        if (s !== v) return `Use only [a-z0-9-]. Did you mean "${s}"?`;
        return true;
      },
    });
    slug = sanitiseSlug(slug);
  }

  // Port: flag → manifest.ports.client (preferred) → manifest.ports.server.
  let devPort: number;
  if (portFlag) {
    devPort = Number(portFlag);
    if (!Number.isFinite(devPort) || devPort <= 0) {
      console.log(chalk.red(`  --port ${portFlag} is not a valid port number.`));
      process.exit(1);
    }
  } else {
    devPort = manifest.surfaces === "server-only" ? manifest.ports.server : manifest.ports.client;
  }

  console.log(chalk.bold(`\n  Enabling local-dev for ${chalk.cyan(manifest.name)}\n`));
  console.log(`  Slug:      ${chalk.cyan(slug)}`);
  console.log(`  Domain:    ${chalk.cyan(localDevDomain)}`);
  console.log(`  Dev port:  ${chalk.cyan(devPort)}`);
  console.log(`  URL:       ${chalk.cyan(localDevUrl(slug, localDevDomain))}`);
  const skipConfirm = args.includes("--yes") || args.includes("-y");
  if (!skipConfirm) {
    const ok = await askConfirm({ message: "Proceed?", default: true });
    if (!ok) {
      console.log(chalk.dim("  Aborted."));
      return;
    }
  }

  const result = await enableProjectLocalDev({ projectDir, slug, localDevDomain, devPort });

  // Persist the slug in the manifest so subsequent runs (plugin, doctor,
  // future `dev-setup disable`) all converge on the same identity.
  if (manifest.localDev?.slug !== slug || manifest.localDev?.domain !== localDevDomain) {
    const updated = { ...manifest, localDev: { slug, domain: localDevDomain } };
    writeManifest(projectDir, updated);
  }

  console.log(`\n  Framework:       ${chalk.cyan(result.framework)}`);
  console.log(`  Caddy fragment:  ${chalk.green(result.wroteFragment)}`);
  console.log(
    `  docs/dev-setup.md: ${result.wroteDocs ? chalk.green("wrote") : chalk.dim("unchanged")}`,
  );
  const configLabel = result.framework === "vite" ? "vite.config:   " : "next.config:   ";
  console.log(`  ${configLabel}  ${formatPatch(result.patchedConfig)}`);
  console.log(`  package.json:    ${formatPatch(result.patchedPackageJson)}`);
  if (result.patchedPackageJson === "added") {
    console.log(
      chalk.dim(`\n  Don't forget: run \`pnpm install\` in ${projectDir} to pull the plugin in.`),
    );
  }
  if (result.patchedConfig === "manual-wire-required") {
    // Vite path: too much shape variance for safe auto-patching. Tell
    // the user exactly what to paste so they don't have to read the
    // generated `docs/dev-setup.md` to figure it out.
    console.log(chalk.bold("\n  Vite config wiring (paste into your vite.config):"));
    console.log(chalk.dim('    import { localDev } from "@hatchkit/dev-plugin-vite";'));
    console.log(chalk.dim("    // …"));
    console.log(chalk.dim("    plugins: ["));
    console.log(chalk.dim("      // …your existing plugins"));
    console.log(
      chalk.dim(`      localDev({ slug: "${slug}", localDevDomain: "${localDevDomain}" }),`),
    );
    console.log(chalk.dim("    ],"));
    console.log(
      chalk.dim(`    server: { allowedHosts: [".${localDevDomain}", ".ts.net", ".local"] },`),
    );
  }
  if (result.patchedConfig === "unsupported-shape") {
    console.log(chalk.bold("\n  Next config wiring (CJS / non-standard shape):"));
    console.log(chalk.dim('    const { withLocalDev } = require("@hatchkit/dev-plugin-next");'));
    console.log(
      chalk.dim(
        `    module.exports = withLocalDev(nextConfig, { slug: "${slug}", localDevDomain: "${localDevDomain}" });`,
      ),
    );
  }
  console.log(
    chalk.dim(`\n  Verify with: \`hatchkit doctor\` (or \`hatchkit dev-setup status\`).`),
  );
}

async function runDevSetupDisableCli(args: string[]): Promise<void> {
  const chalk = (await import("chalk")).default;
  const { resolve } = await import("node:path");
  const { readManifest, writeManifest } = await import("./scaffold/manifest.js");

  const projectDirFlagIdx = args.findIndex(
    (a) => a === "--project-dir" || a.startsWith("--project-dir="),
  );
  const projectDirFlag =
    projectDirFlagIdx === -1
      ? undefined
      : args[projectDirFlagIdx].includes("=")
        ? args[projectDirFlagIdx].slice("--project-dir=".length)
        : args[projectDirFlagIdx + 1];

  const projectDir = projectDirFlag ? resolve(projectDirFlag) : resolve(".");
  const manifest = readManifest(projectDir);
  if (!manifest) {
    console.log(chalk.red(`  No .hatchkit.json found at ${projectDir}.`));
    process.exit(1);
  }
  const slug = manifest.localDev?.slug;
  if (!slug) {
    console.log(
      chalk.dim(`  ${manifest.name} has no local-dev integration recorded. Nothing to disable.`),
    );
    return;
  }

  const result = disableProjectLocalDev(projectDir, slug);
  // Drop the manifest field so future doctor / plugin runs don't think
  // the integration is still active.
  const { localDev: _, ...rest } = manifest;
  writeManifest(projectDir, rest);

  console.log(chalk.bold(`\n  Disabled local-dev for ${chalk.cyan(manifest.name)}\n`));
  console.log(
    `  Caddy fragment:    ${result.removedFragment ? chalk.green("removed") : chalk.dim("not present")}`,
  );
  console.log(
    `  docs/dev-setup.md: ${result.removedDocs ? chalk.green("removed") : chalk.dim("not present")}`,
  );
  console.log(
    chalk.dim(
      "\n  Left in place: next.config wrapper + package.json dep. Both inert without the fragment;",
    ),
  );
  console.log(chalk.dim("  remove by hand if you don't expect to re-enable later.\n"));
}

function formatPatch(
  state:
    | "added"
    | "already-wrapped"
    | "already-present"
    | "no-file"
    | "unsupported-shape"
    | "manual-wire-required"
    | "skipped",
): string {
  // chalk import is async on this path; defer to ANSI codes to keep this
  // helper sync. Inputs are bounded so this stays readable.
  const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
  const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  switch (state) {
    case "added":
      return green("patched");
    case "already-wrapped":
    case "already-present":
      return dim("already present");
    case "no-file":
      return dim("no file to patch");
    case "unsupported-shape":
      return yellow("unsupported shape — wrap manually");
    case "manual-wire-required":
      return yellow("manual wire required — see instructions below");
    case "skipped":
      return dim("skipped");
  }
}
