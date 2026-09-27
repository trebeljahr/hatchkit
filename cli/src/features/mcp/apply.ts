/*
 * cli/src/features/mcp/apply.ts — layering `packages/mcp` onto a project
 * through the ledger.
 *
 * Every mutation goes through `ctx.ledger`, so `--dry-run` and idempotency
 * are structural rather than remembered (docs/feature-authoring.md →
 * "--dry-run"). Three kinds of write, one primitive each:
 *
 *  - The package's own source is WRITTEN when absent and only RENAMED when it
 *    is already there. `writeIfChanged` alone would be wrong even though this
 *    feature generates the files: `packages/mcp/src/tools.ts` is source a user
 *    edits the first time they add a tool, and overwriting it on the next
 *    `update` would silently undo that work.
 *  - The root manifest's scripts go through `mergePackageJson`, which is
 *    add-only and REPORTS a differing value instead of reverting it.
 *  - The one aggregate script the package has to be named in is a fixed-point
 *    `edit`: the segment's presence is the idempotency key.
 *
 * The rename pass runs in BOTH directions of the scaffold, which is why there
 * is no separate create-time hook the way `client-core` needs one. `create`
 * copies the whole starter first, so by the time this runs the files are
 * already on disk and the copy step skips them — the `edit` branch is what
 * puts the project's own names into them.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { clientBuildArgUrls } from "../../scaffold/client-build-args.js";
import { substituteIdentifierTokens } from "../../scaffold/identifiers.js";
// Through the feature's own door rather than its internals: the walker
// skips `node_modules` and `dist`, and a second copy of that rule here would
// be a second chance to ship this repository's build output in a scaffold.
import { starterFilesUnder } from "../client-core/index.js";
import type { FeatureContext, FeaturePlanContext } from "../contract.js";
import { renameMcpLiterals, retargetApiOrigin, setProductName } from "./rename.js";
import {
  MCP_OWNED_PATHS,
  MCP_ROOT_SCRIPTS,
  MCP_TEST_AGGREGATE,
  MCP_TEST_SEGMENT,
  PUBLIC_API_ROUTE_TABLE,
} from "./types.js";

/** Monorepo root → the starter template, four hops up from the compiled file. */
const MONOREPO_ROOT = resolve(join(import.meta.dirname, "..", "..", "..", ".."));
const STARTER_ROOT = join(MONOREPO_ROOT, "starter");

export type ApplyMcpResult = {
  /** Things only a person can do, for the caller to print after the run. */
  manual: string[];
};

/**
 * The API origin this project's clients are built against.
 *
 * `clientBuildArgUrls` is the same function the web client's build args come
 * from, so the origin the MCP server defaults to and the origin the web app is
 * built against cannot disagree — which they did the last time two call sites
 * each composed `https://${domain}` with their own idea of the topology.
 */
export function apiOriginFor(project: {
  domain: string;
  topology?: FeaturePlanContext["manifest"]["topology"];
}): string {
  // Takes the two fields it reads rather than a whole manifest: the create
  // path needs this BEFORE `toManifest` has run, and widening the parameter is
  // honest about what the function actually depends on.
  return clientBuildArgUrls(project.domain, project.topology ?? "single-origin").apiUrl;
}

/** Every project-relative file the feature would write. */
export function mcpPlannedFiles(starterRoot: string = STARTER_ROOT): string[] {
  return MCP_OWNED_PATHS.flatMap((rel) => starterFilesUnder(starterRoot, rel));
}

export function applyMcp(ctx: FeatureContext, starterRoot: string = STARTER_ROOT): ApplyMcpResult {
  const manual: string[] = [];

  if (!existsSync(starterRoot)) {
    ctx.log(
      `  mcp: starter template not found at ${starterRoot} — re-clone or pull the latest main.`,
    );
    return { manual };
  }

  const apiOrigin = apiOriginFor(ctx.manifest);
  const render = (content: string): string =>
    setProductName(
      retargetApiOrigin(
        renameMcpLiterals(substituteIdentifierTokens(content, ctx.identifiers), ctx.identifiers),
        apiOrigin,
      ),
      ctx.identifiers.productName,
    );

  let kept = 0;
  for (const rel of mcpPlannedFiles(starterRoot)) {
    const source = readStarterFile(starterRoot, rel);
    if (source === null) continue;
    if (ctx.ledger.exists(rel)) {
      // Already here — a fresh scaffold, or a re-run. The file is the
      // project's from the moment it landed, so the only thing done to it is
      // the rename, which is a fixed point and finds nothing on a re-run.
      kept += 1;
      ctx.ledger.edit(rel, render);
      continue;
    }
    ctx.ledger.writeIfChanged(rel, render(source));
  }
  if (kept > 0) {
    ctx.log(`  mcp: kept ${kept} existing file(s) — they are yours now.`);
  }

  ctx.ledger.mergePackageJson("package.json", { scripts: { ...MCP_ROOT_SCRIPTS } });
  if (!nameTestsInAggregate(ctx)) {
    manual.push(
      `Add \`&& ${MCP_TEST_SEGMENT}\` to the root \`${MCP_TEST_AGGREGATE}\` script: the aggregate names its packages one at a time, and a package it does not name is one whose tests never run in CI.`,
    );
  }

  // Not a conflict — nothing failed to apply, and the feature is still worth
  // having in a project that is about to add the REST surface. But a package
  // whose every tool calls `/api/v1` is useless against a server that has
  // none, and the failure a user would otherwise meet is a 404 on every call
  // with nothing saying why.
  if (!ctx.ledger.exists(PUBLIC_API_ROUTE_TABLE)) {
    manual.push(
      `This project has no ${PUBLIC_API_ROUTE_TABLE}, so there is no /api/v1 for the server to call. Add the \`public-api\` feature — every tool this package offers is a client of that surface.`,
    );
  }

  manual.push(
    `Run \`pnpm install\` for the new workspace package, then \`pnpm run build:mcp\` and follow packages/mcp/README.md — verify the binary BEFORE configuring a host, because a misconfigured stdio server reports only that the process exited.`,
  );

  for (const conflict of ctx.ledger.conflicts()) {
    ctx.log(`  mcp: ${conflict.file} — ${conflict.detail ?? "not applied"}`);
  }
  return { manual };
}

/**
 * Name the package's tests in the root aggregate, once.
 *
 * A fixed point: the segment's presence is the idempotency key, so a second
 * apply changes nothing and a project that moved the segment elsewhere in the
 * chain keeps it where they put it. Returns false when there is no aggregate
 * to append to, which is a manual step rather than a guess about where the
 * project runs its tests.
 */
function nameTestsInAggregate(ctx: FeatureContext): boolean {
  const raw = ctx.ledger.read("package.json");
  if (raw === undefined) return false;
  let current: string | undefined;
  try {
    current = (JSON.parse(raw) as { scripts?: Record<string, string> }).scripts?.[
      MCP_TEST_AGGREGATE
    ];
  } catch {
    return false;
  }
  if (current === undefined) return false;
  if (current.includes(MCP_TEST_SEGMENT)) return true;

  ctx.ledger.edit("package.json", (content) => {
    const pkg = JSON.parse(content) as { scripts?: Record<string, string> };
    const script = pkg.scripts?.[MCP_TEST_AGGREGATE];
    if (pkg.scripts === undefined || script === undefined || script.includes(MCP_TEST_SEGMENT)) {
      return content;
    }
    pkg.scripts[MCP_TEST_AGGREGATE] = `${script} && ${MCP_TEST_SEGMENT}`;
    return `${JSON.stringify(pkg, null, 2)}\n`;
  });
  return true;
}

function readStarterFile(starterRoot: string, rel: string): string | null {
  const abs = join(starterRoot, rel);
  if (!existsSync(abs) || statSync(abs).isDirectory()) return null;
  try {
    return readFileSync(abs, "utf-8");
  } catch {
    return null;
  }
}
