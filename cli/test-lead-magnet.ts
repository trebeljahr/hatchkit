/**
 * `hatchkit add <project> lead-magnet`: edits the newsletter's
 * magnets.json (the starter's server, or the newsletter Worker of a
 * static site) and warns about what a delivery still needs. Local files
 * only; every project here is a temp directory.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const { applyLeadMagnet, findMagnetsFile } = await import("./src/features/lead-magnet/index.js");

const results: Record<string, boolean> = {};
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    results[name] = true;
  } catch (err) {
    results[name] = false;
    console.log(`\n  x ${name}\n    ${(err as Error).stack}\n`);
  }
}

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "hatchkit-lead-magnet-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

const SERVER = "packages/server/src/services/newsletter/magnets.json";
const serverProject = (env = "") =>
  project({
    "packages/server/package.json": "{}",
    "packages/server/src/index.ts": "",
    [SERVER]: "{}\n",
    "packages/server/.env.production": env,
  });
const read = (dir: string, rel = SERVER) => JSON.parse(readFileSync(join(dir, rel), "utf-8"));

await test("adds an object magnet to the server's magnets.json and lists it", () => {
  const dir = serverProject(
    "NEWSLETTER_TOKEN_SECRET=x\nBETTER_AUTH_URL=x\nS3_BUCKET_NAME=x\nAWS_ACCESS_KEY_ID=x\nAWS_SECRET_ACCESS_KEY=x\n",
  );
  const added = applyLeadMagnet({
    projectDir: dir,
    key: "wallpapers",
    title: "Wallpaper pack",
    object: "magnets/wallpapers.zip",
    filename: "Wallpapers.zip",
  });
  assert.equal(added.ok, true);
  assert.equal(added.action, "added");
  assert.deepEqual(added.warnings, []);
  assert.deepEqual(read(dir), {
    wallpapers: { title: "Wallpaper pack", object: "magnets/wallpapers.zip", filename: "Wallpapers.zip" },
  });
  assert.ok(added.nextSteps.some((s) => s.includes('<SubscribeForm magnet="wallpapers"')));

  const listed = applyLeadMagnet({ projectDir: dir });
  assert.equal(listed.action, "listed");
  assert.deepEqual(Object.keys(listed.magnets), ["wallpapers"]);
});

await test("updates one field, keeps the rest; switching to --url drops filename", () => {
  const dir = serverProject();
  applyLeadMagnet({ projectDir: dir, key: "pack", title: "Pack", object: "magnets/p.zip", filename: "P.zip" });
  applyLeadMagnet({ projectDir: dir, key: "pack", title: "Better pack" });
  assert.deepEqual(read(dir).pack, { title: "Better pack", object: "magnets/p.zip", filename: "P.zip" });
  const switched = applyLeadMagnet({ projectDir: dir, key: "pack", url: "https://example.test/p.zip" });
  assert.equal(switched.action, "updated");
  assert.deepEqual(read(dir).pack, { title: "Better pack", url: "https://example.test/p.zip" });
});

await test("refuses bad keys, two sources, http and path escapes; writes nothing", () => {
  const dir = serverProject();
  const bad = [
    { key: "Bad_Key", title: "x", url: "https://example.test/a" },
    { key: "two", title: "x", url: "https://example.test/a", object: "a.zip" },
    { key: "plain", title: "x", url: "http://example.test/a" },
    { key: "escape", title: "x", object: "magnets/../.env" },
    { key: "untitled", object: "a.zip" },
    { key: "url-name", title: "x", url: "https://example.test/a", filename: "a.zip" },
  ];
  for (const opts of bad) {
    const result = applyLeadMagnet({ projectDir: dir, ...opts });
    assert.equal(result.ok, false, opts.key);
  }
  assert.deepEqual(read(dir), {});
});

await test("--dry-run and --remove", () => {
  const dir = serverProject();
  const dry = applyLeadMagnet({ projectDir: dir, key: "list", title: "List", url: "https://example.test/l.pdf", dryRun: true });
  assert.equal(dry.action, "added");
  assert.deepEqual(read(dir), {});

  applyLeadMagnet({ projectDir: dir, key: "list", title: "List", url: "https://example.test/l.pdf" });
  const removed = applyLeadMagnet({ projectDir: dir, key: "list", remove: true });
  assert.equal(removed.action, "removed");
  assert.deepEqual(read(dir), {});
  assert.equal(applyLeadMagnet({ projectDir: dir, key: "list", remove: true }).ok, false);
});

await test("warns about what a delivery needs", () => {
  const dir = serverProject("CRON_SECRET=x\n");
  const result = applyLeadMagnet({ projectDir: dir, key: "pack", title: "Pack", object: "magnets/p.zip" });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => w.includes("BETTER_AUTH_URL")));
  assert.ok(result.warnings.some((w) => w.includes("S3_BUCKET_NAME")));
  assert.ok(!result.warnings.some((w) => w.includes("NEWSLETTER_TOKEN_SECRET")), "CRON_SECRET is the fallback");
});

await test("a static site's newsletter Worker: edits its magnets.json, warns without a MAGNETS binding", () => {
  const WORKER = "workers/newsletter/src/magnets.json";
  const dir = project({
    [WORKER]: "{}\n",
    "workers/newsletter/wrangler.jsonc": '{\n  // "r2_buckets": [{ "binding": "MAGNETS", "bucket_name": "x" }],\n}\n',
  });
  assert.equal(findMagnetsFile(dir)?.kind, "worker");
  const result = applyLeadMagnet({ projectDir: dir, key: "pack", title: "Pack", object: "magnets/p.zip" });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => w.includes("MAGNETS")));
  assert.deepEqual(read(dir, WORKER), { pack: { title: "Pack", object: "magnets/p.zip" } });
});

await test("a project whose newsletter predates magnets, or has none, is told what to do", () => {
  const old = project({
    "packages/server/package.json": "{}",
    "packages/server/src/index.ts": "",
    "packages/server/src/services/newsletter/routes.ts": "",
  });
  const result = applyLeadMagnet({ projectDir: old, key: "x", title: "x", url: "https://example.test/x" });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /predates lead magnets/);

  const none = applyLeadMagnet({ projectDir: project({ "README.md": "" }) });
  assert.match(none.errors[0], /no newsletter service/);
});

const failed = Object.entries(results).filter(([, ok]) => !ok);
console.log(`\nlead-magnet: ${Object.keys(results).length - failed.length}/${Object.keys(results).length} passed`);
if (failed.length) process.exit(1);
