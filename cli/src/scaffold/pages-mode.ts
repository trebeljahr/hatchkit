// Pages-specific tweaks applied AFTER `pruneToClientOnly`.
//
// The client-only prune strips the server package + tRPC/auth glue,
// but leaves the Next config configured for a standalone server +
// `/api/*` rewrites that assume a backend. Pages serves flat static
// files; nothing of that wiring makes sense here.
//
// This module patches what's left so `pnpm build` in the pruned
// package produces an `out/` directory ready for `actions/upload-pages-artifact`.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rewriteFile } from "./starter-files.js";

/** Apply all gh-pages-specific changes to a scaffolded project that
 *  has already gone through `pruneToClientOnly`. Idempotent: safe to
 *  call against a project that's already had these tweaks applied
 *  (each step checks for the desired end state first). */
export function applyPagesMode(outputDir: string, modifications: string[]): void {
  patchNextConfig(outputDir, modifications);
  ensureCnameDirExists(outputDir, modifications);
}

/** Rewrite `packages/client/next.config.ts` (or .js/.mjs) so it
 *  static-exports cleanly:
 *    · `output: "export"`           — produces a flat `out/` Pages can host
 *    · drop the `rewrites()` block  — Pages can't run server rewrites
 *    · `images: { unoptimized: true }` — static export has no image server
 *
 *  No-ops when there's no Next config (e.g. someone's swapped the
 *  client for plain Vite — they'll have their own build pipeline).
 *  Failures here aren't fatal because hatchkit-create can warn the
 *  user before the first push.
 */
function patchNextConfig(outputDir: string, modifications: string[]): void {
  const candidates = ["next.config.ts", "next.config.js", "next.config.mjs", "next.config.cjs"];
  const clientDir = join(outputDir, "packages/client");
  const found = candidates.map((c) => join(clientDir, c)).find((p) => existsSync(p));
  if (!found) return;

  rewriteFile(found, (raw) => {
    let out = raw;

    // 1. Switch `output: "standalone"` → `output: "export"`. The
    //    starter writes "standalone"; users on different configs
    //    may have something else. Accept any quoted value or no
    //    `output` key at all.
    if (/output\s*:\s*['"][^'"]*['"]/.test(out)) {
      out = out.replace(/output\s*:\s*['"][^'"]*['"]/, 'output: "export"');
    } else {
      // Inject into the config object. Match the opening of the
      // typed `: NextConfig = {` declaration (or a bare `= {` for
      // .js configs). Insert as the first property.
      out = out.replace(/(NextConfig\s*=\s*\{|=\s*\{)/, '$1\n  output: "export",');
    }

    // 2. Drop the `rewrites()` block. It's an async function inside
    //    the config object. Match `async rewrites() { ... },` —
    //    JS doesn't have multi-line regex without `s` flag; use it.
    out = out.replace(/async\s+rewrites\s*\(\s*\)\s*\{[\s\S]*?\n\s*\},?\s*\n/, "");

    // 3. Ensure `images.unoptimized: true`. Without this, `<Image>`
    //    fails at runtime on a static export.
    if (!/images\s*:\s*\{[^}]*unoptimized\s*:\s*true/s.test(out)) {
      // No images block at all? Inject right after `output: "export"`.
      if (!/images\s*:\s*\{/.test(out)) {
        out = out.replace(
          /(output\s*:\s*['"]export['"]\s*,)/,
          "$1\n  images: { unoptimized: true },",
        );
      } else {
        // images block exists but missing the flag. Add unoptimized.
        out = out.replace(/(images\s*:\s*\{)/, "$1 unoptimized: true,");
      }
    }

    return out;
  });
  modifications.push(
    "gh-pages: patched next.config (output=export, dropped rewrites, images.unoptimized=true)",
  );
}

/** Make sure the publish folder hatchkit's gh-pages flow writes
 *  CNAME into actually exists. For Next.js client-only that's
 *  `packages/client/public/`. The starter ships this folder, but if
 *  someone's stripped it bare we recreate it (and drop a `.gitkeep`)
 *  so the CNAME write doesn't fail.
 *
 *  Mirrors the safety net in `writeCnameFile` in pages.ts — duplicated
 *  here because applyPagesMode runs at scaffold time, before the
 *  pages-setup step that writes CNAME.
 */
function ensureCnameDirExists(outputDir: string, modifications: string[]): void {
  const publicDir = join(outputDir, "packages/client/public");
  if (existsSync(publicDir)) return;
  // Create with a placeholder so git tracks the directory. We don't
  // import mkdirSync at the top to keep imports tight; pull it lazily.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdirSync } = require("node:fs") as { mkdirSync: typeof import("node:fs").mkdirSync };
  mkdirSync(publicDir, { recursive: true });
  writeFileSync(join(publicDir, ".gitkeep"), "");
  modifications.push("gh-pages: created packages/client/public/ for CNAME placement");
}

/** Read the patched next.config back as a string. Useful for tests
 *  and for the adopt flow's heuristics-driven warning ("we WOULD
 *  patch your next.config to look like X"). */
export function previewPatchedNextConfig(outputDir: string): string | null {
  const candidates = ["next.config.ts", "next.config.js", "next.config.mjs", "next.config.cjs"];
  const found = candidates
    .map((c) => join(outputDir, "packages/client", c))
    .find((p) => existsSync(p));
  if (!found) return null;
  return readFileSync(found, "utf8");
}
