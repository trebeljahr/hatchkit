/**
 * The export is the only path to a published extension, and almost everything
 * it gets wrong fails on somebody else's machine — the store's build box, or a
 * reviewer's laptop — after the submission.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PACKAGE_ROOT,
  STORE_SCRIPTS,
  auditExport,
  checkOutDir,
  flipLocalDefault,
  rewriteConfigComments,
  rewriteVendorHeader,
  storeManifest,
  storeRange,
  stringLiterals,
  withoutComments,
} from "./export-store.mjs";

test("a specifier that only resolves in this repository is refused at export time", () => {
  // Left in, it installs fine here and fails on the store's build machine.
  for (const range of ["workspace:*", "link:../core", "file:../core", "catalog:default"]) {
    assert.throws(() => storeRange("@thing/core", range), /Vendor that code/);
  }
  assert.equal(storeRange("zod", "^4.4.3"), "^4.4.3");
});

test("the store manifest drops repository notes and takes the store's scripts", () => {
  const manifest = {
    name: "thing",
    "//name": "a note for whoever works here",
    author: "placeholder",
    license: "UNLICENSED",
    scripts: { dev: "pnpm run vendor && ray develop" },
    dependencies: { zod: "^4.4.3" },
    commands: [{ name: "one", "//mode": "why", mode: "view" }],
  };
  const out = storeManifest(manifest, { author: "real-handle", license: "MIT" });
  assert.equal(out["//name"], undefined);
  assert.equal(out.author, "real-handle");
  assert.equal(out.license, "MIT");
  assert.deepEqual(out.scripts, STORE_SCRIPTS);
  assert.deepEqual(out.commands, [{ name: "one", mode: "view" }]);
});

test("the export refuses a destination that would destroy something", () => {
  assert.throws(() => checkOutDir("/"), /filesystem root/);
  assert.throws(() => checkOutDir(homedir()), /home directory/);
  assert.throws(() => checkOutDir(PACKAGE_ROOT), /contains this package|inside this package/);
  assert.throws(() => checkOutDir(join(PACKAGE_ROOT, "src")), /inside this package/);

  const dir = mkdtempSync(join(tmpdir(), "export-dest-"));
  try {
    writeFileSync(join(dir, "important.txt"), "somebody's work");
    assert.throws(() => checkOutDir(dir), /not empty and holds no package.json/);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "something-else" }));
    assert.throws(() => checkOutDir(dir), /holds "something-else"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the development-origin flag is flipped, and its disappearance is an error", () => {
  assert.match(
    flipLocalDefault("export const USE_LOCAL_DEV_ORIGINS = true;\n"),
    /USE_LOCAL_DEV_ORIGINS = false;/,
  );
  // If the line is renamed and this is not, a store reviewer's first run
  // reaches localhost and the extension looks broken on review.
  assert.throws(() => flipLocalDefault("export const SOMETHING_ELSE = true;\n"), /no longer/);
});

test("the vendored header and the config comments stop naming the tooling", () => {
  const vendored = rewriteVendorHeader(
    "// GENERATED — DO NOT EDIT.\n// Written by `scripts/vendor-core.mjs`.\n\nexport const a = 1;\n",
  );
  assert.ok(!vendored.includes("vendor-core"));
  assert.ok(vendored.includes("export const a = 1;"));

  const ignore = rewriteConfigComments("# Written by scripts/vendor-core.mjs.\nsrc/vendor/\n");
  assert.ok(!ignore.includes("vendor-core"));
  assert.match(ignore, /^src\/vendor\/$/m);
});

test("the audit reads user-visible strings but not comments", () => {
  const dir = mkdtempSync(join(tmpdir(), "export-audit-"));
  try {
    mkdirSync(join(dir, "src", "lib"), { recursive: true });
    writeFileSync(join(dir, "README.md"), "# Fine\n");
    writeFileSync(
      join(dir, "src", "lib", "a.ts"),
      '// A comment about packages/core, which nobody reads in the store.\nexport const ok = "all good";\n',
    );
    assert.deepEqual(auditExport(dir), []);

    writeFileSync(
      join(dir, "src", "lib", "a.ts"),
      'export const toast = "Run pnpm install first";\n',
    );
    const problems = auditExport(dir);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /shows a string naming the monorepo/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the audit refuses a README that names the repository", () => {
  const dir = mkdtempSync(join(tmpdir(), "export-readme-"));
  try {
    writeFileSync(join(dir, "README.md"), "Clone the monorepo and run it.\n");
    const problems = auditExport(dir);
    assert.ok(
      problems.some((p) => p.includes("It is the store page.")),
      problems.join("\n"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("string extraction ignores what a comment says", () => {
  const code = withoutComments('/* "packages/core" */\nconst a = "kept"; // "dropped"\n');
  assert.deepEqual(stringLiterals(code), ["kept"]);
});
