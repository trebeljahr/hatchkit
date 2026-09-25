/*
 * cli/test-workspaces.ts — the `workspaces` feature (tenants, members,
 * roles, invitations).
 *
 * Two jobs.
 *
 * 1. The PACKAGING contract: every template in the file map exists,
 *    renders with no placeholder left behind, lands where the map says,
 *    is idempotent on a re-run, and never clobbers a file the user has
 *    edited. `hatchkit update` re-running over a live project is the
 *    common case, and a writer that overwrote a customised members
 *    screen would be discovered far too late.
 *
 * 2. The RULES, pinned at this layer. The generated app carries its own
 *    tests for them, but those only run inside a scaffolded project. A
 *    template edit that silently drops the CSPRNG invitation id, or the
 *    mirror-last write order, or the 404 lockdown, would ship to every
 *    future project and break nothing loudly. So this file greps the
 *    rendered output for the load-bearing lines. Each assertion names
 *    what breaks if it stops holding — if you are here because one
 *    failed, read that message before you change the assertion.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  applyWorkspacesFeature,
  detectTargets,
  filesFor,
  hasWorkspacesFeature,
  renderWorkspacesTemplate,
  WORKSPACE_FILES,
} from "./src/features/workspaces/index.js";
import { defaultTokens } from "./src/features/workspaces/render.js";
import type { WorkspacesTargets } from "./src/features/workspaces/types.js";

const results: Record<string, boolean> = {};

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return (async () => {
    try {
      await fn();
      results[name] = true;
    } catch (err) {
      results[name] = false;
      console.log(`\n  x ${name}\n    ${(err as Error).message}\n`);
    }
  })();
}

const ALL_TARGETS: WorkspacesTargets = {
  server: true,
  shared: true,
  client: true,
  websocket: true,
};

/* ── A throwaway project shaped like a scaffolded one ────────────────── */

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf-8");
}

/** The parts of the starter the codemods anchor on, and nothing else. */
function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "hatchkit-workspaces-"));

  write(root, "packages/shared/src/index.ts", 'export * from "./types.js";\n');

  write(
    root,
    "packages/server/src/trpc/router.ts",
    `import { router } from "./trpc.js";
import { healthRouter } from "./routers/health.js";
import { itemsRouter } from "./routers/items.js";

export const appRouter = router({
  health: healthRouter,
  items: itemsRouter,
});

export type AppRouter = typeof appRouter;
`,
  );

  write(
    root,
    "packages/server/src/auth/auth.ts",
    `import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { env, getTrustedOrigins } from "../config/env.js";

export async function initAuth(): Promise<void> {
  _auth = betterAuth({
    database: mongodbAdapter(db),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: getTrustedOrigins(),

    emailAndPassword: { enabled: true },
  });
}
`,
  );

  write(
    root,
    "packages/server/src/app.ts",
    `import express from "express";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "./trpc/router.js";
import { createContext } from "./trpc/context.js";

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "100kb" }));
  const trpcMiddleware = createExpressMiddleware({ router: appRouter, createContext });
  app.use("/api/trpc", trpcMiddleware);

  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
  return app;
}
`,
  );

  write(
    root,
    "packages/server/src/index.ts",
    `import { createApp } from "./app.js";
import { initAuth, disconnectAuth } from "./auth/auth.js";
import { setupWebSocket } from "./ws/handler.js";

async function start(): Promise<void> {
  try {
    await connectToDB();
    await initAuth();
    server.listen(env.PORT);
  } catch (err) {
    process.exit(1);
  }
}
`,
  );

  write(root, "packages/client/src/app/layout.tsx", "export default function L() { return null; }\n");

  // The starter's login and signup pages, reduced to the two lines the
  // ?next= codemod anchors on.
  for (const page of ["login", "signup"]) {
    write(
      root,
      `packages/client/src/app/${page}/page.tsx`,
      `"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "@/lib/auth-client";

export default function Page() {
  const router = useRouter();
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const result = await signIn.email({ email, password });
    if (result.error) {
      setError(result.error.message ?? "Login failed");
    } else {
      router.push("/dashboard");
    }
  }
  return null;
}
`,
    );
  }
  return root;
}

function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), "utf-8");
}

/* ── 1. Packaging ────────────────────────────────────────────────────── */

await test("every template in the file map exists and renders fully", () => {
  const tokens = defaultTokens("demo-app");
  for (const file of WORKSPACE_FILES) {
    const rendered = renderWorkspacesTemplate(file.template, tokens);
    assert.ok(rendered.length > 0, `${file.template} rendered empty`);
    const leftover = rendered.match(/__HATCHKIT_[A-Z0-9_]+__/);
    assert.equal(
      leftover,
      null,
      `${file.template} still holds ${leftover?.[0]} — add the token to WorkspacesTokens`,
    );
  }
});

await test("destinations are unique and project-relative", () => {
  const seen = new Set<string>();
  for (const file of WORKSPACE_FILES) {
    assert.ok(!file.dest.startsWith("/"), `${file.dest} must be project-relative`);
    assert.ok(!file.dest.includes("\\"), `${file.dest} must use forward slashes`);
    assert.ok(!seen.has(file.dest), `two templates both write ${file.dest}`);
    seen.add(file.dest);
  }
});

await test("apply writes the files and wires the existing ones", () => {
  const root = makeProject();
  try {
    const result = applyWorkspacesFeature({
      projectDir: root,
      projectName: "demo-app",
      targets: ALL_TARGETS,
    });

    assert.equal(result.skipped.length, 0, "nothing should be skipped in a fresh project");
    assert.equal(
      result.written.length,
      filesFor(ALL_TARGETS).length,
      "every file for these targets should be written",
    );
    assert.ok(hasWorkspacesFeature(root), "the feature should be detectable afterwards");

    // The four wirings.
    assert.match(read(root, "packages/shared/src/index.ts"), /export \* from "\.\/membership\.js";/);

    const router = read(root, "packages/server/src/trpc/router.ts");
    assert.match(router, /workspaces: workspacesRouter/);
    assert.match(router, /members: membersRouter/);
    assert.match(router, /invitations: invitationsRouter/);
    assert.match(router, /from "\.\/routers\/workspaces\.js"/);

    const auth = read(root, "packages/server/src/auth/auth.ts");
    assert.match(auth, /organizationLockdown/, "the lockdown must be wired as a before-hook");
    assert.match(auth, /plugins: \[organization\(/, "the plugin stays installed for its tables");
    assert.match(
      auth,
      /disableOrganizationDeletion: true/,
      "deleting an organization would orphan the mirror rows the app authorizes from",
    );

    assert.match(read(root, "packages/server/src/app.ts"), /registerWorkspaceRoutes\(app\)/);
    assert.match(read(root, "packages/server/src/index.ts"), /installMembershipPublisher\(\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("a second apply is a no-op — update must be safe to re-run", () => {
  const root = makeProject();
  try {
    applyWorkspacesFeature({ projectDir: root, projectName: "demo-app", targets: ALL_TARGETS });
    const routerAfterFirst = read(root, "packages/server/src/trpc/router.ts");

    const second = applyWorkspacesFeature({
      projectDir: root,
      projectName: "demo-app",
      targets: ALL_TARGETS,
    });

    assert.equal(second.written.length, 0, `re-run wrote ${second.written.length} file(s)`);
    assert.equal(second.skipped.length, 0, `re-run skipped ${second.skipped.length} file(s)`);
    assert.equal(
      second.unchanged.length,
      filesFor(ALL_TARGETS).length,
      "every file should report unchanged",
    );
    assert.equal(second.patched.length, 0, "no codemod should fire twice");
    assert.equal(
      read(root, "packages/server/src/trpc/router.ts"),
      routerAfterFirst,
      "a re-run must not double the router registration",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("a file the user edited is left alone and reported", () => {
  const root = makeProject();
  try {
    applyWorkspacesFeature({ projectDir: root, projectName: "demo-app", targets: ALL_TARGETS });

    const edited = "packages/client/src/components/members/members-screen.tsx";
    const mine = "// my own members screen\nexport function MembersScreen() { return null; }\n";
    writeFileSync(join(root, edited), mine, "utf-8");

    const again = applyWorkspacesFeature({
      projectDir: root,
      projectName: "demo-app",
      targets: ALL_TARGETS,
    });

    assert.ok(again.skipped.includes(edited), "an edited file must be reported as skipped");
    assert.equal(read(root, edited), mine, "an edited file must never be overwritten");
    assert.ok(
      again.nextSteps.some((s) => s.includes(edited)),
      "the user must be told which files were left alone",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("targets gate what is written", () => {
  const backendOnly: WorkspacesTargets = {
    server: true,
    shared: true,
    client: false,
    websocket: false,
  };
  const paths = filesFor(backendOnly).map((f) => f.dest);
  assert.ok(
    !paths.some((p) => p.startsWith("packages/client/")),
    "a backend surface must get no client files",
  );
  assert.ok(
    !paths.some((p) => p.includes("membership-sync")),
    "the per-recipient fan-out needs the websocket feature",
  );
  assert.ok(
    paths.includes("packages/server/src/services/membership/index.ts"),
    "the service layer is the point of the feature",
  );

  const withWs = filesFor({ ...backendOnly, websocket: true }).map((f) => f.dest);
  assert.ok(withWs.includes("packages/server/src/ws/membership-sync.ts"));
});

await test("detectTargets reads the project rather than being told", () => {
  const root = makeProject();
  try {
    const t = detectTargets(root, ["websocket"]);
    assert.deepEqual(t, { server: true, shared: true, client: true, websocket: true });

    rmSync(join(root, "packages/client"), { recursive: true, force: true });
    assert.equal(detectTargets(root, []).client, false, "a removed client must be detected");
    assert.equal(detectTargets(root, []).websocket, false, "websocket comes from the feature list");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("a project with neither server nor client is refused, not half-written", () => {
  const root = mkdtempSync(join(tmpdir(), "hatchkit-workspaces-empty-"));
  try {
    const result = applyWorkspacesFeature({
      projectDir: root,
      projectName: "demo-app",
      targets: { server: false, shared: false, client: false, websocket: false },
    });
    assert.equal(result.written.length, 0);
    assert.ok(result.nextSteps.some((s) => s.includes("needs a server or a client")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("a missing anchor becomes a next step, never a mangled file", () => {
  const root = makeProject();
  try {
    // A user who moved createApp() elsewhere: app.ts no longer has the
    // tRPC mount the codemod anchors on.
    write(root, "packages/server/src/app.ts", "// moved to server/http/app.ts\n");

    const result = applyWorkspacesFeature({
      projectDir: root,
      projectName: "demo-app",
      targets: ALL_TARGETS,
    });

    assert.equal(
      read(root, "packages/server/src/app.ts"),
      "// moved to server/http/app.ts\n",
      "a file we could not understand must be left exactly as it was",
    );
    assert.ok(
      result.nextSteps.some((s) => s.includes("registerWorkspaceRoutes")),
      "the user must be told to wire the REST routes by hand",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ── 2. The rules, pinned in the rendered output ─────────────────────── */

const tokens = defaultTokens("demo-app");
const rendered = new Map<string, string>();
for (const file of WORKSPACE_FILES) {
  rendered.set(file.dest, renderWorkspacesTemplate(file.template, tokens));
}
/** Every emitted server file, concatenated — for "nowhere does X" checks. */
const allServer = [...rendered.entries()]
  .filter(([dest]) => dest.startsWith("packages/server/"))
  .map(([, body]) => body)
  .join("\n");

function source(dest: string): string {
  const body = rendered.get(dest);
  assert.ok(body, `no template writes ${dest} — the file map and this test disagree`);
  return body;
}

/** Strip comments, so a file may NAME a forbidden call while warning against it. */
function code(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
}

await test("rule: the organization plugin's HTTP surface answers 404", () => {
  const lockdown = source("packages/server/src/auth/organization-lockdown.ts");
  assert.match(lockdown, /404/, "the lockdown must answer 404, not 403");
  assert.match(
    lockdown,
    /\/organization\//,
    "the lockdown must match on the plugin's path prefix, so a future endpoint is locked by default",
  );
  assert.match(
    lockdown,
    /ORGANIZATION_ENDPOINT_PATHS/,
    "the endpoint list must be exported so the generated app's test can iterate it",
  );

  const pin = source("packages/server/src/tests/organization-http-lockdown.test.ts");
  assert.match(pin, /ORGANIZATION_ENDPOINT_PATHS/, "the pin must hit every endpoint, not a sample");
  assert.match(pin, /better-auth/, "the pin must run against the real library, not a mock");
});

await test("rule: invitation ids carry real entropy, never an adapter ObjectId", () => {
  const inv = source("packages/server/src/services/membership/invitations.ts");
  assert.match(
    inv,
    /randomBytes\(\s*12\s*\)/,
    "an invitation id must be 96 CSPRNG bits — an ObjectId is a timestamp plus a counter and is guessable from one live invitation",
  );
  assert.match(inv, /base64url/, "the id must be URL-safe: it travels as a query parameter");
});

await test("rule: acceptance matches the invited email, and matches it BEFORE status", () => {
  const inv = source("packages/server/src/services/membership/invitations.ts");
  assert.match(inv, /emailsMatch/, "the email match is what stops a forwarded link being accepted");

  const emailAt = inv.indexOf("emailsMatch");
  const statusAt = inv.search(/invitationNotPending/);
  assert.ok(emailAt !== -1 && statusAt !== -1, "both checks must be present");
  assert.ok(
    emailAt < statusAt,
    "the email match must precede the status check, or a wrong account learns whether the link is still live",
  );
  assert.ok(
    !/requireEmailVerification|emailVerified/.test(inv),
    "acceptance must NOT require a verified address — self-hosts with no mail transport could never invite anyone",
  );
});

await test("rule: the invite link is a query parameter, not a path segment", () => {
  const contract = source("packages/shared/src/membership.ts");
  assert.match(
    contract,
    /\/invite\/\?id=/,
    "a static export cannot serve /invite/<id>, so the id must be a query parameter",
  );
});

await test("rule: the invite page lives outside the protected route tree", () => {
  const invitePage = WORKSPACE_FILES.find((f) => f.dest.endsWith("app/invite/page.tsx"));
  assert.ok(invitePage, "the feature must ship a public invite page");
  assert.ok(
    !invitePage.dest.includes("(protected)"),
    "under a protected layout a signed-out invitee is bounced to /login before the page can say whose workspace invited them",
  );
  const membersPage = WORKSPACE_FILES.find((f) => f.dest.endsWith("members/page.tsx"));
  assert.ok(
    membersPage?.dest.includes("(protected)"),
    "the members screen, by contrast, belongs inside the protected tree",
  );
});

await test("rule: owner is reachable only by transfer", () => {
  const contract = source("packages/shared/src/membership.ts");
  assert.match(
    contract,
    /ASSIGNABLE_ROLES = \["admin", "member"\]/,
    "the roles an invitation or a role update may name must exclude owner",
  );
  const members = source("packages/server/src/services/membership/members.ts");
  assert.match(
    members,
    /ownerNotAssignable/,
    "a role update naming owner must be refused at runtime, not only by the type",
  );
  const inv = source("packages/server/src/services/membership/invitations.ts");
  assert.match(inv, /ownerNotAssignable|isAssignableRole/, "an invitation may not name owner");
});

await test("rule: a workspace can never be left with zero owners", () => {
  const contract = source("packages/shared/src/membership.ts");
  for (const refusal of [
    "lastOwner",
    "cannotDemoteLastOwner",
    "cannotRemoveLastOwner",
    "soleMemberCannotLeave",
  ]) {
    assert.match(contract, new RegExp(refusal), `${refusal} must be a stable refusal code`);
  }
  const members = source("packages/server/src/services/membership/members.ts");
  assert.match(members, /countOwners/, "removal and demotion must count the owners first");
  const workspaces = source("packages/server/src/services/membership/workspaces.ts");
  assert.match(workspaces, /countOwners/, "leaving must count the owners first");
});

await test("rule: flags follow the role and a role change never grants one", () => {
  const contract = source("packages/shared/src/membership.ts");
  assert.match(contract, /capabilitiesForRole/);
  assert.match(
    contract,
    /if \(role === "owner"\) return \{ \.\.\.OPEN_CAPABILITIES \}/,
    "an owner's flags are forced on regardless of what the row stores",
  );
  const members = source("packages/server/src/services/membership/members.ts");
  assert.match(
    members,
    /capabilitiesForRole/,
    "a role update must recompute the flags rather than carrying the old ones forward",
  );
});

await test("rule: an unrecognised stored role reads as member", () => {
  const contract = source("packages/shared/src/membership.ts");
  assert.match(contract, /export function normalizeRole/);
  const mirror = source("packages/server/src/services/membership/mirror.ts");
  assert.match(
    mirror,
    /normalizeRole/,
    "every row read out of the mirror must pass through normalizeRole",
  );
});

await test("rule: a foreign id is NOT_FOUND before any permission is consulted", () => {
  const perms = source("packages/server/src/services/membership/permissions.ts");
  assert.match(
    perms,
    /requireMemberOfActorWorkspace/,
    "there must be one scoped lookup every caller uses",
  );
  assert.match(
    perms,
    /workspaceId/,
    "the scoped lookup must carry the actor's workspaceId in the QUERY, not compare after the fact",
  );
  const errors = source("packages/server/src/services/membership/errors.ts");
  assert.match(
    errors,
    /export function notFound\(\)/,
    "notFound takes no refusal code — a code on a 404 leaks which of 'no such id' / 'not yours' happened",
  );
});

await test("rule: the mirror is written last and deleted first", () => {
  const members = source("packages/server/src/services/membership/members.ts");
  const removeAt = members.indexOf("export async function removeMember");
  assert.ok(removeAt !== -1, "removeMember must exist");
  const body = members.slice(removeAt);
  const mirrorDelete = body.search(/WorkspaceMember\.(deleteOne|findOneAndDelete|deleteMany)/);
  const memberDelete = body.search(/membersCollection\(\)[\s\S]{0,80}?delete(One|Many)/);
  assert.ok(mirrorDelete !== -1, "removal must delete the WorkspaceMember mirror");
  assert.ok(memberDelete !== -1, "removal must delete better-auth's member row");
  assert.ok(
    mirrorDelete < memberDelete,
    "the mirror must be deleted FIRST — a crash between the two must leave LESS access, and a retry must finish the job",
  );
});

await test("rule: an explicit tenant id never falls back", () => {
  const workspaces = source("packages/server/src/services/membership/workspaces.ts");
  assert.match(workspaces, /export async function resolveWorkspaceForRequest/);
  assert.match(
    workspaces,
    /pickFallbackWorkspace/,
    "only the ABSENT case may fall back, through the contract's helper",
  );

  const proc = source("packages/server/src/trpc/workspace-procedure.ts");
  assert.match(
    proc,
    /workspaceId/,
    "the procedure must read a per-request workspaceId off the input",
  );
  assert.match(
    proc,
    /z\.object/,
    "the shared input must be an OBJECT — a procedure taking a bare scalar silently loses the tenant id",
  );
});

await test("rule: the realtime fan-out is projected per recipient, read fresh", () => {
  const sync = source("packages/server/src/ws/membership-sync.ts");
  assert.match(sync, /listMemberships/, "the fan-out must read memberships on every publish");
  assert.match(sync, /projectSyncEventFor|projectRecord/, "each recipient gets their own projection");
  assert.match(
    sync,
    /audience/,
    "an event with no author must carry an explicit audience, or it reaches people who may not see the record",
  );
  assert.match(sync, /workspaceId/, "every envelope must name its workspace");
});

await test("rule: nothing outside services/membership writes the membership tables", () => {
  for (const [dest, body] of rendered) {
    if (!dest.startsWith("packages/server/")) continue;
    if (dest.includes("services/membership/")) continue;
    if (dest.includes("/tests/")) continue;
    assert.ok(
      !/WorkspaceMember\.(create|updateOne|deleteOne|insertMany|findOneAndUpdate)/.test(code(body)),
      `${dest} writes the mirror directly — membership changes go through services/membership/ only`,
    );
  }
});

await test("the client never calls better-auth's organization endpoints", () => {
  for (const [dest, body] of rendered) {
    if (!dest.startsWith("packages/client/")) continue;
    assert.ok(
      !/authClient\.organization/.test(code(body)),
      `${dest} calls authClient.organization.* — those HTTP endpoints answer 404`,
    );
  }
});

await test("the client keeps its own tenant choice and switches by full page load", () => {
  const active = source("packages/client/src/lib/active-workspace.ts");
  assert.match(
    active,
    /window\.location\.assign/,
    "switching tenants must be a FULL page load — a route change keeps every cached query and socket built for the previous tenant",
  );
  assert.ok(
    !/activeOrganizationId/.test(code(active)),
    "the client must not follow the session's activeOrganizationId outside a comment explaining why",
  );
  assert.match(active, /workspaceQueryKey/, "everything cached must be keyed by tenant");
});

await test("the REST surface goes through the same service as the typed API", () => {
  const rest = source("packages/server/src/rest/workspaces.ts");
  assert.match(
    rest,
    /services\/membership/,
    "REST must call the shared service — a second implementation here is how the two surfaces drift apart",
  );
  assert.ok(
    !/WorkspaceMember\.|membersCollection\(/.test(rest),
    "REST must not touch the collections itself",
  );
  assert.match(rest, /resolveWorkspaceForRequest/, "REST resolves the tenant the same way tRPC does");
});

await test("the service never imports the websocket layer", () => {
  for (const [dest, body] of rendered) {
    if (!dest.includes("services/membership/")) continue;
    assert.ok(
      !/from "\.\.\/\.\.\/ws\//.test(body),
      `${dest} imports ws/ — the websocket feature is optional and the service must compile without it`,
    );
  }
  const events = source("packages/server/src/services/membership/events.ts");
  assert.match(events, /setMembershipPublisher/, "the ws layer installs itself into the service");
});

await test("caps and rate limits exist and come from the contract", () => {
  const contract = source("packages/shared/src/membership.ts");
  assert.match(contract, /PENDING_INVITE_CAP = \d+/);
  assert.match(contract, /INVITES_PER_INVITER_PER_HOUR = \d+/);
  const inv = source("packages/server/src/services/membership/invitations.ts");
  assert.match(inv, /PENDING_INVITE_CAP/, "the per-workspace pending cap must be enforced");
  assert.match(inv, /assertInviteRateLimit/, "the per-inviter hourly limit must be enforced");
});

await test("a failed send keeps the invitation and returns a copyable link", () => {
  const inv = source("packages/server/src/services/membership/invitations.ts");
  assert.match(
    inv,
    /emailSent/,
    "the caller must learn whether the mail went out, so the UI can offer the link instead",
  );
  assert.match(inv, /invitationUrl/, "the link must come from the contract's builder");
});

await test("the emitted server code uses ESM-correct relative imports", () => {
  const bad: string[] = [];
  for (const [dest, body] of rendered) {
    if (!dest.endsWith(".ts")) continue;
    for (const m of body.matchAll(/from "(\.[^"]*)"/g)) {
      const spec = m[1];
      if (!spec.endsWith(".js") && !spec.endsWith(".json")) {
        bad.push(`${dest}: ${spec}`);
      }
    }
  }
  assert.deepEqual(
    bad,
    [],
    `NodeNext resolution needs a .js extension on every relative import:\n  ${bad.join("\n  ")}`,
  );
});

await test("nothing outside the membership service reaches the auth collections", () => {
  assert.ok(
    allServer.includes("membersCollection"),
    "the collection accessors must exist in the emitted code",
  );
  for (const [dest, body] of rendered) {
    if (!dest.startsWith("packages/server/")) continue;
    if (dest.includes("services/membership/")) continue;
    if (dest.includes("/tests/")) continue;
    assert.ok(
      !/collection\("(organization|member|invitation)"\)/.test(code(body)),
      `${dest} reaches a better-auth collection directly — go through services/membership/mirror.ts`,
    );
  }
});

await test("sign-in honours ?next= so an invitee returns to the invite page", () => {
  const root = makeProject();
  try {
    applyWorkspacesFeature({ projectDir: root, projectName: "demo-app", targets: ALL_TARGETS });

    for (const page of ["login", "signup"]) {
      const src = read(root, `packages/client/src/app/${page}/page.tsx`);
      assert.match(
        src,
        /import \{ safeNext \} from "@\/lib\/safe-next";/,
        `${page} must import the one validator allowed to approve a next`,
      );
      assert.match(
        src,
        /router\.push\(safeNext\(next, "\/dashboard"\)\)/,
        `${page} must send the person to the validated next, or an invitee lands on /dashboard and loses the invitation`,
      );
      assert.ok(
        !/useSearchParams/.test(code(src)),
        `${page} must read the parameter in the handler — useSearchParams() during render needs a Suspense boundary under a static export`,
      );
      assert.match(
        src,
        /typeof window === "undefined"/,
        `${page} must guard the window read so a prerender does not throw`,
      );
    }

    // Re-running must not stack a second import or a second push.
    applyWorkspacesFeature({ projectDir: root, projectName: "demo-app", targets: ALL_TARGETS });
    const login = read(root, "packages/client/src/app/login/page.tsx");
    assert.equal(
      login.match(/import \{ safeNext \}/g)?.length,
      1,
      "a re-run must not duplicate the safe-next import",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("safe-next is the only thing that validates a redirect target", () => {
  const sn = source("packages/client/src/lib/safe-next.ts");
  assert.match(sn, /SAFE_NEXT_PREFIXES/, "the allowlist must be exported so it can be asserted");
  assert.match(sn, /\/invite/, "the invite page must be reachable through a next");

  // Nothing else may hand-roll the check.
  for (const [dest, body] of rendered) {
    if (!dest.startsWith("packages/client/")) continue;
    if (dest.endsWith("lib/safe-next.ts")) continue;
    assert.ok(
      !/startsWith\("\/"\)/.test(code(body)),
      `${dest} looks like it validates a path itself — route it through lib/safe-next.ts`,
    );
  }
});

await test("the contract is imported deep, never through the shared barrel", () => {
  const offenders: string[] = [];
  for (const [dest, body] of rendered) {
    if (/from "@starter\/shared";/.test(code(body))) offenders.push(dest);
  }
  assert.deepEqual(
    offenders,
    [],
    "these import the @starter/shared BARREL:\n  " +
      offenders.join("\n  ") +
      "\nThe shared package emits CommonJS, so a name re-exported through the barrel's " +
      "`export *` is not statically analysable. The import compiles and then fails at run " +
      'time with "does not provide an export named ..." under `node --import tsx --test`, ' +
      "which is how the generated server's own tests run. Import " +
      '"@starter/shared/membership.js" instead.',
  );

  // …and the contract must actually be reachable at that specifier.
  const contract = WORKSPACE_FILES.find((f) => f.dest.endsWith("shared/src/membership.ts"));
  assert.ok(contract, "the contract must ship as packages/shared/src/membership.ts");
});

/* ── Summary ─────────────────────────────────────────────────────────── */

console.log("\n=== SUMMARY (workspaces) ===");
let allOk = true;
for (const [name, ok] of Object.entries(results)) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) allOk = false;
}
console.log();
process.exit(allOk ? 0 : 1);
