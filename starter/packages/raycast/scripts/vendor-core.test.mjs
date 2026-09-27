/**
 * The vendored tree is a generated copy, so the only thing that keeps it
 * honest is a test that regenerates it and compares.
 *
 * A stale copy does not fail anywhere else. The extension still builds, still
 * runs, and still queues and replays work — slightly differently from every
 * other client, because it is running an older copy of the rules. That is why
 * this is in the default test run rather than in a release check.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PACKAGE_ROOT,
  check,
  checkDeclaredDependencies,
  checkTypeOnlyBleed,
  plan,
  readImports,
} from "./vendor-core.mjs";

const VENDOR_DIR = join(PACKAGE_ROOT, "src", "vendor");

test("the committed vendor tree is byte-for-byte what the generator writes", () => {
  // `plan()` renders into memory; `check()` compares every rendered file
  // against the one on disk and reports missing, stale and orphaned.
  const problems = check(plan());
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("no vendored file still imports across a package or with a .js extension", () => {
  for (const name of readdirSync(VENDOR_DIR)) {
    const text = readFileSync(join(VENDOR_DIR, name), "utf-8");
    for (const { specifier } of readImports(text, name)) {
      assert.ok(
        !specifier.startsWith("@starter/"),
        `${name} still imports "${specifier}" — the flat copy has no such package.`,
      );
      assert.ok(
        !(specifier.startsWith(".") && specifier.endsWith(".js")),
        `${name} imports "${specifier}"; the bundler and the typechecker both want it extensionless.`,
      );
    }
  }
});

test("the barrel exports a type-only module only as a type", () => {
  const barrel = readFileSync(join(VENDOR_DIR, "index.ts"), "utf-8");
  // `types.ts` is the shared domain types, reached from `src/` and from the
  // vendored core only through `import type`. A plain `export … from` of it
  // would be a runtime import of a module that compiles to nothing — and the
  // same mistake on the schemas module would pull the validation library into
  // every command bundle.
  for (const line of barrel.split("\n")) {
    if (!line.includes('from "./types"')) continue;
    assert.ok(
      line.startsWith("export type {"),
      `the barrel value-exports the type-only module: ${line}`,
    );
  }
});

test("every package the vendored tree imports is declared in this manifest", () => {
  // The store builds this package alone with a plain install, so an undeclared
  // import fails there and nowhere else.
  const problems = [];
  const files = new Map();
  for (const name of readdirSync(VENDOR_DIR))
    files.set(join(VENDOR_DIR, name), { typeOnly: false });
  checkDeclaredDependencies(files, problems);
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("readImports reads both spellings of a type-only import", () => {
  const source = [
    'import type { A } from "./a.js";',
    'import { type B, c } from "./b.js";',
    'import { d } from "zod";',
  ].join("\n");
  const imports = readImports(source, "fixture");
  assert.deepEqual(imports[0].names, [{ name: "A", typeOnly: true }]);
  assert.deepEqual(imports[1].names, [
    { name: "B", typeOnly: true },
    { name: "c", typeOnly: false },
  ]);
  assert.equal(imports[2].specifier, "zod");
});

test("a type-only module that imports a runtime package is refused", () => {
  // The failure this exists for: a schemas module reached for one exported
  // type. It compiles to nothing on its own, but vendoring it puts its
  // validation library in every command bundle.
  const dir = mkdtempSync(join(tmpdir(), "vendor-bleed-"));
  try {
    const schemas = join(dir, "schemas.ts");
    writeFileSync(schemas, 'import { z } from "zod";\nexport type Thing = { a: string };\n');
    const problems = [];
    checkTypeOnlyBleed(new Map([[schemas, { typeOnly: true }]]), new Map(), new Map(), problems);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /reached only as a type but imports "zod"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check reports a stale file, a missing one and an orphan", () => {
  const files = new Map([
    ["index.ts", "different"],
    ["nope.ts", "x"],
  ]);
  const problems = check(files);
  assert.ok(
    problems.some((p) => p === "stale: src/vendor/index.ts"),
    problems.join("\n"),
  );
  assert.ok(
    problems.some((p) => p === "missing: src/vendor/nope.ts"),
    problems.join("\n"),
  );
  assert.ok(
    problems.some((p) => p.startsWith("orphaned: src/vendor/api-client.ts")),
    problems.join("\n"),
  );
});

test("every vendored file carries the do-not-edit header", () => {
  for (const name of readdirSync(VENDOR_DIR)) {
    const first = readFileSync(join(VENDOR_DIR, name), "utf-8").split("\n")[0];
    assert.equal(first, "// GENERATED — DO NOT EDIT.", `${name} has no generated header`);
  }
});

test("the vendored tree is linted and formatted by nobody", () => {
  // A byte-for-byte copy formatted by this package's settings shows up as
  // drift on every regeneration, and a lint fix here is overwritten.
  const ignore = readFileSync(join(PACKAGE_ROOT, ".prettierignore"), "utf-8");
  assert.match(ignore, /^src\/vendor\/$/m);
  const eslint = readFileSync(join(PACKAGE_ROOT, "eslint.config.mjs"), "utf-8");
  assert.match(eslint, /ignores:.*src\/vendor/);
});

test("a fresh render into a temp directory matches the committed tree", () => {
  const dir = mkdtempSync(join(tmpdir(), "vendor-roundtrip-"));
  try {
    mkdirSync(join(dir, "vendor"));
    const files = plan();
    for (const [name, contents] of files) writeFileSync(join(dir, "vendor", name), contents);
    for (const [name] of files) {
      assert.equal(
        readFileSync(join(dir, "vendor", name), "utf-8"),
        readFileSync(join(VENDOR_DIR, name), "utf-8"),
        `${name} differs from the committed copy`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
