/*
 * cli/src/features/mcp/rename.ts — put the project's own names into the MCP
 * package's environment variables, its binary name and its display text.
 *
 * Three rewrites, all of them fixed points, all of them driven by
 * `ctx.identifiers` and never by a rule invented here. The reason they are
 * rewrites rather than template substitutions is on `MCP_IDENTIFIER_RENAMES`
 * in `types.ts`.
 *
 * Both directions are tested in `cli/test-mcp.ts`, which is what stops the
 * table from drifting away from the files it renames.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectIdentifiers } from "../../scaffold/identifiers.js";
import {
  MCP_IDENTIFIER_RENAMES,
  MCP_OWNED_PATHS,
  MCP_STARTER_DEV_ORIGIN,
  MCP_STARTER_PRODUCT_NAME,
} from "./types.js";

/** The replacement for one rename, from the project's identifiers. */
function replacementFor(
  to: (typeof MCP_IDENTIFIER_RENAMES)[number]["to"],
  ids: ProjectIdentifiers,
): string {
  switch (to) {
    case "tokenVar":
      return `${ids.envPrefix}_API_TOKEN`;
    case "originVar":
      return `${ids.envPrefix}_API_URL`;
    // The server name and the binary name are one identifier with two
    // spellings, and `clientIds.mcp` is the frozen value the identifier set
    // already reserves for this host slot — see `CLIENT_HOSTS` in
    // cli/src/scaffold/identifiers.ts. Composing `${token}-mcp` here instead
    // would be a fifth place that derives a name, which is the bug that
    // module exists to prevent.
    case "serverName":
      return ids.clientIds.mcp;
  }
}

/** `content` with every identifier-bearing literal replaced. */
export function renameMcpLiterals(content: string, ids: ProjectIdentifiers): string {
  let out = content;
  for (const { from, to } of MCP_IDENTIFIER_RENAMES) {
    out = out.split(from).join(replacementFor(to, ids));
  }
  return out;
}

/** True when `content` still carries a starter literal this table renames. */
export function findMcpIdentifierLiterals(content: string): string[] {
  return MCP_IDENTIFIER_RENAMES.filter(({ from }) => content.includes(from)).map(
    ({ from }) => from,
  );
}

/**
 * Point the package at this project's deployed API instead of the starter's
 * development origin.
 *
 * Every occurrence, because the origin is in the config module, in the
 * README's configuration table and in the README's expected verification
 * output — a setup page that told the user to expect a line the binary will
 * never print is worse than no setup page.
 *
 * Only while the starter's own value is still there. A project whose author
 * has changed it has made a decision, and an `update` that put the manifest's
 * domain back would undo that decision without ever failing.
 */
export function retargetApiOrigin(content: string, apiOrigin: string): string {
  return content.split(MCP_STARTER_DEV_ORIGIN).join(apiOrigin);
}

/** The same, for the product name the model is told about. */
export function setProductName(content: string, productName: string): string {
  if (!content.includes(MCP_STARTER_PRODUCT_NAME)) return content;
  return content.replace(
    MCP_STARTER_PRODUCT_NAME,
    `export const PRODUCT_NAME = ${JSON.stringify(productName)};`,
  );
}

/**
 * Put the project's names into the MCP tree that `create` has already copied,
 * and report what changed.
 *
 * `create` copies the whole starter and subtracts, so every file is already on
 * disk by the time this runs — which is why `applyMcp` cannot serve the create
 * path: its copy-if-absent loop finds them all present and renames nothing.
 * The update path needs the copy, the create path needs only the rename.
 *
 * The same three transforms `applyMcp` composes, in the same order, so a
 * project scaffolded WITH the feature and one that added it later end up with
 * identical files. Running them in a different order here would be a
 * difference nothing tests and nobody would look for.
 */
export function renameMcpTree(
  projectDir: string,
  ids: ProjectIdentifiers,
  apiOrigin: string,
): string[] {
  let renamed = 0;

  for (const rel of MCP_OWNED_PATHS) {
    for (const file of mcpFilesUnder(join(projectDir, rel))) {
      let content: string;
      try {
        content = readFileSync(file, "utf-8");
      } catch {
        continue;
      }
      const next = setProductName(
        retargetApiOrigin(renameMcpLiterals(content, ids), apiOrigin),
        ids.productName,
      );
      if (next === content) continue;
      writeFileSync(file, next, "utf-8");
      renamed += 1;
    }
  }

  return renamed === 0
    ? []
    : [`mcp: project identifiers written into ${renamed} file(s) (env prefix, client id, origin)`];
}

/** Every file beneath `abs`, skipping what is never ours to rewrite. */
function mcpFilesUnder(abs: string): string[] {
  if (!existsSync(abs)) return [];
  if (!statSync(abs).isDirectory()) return [abs];
  const out: string[] = [];
  for (const entry of readdirSync(abs)) {
    if (entry === "node_modules" || entry === "dist") continue;
    out.push(...mcpFilesUnder(join(abs, entry)));
  }
  return out;
}
