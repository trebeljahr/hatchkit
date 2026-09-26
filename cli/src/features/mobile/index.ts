/*
 * cli/src/features/mobile/index.ts — the `mobile` (Capacitor) feature,
 * registered on `features/contract.ts`.
 *
 * The feature ships in `starter/`, so the two directions are not
 * symmetric and only one of them lives here:
 *
 *  - `create` copies the whole starter and SUBTRACTS what was not
 *    selected. That path is `scaffold/app.ts` plus the strippers in
 *    `scaffold/starter-files.ts`; nothing in this file runs.
 *  - `update` layers the feature onto an existing project, which is
 *    `apply` below.
 *
 * `scaffold/mobile-feature.ts` remains the ONE manifest of what the
 * feature consists of — the strip iterates it and so does `apply`, so a
 * file added to the starter cannot reach new scaffolds and no updated
 * project, or the reverse.
 *
 * ============================================================
 * WHY `apply` RUNS UNCONDITIONALLY
 * ============================================================
 *
 * `hatchkit update` adds FEATURES, and for a project that already has
 * Capacitor `mobile` is already in the manifest — so the add path never
 * fires and there is NO other path that reaches an existing mobile
 * project. A project scaffolded before `scripts/build-mobile.mjs`, the
 * storage tiers or the native stylesheets existed would therefore stay
 * missing all of them, permanently. `update` calls this feature on every
 * run for a project that has it (see `refreshRegisteredFeature` in
 * `scaffold/update.ts`), which is only safe because every step below is
 * additive and idempotent — which is what the ledger is for.
 *
 * ============================================================
 * WHICH PRIMITIVE, AND WHERE THE CONTRACT DOES NOT REACH
 * ============================================================
 *
 * Per the table in `docs/feature-authoring.md`:
 *
 *  - starter files      `copyIfAbsent` — binary (resources/icon.png) and
 *                       executable (the four `.sh` entry points) rule out
 *                       `writeIfChanged`, which round-trips through a
 *                       UTF-8 string and writes 0644.
 *  - package.json       `mergePackageJson`, add-only. See `mergeManifest`.
 *  - .gitignore         `ensureManagedBlock` for the holes, `edit` for the
 *                       blanket `ios/` + `android/` lines a block cannot
 *                       remove.
 *  - layout.tsx         `edit` with a fixed-point transform.
 *  - globals.css        `edit`. `ensureManagedBlock` CANNOT do this one —
 *                       see `wireNativeStyles` for the two reasons.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";
import { substituteIdentifierTokens } from "../../scaffold/identifiers.js";
import {
  MOBILE_DEPS,
  MOBILE_IDENTIFIER_RENAME_PATHS,
  MOBILE_PATHS,
  MOBILE_SCRIPTS,
  NATIVE_GENERATED_TRACKED,
  NATIVE_GENERATED_UNTRACKED,
} from "../../scaffold/mobile-feature.js";
import { renameStarterIdentifiers } from "../client-core/rename.js";
import { type FeatureContext, registerFeature } from "../contract.js";

/** Monorepo root → the starter template, four hops up from this file. */
const MONOREPO_ROOT = resolve(join(import.meta.dirname, "..", "..", "..", ".."));
const STARTER_ROOT = join(MONOREPO_ROOT, "starter");

const LAYOUT = "packages/client/src/app/layout.tsx";
const GLOBALS = "packages/client/src/styles/globals.css";
const GITIGNORE = ".gitignore";
const CAP_CONFIG = "capacitor.config.ts";
const PKG = "package.json";

/** Marker id for the generated-path holes in `.gitignore`. */
const IGNORE_BLOCK = "mobile-native";
/** Marker id for the stylesheet imports in `globals.css`. */
const STYLES_BLOCK = "mobile-native-styles";

export const mobileFeature = registerFeature({
  id: "mobile",
  title: "Mobile app (Capacitor)",
  summary:
    "iOS and Android wrappers around the static client export, with committed native trees, one build entry point, and native session storage in the platform keychain.",
  /**
   * Every surface that produces a client bundle. A `backend` surface has
   * no client to wrap — `scaffold/surfaces.ts` already drops the scripts
   * there, and offering the feature would be a support question later.
   */
  surfaces: ["fullstack", "split", "static"],
  addableAfterScaffold: true,

  apply(ctx: FeatureContext) {
    applyMobile(ctx);
  },
});

/**
 * Layer the feature onto `ctx.projectDir`.
 *
 * `starterRoot` is injectable so a test can point at a fixture instead
 * of the checkout's template.
 */
export function applyMobile(ctx: FeatureContext, starterRoot: string = STARTER_ROOT): void {
  if (!existsSync(starterRoot)) {
    ctx.log(
      `  mobile: starter template not found at ${starterRoot} — re-clone or pull the latest main.`,
    );
    return;
  }

  copyOwnedPaths(ctx, starterRoot);
  substituteCapacitorIdentifiers(ctx);
  renameClientStorageKeys(ctx, starterRoot);
  mergeManifest(ctx, starterRoot);
  wireLayout(ctx);
  wireNativeStyles(ctx);
  trackNativeTrees(ctx);

  for (const conflict of ctx.ledger.conflicts()) {
    ctx.log(`  mobile: ${conflict.file} — ${conflict.detail ?? "not applied"}`);
  }
}

/* ================================================================== */
/* Starter files                                                      */
/* ================================================================== */

/**
 * Copy every path the feature owns out of the starter.
 *
 * Directories are MERGED rather than skipped when they already exist: a
 * project scaffolded before `scripts/lib/` or
 * `packages/client/src/mobile/network.ts` existed has the parent
 * directory and not the new files, and a whole-directory skip would
 * leave it half-upgraded — with a globals.css importing a stylesheet
 * that is not there and a layout importing a module that is not there.
 * Half is worse than either end. `starterFilesUnder` flattens to files
 * for exactly that reason.
 *
 * `ios/` and `android/` are skipped: they are generated per machine by
 * `pnpm cap:add:*` and then committed, so the starter has no copy to
 * hand over. (`copyIfAbsent` would report `absent` anyway; skipping
 * keeps that out of the run summary, where it reads as a fault.)
 */
function copyOwnedPaths(ctx: FeatureContext, starterRoot: string): void {
  for (const rel of MOBILE_PATHS) {
    if (rel === "ios" || rel === "android") continue;
    for (const file of starterFilesUnder(starterRoot, rel)) {
      ctx.ledger.copyIfAbsent(file, join(starterRoot, file));
    }
  }
}

/** Every file under `rel` in the starter, as project-relative posix paths. */
export function starterFilesUnder(starterRoot: string, rel: string): string[] {
  const abs = join(starterRoot, rel);
  if (!existsSync(abs)) return [];
  if (!statSync(abs).isDirectory()) return [rel];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist") continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(relative(starterRoot, path).split(sep).join(posix.sep));
    }
  };
  walk(abs);
  return out.sort();
}

/**
 * Substitute project identifiers into `capacitor.config.ts`.
 *
 * Only here, and only on the way in. Once `cap add` has run the native
 * trees hold their own copies of the identifier and `cap sync` never
 * revisits them — so a LATER rename has to go through
 * `hatchkit rename-project`, which rewrites the native trees too, and
 * `scripts/build-mobile.mjs` fails the build when the two disagree.
 *
 * The identifiers come from `ctx.identifiers`, the project's frozen set,
 * and are never derived here: the bundle id IS the app's identity on
 * both stores, and a second opinion about it is an app that cannot be
 * updated. See `cli/src/scaffold/identifiers.ts`.
 */
function substituteCapacitorIdentifiers(ctx: FeatureContext): void {
  // Fixed point: substitution consumes `{{token}}` and produces a
  // literal, so a second pass finds nothing left to replace.
  ctx.ledger.edit(CAP_CONFIG, (content) => substituteIdentifierTokens(content, ctx.identifiers));
}

/**
 * Write the project's own `storagePrefix` into the client runtime's storage
 * keys — the session token in the keychain and the hand-over marker in the
 * durable store.
 *
 * These ship as `"starter.…"` literals rather than `{{…}}` tokens, for the
 * reason `features/client-core/rename.ts` spells out: the starter is a real
 * workspace that has to typecheck and run before it is ever scaffolded. So
 * they need the rename pass, not the substitution pass.
 *
 * Fixed point, and safe on every `update`: each rename matches a `starter.`
 * prefix, so a file this pass has already renamed and a file the user has
 * edited both contain nothing to match. That is what makes it correct to run
 * unconditionally — a project scaffolded before its keys were prefixed keeps
 * the keys its shipped builds wrote, because rewriting those would strand a
 * live keychain item and an undrained offline queue rather than migrate them.
 */
function renameClientStorageKeys(ctx: FeatureContext, starterRoot: string): void {
  for (const rel of MOBILE_IDENTIFIER_RENAME_PATHS) {
    for (const file of starterFilesUnder(starterRoot, rel)) {
      ctx.ledger.edit(file, (content) => renameStarterIdentifiers(content, ctx.identifiers));
    }
  }
}

/* ================================================================== */
/* package.json                                                       */
/* ================================================================== */

/**
 * Add the feature's scripts and dependencies, taking every value from
 * the starter so the versions and command lines can only ever come from
 * one place.
 *
 * Add-only, via `mergePackageJson`: a script the user has changed is
 * REPORTED and kept, not reverted. That is a deliberate change from the
 * pre-contract `ensureMobile`, which overwrote unconditionally — and
 * since this apply runs on every `update`, an overwrite meant the user's
 * edit disappeared again on every run, with nothing said. The one value
 * hatchkit still takes back is `cap:sync`, below, because that one is
 * not a customisation but a hole.
 *
 * `hatchkit update --force` does NOT reach here yet. It is plumbed to the
 * hand-written `addDesktop`, and `FeatureContext` carries no `force`, so a
 * registered feature cannot see it. Closing that gap means putting the
 * flag on the context — a contract change every feature would inherit —
 * and belongs with the `desktop` port rather than ahead of it. Until then
 * the conflict line says what was kept and does not offer a flag that
 * would not work.
 */
function mergeManifest(ctx: FeatureContext, starterRoot: string): void {
  const starterPkg = readStarterPackageJson(starterRoot);
  if (starterPkg === null) return;

  const scripts: Record<string, string> = {};
  for (const name of MOBILE_SCRIPTS) {
    const value = starterPkg.scripts?.[name];
    if (value !== undefined) scripts[name] = value;
  }

  const dependencies: Record<string, string> = {};
  const devDependencies: Record<string, string> = {};
  for (const name of MOBILE_DEPS) {
    const dep = starterPkg.dependencies?.[name];
    const dev = starterPkg.devDependencies?.[name];
    if (dep !== undefined) dependencies[name] = dep;
    else if (dev !== undefined) devDependencies[name] = dev;
  }

  ctx.ledger.mergePackageJson(PKG, { scripts, dependencies, devDependencies });

  // Drop the retired `cap:sync`.
  //
  // A project scaffolded before `build-mobile.mjs` existed has
  // `"cap:sync": "cap sync"`. The starter no longer defines it, so the
  // merge above cannot reach it — and a bare `cap sync` skips the API
  // URL check, the chunk assertion, the identifier drift check and the
  // dev-server guard while still producing an app that installs. That is
  // worse than no script, so it goes.
  //
  // This is the one REMOVAL in an otherwise additive feature. It is
  // allowed because the script is hatchkit's own, and it is narrow: only
  // when the starter has stopped defining it.
  if (starterPkg.scripts?.["cap:sync"] === undefined) {
    ctx.ledger.edit(PKG, (raw) => removeScript(raw, "cap:sync"));
  }
}

/** Remove one script from a package.json string, preserving the rest
 *  verbatim-ish (re-serialised at 2 spaces, as every writer here does).
 *  A fixed point: a second call finds no such key and returns `raw`. */
function removeScript(raw: string, name: string): string {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return raw;
  }
  const scripts = pkg.scripts as Record<string, string> | undefined;
  if (!scripts || !(name in scripts)) return raw;
  delete scripts[name];
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

function readStarterPackageJson(starterRoot: string): {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
} | null {
  const abs = join(starterRoot, PKG);
  if (!existsSync(abs)) return null;
  try {
    return JSON.parse(readFileSync(abs, "utf-8"));
  } catch {
    return null;
  }
}

/* ================================================================== */
/* layout.tsx                                                         */
/* ================================================================== */

/**
 * Mount the bridge loader and the pre-paint root marker in the client
 * layout.
 *
 * `edit` with a fixed-point transform: each insertion is keyed on the
 * symbol it PRODUCES (`MobileBridgeLoader`, `ROOT_MARKER_SCRIPT`), not
 * on the insertion point, so a second apply finds both and changes
 * nothing — and a hand-edited layout that already mounts them, anywhere,
 * is left alone.
 */
function wireLayout(ctx: FeatureContext): void {
  const before = ctx.ledger.read(LAYOUT);
  // Warn outside the transform: `edit` also runs `fn` on a dry run, and a
  // warning printed from inside it would fire twice for one decision.
  if (before !== undefined && !before.includes("ROOT_MARKER_SCRIPT") && !/<head>/.test(before)) {
    ctx.log(
      "  ! layout.tsx has no <head> — add the ROOT_MARKER_SCRIPT <script> tag by hand\n" +
        "    (see starter/packages/client/src/app/layout.tsx). Without it the app paints\n" +
        "    one unpadded frame on every WebView reload.",
    );
  }

  ctx.ledger.edit(LAYOUT, (input) => {
    let content = input;

    if (!content.includes("MobileBridgeLoader")) {
      content = content.replace(
        /(import[^\n]+"@\/styles\/globals\.css";\n)/,
        `$1import { MobileBridgeLoader } from "@/mobile/MobileBridgeLoader";\n`,
      );
      content = content.replace(/(<body[^>]*>)\s*/, `$1\n        <MobileBridgeLoader />\n        `);
    }

    // The pre-paint marker. It sets `html.cap` before the first paint,
    // which is what matters on a WebView reload — there is no splash
    // screen to hide the unpadded frame. It goes on <html>, never
    // <body>: a pre-paint script that mutates <body> makes the served
    // HTML and the hydrated DOM disagree about body's attributes, and
    // the only way to silence that is `suppressHydrationWarning` on
    // <body>, which then silences every other body-level mismatch for
    // the web app forever.
    if (!content.includes("ROOT_MARKER_SCRIPT")) {
      content = content.replace(
        /(import[^\n]+"@\/styles\/globals\.css";\n)/,
        `import { ROOT_MARKER_SCRIPT } from "@/mobile/platform";\n$1`,
      );
      if (/<head>/.test(content)) {
        content = content.replace(
          /(<head>)\s*\n/,
          `$1\n        <script dangerouslySetInnerHTML={{ __html: ROOT_MARKER_SCRIPT }} />\n`,
        );
      }
    }

    return content;
  });
}

/* ================================================================== */
/* globals.css                                                        */
/* ================================================================== */

/**
 * Import `native.css` + `standalone.css` from `globals.css`.
 *
 * **Why this is `edit` and not `ensureManagedBlock`.** The block has to
 * land before the first CSS rule — CSS requires every `@import` to
 * precede every other rule, and an import that does not is dropped
 * silently by the parser, so the native chrome would just never apply.
 * `ensureManagedBlock` cannot honour that, for two independent reasons:
 *
 *  1. **Marker syntax.** Its markers are LINE comments. CSS has none;
 *     `inferCommentPrefix` returns `#` for an unrecognised extension,
 *     and `# hatchkit:begin …` in a stylesheet is a parse error. `//`
 *     is not valid CSS either, and `/*` alone is unterminated.
 *  2. **Placement.** Its `anchor` is a single substring, matched FIRST
 *     and inserted AFTER — it cannot express "after the LAST `@import`"
 *     — and when the anchor is missing it appends AT END OF FILE, which
 *     for a stylesheet is precisely the silently-dropped case above.
 *
 * So the markers are emitted here in CSS block-comment syntax and placed
 * by hand. The region is still hatchkit's to rewrite in a later version:
 * a re-apply that finds the markers replaces what is between them.
 *
 * A project that carries the imports WITHOUT markers is left alone — it
 * was scaffolded from the starter, which ships them, and wrapping lines
 * hatchkit did not write in "managed by hatchkit" would be a lie.
 */
function wireNativeStyles(ctx: FeatureContext): void {
  ctx.ledger.edit(GLOBALS, (content) => {
    const begin = `/* hatchkit:begin ${STYLES_BLOCK}`;
    const end = `/* hatchkit:end ${STYLES_BLOCK} */`;
    const block = nativeStylesBlock();

    const beginAt = content.indexOf(begin);
    const endAt = content.indexOf(end);
    if (beginAt !== -1 && endAt !== -1 && endAt > beginAt) {
      // Managed region: replace in place, position preserved.
      return content.slice(0, beginAt) + block + content.slice(endAt + end.length);
    }
    // Already imported, unmarked — the starter's own copy. Not ours.
    if (content.includes('@import "./native.css"')) return content;

    // Place it after the last @import, which is the last position that
    // is still before every rule. With no imports at all the top of the
    // file is the only safe place.
    const imports = [...content.matchAll(/^@import\s+[^\n]*;\n/gm)];
    if (imports.length === 0) return `${block}\n${content}`;
    const last = imports[imports.length - 1];
    const at = (last.index ?? 0) + last[0].length;
    return `${content.slice(0, at)}\n${block}\n${content.slice(at)}`;
  });
}

function nativeStylesBlock(): string {
  return (
    `/* hatchkit:begin ${STYLES_BLOCK}\n` +
    " * Managed by hatchkit — edits between these markers are overwritten.\n" +
    " *\n" +
    " * Native and installed-web-app chrome. Imported here, before the first\n" +
    " * rule, because CSS requires every @import to precede every other rule.\n" +
    " * Left unlayered on purpose: Tailwind's utilities sit in\n" +
    " * `@layer utilities`, so an unlayered rule already beats them and no\n" +
    " * `!important` is needed in either file.\n" +
    " *\n" +
    " *   native.css      every selector under `html.cap`, so it is inert on web\n" +
    " *                   BY CONSTRUCTION. A rule that would also be right on web\n" +
    " *                   belongs in globals.css, not there.\n" +
    " *   standalone.css  `@media (display-mode: standalone)` copies of the\n" +
    " *                   safe-area rules, scoped `html:not(.cap)`. NOT inert by\n" +
    " *                   construction — `viewport-fit=cover` ships to every host,\n" +
    " *                   and an installed web app gets the real insets with none\n" +
    " *                   of native.css applying to it.\n" +
    " */\n" +
    '@import "./native.css";\n' +
    '@import "./standalone.css";\n' +
    `/* hatchkit:end ${STYLES_BLOCK} */`
  );
}

/* ================================================================== */
/* .gitignore                                                         */
/* ================================================================== */

/**
 * Track the native trees, and ignore the paths inside them that a build
 * regenerates.
 *
 * A project scaffolded before the committed-native-trees change has a
 * flat `ios/` and `android/` in `.gitignore`, which means the hand edits
 * that live only in those trees — the ATS exception, the orientation
 * set, the Android debug-only cleartext config, the version wiring and
 * the signing config — are on exactly one machine, and the release
 * workflow (which never runs `cap add`) has nothing to build.
 *
 * Two primitives, because one cannot do both halves: `ensureManagedBlock`
 * adds the holes (append-at-end is correct for an ignore file, and `#`
 * is the right comment prefix), but it cannot REMOVE the two blanket
 * lines, so those go through `edit`.
 */
function trackNativeTrees(ctx: FeatureContext): void {
  const before = ctx.ledger.read(GITIGNORE);
  if (before === undefined) return;

  // Drop the blanket ignores. Anchored to a whole line so a path like
  // `vendor/ios/` — or any of the holes below — is untouched. Fixed
  // point: a second pass finds no such line.
  ctx.ledger.edit(GITIGNORE, (content) => content.replace(/^(ios|android)\/\s*$\n?/gm, ""));

  // A project scaffolded WITH mobile already carries these lines from
  // the starter, unmarked. Appending a marked second copy would be pure
  // noise, and wrapping the starter's lines would claim text this
  // feature did not write.
  const unmarked =
    before.includes("ios/App/App/public/") && !before.includes(`hatchkit:begin ${IGNORE_BLOCK}`);
  if (unmarked) return;

  ctx.ledger.ensureManagedBlock(GITIGNORE, IGNORE_BLOCK, nativeIgnoreBody());
}

function nativeIgnoreBody(): string {
  return (
    "# Capacitor native projects: COMMITTED, with holes.\n" +
    "#\n" +
    "# The ATS exception, the orientation set, the Android debug-only cleartext\n" +
    "# config, the version wiring and the optional signing config are hand edits\n" +
    "# that live only in these trees, and a fresh checkout must build the real app\n" +
    "# without a generator run. scripts/cap-add.mjs applies them; you commit them.\n" +
    "#\n" +
    "# Rewritten by every `pnpm build:mobile` but still TRACKED (a diff after a\n" +
    "# build is normal — commit it when the plugin set changed):\n" +
    `${NATIVE_GENERATED_TRACKED.map((p) => `#   ${p}`).join("\n")}\n` +
    "#\n" +
    "# Generated and NOT tracked — the holes below. A checkout that has never run\n" +
    "# `pnpm build:mobile` has none of them and cannot be opened in Xcode or\n" +
    "# Gradle at all. Build first.\n" +
    `${NATIVE_GENERATED_UNTRACKED.join("\n")}\n` +
    "ios/App/build/\n" +
    "ios/App/DerivedData/\n" +
    "ios/App/.swiftpm/\n" +
    "ios/App/CapApp-SPM/.build/\n" +
    "ios/App/App.xcodeproj/xcuserdata/\n" +
    "ios/App/App.xcodeproj/project.xcworkspace/xcuserdata/\n" +
    "android/.gradle/\n" +
    "android/build/\n" +
    "android/app/build/\n" +
    "android/local.properties\n" +
    "# A credential. Signing is environment-driven and optional, so a checkout\n" +
    "# without this file still builds — unsigned.\n" +
    "android/app/release.keystore\n" +
    "\n" +
    "# The mobile export has its own directory. A shared one means a Playwright\n" +
    "# run can silently be installed as the app.\n" +
    "packages/client/out-mobile/"
  );
}
