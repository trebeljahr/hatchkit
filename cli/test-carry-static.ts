/**
 * carry-static.mjs — the old-chunk carry for clients on Cloudflare Workers.
 *
 * A Worker version serves only the files it was uploaded with, so every
 * upload must carry the hashed files of the releases before it. This test
 * plays three deploys against a local HTTP server standing in for the live
 * site and checks what each build carries, plus every rule that must fail
 * the build: colliding paths, a tampered download, a manifest pointing
 * outside the hashed directory, and the per-version file limit.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SCRIPT = join(import.meta.dirname, "src/templates/client-host/scripts/carry-static.mjs");
const { carry, validateManifest } = (await import(SCRIPT)) as {
  carry: (options: Record<string, unknown>) => Promise<CarrySummary>;
  validateManifest: (value: unknown, dirs: string[]) => unknown;
};

interface CarrySummary {
  release: string;
  carried: { sha: string; files: number }[];
  downloaded: number;
  previous: string;
  notes: string[];
  uploadFiles: number;
}

const results: Record<string, boolean> = {};
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    results[name] = true;
  } catch (err) {
    results[name] = false;
    console.log(`\n  x ${name}\n    ${(err as Error).stack}\n`);
  }
}

const root = mkdtempSync(join(tmpdir(), "carry static "));
const live = join(root, "live");
mkdirSync(live);

/** The live site: serves `live/` like Workers assets, 404 otherwise.
 *  `override` lets a test answer one path with other bytes. */
const overrides = new Map<string, { status: number; body: string }>();
const requests: string[] = [];
const server: Server = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  requests.push(req.url ?? "");
  const override = overrides.get(path);
  if (override) {
    res.writeHead(override.status);
    res.end(override.body);
    return;
  }
  const file = join(live, ...path.slice(1).split("/"));
  if (path.endsWith("/") || !existsSync(file)) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  res.writeHead(200);
  res.end(readFileSync(file));
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
const site = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

/** Write one build's output: `files` maps a path under out/ to contents. */
function build(name: string, files: Record<string, string>): string {
  const out = join(root, name);
  rmSync(out, { recursive: true, force: true });
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(out, rel)), { recursive: true });
    writeFileSync(join(out, rel), body);
  }
  return out;
}

/** "Deploy" a build: the live site now serves exactly that output. */
function deploy(out: string): void {
  rmSync(live, { recursive: true, force: true });
  cpSync(out, live, { recursive: true });
}

const has = (out: string, rel: string) => existsSync(join(out, rel));
const manifestOf = (out: string) =>
  JSON.parse(readFileSync(join(out, "release-assets.json"), "utf8")) as {
    schema: number;
    releases: { sha: string; files: { path: string }[] }[];
  };

const A = build("a", {
  "index.html": "a",
  "_next/static/chunks/main-aaa.js": "A main",
  "_next/static/chunks/common-ccc.js": "common",
  "_next/static/buildA/_buildManifest.js": "A manifest",
});

await test("first deploy: no live manifest carries nothing and writes one", async () => {
  const summary = await carry({ site, out: A, release: "aaaaaaa" });
  assert.equal(summary.downloaded, 0);
  assert.deepEqual(summary.carried, []);
  assert.match(summary.previous, /HTTP 404/);
  assert.ok(summary.notes.some((n) => n.includes("nothing carried")));
  const m = manifestOf(A);
  assert.equal(m.schema, 1);
  assert.deepEqual(
    m.releases.map((r) => r.sha),
    ["aaaaaaa"],
  );
  assert.equal(m.releases[0].files.length, 3, "lists only files under _next/static");
});

deploy(A);
const B = build("b", {
  "index.html": "b",
  "_next/static/chunks/main-bbb.js": "B main",
  "_next/static/chunks/common-ccc.js": "common",
  "_next/static/buildB/_buildManifest.js": "B manifest",
});

await test("second deploy carries the live release's missing files", async () => {
  const summary = await carry({ site, out: B, release: "bbbbbbb" });
  assert.deepEqual(summary.carried, [{ sha: "aaaaaaa", files: 3 }]);
  assert.equal(summary.downloaded, 2, "common-ccc.js is this build's own, same bytes");
  assert.equal(readFileSync(join(B, "_next/static/chunks/main-aaa.js"), "utf8"), "A main");
  assert.ok(has(B, "_next/static/buildA/_buildManifest.js"));
  assert.deepEqual(
    manifestOf(B).releases.map((r) => r.sha),
    ["bbbbbbb", "aaaaaaa"],
  );
});

await test("the manifest fetch carries a cache-busting query", () => {
  assert.ok(requests.some((r) => /^\/release-assets\.json\?carry=\d+$/.test(r)));
});

deploy(B);
const C = build("c", {
  "index.html": "c",
  "_next/static/chunks/main-ccc2.js": "C main",
  "_next/static/buildC/_buildManifest.js": "C manifest",
});

await test("third deploy carries two releases, files of the oldest come from the live site", async () => {
  const summary = await carry({ site, out: C, release: "ccccccc" });
  assert.deepEqual(
    summary.carried.map((r) => r.sha),
    ["bbbbbbb", "aaaaaaa"],
  );
  // A's files are on the live site only because B carried them.
  assert.ok(has(C, "_next/static/chunks/main-aaa.js"));
  assert.ok(has(C, "_next/static/chunks/main-bbb.js"));
  assert.ok(has(C, "_next/static/chunks/common-ccc.js"));
});

deploy(C);
const D = build("d", { "index.html": "d", "_next/static/chunks/main-ddd.js": "D main" });

await test("keep=2 drops the third release back", async () => {
  const summary = await carry({ site, out: D, release: "ddddddd" });
  assert.deepEqual(
    summary.carried.map((r) => r.sha),
    ["ccccccc", "bbbbbbb"],
  );
  assert.ok(!has(D, "_next/static/chunks/main-aaa.js"));
  assert.ok(has(D, "_next/static/chunks/main-bbb.js"));
});

await test("a rebuild of the live commit still carries the live build's own chunks", async () => {
  // A seed uploaded from a laptop and CI's build of the same commit differ
  // in a few chunks; the rebuild must keep the seed's tabs working.
  const again = build("c-again", {
    "_next/static/chunks/main-ccc3.js": "C main, rebuilt elsewhere",
    "_next/static/buildC2/_buildManifest.js": "C manifest",
  });
  const summary = await carry({ site, out: again, release: "ccccccc" });
  assert.deepEqual(
    summary.carried.map((r) => r.sha),
    ["ccccccc", "bbbbbbb"],
  );
  assert.ok(has(again, "_next/static/chunks/main-ccc2.js"), "the live build's chunk is carried");
  assert.ok(has(again, "_next/static/chunks/main-bbb.js"));
});

await test("one path with two contents fails the build", async () => {
  const bad = build("collide", { "_next/static/chunks/main-bbb.js": "not B" });
  await assert.rejects(
    carry({ site, out: bad, release: "eeeeeee" }),
    /asset collision at \/_next\/static\/chunks\/main-bbb\.js/,
  );
});

await test("a per-build manifest at a fixed build ID keeps this build's copy", async () => {
  const fixed = build("fixed-id", {
    "_next/static/buildC/_buildManifest.js": "next manifest",
    "_next/static/chunks/main-fff.js": "F",
  });
  const summary = await carry({ site, out: fixed, release: "fffffff" });
  assert.equal(
    readFileSync(join(fixed, "_next/static/buildC/_buildManifest.js"), "utf8"),
    "next manifest",
  );
  assert.ok(summary.notes.some((n) => n.includes("_buildManifest.js")));
  const carriedC = manifestOf(fixed).releases.find((r) => r.sha === "ccccccc");
  assert.ok(carriedC && !carriedC.files.some((f) => f.path.endsWith("_buildManifest.js")));
});

await test("a download with other bytes than listed fails", async () => {
  overrides.set("/_next/static/chunks/main-bbb.js", { status: 200, body: "tampered" });
  try {
    const out = build("tamper", { "_next/static/chunks/x-1.js": "x" });
    await assert.rejects(carry({ site, out, release: "1111111" }), /sha256/);
  } finally {
    overrides.clear();
  }
});

await test("a listed file the live site lacks fails", async () => {
  overrides.set("/_next/static/chunks/main-bbb.js", { status: 404, body: "" });
  try {
    const out = build("missing", { "_next/static/chunks/x-1.js": "x" });
    await assert.rejects(carry({ site, out, release: "2222222" }), /could not carry .*HTTP 404/);
  } finally {
    overrides.clear();
  }
});

await test("an SPA fallback (HTML with 200) reads as no manifest", async () => {
  overrides.set("/release-assets.json", { status: 200, body: "<!doctype html>" });
  try {
    const out = build("spa", { "_next/static/chunks/x-1.js": "x" });
    const summary = await carry({ site, out, release: "3333333" });
    assert.equal(summary.previous, "response is not JSON");
    await assert.rejects(
      carry({ site, out, release: "3333333", requirePrevious: true }),
      /no live manifest/,
    );
  } finally {
    overrides.clear();
  }
});

await test("a manifest path outside the hashed dir is refused", () => {
  const sha = "0".repeat(64);
  for (const path of ["/index.html", "/_next/static/../../etc/passwd", "/_next/static/a?b"]) {
    assert.throws(
      () =>
        validateManifest(
          { schema: 1, releases: [{ sha: "abc", files: [{ path, sha256: sha, size: 1 }] }] },
          ["_next/static"],
        ),
      /outside/,
      path,
    );
  }
  assert.throws(() => validateManifest({ schema: 2, releases: [] }, ["_next/static"]), /schema/);
});

await test("the file limit fails before any download", async () => {
  const out = build("limit", { "_next/static/chunks/x-1.js": "x" });
  const before = requests.length;
  await assert.rejects(carry({ site, out, release: "4444444", maxFiles: 2 }), /limit 2/);
  assert.equal(
    requests.slice(before).filter((r) => r.startsWith("/_next/")).length,
    0,
    "no chunk downloaded",
  );
});

await test("--dry-run writes nothing", async () => {
  const out = build("dry", { "_next/static/chunks/x-1.js": "x" });
  const summary = await carry({ site, out, release: "5555555", dryRun: true });
  assert.ok(summary.downloaded > 0);
  assert.ok(!has(out, "release-assets.json"));
  assert.ok(!has(out, "_next/static/chunks/main-bbb.js"));
});

/** Async on purpose: spawnSync would block the in-process live site. */
function runCli(args: string[], env: Record<string, string>) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
}

await test("the CLI runs from a path with spaces and reads GITHUB_SHA", async () => {
  const out = build("cli", { "_next/static/chunks/x-9.js": "x" });
  const run = await runCli(["--site", site, "--out", out], {
    GITHUB_SHA: "6666666",
    GITHUB_ACTIONS: "",
  });
  assert.equal(run.status, 0, run.stderr);
  const summary = JSON.parse(run.stdout) as CarrySummary;
  assert.equal(summary.release, "6666666");
  assert.ok(summary.downloaded > 0);
  const bad = await runCli(["--site", site, "--out", out, "--bogus", "1"], {
    GITHUB_SHA: "6666666",
  });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Unknown option --bogus/);
});

server.close();
rmSync(root, { recursive: true, force: true });

const failed = Object.entries(results).filter(([, ok]) => !ok);
console.log(
  `\ncarry-static: ${Object.keys(results).length - failed.length}/${Object.keys(results).length} passed`,
);
if (failed.length) process.exit(1);
