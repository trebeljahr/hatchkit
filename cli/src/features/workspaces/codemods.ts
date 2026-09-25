/*
 * cli/src/features/workspaces/codemods.ts — the in-place edits that wire
 * the feature's new files into a project that already exists.
 *
 * Every rewriter is a FIXED POINT: it anchors on what the edit
 * PRODUCES, not on where the edit goes, so running it twice is the same
 * as running it once. `update` re-applies every selected feature on
 * every run, and a rewriter that checked only for its insertion point
 * would add a second router registration each time — silently, and
 * cumulatively.
 *
 * They also fail SOFT. Returning the content unchanged tells the ledger
 * "unchanged"; returning null means this file is not shaped the way we
 * expect — a user who moved `createApp()` elsewhere gets a "wire this
 * up yourself" line, not a mangled `app.ts`.
 *
 * Nothing here touches `node:fs`. Every write goes through
 * `ctx.ledger`, which is what makes `--dry-run` correct for free.
 */

import type { FeatureContext } from "../contract.js";
import type { WorkspacesTargets } from "./types.js";

/**
 * Apply one rewriter. `fn` returns the new content, the SAME content
 * when the edit is already present, or null when the file is not shaped
 * the way the rewriter expects — which becomes a logged hint.
 */
function patch(
  ctx: FeatureContext,
  rel: string,
  fn: (content: string) => string | null,
  hint: string,
): void {
  if (!ctx.ledger.exists(rel)) return;
  let recognised = true;
  ctx.ledger.edit(rel, (content) => {
    const out = fn(content);
    if (out === null) {
      recognised = false;
      return content;
    }
    return out;
  });
  if (!recognised) ctx.log(`  workspaces: ${hint}`);
}

/* ── shared: re-export the membership contract ──────────────────────── */

export function wireSharedExport(ctx: FeatureContext): void {
  patch(
    ctx,
    "packages/shared/src/index.ts",
    (content) => {
      if (content.includes("./membership.js")) return content;
      return `${content.trimEnd()}\nexport * from "./membership.js";\n`;
    },
    'Add `export * from "./membership.js";` to packages/shared/src/index.ts.',
  );
}

/* ── server: register the three routers ─────────────────────────────── */

const ROUTER_IMPORTS = `import { workspacesRouter } from "./routers/workspaces.js";
import { membersRouter } from "./routers/members.js";
import { invitationsRouter } from "./routers/invitations.js";
`;

export function wireTrpcRouter(ctx: FeatureContext): void {
  patch(
    ctx,
    "packages/server/src/trpc/router.ts",
    (content) => {
      if (content.includes("workspacesRouter")) return content;
      // Anchor on the last existing router import so the new ones land in
      // the same block rather than above the file's header comment.
      const importAnchor =
        /(^import .*from "\.\/routers\/[^"]+\.js";\n)(?![\s\S]*^import .*from "\.\/routers\/)/m;
      if (!importAnchor.test(content)) return null;
      let out = content.replace(importAnchor, `$1${ROUTER_IMPORTS}`);

      // Anchor on the router object's opening brace.
      const objectAnchor = /(export const appRouter = router\(\{\n)/;
      if (!objectAnchor.test(out)) return null;
      out = out.replace(
        objectAnchor,
        `$1  workspaces: workspacesRouter,\n  members: membersRouter,\n  invitations: invitationsRouter,\n`,
      );
      return out;
    },
    "Register workspacesRouter, membersRouter and invitationsRouter in packages/server/src/trpc/router.ts.",
  );
}

/* ── server: the organization plugin, locked down ───────────────────── */

export function wireAuthPlugin(ctx: FeatureContext): void {
  patch(
    ctx,
    "packages/server/src/auth/auth.ts",
    (content) => {
      if (content.includes("organizationLockdown")) return content;

      const importAnchor = /(import \{ mongodbAdapter \} from "better-auth\/adapters\/mongodb";\n)/;
      if (!importAnchor.test(content)) return null;
      let out = content.replace(
        importAnchor,
        `$1import { organization } from "better-auth/plugins";\n` +
          `import { organizationLockdown } from "./organization-lockdown.js";\n` +
          `import { bootstrapWorkspaceOnUserCreate } from "./workspace-bootstrap.js";\n`,
      );

      // Anchor on `baseURL`, not on `trustedOrigins`.
      //
      // This used to match the literal line `trustedOrigins:
      // getTrustedOrigins(),`, which broke the moment another feature
      // made that option a per-request function (the store-client trust
      // switch did exactly that). The failure was the quiet kind: the
      // patch reported a conflict, the organization plugin was never
      // installed, and the project looked scaffolded.
      //
      // `baseURL: env.BETTER_AUTH_URL` is the stable line in this
      // config — better-auth cannot work without it and nothing else
      // has a reason to rewrite it. The older shape is still accepted
      // so a project scaffolded before that change can still add
      // workspaces.
      const configAnchor = /(\n {4}baseURL: env\.BETTER_AUTH_URL,\n)/;
      const legacyAnchor = /(\n {4}trustedOrigins: getTrustedOrigins\(\),\n)/;
      const anchor = configAnchor.test(out)
        ? configAnchor
        : legacyAnchor.test(out)
          ? legacyAnchor
          : null;
      if (anchor === null) return null;
      out = out.replace(
        anchor,
        `$1
    // The organization plugin stays installed for its tables and for the
    // server-side auth.api.createOrganization the signup hook calls — but
    // every /api/auth/organization/* request over HTTP answers 404. Each
    // of those endpoints writes better-auth's \`member\` and never the
    // app's WorkspaceMember mirror, so each was a way around the rules in
    // services/membership/. See auth/organization-lockdown.ts.
    plugins: [organization({ disableOrganizationDeletion: true })],
    hooks: { before: organizationLockdown },

    databaseHooks: {
      user: {
        create: {
          // A new account gets its own workspace. Never throws out of the
          // hook: a failed bootstrap must not block the signup.
          after: bootstrapWorkspaceOnUserCreate,
        },
      },
    },
`,
      );
      return out;
    },
    "Install better-auth's organization plugin with `hooks: { before: organizationLockdown }` in packages/server/src/auth/auth.ts.",
  );
}

/* ── server: mount the REST surface ─────────────────────────────────── */

export function wireRestRoutes(ctx: FeatureContext): void {
  patch(
    ctx,
    "packages/server/src/app.ts",
    (content) => {
      if (content.includes("registerWorkspaceRoutes")) return content;

      const importAnchor = /(import \{ appRouter \} from "\.\/trpc\/router\.js";\n)/;
      if (!importAnchor.test(content)) return null;
      let out = content.replace(
        importAnchor,
        `$1import { registerWorkspaceRoutes } from "./rest/workspaces.js";\n`,
      );

      // After tRPC, before the health endpoint — the REST surface shares
      // the same service layer, so ordering between the two is free, but
      // it must sit after express.json().
      const mountAnchor = /(\n {2}app\.use\("\/api\/trpc", trpcMiddleware\);\n)/;
      if (!mountAnchor.test(out)) return null;
      out = out.replace(
        mountAnchor,
        `$1
  // ── 5a. Workspaces REST — the same services/membership/ the tRPC
  //     routers call, so the two surfaces cannot drift apart.
  registerWorkspaceRoutes(app);
`,
      );
      return out;
    },
    "Call registerWorkspaceRoutes(app) after the tRPC middleware in packages/server/src/app.ts.",
  );
}

/* ── server: install the per-recipient publisher (websocket only) ───── */

export function wireMembershipPublisher(ctx: FeatureContext): void {
  patch(
    ctx,
    "packages/server/src/index.ts",
    (content) => {
      if (content.includes("installMembershipPublisher")) return content;

      const importAnchor = /(import \{ setupWebSocket \} from "\.\/ws\/handler\.js";\n)/;
      if (!importAnchor.test(content)) return null;
      let out = content.replace(
        importAnchor,
        `$1import { installMembershipPublisher } from "./ws/membership-sync.js";\n`,
      );

      // After initAuth(), so the fan-out can read memberships.
      const callAnchor = /(\n {4}await initAuth\(\);\n)/;
      if (!callAnchor.test(out)) return null;
      out = out.replace(
        callAnchor,
        `$1
    // Route the membership service's events into the per-recipient
    // fan-out. Without this the service publishes into a no-op and
    // members' screens never refresh on a role change.
    installMembershipPublisher();
`,
      );
      return out;
    },
    "Call installMembershipPublisher() after initAuth() in packages/server/src/index.ts.",
  );
}

/* ── client: let sign-in return the invitee to the invite page ──────── */

/**
 * The invite page sends a signed-out visitor to /login with a `?next=`
 * pointing back at `/invite/?id=...`. Without this patch the starter's
 * login page pushes to /dashboard unconditionally and the invitation is
 * simply lost — the person signs in and never sees who invited them.
 *
 * The parameter is read inside the submit handler from
 * `window.location.search`, NOT through `useSearchParams()`. Under
 * `output: "export"` a client component calling `useSearchParams()`
 * during render must sit inside a Suspense boundary or the build fails,
 * and wrapping the user's whole login page in one from a regex codemod
 * is not something to attempt. An event handler only ever runs in the
 * browser, so neither concern applies there.
 *
 * Every value goes through `safeNext`, which is the ONLY thing allowed
 * to validate a `next`: the login page is the one page everybody trusts,
 * which is exactly what makes an unvalidated redirect target a phishing
 * vector.
 */
function wireNextParam(ctx: FeatureContext, page: string): void {
  const rel = `packages/client/src/app/${page}/page.tsx`;
  patch(
    ctx,
    rel,
    (content) => {
      if (content.includes("safeNext")) return content;
      if (!content.includes('router.push("/dashboard")')) return null;

      const importAnchor = /(import \{ useRouter \} from "next\/navigation";\n)/;
      if (!importAnchor.test(content)) return null;
      let out = content.replace(importAnchor, `$1import { safeNext } from "@/lib/safe-next";\n`);

      out = out.replace(
        'router.push("/dashboard");',
        `// Honour ?next= (e.g. an invitation link) through safe-next, which
        // is the only validator allowed to approve one. Read here rather
        // than via useSearchParams() so the page needs no Suspense
        // boundary under a static export.
        const next =
          typeof window === "undefined"
            ? null
            : new URLSearchParams(window.location.search).get("next");
        router.push(safeNext(next, "/dashboard"));`,
      );
      return out;
    },
    `${rel} does not look like the starter's — make it honour ?next= through lib/safe-next.ts, or an invitee who signs in will land on /dashboard and lose the invitation.`,
  );
}

export function wireLoginNext(ctx: FeatureContext): void {
  wireNextParam(ctx, "login");
}

export function wireSignupNext(ctx: FeatureContext): void {
  wireNextParam(ctx, "signup");
}

/* ── client: link the members screen from the protected nav ─────────── */

/**
 * Reports only — it never writes. The starter's protected layout has no
 * nav list that can be extended reliably, and guessing at one produces
 * broken JSX. The gating is cosmetic anyway: the server authorizes from
 * the membership mirror either way.
 */
export function wireClientNav(ctx: FeatureContext): void {
  const rel = "packages/client/src/app/(protected)/layout.tsx";
  const content = ctx.ledger.read(rel);
  if (content === undefined) return;
  if (content.includes("/app/members") || content.includes('href="/members"')) return;
  ctx.log(
    "  workspaces: add a link to /members in your protected layout's navigation (cosmetic — the server authorizes independently).",
  );
}

/* ── the whole set ──────────────────────────────────────────────────── */

export function runWorkspaceCodemods(ctx: FeatureContext, targets: WorkspacesTargets): void {
  if (targets.shared) wireSharedExport(ctx);
  if (targets.server) {
    wireTrpcRouter(ctx);
    wireAuthPlugin(ctx);
    wireRestRoutes(ctx);
  }
  // The publisher lives in ws/, which only exists with that feature on.
  if (targets.server && targets.websocket) wireMembershipPublisher(ctx);
  if (targets.client) {
    wireLoginNext(ctx);
    wireSignupNext(ctx);
    wireClientNav(ctx);
  }
}
