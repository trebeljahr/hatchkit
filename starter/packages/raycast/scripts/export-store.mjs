#!/usr/bin/env node
/**
 * Write the standalone, publishable copy of this extension.
 *
 * ============================================================
 * WHY AN EXPORT AND NOT A PUBLISH FROM HERE
 * ============================================================
 *
 * The workspace package cannot be published as it stands. Its `name` and
 * `author` are scaffold placeholders and both are PERMANENT after the first
 * publish; its scripts run a vendor step and a package manager that do not
 * exist outside this repository; its development build points at localhost;
 * and its comments name tooling a store reader has no way to look at.
 *
 * So publishing goes: export, inspect, publish the copy. `npm run publish` in
 * the workspace package is a guard that exits (scripts/refuse-publish.mjs).
 *
 * ============================================================
 * WHAT IS REWRITTEN — THREE THINGS, AND NOTHING ELSE
 * ============================================================
 *
 * 1. `src/lib/local-defaults.ts` flips to `false`, so a store reviewer's
 *    `ray develop` run reaches the hosted service instead of a port nothing is
 *    serving on their machine.
 * 2. The vendored files' headers stop naming the generator.
 * 3. The prettier and eslint comments stop naming it.
 *
 * Then every copied file is re-read and the export throws if anything still
 * names the tooling. That check is what keeps the rewrite list honest: the
 * repository is free to name the generator anywhere, and the export is the
 * place that finds out.
 *
 * Usage:
 *   node scripts/export-store.mjs <dir> --license <spdx> --author <handle>
 *                                 [--lint] [--build] [--draft]
 *
 * `--license` and `--author` are DECISIONS and have no defaults. A wrong
 * author or license committed to the repository would otherwise be published
 * silently, and the author is half the key the launcher stores every install's
 * credential under.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");
const WORKSPACE_PACKAGES = resolve(PACKAGE_ROOT, "..");

/**
 * Exactly what the store copy contains. A list, not a glob with exclusions:
 * a new file in the repository is left out until somebody decides it belongs
 * in a published package, which is the safe direction to be wrong in.
 */
const COPY = [
  "package.json",
  "tsconfig.json",
  "raycast-env.d.ts",
  "eslint.config.mjs",
  ".prettierrc",
  ".prettierignore",
  "README.md",
  "assets",
  "src",
];

/** The store copy's scripts, verbatim from the launcher's own template. */
const STORE_SCRIPTS = {
  build: "ray build",
  dev: "ray develop",
  "fix-lint": "ray lint --fix",
  lint: "ray lint",
  publish: "npx @raycast/api@latest publish",
};

/**
 * Names for the tooling that produced this copy. None may survive the export.
 *
 * Deliberately narrow: this is the BUILD SYSTEM's vocabulary, not the
 * project's. A comment in the copy that mentions the shared client core is
 * fine and often useful; one that tells a store reader to run a script they do
 * not have is not.
 */
const TOOLING_MARKERS = ["vendor-core", "export-store", "run vendor", "refuse-publish"];

/**
 * Names for the monorepo, refused in the README and in any user-VISIBLE string
 * in `src/`.
 *
 * The README is the store page: a reader of it has no repository. And a string
 * literal that reaches a toast or a menu title is read by somebody who has no
 * way to act on "run pnpm install".
 */
const MONOREPO_MARKERS = [
  "workspace:",
  "pnpm",
  "packages/core",
  "packages/shared",
  "packages/raycast",
  "monorepo",
  "node_modules",
];

/* ================================================================== */
/* Arguments                                                          */
/* ================================================================== */

function parseArgs(argv) {
  const options = {
    dir: null,
    license: null,
    author: null,
    lint: false,
    build: false,
    draft: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--lint") options.lint = true;
    else if (arg === "--build") options.build = true;
    else if (arg === "--draft") options.draft = true;
    else if (arg === "--license") options.license = argv[++i] ?? null;
    else if (arg === "--author") options.author = argv[++i] ?? null;
    else if (arg.startsWith("--")) throw new Error(`Unknown flag "${arg}".`);
    else if (options.dir === null) options.dir = arg;
    else throw new Error(`Unexpected argument "${arg}".`);
  }
  if (options.dir === null) throw new Error("Give the directory to export into.");
  if (options.license === null) {
    throw new Error("--license is required. It is a decision, so it has no default.");
  }
  if (options.author === null) {
    throw new Error(
      "--author is required. It is a decision, and it is half the key the launcher stores every install's credential under — see PUBLISHING.md.",
    );
  }
  if (options.build && options.draft) {
    throw new Error("--build and --draft are mutually exclusive: a draft is not a submission.");
  }
  return options;
}

/**
 * Refuse a destination that would destroy something.
 *
 * The export CLEARS its directory, so a mistyped path is a delete. Anything
 * inside the repository, a home directory, a filesystem root, or an existing
 * directory that is not a previous export of this package is refused.
 */
export function checkOutDir(dir, packageRoot = PACKAGE_ROOT) {
  const target = resolve(dir);
  const inside = (parent, child) => child === parent || child.startsWith(parent + sep);
  if (target === resolve("/")) throw new Error("Refusing to export into the filesystem root.");
  if (target === resolve(homedir()))
    throw new Error("Refusing to export into your home directory.");
  if (inside(target, packageRoot)) {
    throw new Error(`Refusing to export into ${target}: it contains this package.`);
  }
  if (inside(packageRoot, target)) {
    throw new Error(`Refusing to export into ${target}: it is inside this package.`);
  }
  if (!existsSync(target)) return target;
  if (!statSync(target).isDirectory()) throw new Error(`${target} is not a directory.`);
  const entries = readdirSync(target);
  if (entries.length === 0) return target;
  const manifest = join(target, "package.json");
  if (!existsSync(manifest)) {
    throw new Error(`Refusing to clear ${target}: it is not empty and holds no package.json.`);
  }
  const name = JSON.parse(readFileSync(manifest, "utf-8")).name;
  const ours = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf-8")).name;
  if (name !== ours) {
    throw new Error(`Refusing to clear ${target}: it holds "${name}", not a copy of "${ours}".`);
  }
  return target;
}

/* ================================================================== */
/* The manifest                                                       */
/* ================================================================== */

/**
 * An npm range the store's build machine can install.
 *
 * A `workspace:`, `link:`, `file:` or `catalog:` specifier resolves only in
 * this repository. Left in, it fails on the store's build machine — after the
 * submission, where the error is somebody else's — so it is thrown here with
 * the only real answer: vendor the code instead.
 */
export function storeRange(name, range) {
  if (typeof range !== "string") throw new Error(`${name}: dependency range is not a string.`);
  for (const local of ["workspace:", "link:", "file:", "catalog:", "portal:"]) {
    if (range.startsWith(local)) {
      throw new Error(
        `"${name}": "${range}" cannot be installed from the public registry. Vendor that code into src/vendor/ instead — the store builds this package on its own, with no workspace around it.`,
      );
    }
  }
  return range;
}

/** The store copy's package.json: no repo notes, no repo scripts, real metadata. */
export function storeManifest(manifest, { author, license }) {
  const out = {};
  for (const [key, value] of Object.entries(manifest)) {
    // `//`-prefixed keys are notes for whoever works in the repository.
    if (key.startsWith("//")) continue;
    out[key] = value;
  }
  out.author = author;
  out.license = license;
  out.scripts = { ...STORE_SCRIPTS };
  for (const section of ["dependencies", "devDependencies"]) {
    const deps = manifest[section];
    if (deps === undefined) continue;
    const converted = {};
    for (const [name, range] of Object.entries(deps)) {
      if (name.startsWith("//")) continue;
      converted[name] = storeRange(name, range);
    }
    out[section] = converted;
  }
  // Each command may carry its own notes.
  if (Array.isArray(out.commands)) {
    out.commands = out.commands.map((command) =>
      Object.fromEntries(Object.entries(command).filter(([key]) => !key.startsWith("//"))),
    );
  }
  return out;
}

/* ================================================================== */
/* The three rewrites                                                 */
/* ================================================================== */

const STORE_VENDOR_HEADER = [
  "// Vendored from the project's shared client core.",
  "//",
  "// This directory is a copy, kept identical to the source it was taken from.",
  "// Changes belong in the project, not here.",
].join("\n");

/** `true` -> `false` on the one exported flag, and nowhere else. */
export function flipLocalDefault(text) {
  const rewritten = text.replace(
    /export const USE_LOCAL_DEV_ORIGINS = true;/,
    "export const USE_LOCAL_DEV_ORIGINS = false;",
  );
  if (rewritten === text) {
    throw new Error("src/lib/local-defaults.ts no longer carries the flag the export flips.");
  }
  return rewritten;
}

/** Replace a vendored file's generator header with one a store reader can use. */
export function rewriteVendorHeader(text) {
  const lines = text.split("\n");
  let end = 0;
  while (end < lines.length && lines[end].startsWith("//")) end += 1;
  if (end === 0) return text;
  return [STORE_VENDOR_HEADER, ...lines.slice(end)].join("\n");
}

/** The store copy's reason for excluding the vendored tree, in two shapes. */
const STORE_IGNORE_REASON = [
  "src/vendor/ is a copy of the project's shared client core, kept identical",
  "to the source it was taken from. Formatting or fixing it here produces a",
  "diff that the next copy overwrites, so every regeneration reads as drift.",
];

/**
 * Replace a config file's LEADING comment block wholesale, rather than
 * patching the lines that name the tooling.
 *
 * Per-line substitution looked tidier and produced a comment that contradicted
 * itself halfway through — the surviving lines were written to follow the ones
 * that were replaced. A reader of the store copy gets one paragraph that makes
 * sense on its own; the rule underneath it is untouched.
 */
export function rewriteConfigComments(text) {
  if (text.startsWith("/**")) {
    const end = text.indexOf("*/");
    if (end === -1) return text;
    const block = ["/**", ...STORE_IGNORE_REASON.map((line) => ` * ${line}`), " */"].join("\n");
    return `${block}${text.slice(end + 2)}`;
  }
  const lines = text.split("\n");
  let first = 0;
  while (first < lines.length && (lines[first].startsWith("#") || lines[first] === "")) first += 1;
  return [...STORE_IGNORE_REASON.map((line) => `# ${line}`), "", ...lines.slice(first)].join("\n");
}

/* ================================================================== */
/* The refusals                                                       */
/* ================================================================== */

/** `text` with every comment blanked, so only real code is left. */
export function withoutComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/([^:"'`\\])\/\/.*$/gm, "$1");
}

/** Every string literal in `code`. */
export function stringLiterals(code) {
  const found = [];
  for (const match of code.matchAll(/"([^"\\\n]*(?:\\.[^"\\\n]*)*)"|`([^`\\]*(?:\\.[^`\\]*)*)`/g)) {
    found.push(match[1] ?? match[2] ?? "");
  }
  return found;
}

/** Sentences naming problems with a finished export. Empty means publishable. */
export function auditExport(root) {
  const problems = [];

  for (const file of filesUnder(root)) {
    const rel = relative(root, file).split(sep).join("/");
    if (!/\.(ts|tsx|mjs|js|json|md|prettierrc|prettierignore)$/.test(rel) && !rel.includes(".")) {
      continue;
    }
    const text = readFileSync(file, "utf-8");

    for (const marker of TOOLING_MARKERS) {
      if (text.includes(marker)) {
        problems.push(`${rel} still names the tooling ("${marker}").`);
      }
    }

    if (rel === "README.md") {
      for (const marker of MONOREPO_MARKERS) {
        if (text.includes(marker)) {
          problems.push(`README.md names the monorepo ("${marker}"). It is the store page.`);
        }
      }
      continue;
    }

    // User-visible strings in src/, comments and the vendored tree excluded:
    // the vendored files are copies, and a comment is not shown to anybody.
    if (!rel.startsWith("src/") || rel.startsWith("src/vendor/")) continue;
    for (const literal of stringLiterals(withoutComments(text))) {
      for (const marker of MONOREPO_MARKERS) {
        if (literal.includes(marker)) {
          problems.push(`${rel} shows a string naming the monorepo: ${JSON.stringify(literal)}.`);
        }
      }
    }
  }
  return problems;
}

function filesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

/* ================================================================== */
/* The export                                                         */
/* ================================================================== */

const PLACEHOLDER_ORIGIN = ".starter.example";

function main() {
  const options = parseArgs(process.argv.slice(2));
  const target = checkOutDir(options.dir);

  const manifestText = readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8");
  const manifest = JSON.parse(manifestText);

  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });

  for (const entry of COPY) {
    const from = join(PACKAGE_ROOT, entry);
    if (!existsSync(from)) throw new Error(`${entry} is missing; the export list is out of date.`);
    cpSync(from, join(target, entry), { recursive: true });
  }
  // No build output: `dist/` is this machine's, and the store builds its own.
  rmSync(join(target, "src", "dist"), { recursive: true, force: true });

  writeFileSync(
    join(target, "package.json"),
    `${JSON.stringify(storeManifest(manifest, options), null, 2)}\n`,
    "utf-8",
  );

  const localDefaults = join(target, "src", "lib", "local-defaults.ts");
  writeFileSync(localDefaults, flipLocalDefault(readFileSync(localDefaults, "utf-8")), "utf-8");

  const vendorDir = join(target, "src", "vendor");
  for (const file of filesUnder(vendorDir)) {
    writeFileSync(file, rewriteVendorHeader(readFileSync(file, "utf-8")), "utf-8");
  }

  for (const config of [".prettierignore", "eslint.config.mjs"]) {
    const path = join(target, config);
    writeFileSync(path, rewriteConfigComments(readFileSync(path, "utf-8")), "utf-8");
  }

  const problems = auditExport(target);
  if (problems.length > 0) {
    throw new Error(`The exported copy is not publishable:\n  · ${problems.join("\n  · ")}`);
  }

  const originsArePlaceholders = readFileSync(
    join(target, "src", "lib", "preferences.ts"),
    "utf-8",
  ).includes(PLACEHOLDER_ORIGIN);
  if (originsArePlaceholders && !options.draft) {
    throw new Error(
      "src/lib/preferences.ts still carries the scaffold's placeholder release origins. Point them at the deployed service, or pass --draft to export anyway.",
    );
  }

  console.log(`export: wrote ${relative(process.cwd(), target) || target}`);
  if (options.draft) {
    console.warn(
      "export: DRAFT — the release origins are still placeholders. Do not publish this.",
    );
  }

  if (options.lint) run(target, ["lint", "-I"]);
  if (options.build) {
    // `ray build` with no `-o` writes into the launcher's installed-extensions
    // directory, which would install this copy over whatever is there.
    const out = mkdtempSync(join(tmpdir(), `${basename(target)}-build-`));
    try {
      run(target, ["build", "-e", "dist", "-o", out]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }
}

function run(cwd, args) {
  const bin = join(cwd, "node_modules", ".bin", "ray");
  if (!existsSync(bin)) {
    throw new Error(
      `Cannot run \`ray ${args[0]}\` in the exported copy: install its dependencies there first.`,
    );
  }
  execFileSync(bin, args, { cwd, stdio: "inherit" });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export { COPY, PACKAGE_ROOT, STORE_SCRIPTS, TOOLING_MARKERS, MONOREPO_MARKERS, WORKSPACE_PACKAGES };
