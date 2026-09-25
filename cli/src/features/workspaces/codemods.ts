/*
 * cli/src/features/workspaces/codemods.ts — the in-place edits that wire
 * the feature's new files into a project that already exists.
 *
 * Every rewriter here is a GET-then-diff: it looks for a marker it would
 * have written itself, returns "unchanged" when it finds one, and never
 * writes a file it did not change. That is what makes `hatchkit update`
 * safe to re-run, and what keeps a half-finished run from doubling a
 * router registration on the retry.
 *
 * These edits deliberately fail SOFT. A user who moved `createApp()` into
 * another file should get a "wire this up yourself" next-step, not a
 * mangled `app.ts`.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type CodemodOutcome = "patched" | "unchanged" | "missing" | "manual";

export interface CodemodResult {
  /** Project-relative path the rewriter targets. */
  file: string;
  outcome: CodemodOutcome;
  /** Set when `outcome === "manual"` — what the user must do by hand. */
  hint?: string;
}

function patch(
  projectDir: string,
  rel: string,
  fn: (content: string) => string | null,
  hint: string,
  dryRun = false,
): CodemodResult {
  const abs = join(projectDir, rel);
  if (!existsSync(abs)) return { file: rel, outcome: "missing" };
  const before = readFileSync(abs, "utf-8");
  const after = fn(before);
  if (after === null) return { file: rel, outcome: "manual", hint };
  if (after === before) return { file: rel, outcome: "unchanged" };
  if (!dryRun) writeFileSync(abs, after, "utf-8");
  return { file: rel, outcome: "patched" };
}

/* ── shared: re-export the membership contract ──────────────────────── */

export function wireSharedExport(projectDir: string, dryRun = false): CodemodResult {
  return patch(
    projectDir,
    "packages/shared/src/index.ts",
    (content) => {
      if (content.includes("./membership.js")) return content;
      return `${content.trimEnd()}\nexport * from "./membership.js";\n`;
    },
    'Add `export * from "./membership.js";` to packages/shared/src/index.ts.',
    dryRun,
  );
}

/* ── server: register the three routers ─────────────────────────────── */

const ROUTER_IMPORTS = `import { workspacesRouter } from "./routers/workspaces.js";
import { membersRouter } from "./routers/members.js";
import { invitationsRouter } from "./routers/invitations.js";
`;

export function wireTrpcRouter(projectDir: string, dryRun = false): CodemodResult {
  return patch(
    projectDir,
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
    dryRun,
  );
}

/* ── server: the organization plugin, locked down ───────────────────── */

export function wireAuthPlugin(projectDir: string, dryRun = false): CodemodResult {
  return patch(
    projectDir,
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

      const configAnchor = /(\n {4}trustedOrigins: getTrustedOrigins\(\),\n)/;
      if (!configAnchor.test(out)) return null;
      out = out.replace(
        configAnchor,
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
    dryRun,
  );
}

/* ── server: mount the REST surface ─────────────────────────────────── */

export function wireRestRoutes(projectDir: string, dryRun = false): CodemodResult {
  return patch(
    projectDir,
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
    dryRun,
  );
}

/* ── server: install the per-recipient publisher (websocket only) ───── */

export function wireMembershipPublisher(projectDir: string, dryRun = false): CodemodResult {
  return patch(
    projectDir,
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
    dryRun,
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
function wireNextParam(projectDir: string, page: string, dryRun: boolean): CodemodResult {
  const rel = `packages/client/src/app/${page}/page.tsx`;
  return patch(
    projectDir,
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
    `Make packages/client/src/app/${page}/page.tsx honour ?next= through lib/safe-next.ts, or an invitee who signs in will land on /dashboard and lose the invitation.`,
    dryRun,
  );
}

export function wireLoginNext(projectDir: string, dryRun = false): CodemodResult {
  return wireNextParam(projectDir, "login", dryRun);
}

export function wireSignupNext(projectDir: string, dryRun = false): CodemodResult {
  return wireNextParam(projectDir, "signup", dryRun);
}

/* ── client: link the members screen from the protected nav ─────────── */

/** Never writes, so it takes no `dryRun` — it only ever reports. */
export function wireClientNav(projectDir: string): CodemodResult {
  const rel = "packages/client/src/app/(protected)/layout.tsx";
  const abs = join(projectDir, rel);
  if (!existsSync(abs)) return { file: rel, outcome: "missing" };
  const content = readFileSync(abs, "utf-8");
  if (content.includes("/app/members") || content.includes('href="/members"')) {
    return { file: rel, outcome: "unchanged" };
  }
  // The starter's protected layout has no nav list to extend reliably,
  // and guessing at one would produce broken JSX. Hand this to the user:
  // the gating is cosmetic anyway — the server refuses either way.
  return {
    file: rel,
    outcome: "manual",
    hint: "Add a link to /members in your protected layout's navigation (cosmetic — the server authorizes independently).",
  };
}

/* ── the whole set ──────────────────────────────────────────────────── */

export interface RunCodemodsInput {
  projectDir: string;
  server: boolean;
  shared: boolean;
  client: boolean;
  websocket: boolean;
  dryRun?: boolean;
}

export function runWorkspaceCodemods(input: RunCodemodsInput): CodemodResult[] {
  const { projectDir, dryRun } = input;
  const results: CodemodResult[] = [];
  if (input.shared) results.push(wireSharedExport(projectDir, dryRun));
  if (input.server) {
    results.push(wireTrpcRouter(projectDir, dryRun));
    results.push(wireAuthPlugin(projectDir, dryRun));
    results.push(wireRestRoutes(projectDir, dryRun));
  }
  if (input.server && input.websocket) {
    results.push(wireMembershipPublisher(projectDir, dryRun));
  }
  if (input.client) {
    results.push(wireLoginNext(projectDir, dryRun));
    results.push(wireSignupNext(projectDir, dryRun));
    results.push(wireClientNav(projectDir));
  }
  return results;
}
