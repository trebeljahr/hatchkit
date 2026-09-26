/*
 * cli/src/features/token-client-auth/index.ts — session identity, lifetime
 * and devices.
 *
 * Row 1 of `docs/template-gaps.md`, minus the parts other features already
 * shipped. What this one owns:
 *
 *   · the self-reported client header, and the `client` field it stamps on
 *     every session row;
 *   · per-client-kind session lifetime, enforced by BOTH database hooks;
 *   · `packages/core/src/session-auth.ts` — password sign-in and the device
 *     flow, from a host with no cookie jar;
 *   · `exposedHeaders: ["set-auth-token"]`, without which no cross-origin
 *     client can read the token it was just issued;
 *   · Settings → Devices, with per-session revocation.
 *
 * What it deliberately does NOT own, and why:
 *
 *   · `bearer()` and the plugin registration order — `auth-account-security`,
 *     whose `plugin-order.ts` argues the ordering constraint.
 *   · the RFC 8628 endpoints and per-request trusted origins — the `extension`
 *     feature, which is what needs them first.
 *   · the socket feed, its revoked-session close code and the client latch —
 *     `client-core`.
 *
 * Every name it emits comes from `ctx.identifiers`. None is derived here: a
 * header name and a client id are contracts the moment a token is issued
 * against them, and a second derivation rule is how a project ends up with
 * two of them.
 */
import type { ProjectIdentifiers } from "../../scaffold/identifiers.js";
import { clientCoreFeature } from "../client-core/index.js";
import { type FeatureContext, registerFeature } from "../contract.js";
import {
  type TemplateTokens,
  identifierTemplateTokens,
  renderFeatureTemplate,
} from "../templates.js";
import { type RewriteResult, rewriteAuthConfig, rewriteBarrel, rewriteCors } from "./rewriter.js";

export * from "./rewriter.js";

/** Where this feature's templates live under `cli/src/templates/`. */
export const TEMPLATE_DIR = "token-client-auth";

/** Files this feature generates and owns outright. */
export const OWNED = {
  sharedClientKind: "packages/shared/src/client-kind.ts",
  coreSessionAuth: "packages/core/src/session-auth.ts",
  authClientLabel: "packages/server/src/auth/client-label.ts",
  authSessionLifetime: "packages/server/src/auth/session-lifetime.ts",
  authSessionHooks: "packages/server/src/auth/session-hooks.ts",
  devicesPage: "packages/client/src/app/(protected)/settings/devices/page.tsx",
  doc: "docs/token-client-auth.md",
} as const;

/** Files the starter owns, which this feature edits in place. */
export const EDITED = {
  sharedIndex: "packages/shared/src/index.ts",
  coreIndex: "packages/core/src/index.ts",
  authConfig: "packages/server/src/auth/auth.ts",
  serverApp: "packages/server/src/app.ts",
} as const;

/** The template for each owned file, without the `.tmpl` the loader adds. */
export const TEMPLATE_FOR: Record<keyof typeof OWNED, string> = {
  sharedClientKind: "shared/client-kind.ts",
  coreSessionAuth: "core/session-auth.ts",
  authClientLabel: "server/auth/client-label.ts",
  authSessionLifetime: "server/auth/session-lifetime.ts",
  authSessionHooks: "server/auth/session-hooks.ts",
  devicesPage: "client/devices-page.tsx",
  doc: "docs/token-client-auth.md",
};

/**
 * The tokens these templates need on top of the shared identifier set.
 *
 * One per client id, because a template cannot index a record. They are read
 * from the identifiers, never rebuilt from the project name.
 */
export function featureTokens(ids: ProjectIdentifiers): TemplateTokens {
  return {
    ...identifierTemplateTokens(ids),
    CLIENT_ID_DESKTOP: ids.clientIds.desktop,
    CLIENT_ID_MOBILE: ids.clientIds.mobile,
    CLIENT_ID_EXTENSION: ids.clientIds.extension,
    CLIENT_ID_RAYCAST: ids.clientIds.raycast,
    CLIENT_ID_MCP: ids.clientIds.mcp,
    CLIENT_ID_CLI: ids.clientIds.cli,
  };
}

/** Render one of this feature's templates. */
export function render(name: string, ids: ProjectIdentifiers): string {
  return renderFeatureTemplate(TEMPLATE_DIR, `${name}.tmpl`, featureTokens(ids));
}

export const tokenClientAuthFeature = registerFeature({
  id: "token-client-auth",
  title: "Session identity, lifetime and devices",
  summary:
    "A named client on every session, per-client-kind lifetimes, cookie-less sign-in helpers, and a devices list.",
  /**
   * `packages/core` is where the host-free sign-in helper belongs — the same
   * code has to run in Node, in a service worker and in a WebView — and
   * `client-core` is the feature that creates that package. Stated as a
   * prerequisite rather than checked at runtime so the selection pulls it in
   * and orders it first, per docs/feature-authoring.md.
   */
  requires: [clientCoreFeature.id],
  /** The same surfaces `client-core` serves: the kit needs a client package,
   *  and the hooks need a server. */
  surfaces: ["fullstack", "split"],
  addableAfterScaffold: true,

  apply(ctx: FeatureContext) {
    const { ledger, identifiers, log } = ctx;

    if (!ledger.exists(EDITED.authConfig)) {
      log(
        `  token-client-auth: skipped — ${EDITED.authConfig} is missing. A project with no server has no session to name.`,
      );
      return;
    }

    const write = (key: keyof typeof OWNED): void => {
      ledger.writeIfChanged(OWNED[key], render(TEMPLATE_FOR[key], identifiers));
    };

    /**
     * Run one anchored rewrite against a file the starter owns.
     *
     * The rewrite decides before the ledger writes, so a file whose anchors
     * have moved is recorded as a CONFLICT rather than as `unchanged`.
     * `unchanged` is what "already applied" looks like, and the two must not
     * be indistinguishable — a user whose `auth.ts` was skipped needs to hear
     * it.
     *
     * The transform handed to `edit` is a constant function, trivially a fixed
     * point; the real idempotence lives in the rewrites, each of which
     * recognises its own output.
     */
    const applyEdit = (rel: string, rewrite: (source: string) => RewriteResult): void => {
      const source = ledger.read(rel);
      if (source === undefined) {
        // Records `absent`. A feature editing a file another feature owns has
        // to tolerate that feature being off.
        ledger.edit(rel, (unchanged) => unchanged);
        return;
      }
      const result = rewrite(source);
      if (result.outcome === "manual") {
        ledger.conflict(rel, result.reason ?? "could not be edited automatically");
        return;
      }
      ledger.edit(rel, () => result.next ?? source);
    };

    write("sharedClientKind");
    write("authSessionLifetime");
    write("authClientLabel");
    write("authSessionHooks");
    write("doc");

    applyEdit(EDITED.sharedIndex, (source) => rewriteBarrel(source, ["client-kind"]));
    applyEdit(EDITED.authConfig, rewriteAuthConfig);
    applyEdit(EDITED.serverApp, rewriteCors);

    // The sign-in helper lives in the client kit, which `client-core` created
    // before this ran.
    if (ledger.exists(EDITED.coreIndex)) {
      write("coreSessionAuth");
      // No tsconfig edit: `packages/core` already compiles with the DOM lib,
      // which the sign-in helper needs for `fetch`, `Response` and
      // `AbortSignal`. The client kit ships it that way.
      applyEdit(EDITED.coreIndex, (source) => rewriteBarrel(source, ["session-auth"]));
    } else {
      ledger.conflict(
        OWNED.coreSessionAuth,
        `${EDITED.coreIndex} is missing, so the sign-in helper was not written. Add the client-core feature, then re-run.`,
      );
    }

    if (ledger.exists("packages/client/src/app/layout.tsx")) {
      write("devicesPage");
    } else {
      log("  token-client-auth: no client — the devices screen was not written.");
    }

    log(
      `  token-client-auth: clients identify with \`${identifiers.clientHeader}\`. The value is self-reported: it labels a session and picks its window, and is never an authorization decision.`,
    );
  },
});
