#!/usr/bin/env node
/**
 * The `publish` script, which refuses to publish.
 *
 * Publishing happens from the EXPORTED copy and nowhere else. The in-repo
 * manifest carries scaffold placeholders for the two fields that are permanent
 * after the first publish — `name` and `author` — and its scripts, its
 * `workspace` neighbours and its `USE_LOCAL_DEV_ORIGINS` flag are all wrong for
 * a store build. A `publish` that worked here would publish all of that, once,
 * irreversibly.
 *
 * So the script exists in order to fail: `npm publish`-shaped muscle memory
 * lands on a sentence that says what to run instead, rather than on a missing
 * script that reads like something to add.
 */
console.error(
  [
    "Refusing to publish from the workspace package.",
    "",
    "This copy carries scaffold placeholders for `name` and `author`, and both are",
    "PERMANENT once published: the launcher keys its encrypted per-extension store",
    "by the pair, so changing either later orphans every install's stored",
    "credential and its queue of unsent work. See PUBLISHING.md.",
    "",
    "Publish from the exported copy:",
    "",
    "  node scripts/export-store.mjs ../../../<somewhere> \\",
    "      --license <spdx-id> --author <your-store-handle> --lint",
    "",
    "then run the store's own publish command inside that directory.",
  ].join("\n"),
);
process.exit(1);
