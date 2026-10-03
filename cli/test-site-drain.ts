/**
 * Hatchkit's own nginx image. The opt-in container test builds only its actual
 * runtime stage, using tiny static fixtures instead of rebuilding the docs.
 * HATCHKIT_TEST_SITE_DRAIN_DOCKER=1 pnpm --filter hatchkit exec node scripts/test.mjs test-site-drain.ts
 */
import assert from "node:assert/strict";
import { type ExecFileOptions, execFile } from "node:child_process";
import { randomInt } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

function exec(
  command: string,
  args: string[],
  options: ExecFileOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  // The isolated runner wraps execFile to block keychain subprocesses; use
  // its callback directly instead of relying on Node's custom promisifier.
  return new Promise((resolve, reject) => {
    execFile(command, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });
}
const repo = join(import.meta.dirname, "..");
const dockerfile = readFileSync(join(repo, "Dockerfile"), "utf8");
const nginx = readFileSync(join(repo, "docs/nginx.conf"), "utf8");
const entrypoint = join(repo, "docs/drain-entrypoint.sh");
const runtime = dockerfile.slice(dockerfile.indexOf("FROM nginx:alpine AS runner"));

assert.match(runtime, /^STOPSIGNAL SIGTERM$/m, "override nginx's inherited SIGQUIT");
assert.match(runtime, /^ENV SHUTDOWN_DRAIN_SECONDS=20$/m);
assert.match(runtime, /^HEALTHCHECK --interval=2s --timeout=5s --start-period=15s --retries=5/m);
assert.match(runtime, /ENTRYPOINT \["\/usr\/local\/bin\/drain-entrypoint"\]/);
await exec("sh", ["-n", entrypoint]);
await assert.rejects(
  exec("sh", [entrypoint], {
    env: { PATH: process.env.PATH, SHUTDOWN_DRAIN_SECONDS: "invalid" },
  }),
  /SHUTDOWN_DRAIN_SECONDS must be a non-negative integer/,
);
console.log("✓ site runtime signal, health timing and entrypoint validation");

if (process.env.HATCHKIT_TEST_SITE_DRAIN_DOCKER !== "1") {
  console.log("Container smoke skipped; set HATCHKIT_TEST_SITE_DRAIN_DOCKER=1 to run it.");
} else {
  const work = mkdtempSync(join(tmpdir(), "hatchkit-site-drain-"));
  const name = `hatchkit-site-drain-${process.pid}`;
  const tag = `${name}:test`;
  const abort = new AbortController();
  let stopping: Promise<string> | undefined;
  let reading: Promise<ArrayBuffer> | undefined;
  const docker = async (args: string[]): Promise<string> =>
    (await exec("docker", args, { timeout: 60_000, maxBuffer: 1024 * 1024 })).stdout.trim();
  try {
    mkdirSync(join(work, "docs"));
    mkdirSync(join(work, "site/docs/commands"), { recursive: true });
    copyFileSync(entrypoint, join(work, "docs/drain-entrypoint.sh"));
    // Rate limiting keeps an accepted response alive beyond the drain. All
    // production routes and the loopback readiness rule remain unchanged.
    writeFileSync(
      join(work, "docs/nginx.conf"),
      nginx.replace(
        "    location / {",
        "    location = /slow.bin { limit_rate 65536; }\n\n    location / {",
      ),
    );
    writeFileSync(join(work, "site/index.html"), "site-home");
    writeFileSync(join(work, "site/docs/commands.html"), "site-commands");
    writeFileSync(join(work, "site/404.html"), "site-not-found");
    const slowBytes = 384 * 1024;
    writeFileSync(join(work, "site/slow.bin"), Buffer.alloc(slowBytes, 120));
    writeFileSync(
      join(work, "Dockerfile"),
      runtime.replace(
        "COPY --from=build /app/out /usr/share/nginx/html",
        "COPY site /usr/share/nginx/html",
      ),
    );
    await docker(["build", "--pull=false", "--network=none", "-q", "-t", tag, work]);
    assert.equal(
      await docker(["image", "inspect", "--format", "{{.Config.StopSignal}}", tag]),
      "SIGTERM",
    );

    let port = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const listener = createServer();
      const candidate = randomInt(49152, 65536);
      try {
        await new Promise<void>((resolve, reject) => {
          listener.once("error", reject);
          listener.listen(candidate, "127.0.0.1", resolve);
        });
        await new Promise<void>((resolve, reject) =>
          listener.close((error) => (error ? reject(error) : resolve())),
        );
        port = candidate;
        break;
      } catch {
        /* try another unused high port */
      }
    }
    assert.ok(port, "could not reserve an unused high port after three attempts");
    await docker([
      "run",
      "-d",
      "--name",
      name,
      "--memory",
      "128m",
      "--cpus",
      "1",
      "--stop-timeout",
      "15",
      "-e",
      "SHUTDOWN_DRAIN_SECONDS=2",
      "-p",
      `127.0.0.1:${port}:80`,
      tag,
    ]);
    const origin = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        ready = (await fetch(origin, { signal: AbortSignal.timeout(500) })).status === 200;
      } catch {
        /* nginx may still be starting */
      }
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready, "nginx became ready");
    assert.equal(await (await fetch(`${origin}/docs/commands`)).text(), "site-commands");
    const redirect = await fetch(`${origin}/docs/commands/`, {
      redirect: "manual",
    });
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.get("location"), "/docs/commands");
    assert.equal((await fetch(`${origin}/missing`)).status, 404);

    const slow = await fetch(`${origin}/slow.bin`, {
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
    });
    assert.equal(slow.status, 200);
    reading = slow.arrayBuffer();
    void reading.catch(() => {}); // cleanup may abort before the main await
    const stoppedAt = Date.now();
    // Use Docker's configured signal, not docker kill --signal=TERM: a wrong
    // inherited StopSignal must fail this regression.
    stopping = docker(["stop", "--time", "15", name]);
    void stopping.catch(() => {});
    let withdrawn = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      const probe = await docker([
        "exec",
        name,
        "sh",
        "-c",
        "wget -S -O /dev/null http://127.0.0.1/ 2>&1 || true",
      ]);
      withdrawn = /503/.test(probe);
      if (withdrawn) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(withdrawn, "loopback readiness fails before nginx stops");
    assert.equal((await fetch(origin)).status, 200, "public homepage still serves during drain");
    assert.equal(
      (await fetch(`${origin}/docs/commands`)).status,
      200,
      "docs still serve during drain",
    );
    const bytes = await reading;
    assert.equal(bytes.byteLength, slowBytes, "accepted response completes after drain and QUIT");
    assert.ok(
      new Uint8Array(bytes).every((value) => value === 120),
      "response contents stay intact",
    );
    await stopping;
    assert.ok(Date.now() - stoppedAt >= 4000, "PID 1 waited beyond the two-second drain");
    assert.equal(await docker(["inspect", "--format", "{{.State.ExitCode}}", name]), "0");
    assert.equal(await docker(["inspect", "--format", "{{.State.OOMKilled}}", name]), "false");
    console.log(
      "✓ default docker stop withdraws readiness, preserves public routes and completes a slow response",
    );
  } finally {
    abort.abort();
    await docker(["rm", "-f", name]).catch(() => {});
    await stopping?.catch(() => {});
    await reading?.catch(() => {});
    await docker(["image", "rm", tag]).catch(() => {});
    rmSync(work, { recursive: true, force: true });
  }
}
