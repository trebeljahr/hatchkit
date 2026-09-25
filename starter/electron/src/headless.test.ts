/*
 * The headless contract (headless.ts), pinned to the source text.
 *
 * A headless run refuses a fixed list of side effects: no tray icon, no OS
 * global shortcut, no notification, no login-item write, no browser window
 * opened, no real keychain item. Every one of them fails QUIETLY when it comes
 * back. A test run takes keyboard focus from whoever is using the machine,
 * drops an icon in their menu bar, or registers a login item that outlives the
 * run — and nothing in the suite goes red.
 *
 * Each module's own test covers its behaviour. These checks cover the
 * arrangement BETWEEN modules, which no single module's test can see: that an
 * effect lives in exactly one place, and that the place is reached only behind
 * the guard. Moving `new Tray(` into another file, or dropping the `headless`
 * branch in front of it, fails here.
 *
 * Comments are stripped before matching, so an explanation can neither satisfy
 * a rule nor break one. A module that is not written yet is skipped for the
 * guard half; the containment half still runs, so the effect cannot appear
 * anywhere else in the meantime.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { HEADLESS_ENV, isHeadless } from "./headless.ts";

// From import.meta.url rather than import.meta.dirname: a transform-based
// loader (tsx, which is how `pnpm test:electron` runs these) does not always
// provide `dirname`, and an undefined one turns every check below into a
// readdir crash rather than a failed assertion.
const here = path.dirname(fileURLToPath(import.meta.url));

const sources = (): string[] =>
  readdirSync(here, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map((file) => path.join(here, file))
    .sort();

const rel = (file: string): string => path.relative(here, file);

/** Source text without comments, so an explanation cannot satisfy a check. */
const code = (file: string): string =>
  readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/** Either spelling of the flag, as an identifier rather than inside a word. */
const HEADLESS = /\bheadless\b|\bisHeadless\b/;

/** `if (… headless …) { … return` — the guard that leaves before the effect.
 *  `continue` counts too: a loop over bindings refuses one and takes the next. */
const HEADLESS_EXIT =
  /\bif\s*\([^)]{0,200}(?:\bheadless\b|\bisHeadless\b)[^)]{0,200}\)[\s\S]{0,400}?\b(?:return|continue|break|throw)\b/;

/** The text from the last statement boundary up to `at`: an `if` head, a ternary. */
function statementHead(text: string, at: number): string {
  const start =
    Math.max(
      text.lastIndexOf(";", at - 1),
      text.lastIndexOf("{", at - 1),
      text.lastIndexOf("}", at - 1),
    ) + 1;
  return text.slice(start, at);
}

/** Every `{ … }` block enclosing `index`, innermost first. */
function blocksAround(text: string, index: number): [number, number][] {
  const open: number[] = [];
  const around: [number, number][] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "{") open.push(i);
    else if (text[i] === "}") {
      const start = open.pop();
      if (start !== undefined && start < index && i > index) around.push([start, i]);
    }
  }
  return around;
}

/**
 * Whether the flag decides that this position is reached: the statement itself
 * names it (a ternary), an enclosing block's `if` head names it, or an
 * enclosing block leaves early when it is set.
 */
function guardedByHeadless(text: string, index: number): boolean {
  if (HEADLESS.test(statementHead(text, index))) return true;
  for (const [start] of blocksAround(text, index)) {
    if (HEADLESS.test(statementHead(text, start))) return true;
    if (HEADLESS_EXIT.test(text.slice(start, index))) return true;
  }
  return false;
}

/** The names a file imports from `./<module>.ts`. */
function importedNames(text: string, module: string): string[] {
  const base = module.replace(/\.ts$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`import\\s*(?:type\\s*)?\\{([^}]*)\\}\\s*from\\s*"\\./${base}\\.ts"`, "g");
  const names: string[] = [];
  for (const match of text.matchAll(pattern)) {
    for (const part of match[1].split(",")) {
      const name = part.replace(/\btype\b/, "").trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.push(name);
    }
  }
  return names;
}

interface EffectRule {
  what: string;
  /** The text that may appear in `owner` and nowhere else. */
  containment: RegExp;
  owner: string;
  /** The effect itself, which must be reached only behind the guard. */
  guard?: RegExp;
}

/*
 * The effects headless refuses, and the one module each of them belongs to.
 *
 * `setLoginItemSettings` is bound in desktop.ts rather than in login-item.ts on
 * purpose: login-item.ts is unit-tested in plain Node, where importing
 * `electron` throws, so it takes the two calls as an injected `LoginItemApi`
 * and does the refusing itself (checked separately below).
 */
const EFFECTS: EffectRule[] = [
  {
    what: "a tray icon",
    containment: /\bnew\s+Tray\s*\(/g,
    owner: "tray.ts",
    guard: /\bnew\s+Tray\s*\(/g,
  },
  {
    what: "an OS global shortcut",
    containment: /\bglobalShortcut\s*\.\s*(?:register|unregister)\s*\(/g,
    owner: "shortcuts.ts",
    guard: /\bglobalShortcut\s*\.\s*register\s*\(/g,
  },
  {
    what: "a system notification",
    containment: /\bnew\s+Notification\s*\(/g,
    owner: "desktop.ts",
    guard: /\bnew\s+Notification\s*\(/g,
  },
  {
    what: "handing a URL to the OS",
    containment: /\bopenExternal\s*\(/g,
    owner: "external.ts",
    guard: /\bopenExternal\s*\(/g,
  },
  {
    what: "an Electron login-item write",
    containment: /\b(?:set|get)LoginItemSettings\b/g,
    owner: "desktop.ts",
  },
  {
    what: "the mock-keychain switch",
    containment: /appendSwitch\s*\(\s*MOCK_KEYCHAIN_SWITCH/g,
    owner: "main.ts",
    guard: /appendSwitch\s*\(\s*MOCK_KEYCHAIN_SWITCH/g,
  },
  {
    what: "the mock-keychain switch name",
    containment: /"use-mock-keychain"/g,
    owner: "secure-store.ts",
  },
];

describe("isHeadless", () => {
  it("is on only for the exact value 1", () => {
    assert.equal(isHeadless({ [HEADLESS_ENV]: "1" }), true);
    for (const value of [undefined, "", "0", "true", "yes", " 1"]) {
      assert.equal(isHeadless({ [HEADLESS_ENV]: value }), false, String(value));
    }
  });

  it("falls back to the process environment", () => {
    assert.equal(isHeadless(), process.env[HEADLESS_ENV] === "1");
  });
});

describe("the headless contract", () => {
  it("keeps every refused effect in one module", () => {
    for (const rule of EFFECTS) {
      // A fresh, non-global copy: `test` on a /g regex carries lastIndex over
      // from the previous file and skips the next one.
      const holds = new RegExp(rule.containment.source);
      const holders = sources()
        .filter((file) => holds.test(code(file)))
        .map(rel);
      for (const holder of holders) {
        assert.equal(
          holder,
          rule.owner,
          `${holder} reaches ${rule.what}; only ${rule.owner} may, and it guards on headless`,
        );
      }
    }
  });

  it("reaches every refused effect only behind the guard", () => {
    for (const rule of EFFECTS) {
      if (rule.guard === undefined) continue;
      const owner = path.join(here, rule.owner);
      // Written by another step of the desktop feature; the containment check
      // above still holds while it is missing.
      if (!existsSync(owner)) continue;

      const text = code(owner);
      const hits = [...text.matchAll(rule.guard)];
      assert.notEqual(hits.length, 0, `${rule.owner} no longer reaches ${rule.what}`);
      if (hits.every((hit) => guardedByHeadless(text, hit.index))) continue;

      // The module does not decide for itself, so each of its callers must.
      const importers = sources().filter(
        (file) => file !== owner && importedNames(code(file), rule.owner).length > 0,
      );
      assert.notEqual(
        importers.length,
        0,
        `${rule.owner} reaches ${rule.what} with no headless guard, and nobody imports it`,
      );
      let calls = 0;
      for (const file of importers) {
        const caller = code(file);
        for (const name of importedNames(caller, rule.owner)) {
          const at = new RegExp(`\\b${name}\\s*\\(`, "g");
          for (const call of caller.matchAll(at)) {
            calls += 1;
            assert.ok(
              guardedByHeadless(caller, call.index),
              `${rel(file)}: ${name}() reaches ${rule.what} without a headless guard`,
            );
          }
        }
      }
      assert.notEqual(calls, 0, `nothing calls into ${rule.owner}, so ${rule.what} is unguarded`);
    }
  });

  it("records a login-item write instead of performing one", () => {
    const text = code(path.join(here, "login-item.ts"));
    assert.match(text, HEADLESS, "login-item.ts no longer knows about headless runs");
    assert.match(
      text,
      /\brecordLoginItem\s*\(/,
      "a refused login-item write that leaves no trace cannot be told from one that stopped working",
    );
  });

  it("reads the headless environment variable only through isHeadless()", () => {
    // One reader means one answer. A second `process.env` test drifts the day
    // the variable is renamed or a second value is accepted.
    for (const file of sources()) {
      if (rel(file) === "headless.ts") continue;
      assert.doesNotMatch(code(file), /_HEADLESS/, rel(file));
    }
  });
});
