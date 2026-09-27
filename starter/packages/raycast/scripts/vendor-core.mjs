#!/usr/bin/env node
/**
 * Copy the shared client core into `src/vendor/`.
 *
 * ============================================================
 * WHY A COPY AT ALL
 * ============================================================
 *
 * The Raycast Store builds this extension ON ITS OWN, from the package
 * directory alone, with a plain `npm install`. A `workspace:*` dependency
 * cannot resolve there — there is no workspace — so the extension cannot
 * import the shared client core the way every other client does. It imports
 * `src/vendor/index` instead, and this script keeps that directory identical
 * to the source packages.
 *
 * A stale copy is a silent behaviour fork: the launcher's offline queue would
 * classify a failure differently from the web app's, replay rows the others
 * hold, or drop rows the others keep — and it would still work, which is what
 * makes it dangerous. `--check` is therefore part of the unit test run.
 *
 * NEVER EDIT `src/vendor/`. Every file there says so in its own header, and
 * the next `vendor` run overwrites whatever was changed.
 *
 * ============================================================
 * TWO CLOSURES, AND GETTING THEM THE SAME IS THE BUG
 * ============================================================
 *
 * · The COPY set is the closure over ALL imports, type-only included. TypeScript
 *   needs every declaration a copied file mentions, even one that compiles to
 *   nothing.
 *
 * · The BARREL's VALUE re-exports are the closure over VALUE imports only. A
 *   file that is reached only as a type must never appear in an `export { … }`
 *   line, because that is a runtime import: the bundler then pulls the module
 *   — and everything IT imports at runtime — into every command that touches
 *   the barrel. The concrete case this guards is a schema file reached for one
 *   `import type`, which would drag the whole validation library into five
 *   command bundles for a type that compiles to nothing. {@link checkTypeOnlyBleed}
 *   refuses it.
 *
 * ============================================================
 * WHAT IS REWRITTEN, AND WHAT IS NOT
 * ============================================================
 *
 * Only import specifiers. Everything else is byte-for-byte, so a diff between
 * a vendored file and its source is always a real difference.
 *
 * Two rewrites:
 *  · A cross-package specifier is resolved to the file that DECLARES each
 *    imported name, and one import statement becomes several when the names
 *    come from several files. The vendored tree is flat, so there is no
 *    package to resolve any more.
 *  · every relative specifier loses its `.js` extension. The source packages
 *    are NodeNext and spell `./ids.js`; this package is compiled with
 *    CommonJS/node10 resolution (see tsconfig.json), which does not map that
 *    back to `ids.ts`.
 *
 * Usage:
 *   node scripts/vendor-core.mjs            write the vendored tree
 *   node scripts/vendor-core.mjs --check    report missing, stale and orphaned
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = resolve(HERE, "..");
const WORKSPACE_PACKAGES = resolve(PACKAGE_ROOT, "..");

/**
 * The packages a name may be resolved through, and their barrels.
 *
 * The specifiers are READ from the sibling manifests rather than written down
 * here. Scaffolding does not rename the workspace packages, so the scope on
 * disk is the one a generated import has to name — and a literal here would be
 * a second place that scope lived, wrong in exactly the projects that renamed
 * it. A missing sibling is an error, not a skip: this extension's prerequisite
 * is the shared client core, and half a vendored tree does not compile.
 */
const SOURCES = ["core", "shared"].map((directory) => {
  const dir = join(WORKSPACE_PACKAGES, directory, "src");
  const manifest = join(WORKSPACE_PACKAGES, directory, "package.json");
  if (!existsSync(manifest)) {
    throw new Error(
      `packages/${directory} is missing. The launcher extension vendors it, so it cannot be built without it.`,
    );
  }
  return { specifier: JSON.parse(readFileSync(manifest, "utf-8")).name, dir };
});

const VENDOR_DIR = join(PACKAGE_ROOT, "src", "vendor");
const SRC_DIR = join(PACKAGE_ROOT, "src");
const BARREL = "index.ts";

const HEADER_LINES = [
  "// GENERATED — DO NOT EDIT.",
  "//",
  "// A byte-for-byte copy of a file in the shared client core, with its import",
  "// specifiers rewritten for this flat directory. Written by",
  "// `scripts/vendor-core.mjs`; `npm test` fails when it is stale.",
  "//",
  "// Edit the source package and re-run the generator. An edit made here is",
  "// silently overwritten on the next run, and until then this surface behaves",
  "// differently from every other client.",
];

/* ================================================================== */
/* Reading imports                                                    */
/* ================================================================== */

/**
 * Every `import` in `text`, as `{ specifier, names, wholeStatement }`.
 *
 * Deliberately narrow: named imports and side-effect imports only. A default
 * import, a namespace import (`import * as x`) or an `export … from` in a
 * source file is REFUSED rather than ignored, because ignoring one would
 * silently leave a name out of the copy set and the failure would be a missing
 * module at build time on somebody else's machine.
 */
export function readImports(text, where) {
  const imports = [];
  // Anchored at the start of a line, and `m`, so the word "import" inside a
  // comment or a string cannot start a match that then runs to the next real
  // `from "…"` — which is exactly what the generated headers made it do.
  const statement = /^import\s+([\s\S]*?)\s*from\s*["']([^"']+)["'];?/gm;
  for (const match of text.matchAll(statement)) {
    const clause = match[1].trim();
    const specifier = match[2];
    const typeOnlyClause = /^type\s+\{/.test(clause);
    const braces = clause.replace(/^type\s+/, "").trim();
    if (!braces.startsWith("{")) {
      throw new Error(
        `${where}: default and namespace imports are not supported by the vendor generator (${clause} from "${specifier}").`,
      );
    }
    if (!braces.endsWith("}")) {
      throw new Error(`${where}: could not read the import clause ${JSON.stringify(clause)}.`);
    }
    const names = braces
      .slice(1, -1)
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "")
      .map((part) => {
        const typeOnly = typeOnlyClause || part.startsWith("type ");
        const name = part
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)[0]
          .trim();
        return { name, typeOnly };
      });
    imports.push({ specifier, names, statement: match[0] });
  }
  return imports;
}

/** `.ts` files under `dir`, recursively, skipping `skip`. */
function filesUnder(dir, skip = []) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (skip.some((s) => path === s)) continue;
    if (entry.isDirectory()) out.push(...filesUnder(path, skip));
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/* ================================================================== */
/* Resolving a name to the file that declares it                      */
/* ================================================================== */

const DECLARATION =
  /^export\s+(?:declare\s+)?(?:abstract\s+)?(const|let|var|function|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm;

/** Exported names in one source file, each flagged as a type or a value. */
export function declaredNames(text) {
  const names = new Map();
  for (const match of text.matchAll(DECLARATION)) {
    const kind = match[1];
    names.set(match[2], kind === "type" || kind === "interface");
  }
  return names;
}

/**
 * name -> { file, isType } across every source package, resolved through the
 * barrels the way an importer would.
 *
 * A barrel line this cannot read is an error, not a skip: a silently dropped
 * `export *` is a name that resolves to nothing, and the build failure lands
 * on whoever next runs the generator rather than on whoever changed the
 * barrel.
 */
export function buildNameIndex() {
  const index = new Map();
  const byBasename = new Map();
  for (const source of SOURCES) {
    const barrel = join(source.dir, "index.ts");
    const text = readFileSync(barrel, "utf-8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      if (trimmed.startsWith("/*")) continue;
      const star = /^export\s+\*\s+from\s+["']([^"']+)["'];?$/.exec(trimmed);
      if (star === null) {
        if (trimmed.startsWith("export")) {
          throw new Error(`${barrel}: the vendor generator cannot read "${trimmed}".`);
        }
        continue;
      }
      const target = star[1];
      // A barrel re-exporting another package's barrel (core does this for
      // shared). Its names are picked up when that package is walked.
      if (!target.startsWith(".")) continue;
      const file = join(source.dir, target.replace(/\.js$/, ".ts"));
      const seen = byBasename.get(basename(file));
      if (seen !== undefined && seen !== file) {
        throw new Error(
          `The vendored tree is flat, so two source files cannot share a basename: ${seen} and ${file}.`,
        );
      }
      byBasename.set(basename(file), file);
      for (const [name, isType] of declaredNames(readFileSync(file, "utf-8"))) {
        const previous = index.get(name);
        if (previous !== undefined && previous.file !== file) {
          throw new Error(
            `"${name}" is exported by both ${previous.file} and ${file}; the vendor barrel cannot say which.`,
          );
        }
        index.set(name, { file, isType });
      }
    }
  }
  return index;
}

/* ================================================================== */
/* The two closures                                                   */
/* ================================================================== */

/**
 * What the extension asks of the barrel: name -> typeOnly.
 *
 * A name imported as a value ANYWHERE is a value. One type-only import site
 * does not make a value import disappear.
 */
export function readBarrelUsage() {
  const used = new Map();
  for (const file of filesUnder(SRC_DIR, [VENDOR_DIR])) {
    const text = readFileSync(file, "utf-8");
    for (const entry of readImports(text, relative(PACKAGE_ROOT, file))) {
      if (!/(^|\/)vendor$/.test(entry.specifier.replace(/\.js$/, ""))) continue;
      for (const { name, typeOnly } of entry.names) {
        used.set(name, (used.get(name) ?? true) && typeOnly);
      }
    }
  }
  return used;
}

/**
 * The copy set, and how each file was reached.
 *
 * `typeOnly` on a file means every edge that reached it was a type-only
 * import. That is the flag the barrel and {@link checkTypeOnlyBleed} read; it
 * is NOT a reason to leave the file out of the copy.
 */
export function buildCopySet(used, index) {
  const reached = new Map();
  const queue = [];

  const visit = (file, typeOnly) => {
    const seen = reached.get(file);
    if (seen === undefined) {
      reached.set(file, { typeOnly });
      queue.push(file);
      return;
    }
    // A value edge to a file already reached type-only upgrades it, and the
    // whole closure below it has to be re-walked as values.
    if (seen.typeOnly && !typeOnly) {
      seen.typeOnly = false;
      queue.push(file);
    }
  };

  for (const [name, typeOnly] of used) {
    const found = index.get(name);
    if (found === undefined) {
      throw new Error(
        `src/ imports "${name}" from the vendor barrel, but no source package exports it.`,
      );
    }
    visit(found.file, typeOnly || found.isType);
  }

  while (queue.length > 0) {
    const file = queue.shift();
    const entry = reached.get(file);
    const text = readFileSync(file, "utf-8");
    for (const imported of readImports(text, file)) {
      const targets = resolveSpecifier(file, imported, index);
      for (const target of targets) {
        // An import inside a type-only file is still type-only from the root's
        // point of view; an import inside a value file inherits the edge.
        visit(target.file, entry.typeOnly || target.typeOnly);
      }
    }
  }
  return reached;
}

/**
 * Which source files one import statement reaches, and whether the edge is
 * type-only. A bare package specifier reaches nothing and is reported by
 * {@link checkDeclaredDependencies} instead.
 */
function resolveSpecifier(fromFile, imported, index) {
  const { specifier, names } = imported;
  if (specifier.startsWith(".")) {
    const file = join(dirname(fromFile), specifier.replace(/\.js$/, ".ts"));
    const typeOnly = names.every((n) => n.typeOnly);
    return [{ file, typeOnly }];
  }
  if (!SOURCES.some((source) => source.specifier === specifier)) return [];
  const byFile = new Map();
  for (const { name, typeOnly } of names) {
    const found = index.get(name);
    if (found === undefined) {
      throw new Error(`${fromFile} imports "${name}" from ${specifier}, which does not export it.`);
    }
    const current = byFile.get(found.file);
    const edgeTypeOnly = typeOnly || found.isType;
    byFile.set(found.file, {
      file: found.file,
      typeOnly: (current?.typeOnly ?? true) && edgeTypeOnly,
    });
  }
  return [...byFile.values()];
}

/* ================================================================== */
/* Rendering                                                          */
/* ================================================================== */

/** One vendored file's contents: the header, then the body with its imports rewritten. */
export function renderVendoredFile(fromFile, text, index) {
  let body = text;
  for (const imported of readImports(text, fromFile)) {
    body = body.replace(imported.statement, rewriteImport(fromFile, imported, index));
  }
  return `${HEADER_LINES.join("\n")}\n\n${body}`;
}

function rewriteImport(fromFile, imported, index) {
  const { specifier, names, statement } = imported;
  if (specifier.startsWith(".")) {
    return statement.replace(/["']([^"']+)["']/, `"./${basename(specifier.replace(/\.js$/, ""))}"`);
  }
  if (!SOURCES.some((source) => source.specifier === specifier)) return statement;

  // One statement becomes one per declaring file. Sorted, so a reordered
  // source import does not produce a spurious diff here.
  const byFile = new Map();
  for (const { name, typeOnly } of names) {
    const found = index.get(name);
    const target = basename(found.file, ".ts");
    const bucket = byFile.get(target) ?? { values: [], types: [] };
    if (typeOnly || found.isType) bucket.types.push(name);
    else bucket.values.push(name);
    byFile.set(target, bucket);
  }
  const lines = [];
  for (const target of [...byFile.keys()].sort()) {
    const { values, types } = byFile.get(target);
    if (values.length > 0) {
      lines.push(`import { ${values.sort().join(", ")} } from "./${target}";`);
    }
    if (types.length > 0) {
      lines.push(`import type { ${types.sort().join(", ")} } from "./${target}";`);
    }
  }
  return lines.join("\n");
}

/** The barrel: exactly the names `src/` uses, grouped by declaring file. */
export function renderBarrel(used, index) {
  const byFile = new Map();
  for (const [name, typeOnly] of used) {
    const found = index.get(name);
    const target = basename(found.file, ".ts");
    const bucket = byFile.get(target) ?? { values: [], types: [] };
    // A `type`/`interface` declaration is always re-exported with
    // `export type`: `isolatedModules` cannot tell otherwise, and a plain
    // re-export of a type is a runtime import of a name that does not exist.
    if (typeOnly || found.isType) bucket.types.push(name);
    else bucket.values.push(name);
    byFile.set(target, bucket);
  }

  const lines = [
    "// GENERATED — DO NOT EDIT.",
    "//",
    "// The vendored surface of the shared client core: exactly the names this",
    "// extension imports, and nothing else. Written by `scripts/vendor-core.mjs`.",
    "//",
    "// A name is re-exported as `export type` whenever it is a type declaration or",
    "// is only ever imported as one. That distinction is load-bearing: `export {`",
    "// is a RUNTIME import, so value-exporting a module that exists only for its",
    "// types pulls that module — and everything it imports at runtime — into every",
    "// command bundle.",
    "",
  ];
  for (const target of [...byFile.keys()].sort()) {
    const { values, types } = byFile.get(target);
    if (values.length > 0) {
      lines.push(`export { ${values.sort().join(", ")} } from "./${target}";`);
    }
    if (types.length > 0) {
      lines.push(`export type { ${types.sort().join(", ")} } from "./${target}";`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/* ================================================================== */
/* Refusals                                                           */
/* ================================================================== */

/**
 * Refuse a type-only file that would drag a runtime package in.
 *
 * A file reached only through `import type` compiles to nothing — unless it is
 * value-exported from the barrel or imports a package at runtime, in which case
 * the bundler keeps the module and its dependencies. The case worth naming: a
 * shared schemas file reached for one exported type, which would put the whole
 * validation library into all five command bundles.
 */
export function checkTypeOnlyBleed(copySet, used, index, problems) {
  const valueExported = new Set();
  for (const [name, typeOnly] of used) {
    const found = index.get(name);
    if (!typeOnly && !found.isType) valueExported.add(found.file);
  }
  for (const [file, how] of copySet) {
    if (!how.typeOnly) continue;
    if (valueExported.has(file)) {
      problems.push(
        `${relative(WORKSPACE_PACKAGES, file)} is only ever imported as a type, but the barrel would export a value from it.`,
      );
    }
    for (const imported of readImports(readFileSync(file, "utf-8"), file)) {
      if (imported.specifier.startsWith(".")) continue;
      if (SOURCES.some((source) => source.specifier === imported.specifier)) continue;
      problems.push(
        `${relative(WORKSPACE_PACKAGES, file)} is reached only as a type but imports "${imported.specifier}" at runtime. Vendoring it would put that package in every command bundle — import the value you need explicitly, or stop importing this module.`,
      );
    }
  }
}

/**
 * Refuse vendored code that imports a package this manifest does not declare.
 *
 * The store builds this package alone with `npm install`, so an undeclared
 * import fails there and nowhere else — on somebody else's machine, after the
 * submission.
 */
export function checkDeclaredDependencies(copySet, problems) {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8"));
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ]);
  for (const file of copySet.keys()) {
    for (const imported of readImports(readFileSync(file, "utf-8"), file)) {
      const { specifier } = imported;
      if (specifier.startsWith(".")) continue;
      if (SOURCES.some((source) => source.specifier === specifier)) continue;
      const pkg = specifier.startsWith("@")
        ? specifier.split("/").slice(0, 2).join("/")
        : specifier.split("/")[0];
      if (declared.has(pkg)) continue;
      problems.push(
        `${relative(WORKSPACE_PACKAGES, file)} imports "${specifier}", which packages/raycast/package.json does not declare. The store's build machine would be the first place this fails.`,
      );
    }
  }
}

/* ================================================================== */
/* Plan / write / check                                               */
/* ================================================================== */

/** What the vendored tree should contain: filename -> contents. */
export function plan() {
  const index = buildNameIndex();
  const used = readBarrelUsage();
  const copySet = buildCopySet(used, index);

  const problems = [];
  checkTypeOnlyBleed(copySet, used, index, problems);
  checkDeclaredDependencies(copySet, problems);
  if (problems.length > 0) {
    throw new Error(`The vendored tree would be unsafe:\n  · ${problems.join("\n  · ")}`);
  }

  const files = new Map();
  for (const file of copySet.keys()) {
    files.set(
      `${basename(file, ".ts")}.ts`,
      renderVendoredFile(file, readFileSync(file, "utf-8"), index),
    );
  }
  files.set(BARREL, renderBarrel(used, index));
  return files;
}

function write(files) {
  if (existsSync(VENDOR_DIR)) rmSync(VENDOR_DIR, { recursive: true, force: true });
  mkdirSync(VENDOR_DIR, { recursive: true });
  for (const [name, contents] of files) {
    writeFileSync(join(VENDOR_DIR, name), contents, "utf-8");
  }
}

/** Missing, stale and orphaned files, as sentences. Empty means in step. */
export function check(files = plan()) {
  const problems = [];
  const onDisk = existsSync(VENDOR_DIR)
    ? new Set(readdirSync(VENDOR_DIR).filter((name) => name.endsWith(".ts")))
    : new Set();
  for (const [name, contents] of files) {
    if (!onDisk.has(name)) {
      problems.push(`missing: src/vendor/${name}`);
      continue;
    }
    if (readFileSync(join(VENDOR_DIR, name), "utf-8") !== contents) {
      problems.push(`stale: src/vendor/${name}`);
    }
  }
  for (const name of onDisk) {
    if (!files.has(name)) problems.push(`orphaned: src/vendor/${name}`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const checking = process.argv.includes("--check");
  try {
    const files = plan();
    if (checking) {
      const problems = check(files);
      if (problems.length > 0) {
        console.error("The vendored copy is out of step with the source packages:");
        for (const problem of problems) console.error(`  · ${problem}`);
        console.error("\nRun `npm run vendor` and commit the result.");
        process.exit(1);
      }
      console.log(`vendor: ${files.size} file(s) in step`);
    } else {
      write(files);
      console.log(`vendor: wrote ${files.size} file(s) to src/vendor/`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
