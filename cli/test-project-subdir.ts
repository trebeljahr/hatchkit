/**
 * Tests for the `projectSubdir` feature — deploying a sub-folder of a
 * larger repo as its own Coolify app.
 *
 * Covers:
 *   · Manifest path normalization (posix slashes, no leading "./",
 *     no escaping segments).
 *   · Coolify API `base_directory` field on create + update body.
 *   · `sync` computes the right desired state when the manifest
 *     records a `projectSubdir`.
 *   · `scaffoldBuildPipeline` writes Dockerfile + compose into the
 *     subdir and deploy.yml at the repo root with the right
 *     `context: <subdir>` substitution.
 *   · `inventory.writeMinimalManifest` writes the manifest at the git
 *     root and records the subdir when invoked from a sub-folder.
 *
 * Run: `pnpm test`.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import {
  normalizeProjectSubdir,
  resolveProjectDir,
  type ProjectManifest,
} from "./src/scaffold/manifest.js";
import { CoolifyApi, normalizeCoolifyBaseDirectory } from "./src/utils/coolify-api.js";
// sync's computeDesiredAppStates was removed with the topology
// refactor — base_directory now flows into `updateApplication`
// through the buildPlan path. Coverage lives in the API-body tests
// above (createApplicationFromPublicRepo + updateApplication body
// shape) plus the static audit that sync.ts passes baseDirectory in
// its PATCH payload.
import { readFileSync as _readFileSyncForSyncAudit } from "node:fs";
import { scaffoldBuildPipeline } from "./src/scaffold/build-pipeline.js";
import { writeMinimalManifest } from "./src/inventory.js";

const failures: string[] = [];
function expect(label: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}: ${(err as Error).message}`);
    console.log(`  ✗ ${label}: ${(err as Error).message}`);
  }
}

console.log("\n  test-project-subdir\n");

// ---------------------------------------------------------------------------
// normalizeProjectSubdir
// ---------------------------------------------------------------------------

expect("normalize: undefined → undefined", () => {
  assert.equal(normalizeProjectSubdir(undefined), undefined);
});
expect("normalize: empty → undefined", () => {
  assert.equal(normalizeProjectSubdir(""), undefined);
});
expect("normalize: '.' → undefined", () => {
  assert.equal(normalizeProjectSubdir("."), undefined);
});
expect("normalize: './site' → 'site'", () => {
  assert.equal(normalizeProjectSubdir("./site"), "site");
});
expect("normalize: 'site/' → 'site'", () => {
  assert.equal(normalizeProjectSubdir("site/"), "site");
});
expect("normalize: '/site/' → 'site'", () => {
  assert.equal(normalizeProjectSubdir("/site/"), "site");
});
expect("normalize: 'apps/web' → 'apps/web'", () => {
  assert.equal(normalizeProjectSubdir("apps/web"), "apps/web");
});
expect("normalize: 'apps\\\\web' (windows) → 'apps/web'", () => {
  assert.equal(normalizeProjectSubdir("apps\\web"), "apps/web");
});
expect("normalize: '..' throws", () => {
  assert.throws(() => normalizeProjectSubdir(".."));
});
expect("normalize: 'apps//web' throws (empty segment)", () => {
  assert.throws(() => normalizeProjectSubdir("apps//web"));
});

// ---------------------------------------------------------------------------
// resolveProjectDir
// ---------------------------------------------------------------------------

expect("resolveProjectDir: no manifest → repoRoot", () => {
  assert.equal(resolveProjectDir("/repo", undefined), "/repo");
});
expect("resolveProjectDir: manifest without subdir → repoRoot", () => {
  const manifest = { projectSubdir: undefined } as ProjectManifest;
  assert.equal(resolveProjectDir("/repo", manifest), "/repo");
});
expect("resolveProjectDir: manifest with 'site' → /repo/site", () => {
  const manifest = { projectSubdir: "site" } as ProjectManifest;
  assert.equal(resolveProjectDir("/repo", manifest), "/repo/site");
});
expect("resolveProjectDir: manifest with 'apps/web' → /repo/apps/web", () => {
  const manifest = { projectSubdir: "apps/web" } as ProjectManifest;
  assert.equal(resolveProjectDir("/repo", manifest), "/repo/apps/web");
});

// ---------------------------------------------------------------------------
// normalizeCoolifyBaseDirectory
// ---------------------------------------------------------------------------

expect("coolify normalize: '' → '/'", () => {
  assert.equal(normalizeCoolifyBaseDirectory(""), "/");
});
expect("coolify normalize: '.' → '/'", () => {
  assert.equal(normalizeCoolifyBaseDirectory("."), "/");
});
expect("coolify normalize: 'site' → '/site'", () => {
  assert.equal(normalizeCoolifyBaseDirectory("site"), "/site");
});
expect("coolify normalize: 'site/' → '/site'", () => {
  assert.equal(normalizeCoolifyBaseDirectory("site/"), "/site");
});
expect("coolify normalize: '/apps/web' → '/apps/web'", () => {
  assert.equal(normalizeCoolifyBaseDirectory("/apps/web"), "/apps/web");
});
expect("coolify normalize: 'apps\\\\web' → '/apps/web'", () => {
  assert.equal(normalizeCoolifyBaseDirectory("apps\\web"), "/apps/web");
});

// ---------------------------------------------------------------------------
// Coolify API: base_directory threads through create + update bodies.
// We can't hit a real Coolify, so spy on fetch via a stub.
// ---------------------------------------------------------------------------

function makeFetchStub() {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const stub = async (url: string | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url: url.toString(), method: init?.method ?? "GET", body });
    return new Response('{"uuid":"x","name":"y"}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { stub, calls };
}

expect("coolify api: createApplicationFromPublicRepo body includes base_directory", async () => {
  const { stub, calls } = makeFetchStub();
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub as unknown as typeof fetch;
  try {
    const api = new CoolifyApi({ url: "https://coolify.example", token: "t" });
    await api.createApplicationFromPublicRepo({
      projectUuid: "p",
      serverUuid: "s",
      gitRepository: "https://github.com/owner/repo",
      name: "myapp",
      buildPack: "dockercompose",
      domains: ["https://myapp.example"],
      baseDirectory: "site",
    });
    assert.equal(calls.length, 1);
    const body = calls[0].body as Record<string, unknown>;
    assert.equal(body.base_directory, "/site");
  } finally {
    globalThis.fetch = realFetch;
  }
});

expect("coolify api: updateApplication body includes base_directory", async () => {
  const { stub, calls } = makeFetchStub();
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub as unknown as typeof fetch;
  try {
    const api = new CoolifyApi({ url: "https://coolify.example", token: "t" });
    await api.updateApplication("uuid-1", { baseDirectory: "apps/web" });
    assert.equal(calls.length, 1);
    const body = calls[0].body as Record<string, unknown>;
    assert.equal(body.base_directory, "/apps/web");
  } finally {
    globalThis.fetch = realFetch;
  }
});

expect("coolify api: updateApplication baseDirectory='' resets to '/'", async () => {
  const { stub, calls } = makeFetchStub();
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub as unknown as typeof fetch;
  try {
    const api = new CoolifyApi({ url: "https://coolify.example", token: "t" });
    await api.updateApplication("uuid-1", { baseDirectory: "" });
    const body = calls[0].body as Record<string, unknown>;
    assert.equal(body.base_directory, "/");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------------------
// Static audit: sync passes baseDirectory into every updateApplication
// call, driven by the manifest's projectSubdir. The topology-aware
// routing model doesn't expose a testable "desired state" function
// anymore; regex-scan the module to catch a regression instead.
// ---------------------------------------------------------------------------

expect("sync: updateApplication call includes baseDirectory from manifest", () => {
  const src = _readFileSyncForSyncAudit(join(process.cwd(), "src/deploy/sync.ts"), "utf-8");
  assert.ok(
    /baseDirectory:\s*plan\.desiredBaseDirectory\s*\?\?\s*""/.test(src),
    "sync's updateApplication PATCH must send baseDirectory: plan.desiredBaseDirectory ?? \"\"",
  );
  assert.ok(
    /manifest\.projectSubdir\s*\|\|\s*undefined/.test(src),
    "sync must derive desired baseDirectory from manifest.projectSubdir",
  );
});

// ---------------------------------------------------------------------------
// scaffoldBuildPipeline: deploy.yml at repoRoot, Dockerfile in subdir
// ---------------------------------------------------------------------------

expect("scaffoldBuildPipeline: subdir build → deploy.yml at repoRoot, Dockerfile in subdir", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "hatchkit-pipeline-subdir-"));
  try {
    const subdir = "site";
    const projectDir = join(repoRoot, subdir);
    mkdirSync(projectDir, { recursive: true });
    // Minimal package.json for framework detection — Next.js shape.
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "site", dependencies: { next: "^15" } }, null, 2),
    );
    writeFileSync(join(projectDir, "next.config.js"), "module.exports = {};");

    const result = scaffoldBuildPipeline({
      projectDir,
      repoRoot,
      projectSubdir: subdir,
      projectName: "site",
      ghOwner: "owner",
      entrypoint: "dist/index.js",
      port: 3000,
      surfaces: "fullstack",
      defaultBranch: "main",
    });

    // Dockerfile + compose land inside the subdir.
    assert.ok(
      existsSync(join(projectDir, "Dockerfile")),
      "Dockerfile should be inside the subdir",
    );
    assert.ok(
      existsSync(join(projectDir, "docker-compose.yml")),
      "docker-compose.yml should be inside the subdir",
    );
    // Workflow lands at repoRoot (.github/workflows/ is repo-root-only).
    assert.ok(
      existsSync(join(repoRoot, ".github/workflows/deploy.yml")),
      "deploy.yml should be at repo root",
    );
    // Workflow context: subdir, not '.'.
    const workflow = readFileSync(join(repoRoot, ".github/workflows/deploy.yml"), "utf-8");
    assert.ok(
      /context:\s*site\b/.test(workflow),
      `workflow should set context: site, got:\n${workflow.slice(0, 500)}`,
    );
    // `file:` resolves against the workspace, not against `context:`, so
    // it needs the subdir prefix too — `file: Dockerfile` here would make
    // the build read the repo root and fail with "Dockerfile not found".
    assert.ok(
      /^\s*file:\s*site\/Dockerfile\s*$/m.test(workflow),
      `workflow should set file: site/Dockerfile, got:\n${workflow.slice(0, 500)}`,
    );
    // The absolute paths in result.createdAbs should reflect the
    // per-file baseDir (subdir for Dockerfile, repoRoot for workflow).
    const absSet = new Set(result.createdAbs);
    assert.ok(absSet.has(join(projectDir, "Dockerfile")));
    assert.ok(absSet.has(join(repoRoot, ".github/workflows/deploy.yml")));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

expect("scaffoldBuildPipeline: no subdir → all files at projectDir, deploy.yml context '.'", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "hatchkit-pipeline-root-"));
  try {
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "root-app" }, null, 2),
    );

    scaffoldBuildPipeline({
      projectDir,
      projectName: "root-app",
      ghOwner: "owner",
      entrypoint: "dist/index.js",
      port: 3000,
      surfaces: "fullstack",
      defaultBranch: "main",
    });

    assert.ok(existsSync(join(projectDir, "Dockerfile")));
    assert.ok(existsSync(join(projectDir, ".github/workflows/deploy.yml")));
    const workflow = readFileSync(join(projectDir, ".github/workflows/deploy.yml"), "utf-8");
    assert.ok(
      /^\s*context:\s*\.\s*$/m.test(workflow),
      `workflow should set context: . for root build, got:\n${workflow.slice(0, 500)}`,
    );
    assert.ok(
      /^\s*file:\s*Dockerfile\s*$/m.test(workflow),
      `workflow should set file: Dockerfile for root build, got:\n${workflow.slice(0, 500)}`,
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// inventory.writeMinimalManifest: from a subdir, manifest lands at repoRoot
// ---------------------------------------------------------------------------

expect("writeMinimalManifest: from subdir of git repo → manifest at root + projectSubdir set", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "hatchkit-inv-subdir-"));
  try {
    // git init so findGitRoot inside inventory.ts succeeds.
    execSync("git init -q", { cwd: repoRoot });
    const subdirAbs = join(repoRoot, "site");
    mkdirSync(subdirAbs, { recursive: true });
    writeFileSync(join(subdirAbs, "package.json"), JSON.stringify({ name: "site" }));

    const manifest = writeMinimalManifest(
      subdirAbs,
      { name: "myapp", domain: "myapp.example" },
      {
        cwd: subdirAbs,
        isGitRepo: true,
        hasGitHubRemote: false,
        manifestPresent: false,
        hasDockerfile: false,
        envSignals: new Set<string>(),
        packageDeps: new Set<string>(),
        dotenvxEncrypted: false,
        envKeysPresent: false,
      },
    );

    assert.equal(manifest.projectSubdir, "site");
    assert.ok(
      existsSync(join(repoRoot, ".hatchkit.json")),
      "manifest must land at the git root, not in the subdir",
    );
    assert.equal(
      existsSync(join(subdirAbs, ".hatchkit.json")),
      false,
      "manifest must NOT also land in the subdir",
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Static audit: setupGitHubRemote + the gh-pages add/commit branch +
// pushInitialBranch must run their git operations at the REPO root,
// not the deployable subdir. A simple regex scan over adopt.ts is
// enough — there should be ZERO `cwd: state.projectDir` calls inside
// setupGitHubRemote, and the pushInitialBranch + ghPages commit lines
// should pass state.repoRoot.
// ---------------------------------------------------------------------------

expect("adopt: setupGitHubRemote runs git ops at state.repoRoot", () => {
  const src = readFileSync(join(process.cwd(), "src/adopt.ts"), "utf-8");
  // Slice out the setupGitHubRemote function body. Grab from the
  // signature to the next top-level `async function`/`function` to
  // bound the scan.
  const start = src.indexOf("async function setupGitHubRemote(");
  assert.ok(start >= 0, "couldn't find setupGitHubRemote signature");
  const tail = src.slice(start);
  const endRel = tail.search(/\n(?:async )?function [A-Za-z]/);
  const body = endRel >= 0 ? tail.slice(0, endRel) : tail;
  assert.ok(
    !/cwd:\s*state\.projectDir/.test(body),
    "setupGitHubRemote must not pass cwd: state.projectDir to any git op (use state.repoRoot)",
  );
});

expect("adopt: gitInit ledger entry records repoRoot, not projectDir", () => {
  const src = readFileSync(join(process.cwd(), "src/adopt.ts"), "utf-8");
  assert.ok(
    /ledger\.record\(\{\s*kind:\s*"gitInit",\s*path:\s*join\(state\.repoRoot,\s*"\.git"\)\s*\}\)/.test(
      src,
    ),
    "gitInit ledger entry should record join(state.repoRoot, '.git')",
  );
  assert.ok(
    !/ledger\.record\(\{\s*kind:\s*"gitInit",\s*path:\s*join\(state\.projectDir,\s*"\.git"\)\s*\}\)/.test(
      src,
    ),
    "gitInit ledger entry must NOT record join(state.projectDir, '.git') anywhere",
  );
});

expect("adopt: pushInitialBranch is called with state.repoRoot", () => {
  const src = readFileSync(join(process.cwd(), "src/adopt.ts"), "utf-8");
  assert.ok(
    /pushInitialBranch\(state\.repoRoot\)/.test(src),
    "initial push should run at state.repoRoot",
  );
});

// ---------------------------------------------------------------------------
// findManifestDirUpward walks up to find the repo-root manifest from
// any subdir — the unblocker for rename-domain / regen-infra / update
// when invoked from inside the deployable subdir.
// ---------------------------------------------------------------------------

expect("findManifestDirUpward: from subdir finds manifest at root", async () => {
  const { findManifestDirUpward } = await import("./src/scaffold/manifest.js");
  const repoRoot = mkdtempSync(join(tmpdir(), "hatchkit-walk-up-"));
  try {
    writeFileSync(join(repoRoot, ".hatchkit.json"), "{}");
    const subdir = join(repoRoot, "site");
    mkdirSync(subdir);
    assert.equal(findManifestDirUpward(subdir), repoRoot);
    assert.equal(findManifestDirUpward(repoRoot), repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

expect("findManifestDirUpward: no manifest anywhere → undefined", async () => {
  const { findManifestDirUpward } = await import("./src/scaffold/manifest.js");
  const dir = mkdtempSync(join(tmpdir(), "hatchkit-no-manifest-"));
  try {
    assert.equal(findManifestDirUpward(dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

expect("writeMinimalManifest: at git root → manifest at root + no projectSubdir", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "hatchkit-inv-root-"));
  try {
    execSync("git init -q", { cwd: repoRoot });
    writeFileSync(join(repoRoot, "package.json"), JSON.stringify({ name: "myapp" }));

    const manifest = writeMinimalManifest(
      repoRoot,
      { name: "myapp", domain: "myapp.example" },
      {
        cwd: repoRoot,
        isGitRepo: true,
        hasGitHubRemote: false,
        manifestPresent: false,
        hasDockerfile: false,
        envSignals: new Set<string>(),
        packageDeps: new Set<string>(),
        dotenvxEncrypted: false,
        envKeysPresent: false,
      },
    );

    assert.equal(manifest.projectSubdir, undefined);
    assert.ok(existsSync(join(repoRoot, ".hatchkit.json")));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

console.log("");
if (failures.length > 0) {
  console.error(`  ${failures.length} test(s) failed:`);
  for (const f of failures) console.error(`    · ${f}`);
  process.exit(1);
} else {
  console.log("  all tests passed");
}
