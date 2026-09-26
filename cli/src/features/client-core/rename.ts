/*
 * cli/src/features/client-core/rename.ts — put the project's own names into the
 * kit's storage keys and the handshake's headers.
 *
 * The starter ships these as literals (`x-starter-api-level`,
 * `"starter.offline-queue"`) rather than `{{…}}` tokens, for the reason spelled
 * out on `IDENTIFIER_RENAMES`: a brace in an HTTP header name makes
 * `new Headers()` throw, and the starter has to be runnable before it is ever
 * scaffolded. So this is the one place that rewrites them, from
 * `ctx.identifiers` and never from a rule of its own.
 *
 * Both directions are tested, which is what stops the table below from drifting
 * away from the files it renames.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectIdentifiers } from "../../scaffold/identifiers.js";
import { CLIENT_CORE_MARKED_FILES, CLIENT_CORE_OWNED_PATHS, IDENTIFIER_RENAMES } from "./types.js";

/** The replacement for one rename, from the project's identifiers. */
function replacementFor(
  to: (typeof IDENTIFIER_RENAMES)[number]["to"],
  ids: ProjectIdentifiers,
): string {
  switch (to) {
    // `clientHeader` is `x-<token>-client`, so the version header is that name
    // plus a suffix — the same shape the starter ships, and the same shape a
    // client library elsewhere would guess.
    case "clientVersionHeader":
      return `${ids.clientHeader}-version`;
    case "apiLevelHeader":
      return `x-${ids.token}-api-level`;
    case "clientHeader":
      return ids.clientHeader;
    // Keeps the opening quote, so only a string literal is rewritten and a
    // sentence in a comment that happens to say "starter." is left alone.
    case "storagePrefix":
      return `"${ids.storagePrefix}.`;
  }
}

/** `content` with every identifier-bearing literal replaced. */
export function renameStarterIdentifiers(content: string, ids: ProjectIdentifiers): string {
  let out = content;
  for (const { from, to } of IDENTIFIER_RENAMES) {
    out = out.split(from).join(replacementFor(to, ids));
  }
  return out;
}

/** True when `content` still carries a starter literal this table renames. */
export function findStarterIdentifierLiterals(content: string): string[] {
  return IDENTIFIER_RENAMES.filter(({ from }) => content.includes(from)).map(({ from }) => from);
}

/**
 * Rename every identifier-bearing literal across the files the feature owns and
 * the files it marks, in a tree `create` has already copied.
 *
 * The `update` path does this per file as it renders it (`apply.ts`); `create`
 * copies the whole starter first and mutates the copy, so it needs one pass over
 * what is already on disk. Returns the modification lines for the scaffold
 * summary, and says nothing when nothing needed renaming.
 */
export function renameClientCoreIdentifiers(projectDir: string, ids: ProjectIdentifiers): string[] {
  const renamed = renameStarterIdentifiersAcross(projectDir, ids, [
    ...CLIENT_CORE_OWNED_PATHS,
    ...CLIENT_CORE_MARKED_FILES,
  ]);
  return renamed === 0
    ? []
    : [
        `client-core: project identifiers written into ${renamed} file(s) (storage keys, handshake headers)`,
      ];
}

/**
 * Rename every identifier-bearing literal under `paths`, and report how many
 * files changed. The one pass shared by every feature that ships starter source
 * carrying a storage key — client-core's kit and the mobile client runtime.
 *
 * SAFE TO RUN OVER FILES THAT ARE ALREADY IN THE PROJECT, which is what lets
 * `update` call it over a whole tree rather than only the files it just copied.
 * Every rename matches a `starter.`-prefixed (or `x-starter-`-prefixed) literal,
 * so a file the user has edited, and a file an earlier pass already renamed,
 * both contain nothing to match and are left byte-identical. A project that was
 * scaffolded before its keys were prefixed keeps the keys its shipped builds
 * wrote — which is the point: rewriting those would strand live data rather than
 * migrate it.
 */
export function renameStarterIdentifiersAcross(
  projectDir: string,
  ids: ProjectIdentifiers,
  paths: readonly string[],
): number {
  let renamed = 0;
  for (const rel of paths) {
    for (const file of filesUnder(join(projectDir, rel))) {
      let content: string;
      try {
        content = readFileSync(file, "utf-8");
      } catch {
        continue;
      }
      const next = renameStarterIdentifiers(content, ids);
      if (next === content) continue;
      writeFileSync(file, next, "utf-8");
      renamed += 1;
    }
  }
  return renamed;
}

/** `abs` if it is a file, otherwise every file beneath it. */
function filesUnder(abs: string): string[] {
  if (!existsSync(abs)) return [];
  if (!statSync(abs).isDirectory()) return [abs];
  const out: string[] = [];
  for (const entry of readdirSync(abs)) {
    if (entry === "node_modules" || entry === "dist") continue;
    out.push(...filesUnder(join(abs, entry)));
  }
  return out;
}
