/**
 * The shutdown drain — keeping a stopping container out of Traefik before
 * it stops serving. See "The last second" in src/deploy/image-runtime.ts.
 *
 * Coolify removes the old container of a rolling update with `docker stop`,
 * and Traefik routes to it until it has exited: without a drain every
 * deploy ends in ~1 s of 502s plus requests that hang into a 504. Each image
 * hatchkit ships therefore fails its health probe on SIGTERM, keeps serving
 * for SHUTDOWN_DRAIN_SECONDS, and only then closes.
 *
 * These pin:
 *   · drain.cjs, run for real under node: a loopback probe on `/` or
 *     `/api/health` gets 503 once SIGTERM arrives, any other request is
 *     served, the server's own SIGTERM handler runs only after the drain,
 *     and a server with no handler is closed and exits on its own;
 *   · SHUTDOWN_DRAIN_SECONDS unset leaves a process's SIGTERM alone;
 *   · drain-entrypoint delivers SIGTERM to the drained process past a
 *     parent that never passes it on. In an image that parent is
 *     `dotenvx run`, which does pass it on — and SIGKILLs the server 5 s
 *     later, mid-drain;
 *   · every image — the starter's two Dockerfiles and the four
 *     build-pipeline templates — bakes in the SAME drain as the CLI's
 *     health timing is built for, and loads/implements it; compose files,
 *     where a drain only delays the restart, turn it off;
 *   · the starter's copy of drain.cjs is the template's, byte for byte.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHUTDOWN_DRAIN_SECONDS } from "./src/deploy/image-runtime.js";
import { scaffoldBuildPipeline } from "./src/scaffold/build-pipeline.js";

const failures: string[] = [];

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`  ✗ ${label}: ${(err as Error).message}`);
    console.log(`  ✗ ${label}: ${(err as Error).message}`);
  }
}

const REPO = join(import.meta.dirname, "..");
const PRELOAD = join(import.meta.dirname, "src/templates/build-pipeline/drain.cjs");
const ENTRYPOINT = join(import.meta.dirname, "src/templates/build-pipeline/drain-entrypoint.sh");
const read = (rel: string) => readFileSync(join(REPO, rel), "utf-8");

// ---------------------------------------------------------------------------
// drain.cjs under a real node process
// ---------------------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), "hatchkit-drain-"));
const FIXTURE = join(work, "server.mjs");
// A server that prints its port, logs each SIGTERM its own handler sees,
// and (with APP_HANDLER) closes and exits 7 from that handler.
writeFileSync(
  FIXTURE,
  `import { createServer } from "node:http";
const server = createServer((req, res) => res.end("ok " + req.url));
server.listen(0, "127.0.0.1", () => console.log("port " + server.address().port));
if (process.env.APP_HANDLER) {
  process.once("SIGTERM", () => {
    console.log("app-shutdown");
    server.close(() => process.exit(7));
  });
}
`,
);

interface Running {
  child: ChildProcess;
  port: number;
  output: () => string;
  exited: Promise<number | null>;
}

function start(env: Record<string, string>, viaEntrypoint = false): Promise<Running> {
  const node = `"${process.execPath}" --require "${PRELOAD}" "${FIXTURE}"`;
  // Through the entrypoint, node runs under a `sh -c` that stays its
  // parent and never passes a signal on: only a SIGTERM delivered to node
  // itself can start the drain.
  const [cmd, args] = viaEntrypoint
    ? ["sh", [ENTRYPOINT, "sh", "-c", `${node}; exit $?`]]
    : [process.execPath, ["--require", PRELOAD, FIXTURE]];
  const child = spawn(cmd, args, {
    env: { PATH: process.env.PATH ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout?.on("data", (d) => {
    out += d;
  });
  child.stderr?.on("data", (d) => {
    out += d;
  });
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no port; output: ${out}`)), 5000);
    child.stdout?.on("data", () => {
      const m = out.match(/port (\d+)/);
      if (m) {
        clearTimeout(t);
        resolve({ child, port: Number(m[1]), output: () => out, exited });
      }
    });
  });
}

const status = async (port: number, path: string) =>
  (await fetch(`http://127.0.0.1:${port}${path}`)).status;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log("\nshutdown drain — drain.cjs");

await check(
  "SIGTERM fails the loopback probe, serves the rest, then runs the app's handler",
  async () => {
    const s = await start({ SHUTDOWN_DRAIN_SECONDS: "1", APP_HANDLER: "1" });
    try {
      assert.equal(await status(s.port, "/"), 200);
      assert.equal(await status(s.port, "/api/health"), 200);
      const sent = Date.now();
      s.child.kill("SIGTERM");
      await sleep(150);
      assert.equal(await status(s.port, "/"), 503, "probe on / while draining");
      assert.equal(await status(s.port, "/api/health"), 503, "probe on /api/health while draining");
      assert.equal(await status(s.port, "/?x=1"), 503, "query string doesn't dodge it");
      assert.equal(await status(s.port, "/page"), 200, "a real page is still served");
      assert.doesNotMatch(s.output(), /app-shutdown/, "the app's handler waits for the drain");
      const code = await s.exited;
      assert.ok(Date.now() - sent >= 1000, "exited only after the drain");
      assert.match(s.output(), /app-shutdown/);
      assert.equal(code, 7, "the app's own handler decided the exit");
    } finally {
      s.child.kill("SIGKILL");
    }
  },
);

await check(
  "with no handler of its own, the server is closed and the process exits 0",
  async () => {
    const s = await start({ SHUTDOWN_DRAIN_SECONDS: "0.5" });
    try {
      s.child.kill("SIGTERM");
      await sleep(100);
      assert.equal(await status(s.port, "/"), 503);
      assert.equal(await s.exited, 0);
    } finally {
      s.child.kill("SIGKILL");
    }
  },
);

await check("HEALTH_CHECK_PATH narrows the probe to the path Coolify uses", async () => {
  const s = await start({ SHUTDOWN_DRAIN_SECONDS: "0.5", HEALTH_CHECK_PATH: "/healthz" });
  try {
    s.child.kill("SIGTERM");
    await sleep(100);
    assert.equal(await status(s.port, "/healthz"), 503);
    assert.equal(await status(s.port, "/"), 200);
    await s.exited;
  } finally {
    s.child.kill("SIGKILL");
  }
});

await check("without SHUTDOWN_DRAIN_SECONDS the preload does nothing", async () => {
  const s = await start({ APP_HANDLER: "1" });
  try {
    const sent = Date.now();
    s.child.kill("SIGTERM");
    assert.equal(await s.exited, 7);
    assert.ok(Date.now() - sent < 1000, "the app's handler ran at once");
  } finally {
    s.child.kill("SIGKILL");
  }
});

await check("drain-entrypoint hands SIGTERM to the drained process, not its parent", async () => {
  const pidfile = join(work, "drain.pid");
  const s = await start(
    { SHUTDOWN_DRAIN_SECONDS: "1", APP_HANDLER: "1", HATCHKIT_DRAIN_PIDFILE: pidfile },
    true,
  );
  try {
    const sent = Date.now();
    s.child.kill("SIGTERM");
    await sleep(150);
    assert.equal(await status(s.port, "/"), 503, "the server behind the shell is draining");
    assert.equal(await status(s.port, "/page"), 200);
    const code = await s.exited;
    assert.ok(Date.now() - sent >= 1000, "exited only after the drain");
    assert.match(s.output(), /app-shutdown/);
    assert.equal(code, 7, "the entrypoint exits with the command's status");
  } finally {
    s.child.kill("SIGKILL");
  }
});

rmSync(work, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// Every image carries the drain the health timing is built for
// ---------------------------------------------------------------------------

console.log("\nshutdown drain — images");

const ENV_LINE = `ENV SHUTDOWN_DRAIN_SECONDS=${SHUTDOWN_DRAIN_SECONDS}`;

await check("the starter's client ships the template's drain.cjs, byte for byte", () => {
  assert.equal(
    read("starter/packages/client/drain.cjs"),
    read("cli/src/templates/build-pipeline/drain.cjs"),
    "starter/packages/client/drain.cjs drifted from cli/src/templates/build-pipeline/drain.cjs — copy one over the other",
  );
});

await check("starter Dockerfiles bake the drain and run it", () => {
  const server = read("starter/packages/server/Dockerfile");
  assert.ok(server.includes(ENV_LINE), `server Dockerfile: ${ENV_LINE}`);
  const client = read("starter/packages/client/Dockerfile");
  assert.ok(client.includes(ENV_LINE), `client Dockerfile: ${ENV_LINE}`);
  assert.match(client, /COPY --from=build \/app\/packages\/client\/drain\.cjs/);
  assert.match(
    client,
    /CMD \["node", "--require", "\.\/packages\/client\/drain\.cjs", "packages\/client\/server\.js"\]/,
  );
  // The server drains in its own code: SIGTERM waits, the probe fails.
  const index = read("starter/packages/server/src/index.ts");
  assert.match(index, /env\.SHUTDOWN_DRAIN_SECONDS > 0 && !isDraining\(\)/);
  const app = read("starter/packages/server/src/app.ts");
  assert.match(app, /isDraining\(\) && isLoopback\(req\.socket\.remoteAddress\)/);
});

await check("compose files turn the drain off", () => {
  const starter = read("starter/docker-compose.yml");
  assert.equal(starter.match(/SHUTDOWN_DRAIN_SECONDS: "0"/g)?.length, 2, "server and client");
  assert.match(
    read("cli/src/templates/build-pipeline/docker-compose.yml.hbs"),
    /- SHUTDOWN_DRAIN_SECONDS=0/,
  );
});

function scaffold(
  files: Record<string, string>,
  surfaces: "static" | "fullstack",
): { dockerfile: string; nginx?: string } {
  const dir = mkdtempSync(join(tmpdir(), "hatchkit-drain-bp-"));
  try {
    for (const [rel, body] of Object.entries(files)) writeFileSync(join(dir, rel), body);
    scaffoldBuildPipeline({
      projectDir: dir,
      projectName: "demo",
      ghOwner: "acme",
      entrypoint: "dist/index.js",
      port: 3000,
      surfaces,
      domain: "demo.example.com",
      defaultBranch: "main",
    });
    const dockerfile = readFileSync(join(dir, "Dockerfile"), "utf-8");
    let nginx: string | undefined;
    try {
      nginx = readFileSync(join(dir, "nginx.conf"), "utf-8");
    } catch {}
    return { dockerfile, nginx };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await check("static (nginx) image: TERM trap, SIGTERM stop signal, conf fails the probe", () => {
  const { dockerfile, nginx } = scaffold(
    { "package.json": JSON.stringify({ name: "demo", devDependencies: { vite: "^6" } }) },
    "static",
  );
  assert.ok(dockerfile.includes(ENV_LINE), ENV_LINE);
  assert.match(dockerfile, /^STOPSIGNAL SIGTERM$/m);
  assert.match(dockerfile, /^ENTRYPOINT \["\/usr\/local\/bin\/drain-entrypoint"\]$/m);
  assert.match(dockerfile, /^CMD \["nginx", "-g", "daemon off;"\]$/m);
  assert.match(dockerfile, /^trap drain TERM$/m);
  assert.match(dockerfile, /touch "\$flag"/);
  assert.ok(nginx, "nginx.conf written");
  assert.match(nginx, /if \(-f \/tmp\/hatchkit-draining\)/);
  assert.match(nginx, /if \(\$drain = "on-probe"\) \{\s*return 503;/);
});

await check("Node images inline drain.cjs and load it ahead of the server", () => {
  const preload = readFileSync(PRELOAD, "utf-8").trimEnd();
  const entrypoint = readFileSync(ENTRYPOINT, "utf-8").trimEnd();
  const cases: Array<[string, Record<string, string>, "static" | "fullstack", RegExp]> = [
    [
      "next",
      { "package.json": JSON.stringify({ name: "demo", dependencies: { next: "^16" } }) },
      "fullstack",
      /"node", "--require", "\/usr\/local\/lib\/drain\.cjs", "\.\/node_modules\/next\/dist\/bin\/next", "start"/,
    ],
    [
      "server",
      { "package.json": JSON.stringify({ name: "demo", dependencies: { express: "^5" } }) },
      "fullstack",
      /node --require \/usr\/local\/lib\/drain\.cjs dist\/index\.js/,
    ],
  ];
  for (const [label, files, surfaces, cmd] of cases) {
    const { dockerfile } = scaffold(files, surfaces);
    assert.ok(dockerfile.includes(ENV_LINE), `${label}: ${ENV_LINE}`);
    assert.ok(
      dockerfile.includes(`COPY <<'EOF' /usr/local/lib/drain.cjs\n${preload}\nEOF\n`),
      `${label}: drain.cjs inlined verbatim`,
    );
    assert.match(dockerfile, cmd, `${label}: CMD loads the drain`);
    assert.ok(
      dockerfile.includes(
        `COPY --chmod=755 <<'EOF' /usr/local/bin/drain-entrypoint\n${entrypoint}\nEOF\n`,
      ),
      `${label}: drain-entrypoint inlined verbatim`,
    );
    assert.match(dockerfile, /^ENTRYPOINT \["\/usr\/local\/bin\/drain-entrypoint"\]$/m);
  }
  // The monorepo variant needs a workspace to be picked; its template is
  // checked as text.
  const mono = read("cli/src/templates/build-pipeline/Dockerfile.nextjs-monorepo.hbs");
  assert.match(mono, /ENV SHUTDOWN_DRAIN_SECONDS=\{\{drainSeconds\}\}/);
  assert.match(mono, /COPY <<'EOF' \/usr\/local\/lib\/drain\.cjs\n\{\{\{drainPreload\}\}\}\nEOF/);
  assert.match(
    mono,
    /COPY --chmod=755 <<'EOF' \/usr\/local\/bin\/drain-entrypoint\n\{\{\{drainEntrypoint\}\}\}\nEOF/,
  );
  assert.match(mono, /^ENTRYPOINT \["\/usr\/local\/bin\/drain-entrypoint"\]$/m);
  assert.match(
    mono,
    /"node", "--require", "\/usr\/local\/lib\/drain\.cjs", "\.\/node_modules\/next\/dist\/bin\/next", "start"/,
  );
});

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("\nAll shutdown-drain assertions passed.");
