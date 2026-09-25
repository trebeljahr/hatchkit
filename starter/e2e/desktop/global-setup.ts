import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { API_ORIGIN, API_PORT, CLIENT_HEADER, EXPORT_DIR, HARNESS_UA, MAIN_JS, REPO_ROOT } from "./support";

/*
 * Servers and build for the desktop harness: a database of its own, a
 * production-mode API on a high port, and nothing shared with a developer's
 * running stack. Returns the teardown, which stops only what it started.
 */

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

async function portInUse(port: number): Promise<boolean> {
  return new Promise((done) => {
    const server = createServer();
    server.once("error", () => done(true));
    server.listen(port, "127.0.0.1", () => server.close(() => done(false)));
  });
}

async function waitFor(check: () => Promise<boolean>, what: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
}

function stop(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.pid === undefined) return Promise.resolve();
  return new Promise((done) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 10_000);
    child.once("exit", () => {
      clearTimeout(timer);
      done();
    });
    child.kill("SIGTERM");
  });
}

/**
 * A MongoDB for this harness alone, in the order that costs the least:
 *
 *   1. MONGODB_URI, which CI sets.
 *   2. A `mongod` of our own on a free port, with a throwaway data directory.
 *   3. The MongoDB the repository's own tooling already runs — the browser
 *      e2e container on 27018, then `pnpm dev:infra` on 27017 — under a
 *      database name nothing else writes to.
 *
 * Returns the URI and what has to be stopped afterwards.
 */
async function startDatabase(): Promise<{ uri: string; mongod: ChildProcess | null; dbPath: string | null }> {
  if (process.env.MONGODB_URI) return { uri: process.env.MONGODB_URI, mongod: null, dbPath: null };

  const hasMongod = spawnSync("mongod", ["--version"], { stdio: "ignore" }).status === 0;
  if (hasMongod) {
    const port = await freePort();
    const dbPath = mkdtempSync(join(tmpdir(), "desktop-e2e-db-"));
    const mongod = spawn("mongod", ["--port", String(port), "--bind_ip", "127.0.0.1", "--dbpath", dbPath, "--quiet"], {
      stdio: "ignore",
    });
    mongod.on("error", (err) => console.error("[desktop-e2e] mongod failed to start:", err.message));
    await waitFor(() => portInUse(port), `mongod on ${port}`, 30_000);
    return { uri: `mongodb://127.0.0.1:${port}/starter-desktop-e2e`, mongod, dbPath };
  }

  for (const port of [27018, 27017]) {
    if (await portInUse(port)) {
      console.log(`[desktop-e2e] using the MongoDB already listening on ${port}`);
      return { uri: `mongodb://127.0.0.1:${port}/starter-desktop-e2e`, mongod: null, dbPath: null };
    }
  }
  throw new Error(
    "No MongoDB for the desktop harness. Start one with `pnpm dev:infra`, install `mongod`, or set MONGODB_URI.",
  );
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  // 1. The Electron binary. Electron's package has no install script, so a
  //    fresh `pnpm install` leaves node_modules/electron without one and the
  //    first launch would download it mid-run.
  const ensure = spawnSync(process.execPath, [join(REPO_ROOT, "scripts/ensure-electron.mjs")], {
    stdio: "inherit",
  });
  if (ensure.status !== 0) throw new Error("scripts/ensure-electron.mjs failed");

  // 2. The export, built against this harness's API — reused when it already
  //    is. NEXT_PUBLIC_API_URL is baked into the export at build time, so an
  //    export built for another origin would test the wrong server.
  //    DESKTOP_E2E_REBUILD=1 forces the rebuild.
  const target = join(EXPORT_DIR, ".build-target.json");
  const builtFor = existsSync(target)
    ? (JSON.parse(readFileSync(target, "utf8")) as { apiUrl?: string }).apiUrl
    : null;
  if (builtFor !== API_ORIGIN || !existsSync(MAIN_JS) || process.env.DESKTOP_E2E_REBUILD === "1") {
    console.log(`[desktop-e2e] building the desktop export against ${API_ORIGIN}`);
    const build = spawnSync(process.execPath, [join(REPO_ROOT, "scripts/build-desktop.mjs")], {
      cwd: REPO_ROOT,
      stdio: "inherit",
      env: { ...process.env, NEXT_PUBLIC_API_URL: API_ORIGIN },
    });
    if (build.status !== 0) throw new Error("scripts/build-desktop.mjs failed");
  } else {
    // The export is reused, but main and preload are always re-bundled: they
    // take a second, and a reused electron/dist runs every spec against the
    // main process as it was before the change under test.
    const bundle = spawnSync(process.execPath, [join(REPO_ROOT, "scripts/build-desktop.mjs"), "--electron-only"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    if (bundle.status !== 0) throw new Error("scripts/build-desktop.mjs --electron-only failed");
  }

  // 3. The database.
  const { uri: mongoUri, mongod, dbPath } = await startDatabase();

  // 4. The API, production-shaped, trusting the app's origin. Every request it
  //    receives is logged (record-requests.mjs), so a spec can prove from the
  //    server side what the app sent — in particular that no Cookie arrived.
  if (await portInUse(API_PORT)) {
    throw new Error(
      `Port ${API_PORT} is taken. Set DESKTOP_E2E_API_PORT to a free port (the export is rebuilt for it).`,
    );
  }
  const logDir = mkdtempSync(join(tmpdir(), "desktop-e2e-requests-"));
  const requestLog = join(logDir, "api.jsonl");
  writeFileSync(requestLog, "");

  const api = spawn(
    process.execPath,
    ["--import", "tsx", "--import", join(__dirname, "record-requests.mjs"), "src/index.ts"],
    {
      cwd: join(REPO_ROOT, "packages/server"),
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(API_PORT),
        MONGODB_URI: mongoUri,
        // No Redis: nothing under test needs it, and an absent URL is a
        // supported configuration (packages/server/src/db/redis.ts).
        REDIS_URL: "",
        BETTER_AUTH_SECRET: "desktop-e2e-secret-desktop-e2e-secret",
        BETTER_AUTH_URL: API_ORIGIN,
        // A closed port: nothing in the desktop app follows a web frontend URL.
        FRONTEND_URL: "http://127.0.0.1:1",
        TRUSTED_ORIGINS: "app://-",
        DESKTOP_E2E_REQUEST_LOG: requestLog,
        DESKTOP_E2E_CLIENT_HEADER: CLIENT_HEADER,
        DESKTOP_E2E_HARNESS_UA: HARNESS_UA,
      },
    },
  );
  await waitFor(async () => (await fetch(`${API_ORIGIN}/api/health`)).ok, `the API on ${API_ORIGIN}`, 60_000);

  // Read by the specs (support.ts); workers inherit this process's env.
  process.env.DESKTOP_E2E_REQUEST_LOG = requestLog;
  process.env.DESKTOP_E2E_MONGODB_URI = mongoUri;

  return async () => {
    await stop(api);
    await stop(mongod);
    if (dbPath) rmSync(dbPath, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  };
}
