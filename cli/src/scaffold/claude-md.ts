/*
 * CLAUDE.md customization for `hatchkit create`.
 *
 * The starter ships an agent-memory file describing the FULL starter —
 * Express middleware ordering, Mongo, dotenvx, desktop/mobile shells,
 * the newsletter smoke scripts. Most of that is wrong for a narrower
 * scaffold, and it's the first file an agent reads in a generated
 * project, so shipping it verbatim actively misleads.
 *
 * `starter/CLAUDE.md` marks the conditional regions with HTML comments:
 *
 *   <!-- hatchkit:if server -->   …block…   <!-- hatchkit:endif -->
 *   text<!-- hatchkit:if stripe -->, inline tail<!-- hatchkit:endif -->
 *
 * Blocks nest. Every `hatchkit:` marker (including the `hatchkit:doc`
 * notes explaining the convention) is stripped from the generated file,
 * so what ships is plain Markdown either way.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProjectConfig } from "../prompts.js";
import { rewriteFile } from "./starter-files.js";
import { surfaceHasClient, surfaceHasServer } from "./surfaces.js";

/** The literal H1 / package name the starter ships with. */
const STARTER_NAME = "node-realtime-starter";

/** Rename and prune the scaffold's CLAUDE.md. Call AFTER the feature
 *  strips, the postgres overlay (which substitutes the DB name into
 *  this file), and `pruneToSurface`, so the conditions match what
 *  actually survived on disk. No-op when the starter has no CLAUDE.md. */
export function applyClaudeMd(
  config: ProjectConfig,
  outputDir: string,
  modifications: string[],
): void {
  const path = join(outputDir, "CLAUDE.md");
  if (!existsSync(path)) return;
  const active = activeConditions(config);
  rewriteFile(path, (raw) => {
    let out = applyConditionals(raw, active);
    out = out.replaceAll(STARTER_NAME, config.name);
    out = applyTagline(out, config);
    return tidyBlankLines(out);
  });
  modifications.push("CLAUDE.md (renamed + pruned to the selected surface/features)");
}

/** The condition names `hatchkit:if` may reference. Anything not in
 *  this set is treated as false, so a typo prunes rather than leaks —
 *  and a marker for a feature this CLI version doesn't know about
 *  doesn't survive into a project that can't honour it. */
function activeConditions(config: ProjectConfig): Set<string> {
  const server = surfaceHasServer(config.surfaces);
  const client = surfaceHasClient(config.surfaces);
  const desktop = config.features.includes("desktop");
  const mobile = config.features.includes("mobile");
  const on: Record<string, boolean> = {
    server,
    client,
    fullstack: server && client,
    static: config.surfaces === "static",
    backend: config.surfaces === "backend",
    // Mirrors the `wantsNewsletter` gate in app.ts — a static scaffold
    // has no server to host the subscribe pipeline, so the smoke
    // scripts go regardless of the email choice.
    newsletter: config.email?.mailingList === "listmonk-ses" && config.surfaces !== "static",
    desktop,
    mobile,
    native: desktop || mobile,
    websocket: config.features.includes("websocket"),
    stripe: config.features.includes("stripe"),
    workspaces: config.features.includes("workspaces"),
  };
  return new Set(Object.keys(on).filter((k) => on[k]));
}

const DIRECTIVE_LINE = /^\s*<!--\s*hatchkit:.*-->\s*$/;
const OPEN_LINE = /^\s*<!--\s*hatchkit:if\s+([\w-]+)\s*-->\s*$/;
const CLOSE_LINE = /^\s*<!--\s*hatchkit:endif\s*-->\s*$/;
const INLINE_SPAN = /<!--\s*hatchkit:if\s+([\w-]+)\s*-->(.*?)<!--\s*hatchkit:endif\s*-->/g;

/** Resolve every conditional marker. Block markers own their whole
 *  line and nest; inline spans live inside one line and don't. */
function applyConditionals(md: string, active: Set<string>): string {
  const out: string[] = [];
  // One entry per open block: whether its contents are kept. An inner
  // block only keeps when every enclosing block does.
  const stack: boolean[] = [];
  const keeping = (): boolean => stack.every(Boolean);

  for (const line of md.split("\n")) {
    const open = OPEN_LINE.exec(line);
    if (open) {
      stack.push(active.has(open[1]));
      continue;
    }
    if (CLOSE_LINE.test(line)) {
      stack.pop();
      continue;
    }
    if (!keeping()) continue;
    // `hatchkit:doc` notes (and any other marker we don't act on) are
    // scaffolding for the starter, not content for the project.
    if (DIRECTIVE_LINE.test(line)) continue;
    out.push(
      line.replace(INLINE_SPAN, (_m, cond: string, body: string) => (active.has(cond) ? body : "")),
    );
  }
  return out.join("\n");
}

/** Swap the starter's one-line pitch for the user's description, or
 *  failing that a sentence that matches the surface they picked. */
function applyTagline(md: string, config: ProjectConfig): string {
  const tagline = config.description?.trim() || defaultTagline(config);
  return md.replace(/^A stampable starter repo[^\n]*$/m, tagline);
}

function defaultTagline(config: ProjectConfig): string {
  const db = config.dbEngine === "postgres" ? "PostgreSQL" : "MongoDB";
  if (config.surfaces === "static") {
    return "A static Next.js (App Router) frontend — Tailwind CSS + shadcn/ui, no backend.";
  }
  if (config.surfaces === "backend") {
    return `An Express + TypeScript backend — tRPC, better-auth, ${db}. No bundled frontend.`;
  }
  return `Express backend, Next.js frontend, ${db}, tRPC, better-auth.`;
}

/** Pruning leaves runs of blank lines where blocks used to be. Collapse
 *  them so the result reads like a hand-written file. */
function tidyBlankLines(md: string): string {
  return `${md
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .trimEnd()}\n`;
}
