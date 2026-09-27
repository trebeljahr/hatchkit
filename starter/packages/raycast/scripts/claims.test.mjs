/**
 * The two numbers that live in more than one place, and nothing else pins.
 *
 * Both are claims made where a person reads them and implemented somewhere
 * else, and both go wrong silently: a stale version reports this build as an
 * older one to the server, and a README that promises six commands is a store
 * page describing an extension that does not exist.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8"));

test("the hand-kept version constant matches the project's", () => {
  // It cannot be read at build time: a store submission is this directory
  // alone — no root manifest beside it, and the launcher's build offers no
  // define to inject one. So it is a literal, and this is the only thing that
  // stops a release bump from forgetting it.
  const source = readFileSync(join(PACKAGE_ROOT, "src", "lib", "version.ts"), "utf-8");
  const declared = /export const EXTENSION_VERSION = "([^"]+)";/.exec(source);
  assert.ok(declared !== null, "src/lib/version.ts no longer declares EXTENSION_VERSION");

  const rootManifest = join(PACKAGE_ROOT, "..", "..", "package.json");
  const root = JSON.parse(readFileSync(rootManifest, "utf-8"));
  assert.equal(
    declared[1],
    root.version,
    `src/lib/version.ts says ${declared[1]} and the project is at ${root.version}.`,
  );
});

test("the README's command table matches the manifest", () => {
  // The README is the store page. A row for a command that is not declared is
  // a promise nobody can keep, and a declared command with no row is invisible
  // to the person deciding whether to install it.
  const readme = readFileSync(join(PACKAGE_ROOT, "README.md"), "utf-8");
  // Read by cell, not by substring: the formatter pads the columns, so
  // `| New Item |` is `| New Item     |` on disk.
  const rows = readme
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("| ---"))
    .map((line) => line.split("|")[1].trim())
    .filter((cell) => cell !== "Command");
  assert.deepEqual(
    rows.sort(),
    manifest.commands.map((command) => command.title).sort(),
    "the README's command table and the manifest list different commands.",
  );
  assert.match(
    readme,
    new RegExp(`\\b${numberWord(manifest.commands.length)} commands\\b`, "i"),
    `README.md does not say there are ${manifest.commands.length} commands.`,
  );
});

test("the persistent surface declares a refresh interval", () => {
  // Raycast unloads a menu bar command once its first render settles, so the
  // declared interval is what covers the unloaded case. Without it the surface
  // shows whatever it drew when it was last opened, indefinitely.
  const menuBar = manifest.commands.find((command) => command.mode === "menu-bar");
  assert.ok(menuBar !== undefined, "no menu-bar command is declared");
  assert.match(menuBar.interval, /^\d+[smhd]$/);
});

test("neither origin preference carries a default", () => {
  // Raycast stores a manifest default as a real preference value, which makes
  // "never touched it" indistinguishable from "typed the production origin" —
  // and the build-mode fallback could then never fire again.
  for (const preference of manifest.preferences) {
    assert.equal(
      preference.default,
      undefined,
      `the "${preference.name}" preference carries a manifest default.`,
    );
  }
});

function numberWord(n) {
  return ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight"][n] ?? String(n);
}
