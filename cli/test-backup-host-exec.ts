// Every remote step of a cleanup settles in bounded time, whatever the
// child process or Coolify does.
//
// broadcastdock, 2026-10-19: `migrate-client --cleanup` deleted the Coolify
// app and then hung for good. `tailscale` on macOS is a shell wrapper that
// runs the app binary, which execs ssh, so ssh is a grandchild. The 60 s
// timer SIGTERMed only the wrapper; the orphaned ssh kept the stdio pipes
// open, so "close" never fired and the promise never settled.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupHostExec } from "./src/backups/provider.js";
import { getStore } from "./src/config.js";
import { CoolifyApi } from "./src/utils/coolify-api.js";

const dir = mkdtempSync(join(tmpdir(), "hatchkit-host-exec-"));
const pidFile = join(dir, "ssh.pid");

const ourPids = () =>
  existsSync(pidFile) ? readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number) : [];
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// A failing run must not leave the fake ssh processes behind.
process.on("exit", () => {
  for (const pid of ourPids()) if (alive(pid)) process.kill(pid, "SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});
const watchdog = setTimeout(() => {
  console.error("✗ a step never settled (the broadcastdock hang)");
  process.exit(1);
}, 30_000);

/** A fake `tailscale` on PATH: like /usr/local/bin/tailscale, a shell
 *  wrapper that runs (not execs) the real program. */
function fakeTailscale(ssh: string) {
  const bin = join(dir, "bin");
  rmSync(bin, { recursive: true, force: true });
  writeFileSync(join(dir, "ssh"), `#!/bin/sh\n${ssh}\n`, { mode: 0o755 });
  rmSync(pidFile, { force: true });
  mkdirSync(bin);
  writeFileSync(join(bin, "tailscale"), `#!/bin/sh\n"${join(dir, "ssh")}" "$@"\n`);
  chmodSync(join(bin, "tailscale"), 0o755);
}

async function settles(promise: Promise<string>) {
  const started = Date.now();
  const result = await promise.then(
    (stdout) => ({ ok: true as const, stdout }),
    (error: Error) => ({ ok: false as const, error }),
  );
  return { ...result, ms: Date.now() - started };
}

async function gone(pids: number[]) {
  for (let i = 0; i < 40 && pids.some(alive); i++) await new Promise((r) => setTimeout(r, 50));
  return !pids.some(alive);
}

try {
  getStore().set("providers.backups", {
    status: "configured",
    repositoryBase: "s3:https://account.eu.r2.cloudflarestorage.com/backups",
    host: { transport: "tailscale", target: "root@backup-host", serverUuid: "server-uuid" },
    autoRegister: false,
  });
  process.env.PATH = `${join(dir, "bin")}:${process.env.PATH}`;

  // 1. The broadcastdock hang: ssh is stuck, ignores SIGTERM, and holds
  //    the pipes. The call fails after its timeout and ssh is gone.
  const stuckSsh = `echo $$ >> "${pidFile}"\ntrap '' TERM\nexec sleep 60`;
  fakeTailscale(stuckSsh);
  {
    const run = await settles(backupHostExec("python3 - sources", "script", 300));
    assert.equal(run.ok, false);
    assert.match((run as { error: Error }).error.message, /timed out after 0\.3 s/);
    assert.ok(run.ms < 5_000, `settled after ${run.ms} ms`);
    assert.ok(await gone(ourPids()), "the stuck ssh grandchild was stopped");
  }

  // 2. The program exits 0 but leaves a process holding stdout open: the
  //    answer it printed is used, without waiting for the timeout.
  fakeTailscale(
    `printf '{"sources": []}\\n'\nsleep 60 &\necho $! >> "${pidFile}"\nsleep 0.2\nexit 0`,
  );
  {
    const run = await settles(backupHostExec("python3 - sources", "script", 20_000));
    assert.equal(run.ok, true, run.ok ? "" : (run as { error: Error }).error.message);
    assert.equal((run as { stdout: string }).stdout.trim(), '{"sources": []}');
    assert.ok(run.ms < 5_000, `settled after ${run.ms} ms`);
    assert.ok(await gone(ourPids()), "the leftover pipe holder was stopped");
  }

  // 3. Unchanged: a host error still reaches the caller.
  fakeTailscale(`printf '{"ok": false, "error": "runner broke"}\\n'\nexit 1`);
  {
    const run = await settles(backupHostExec("python3 - sources", "script", 20_000));
    assert.equal(run.ok, false);
    assert.equal((run as { error: Error }).error.message, "Backup host: runner broke");
  }

  // 4. Ctrl+C: the command runs in its own process group, which the
  //    terminal's SIGINT does not reach. hatchkit stops it, then dies of
  //    the signal as before.
  fakeTailscale(stuckSsh);
  {
    const cli = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        'import("./src/backups/provider.js").then((m) => m.backupHostExec("python3 - sources", "script", 60_000))',
      ],
      { stdio: "ignore" },
    );
    const exited = new Promise<NodeJS.Signals | null>((r) =>
      cli.on("exit", (_, signal) => r(signal)),
    );
    for (let i = 0; i < 200 && ourPids().length === 0; i++)
      await new Promise((r) => setTimeout(r, 50));
    assert.equal(ourPids().length, 1, "the fake ssh started");
    cli.kill("SIGINT");
    assert.equal(await exited, "SIGINT");
    assert.ok(await gone(ourPids()), "Ctrl+C stopped the ssh grandchild too");
  }

  // 5. Coolify: a DELETE that never answers fails within the client's
  //    timeout, and a poll that only times out never reads as "gone".
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/api/v1/applications/gone-app")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end('{"message":"Not found."}');
    }
    // Every other request is left unanswered.
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const coolify = new CoolifyApi({ url, token: "t", timeoutMs: 300 });
  const { waitForAppGone } = await import("./src/deploy/migrate-client.js");
  try {
    const started = Date.now();
    await assert.rejects(
      coolify.deleteApplicationKeepingVolumes("stuck-app"),
      /no answer within 0\.3 s/,
    );
    assert.ok(Date.now() - started < 5_000);

    const stuck = await waitForAppGone(() => coolify.getApplication("stuck-app"), {
      attempts: 2,
      intervalMs: 10,
    });
    assert.equal(stuck.gone, false, "a timeout is not proof the app is gone");
    assert.match(stuck.lastError ?? "", /no answer within/);

    const deleted = await waitForAppGone(() => coolify.getApplication("gone-app"), {
      attempts: 2,
      intervalMs: 10,
    });
    assert.deepEqual(deleted, { gone: true });
  } finally {
    server.closeAllConnections();
    server.close();
  }

  clearTimeout(watchdog);
  // Nothing may keep the process alive: a leftover pipe or timer here is
  // the hang in a smaller form.
  setTimeout(() => {
    console.error("✗ open handles kept the process alive after the last step");
    process.exit(1);
  }, 5_000).unref();
  console.log("✓ backup host commands and Coolify cleanup calls settle in bounded time");
} catch (error) {
  console.error(error);
  process.exit(1);
}
