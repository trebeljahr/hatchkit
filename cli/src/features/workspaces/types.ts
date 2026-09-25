/*
 * cli/src/features/workspaces/types.ts — which halves of a project the
 * `workspaces` feature can write into.
 *
 * Read off the disk at apply time rather than assumed from the
 * manifest: `update` runs against a repository somebody has been
 * working in, and the manifest records what was scaffolded, not what is
 * there now.
 */

export interface WorkspacesTargets {
  /** `packages/server` exists — routers, services, the mirror model. */
  server: boolean;
  /** `packages/shared` exists — the membership contract. */
  shared: boolean;
  /** `packages/client` exists — members screen, invite page, switcher. */
  client: boolean;
  /** The `websocket` feature is on — the per-recipient fan-out is written. */
  websocket: boolean;
}
