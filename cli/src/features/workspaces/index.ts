/*
 * cli/src/features/workspaces/index.ts — the `workspaces` feature:
 * tenants, members, roles and invitations for a scaffolded app.
 *
 * The first feature written against `features/contract.ts`, so it is
 * also the worked example the doc points at: every mutation goes
 * through `ctx.ledger`, which means `--dry-run` works without this file
 * knowing what a dry run is.
 *
 * It is purely ADDITIVE, which is why `create` and `update` share one
 * `apply` instead of the usual write-at-create / copy-at-update pair.
 * Nothing in `starter/` imports these files, so an unselected project
 * has nothing to strip and cannot fail to build on a dangling import —
 * the failure mode that gives every other feature here a paired
 * call-site stripper. The cost is that the emitted source lives under
 * `cli/src/templates/workspaces/` rather than in `starter/`, so it is
 * not exercised by the starter's own typecheck; `cli/test-workspaces.ts`
 * covers it instead.
 */

import { type FeatureContext, registerFeature } from "../contract.js";
import {
  findUnrenderedTokens,
  identifierTemplateTokens,
  renderFeatureTemplate,
} from "../templates.js";
import { runWorkspaceCodemods } from "./codemods.js";
import { filesFor } from "./file-map.js";
import { INVITES_PER_HOUR, INVITE_TTL_DAYS, PENDING_INVITE_CAP } from "./limits.js";
import type { WorkspacesTargets } from "./types.js";

export { WORKSPACE_FILES, filesFor, enabledGroups } from "./file-map.js";
export { runWorkspaceCodemods } from "./codemods.js";
export { PENDING_INVITE_CAP, INVITES_PER_HOUR, INVITE_TTL_DAYS } from "./limits.js";
export type { WorkspacesTargets } from "./types.js";

/** Template directory under `cli/src/templates/`. */
export const WORKSPACES_TEMPLATE_DIR = "workspaces";

/**
 * Work out which halves of a project exist. A `static` surface has no
 * server, a `backend` surface has no client, and the per-recipient
 * realtime fan-out only means anything with the websocket feature on.
 *
 * Read off the disk rather than off the manifest: `update` runs against
 * a repository somebody has been working in, and the manifest records
 * what was scaffolded, not what is there now.
 */
export function detectTargets(
  ledgerExists: (rel: string) => boolean,
  features: readonly string[],
): WorkspacesTargets {
  return {
    server: ledgerExists("packages/server/src/trpc/router.ts"),
    shared: ledgerExists("packages/shared/src/index.ts"),
    client: ledgerExists("packages/client/src/app/layout.tsx"),
    websocket: features.includes("websocket"),
  };
}

/** The tokens the feature's templates render with. */
export function workspacesTokens(ctx: FeatureContext): Record<string, string> {
  return {
    // Never derived here — the frozen set, so the storage key this
    // feature writes under agrees with every other one in the project.
    ...(identifierTemplateTokens(ctx.identifiers) as Record<string, string>),
    PENDING_INVITE_CAP: String(PENDING_INVITE_CAP),
    INVITES_PER_HOUR: String(INVITES_PER_HOUR),
    INVITE_TTL_DAYS: String(INVITE_TTL_DAYS),
  };
}

export const workspacesFeature = registerFeature({
  id: "workspaces",
  title: "Workspaces (tenants, members, roles, invitations)",
  summary:
    "Multi-tenancy: an app-owned membership mirror, a typed API and a REST surface over one service layer, and invitations that work without a mail transport.",
  // Every surface with a server. A `static` project has nothing to
  // authorize from, so the picker should not offer it.
  surfaces: ["fullstack", "split", "backend"],
  addableAfterScaffold: true,

  apply(ctx: FeatureContext) {
    const targets = detectTargets((rel) => ctx.ledger.exists(rel), ctx.manifest.features);

    if (!targets.server && !targets.client) {
      ctx.log("  workspaces: no packages/server or packages/client found — nothing written.");
      return;
    }

    const tokens = workspacesTokens(ctx);
    const files = filesFor(targets);

    for (const file of files) {
      const rendered = renderFeatureTemplate(WORKSPACES_TEMPLATE_DIR, file.template, tokens);
      // A template that outgrew its token list would otherwise ship a
      // literal __HATCHKIT_FOO__ into the user's repo, hundreds of
      // lines from anything they wrote.
      const leftover = findUnrenderedTokens(rendered);
      if (leftover.length > 0) {
        throw new Error(
          `Workspaces template ${file.template} still holds ${leftover.join(", ")} after rendering. Add the token in features/workspaces/index.ts.`,
        );
      }
      ctx.ledger.writeIfChanged(file.dest, rendered);
    }

    runWorkspaceCodemods(ctx, targets);

    if (targets.server && !targets.websocket) {
      ctx.log(
        "  workspaces: websocket is off — membership events publish into a no-op, so the members screen will not live-refresh.",
      );
    }
    // The Postgres overlay rewrites the db layer to Drizzle; the mirror
    // model and the collection accessors this feature ships are
    // Mongoose/MongoDB. Say so rather than leaving the user to discover
    // it at build time.
    if (ctx.ledger.exists("packages/server/src/db/schema.ts")) {
      ctx.log(
        "  workspaces: this project uses the Postgres (Drizzle) overlay — port services/membership/mirror.ts before the server will build.",
      );
    }
    if (files.length > 0) {
      ctx.log(
        "  workspaces: run `pnpm --filter @starter/shared run build` so the server and client pick up the membership contract.",
      );
    }
  },
});

/** True when the project already carries the feature's files. */
export function hasWorkspacesFeature(exists: (rel: string) => boolean): boolean {
  return exists("packages/server/src/services/membership/index.ts");
}
