/*
 * cli/src/features/workspaces/file-map.ts — the declarative list of what
 * the `workspaces` feature writes into a project.
 *
 * One table, read by both the create path and `hatchkit update`, so the
 * two can never disagree about which files the feature owns. `group`
 * gates a row on a half of the project that may not exist: a `static`
 * surface has no server, a `backend` surface has no client, and the
 * per-recipient realtime fan-out is only meaningful with the `websocket`
 * feature on.
 */

import type { WorkspacesTargets } from "./types.js";

export type FileGroup = "shared" | "server" | "client" | "websocket" | "test";

export interface WorkspaceFile {
  /** Path under cli/src/templates/workspaces/, forward slashes. */
  template: string;
  /** Destination relative to the project dir, forward slashes. */
  dest: string;
  group: FileGroup;
}

export const WORKSPACE_FILES: readonly WorkspaceFile[] = [
  /* ── The contract every surface agrees on ─────────────────────────── */
  {
    template: "shared/membership.ts.tmpl",
    dest: "packages/shared/src/membership.ts",
    group: "shared",
  },

  /* ── The mirror the app authorizes from ───────────────────────────── */
  {
    template: "server/models/WorkspaceMember.ts.tmpl",
    dest: "packages/server/src/models/WorkspaceMember.ts",
    group: "server",
  },

  /* ── better-auth stays installed; its HTTP surface answers 404 ────── */
  {
    template: "server/auth/organization-lockdown.ts.tmpl",
    dest: "packages/server/src/auth/organization-lockdown.ts",
    group: "server",
  },
  {
    template: "server/auth/workspace-bootstrap.ts.tmpl",
    dest: "packages/server/src/auth/workspace-bootstrap.ts",
    group: "server",
  },

  /* ── The service layer both the typed API and REST call ───────────── */
  {
    template: "server/services/membership/index.ts.tmpl",
    dest: "packages/server/src/services/membership/index.ts",
    group: "server",
  },
  {
    template: "server/services/membership/errors.ts.tmpl",
    dest: "packages/server/src/services/membership/errors.ts",
    group: "server",
  },
  {
    template: "server/services/membership/permissions.ts.tmpl",
    dest: "packages/server/src/services/membership/permissions.ts",
    group: "server",
  },
  {
    template: "server/services/membership/mirror.ts.tmpl",
    dest: "packages/server/src/services/membership/mirror.ts",
    group: "server",
  },
  {
    template: "server/services/membership/workspaces.ts.tmpl",
    dest: "packages/server/src/services/membership/workspaces.ts",
    group: "server",
  },
  {
    template: "server/services/membership/members.ts.tmpl",
    dest: "packages/server/src/services/membership/members.ts",
    group: "server",
  },
  {
    template: "server/services/membership/invitations.ts.tmpl",
    dest: "packages/server/src/services/membership/invitations.ts",
    group: "server",
  },
  {
    template: "server/services/membership/rate-limit.ts.tmpl",
    dest: "packages/server/src/services/membership/rate-limit.ts",
    group: "server",
  },
  {
    template: "server/services/membership/events.ts.tmpl",
    dest: "packages/server/src/services/membership/events.ts",
    group: "server",
  },

  /* ── The typed API ────────────────────────────────────────────────── */
  {
    template: "server/trpc/workspace-procedure.ts.tmpl",
    dest: "packages/server/src/trpc/workspace-procedure.ts",
    group: "server",
  },
  {
    template: "server/trpc/routers/workspaces.ts.tmpl",
    dest: "packages/server/src/trpc/routers/workspaces.ts",
    group: "server",
  },
  {
    template: "server/trpc/routers/members.ts.tmpl",
    dest: "packages/server/src/trpc/routers/members.ts",
    group: "server",
  },
  {
    template: "server/trpc/routers/invitations.ts.tmpl",
    dest: "packages/server/src/trpc/routers/invitations.ts",
    group: "server",
  },

  /* ── The REST surface, over the same service ──────────────────────── */
  {
    template: "server/rest/workspaces.ts.tmpl",
    dest: "packages/server/src/rest/workspaces.ts",
    group: "server",
  },

  /* ── Realtime, projected per recipient ────────────────────────────── */
  {
    template: "server/ws/membership-sync.ts.tmpl",
    dest: "packages/server/src/ws/membership-sync.ts",
    group: "websocket",
  },

  /* ── Tests that pin the rules in the generated app ────────────────── */
  {
    template: "server/tests/support/memory-membership.ts.tmpl",
    dest: "packages/server/src/tests/support/memory-membership.ts",
    group: "test",
  },
  {
    template: "server/tests/organization-http-lockdown.test.ts.tmpl",
    dest: "packages/server/src/tests/organization-http-lockdown.test.ts",
    group: "test",
  },
  {
    template: "server/tests/membership-lifecycle.test.ts.tmpl",
    dest: "packages/server/src/tests/membership-lifecycle.test.ts",
    group: "test",
  },
  {
    template: "server/tests/members-permissions.test.ts.tmpl",
    dest: "packages/server/src/tests/members-permissions.test.ts",
    group: "test",
  },
  {
    template: "server/tests/workspace-resolution.test.ts.tmpl",
    dest: "packages/server/src/tests/workspace-resolution.test.ts",
    group: "test",
  },

  /* ── The web half ─────────────────────────────────────────────────── */
  {
    template: "client/lib/active-workspace.ts.tmpl",
    dest: "packages/client/src/lib/active-workspace.ts",
    group: "client",
  },
  {
    template: "client/lib/safe-next.ts.tmpl",
    dest: "packages/client/src/lib/safe-next.ts",
    group: "client",
  },
  {
    template: "client/hooks/use-active-workspace.ts.tmpl",
    dest: "packages/client/src/hooks/use-active-workspace.ts",
    group: "client",
  },
  {
    // Deliberately OUTSIDE app/(protected)/ — see the file's own comment.
    template: "client/app/invite/page.tsx.tmpl",
    dest: "packages/client/src/app/invite/page.tsx",
    group: "client",
  },
  {
    template: "client/app/members/page.tsx.tmpl",
    dest: "packages/client/src/app/(protected)/members/page.tsx",
    group: "client",
  },
  {
    template: "client/components/members/members-screen.tsx.tmpl",
    dest: "packages/client/src/components/members/members-screen.tsx",
    group: "client",
  },
  {
    template: "client/components/members/member-row.tsx.tmpl",
    dest: "packages/client/src/components/members/member-row.tsx",
    group: "client",
  },
  {
    template: "client/components/members/invite-form.tsx.tmpl",
    dest: "packages/client/src/components/members/invite-form.tsx",
    group: "client",
  },
  {
    template: "client/components/members/workspace-switcher.tsx.tmpl",
    dest: "packages/client/src/components/members/workspace-switcher.tsx",
    group: "client",
  },
];

/** Which groups a given project can actually receive. */
export function enabledGroups(targets: WorkspacesTargets): Set<FileGroup> {
  const groups = new Set<FileGroup>();
  if (targets.shared) groups.add("shared");
  if (targets.server) {
    groups.add("server");
    groups.add("test");
  }
  if (targets.client) groups.add("client");
  if (targets.server && targets.websocket) groups.add("websocket");
  return groups;
}

export function filesFor(targets: WorkspacesTargets): WorkspaceFile[] {
  const groups = enabledGroups(targets);
  return WORKSPACE_FILES.filter((f) => groups.has(f.group));
}
