/**
 * Opt-in smoke of an already-built, locally cached Next standalone client image.
 * Absent from test-support/suite.json. Requires local Docker and loopback access.
 *
 * HATCHKIT_ROLLING_TEST_CLIENT_IMAGE=my-client:sha pnpm --filter hatchkit exec node scripts/test.mjs test-rolling-client-image.ts
 * Optional: HATCHKIT_ROLLING_TEST_CLIENT_REPORT=/tmp/client-image-result.json
 *
 * No pull, mount, dotenv read, or runtime env injection. In particular, neither
 * HOSTNAME nor PORT is supplied: Docker's defaults previously hid a broken
 * standalone bind address when a smoke test set HOSTNAME=0.0.0.0 itself.
 * This proves image startup, loopback/proxy reachability and PID1 drain only.
 * Browser authentication, Redis fanout and Coolify rollout have separate tests.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const image = process.env.HATCHKIT_ROLLING_TEST_CLIENT_IMAGE;
assert.ok(image, "Set HATCHKIT_ROLLING_TEST_CLIENT_IMAGE to a locally built client image.");
const reportPath = resolve(
  process.env.HATCHKIT_ROLLING_TEST_CLIENT_REPORT ||
    join(tmpdir(), "hatchkit-client-image-result.json"),
);
const container = `hatchkit-client-image-${randomUUID()}`;
const deadline = new AbortController();
const deadlineTimer = setTimeout(
  () => deadline.abort(new Error("Image smoke exceeded 75 seconds")),
  75_000,
);
process.once("SIGINT", () => deadline.abort(new Error("Image smoke interrupted")));
process.once("SIGTERM", () => deadline.abort(new Error("Image smoke terminated")));
const report: Record<string, unknown> = {
  scope: "actual Next standalone image startup and PID1 drain",
  passed: false,
};
let owned = false;

// Explicit callback: the fixture credential runner wraps execFile, so its
// promisify custom result object is not preserved.
function docker(args: string[], timeout = 10_000, cleanup = false): Promise<string> {
  return new Promise((resolveResult, reject) => {
    execFile(
      "docker",
      args,
      {
        encoding: "utf8",
        timeout,
        maxBuffer: 128 * 1024,
        ...(cleanup ? {} : { signal: deadline.signal }),
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`docker ${args[0]} failed: ${stderr.trim() || error.message}`));
        else resolveResult(stdout.trim());
      },
    );
  });
}

async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const port = randomInt(49_152, 65_536);
    const server = createServer();
    const available = await new Promise<boolean>((resolveResult) => {
      server.once("error", () => resolveResult(false));
      server.listen(port, "127.0.0.1", () => server.close(() => resolveResult(true)));
    });
    if (available) return port;
  }
  throw new Error("Could not reserve a high loopback port after three attempts");
}

const sleep = (ms: number) => new Promise<void>((resolveResult) => setTimeout(resolveResult, ms));

try {
  report.imageId = await docker(["image", "inspect", "--format", "{{.Id}}", image]);
  // Inspect only non-secret runtime fields; never print the image's env array.
  const rows = JSON.parse(
    await docker(["image", "inspect", "--format", "{{json .Config.Env}}", image]),
  ) as string[];
  const readEnv = (name: string) =>
    rows.find((row) => row.startsWith(`${name}=`))?.slice(name.length + 1);
  const port = Number(readEnv("PORT"));
  const drainSeconds = Number(readEnv("SHUTDOWN_DRAIN_SECONDS"));
  assert.ok(
    Number.isInteger(port) && port > 0 && port <= 65_535,
    "Image must define its serving PORT",
  );
  assert.ok(
    drainSeconds > 0 && drainSeconds <= 20,
    "Image must define a bounded positive shutdown drain",
  );
  report.imagePort = port;
  report.imageHostname = readEnv("HOSTNAME") ?? null;
  report.drainSeconds = drainSeconds;

  let publishedPort = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    publishedPort = await freePort();
    owned = true;
    try {
      await docker([
        "run",
        "--detach",
        "--pull=never",
        "--name",
        container,
        "--cpus=1",
        "--memory=512m",
        "--publish",
        `127.0.0.1:${publishedPort}:${port}`,
        image,
      ]);
      break;
    } catch (error) {
      await docker(["rm", "--force", "--volumes", container], 10_000, true).catch(() => {});
      owned = false;
      if (attempt === 2 || !/port is already allocated|address already in use/i.test(String(error)))
        throw error;
    }
  }

  const status = async (path = "/") =>
    Number(
      await docker(
        [
          "exec",
          container,
          "node",
          "-e",
          `fetch(${JSON.stringify(`http://127.0.0.1:${port}${path}`)}, {signal:AbortSignal.timeout(2000)}).then(r=>console.log(r.status)).catch(()=>console.log(0))`,
        ],
        4_000,
      ),
    );
  const readyDeadline = Date.now() + 20_000;
  let ready = false;
  let loopbackStatus = 0;
  while (Date.now() < readyDeadline && !deadline.signal.aborted) {
    loopbackStatus = await status();
    if (loopbackStatus === 200) {
      ready = true;
      break;
    }
    await sleep(200);
  }
  report.loopbackStatus = loopbackStatus;
  report.runningHostname = await docker([
    "exec",
    container,
    "node",
    "-e",
    "console.log(process.env.HOSTNAME ?? '')",
  ]);
  const external = await fetch(`http://127.0.0.1:${publishedPort}/`, {
    signal: AbortSignal.timeout(4_000),
  });
  report.publishedStatus = external.status;
  await external.arrayBuffer();
  assert.ok(
    ready,
    "Client image never answered its loopback health probe without an injected HOSTNAME",
  );
  assert.equal(
    external.status,
    200,
    "The same image must answer traffic through Docker's published port",
  );
  assert.equal(await status("/version.json"), 200);

  const stoppedAt = Date.now();
  const stopped = docker(["stop", "--time", "30", container], 35_000);
  // Attach a rejection handler immediately while the in-drain assertions run.
  void stopped.catch(() => {});
  await sleep(500);
  assert.equal(await status(), 503, "SIGTERM must fail the loopback probe before exit");
  assert.equal(
    await status("/version.json"),
    200,
    "Normal traffic is served during drain",
  );
  await stopped;
  const stopMilliseconds = Date.now() - stoppedAt;
  const state = JSON.parse(await docker(["inspect", "--format", "{{json .State}}", container])) as {
    ExitCode: number;
    OOMKilled: boolean;
  };
  report.probeDuringDrain = 503;
  report.stopMilliseconds = stopMilliseconds;
  report.exitCode = state.ExitCode;
  assert.equal(state.OOMKilled, false);
  // Next's cleanup intentionally exits 143 for SIGTERM; the generic drain
  // fallback exits 0. A Docker timeout would SIGKILL the process (137).
  assert.ok(
    state.ExitCode === 0 || state.ExitCode === 143,
    `Unexpected shutdown status ${state.ExitCode}`,
  );
  assert.ok(stopMilliseconds >= drainSeconds * 1_000 - 250 && stopMilliseconds < 30_000);
  report.passed = true;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  clearTimeout(deadlineTimer);
  if (owned) await docker(["rm", "--force", "--volumes", container], 10_000, true);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}
