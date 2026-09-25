/*
 * cli/src/features/workspaces/types.ts — shared shapes for the
 * `workspaces` feature (tenants, members, roles, invitations).
 */

/** Which halves of the project the feature may write into. */
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

export interface WorkspacesApplyInput {
  /** Directory holding `packages/`, i.e. the project root (or subdir). */
  projectDir: string;
  /** Project name, substituted into copy the user reads. */
  projectName: string;
  targets: WorkspacesTargets;
  /** Report what would change without touching the disk. */
  dryRun?: boolean;
}

export interface WorkspacesApplyResult {
  /** Files created by this run, project-relative, forward slashes. */
  written: string[];
  /** Files already present with identical content — left alone. */
  unchanged: string[];
  /** Files present with DIFFERENT content — never clobbered. */
  skipped: string[];
  /** Existing files this run edited in place (router registration etc.). */
  patched: string[];
  /** Human-readable notes for the CLI to print. */
  notes: string[];
  /** Things the user must do by hand afterwards. */
  nextSteps: string[];
}

export const WORKSPACES_DEPS: Readonly<Record<string, string>> = {};

/**
 * better-auth's organization plugin ships inside `better-auth` itself, so
 * the feature adds no new runtime dependency. The constant stays as the
 * single place to declare one if a future addition needs it — an empty
 * map here is a deliberate answer, not an unfinished one.
 */
export const WORKSPACES_SCRIPTS: Readonly<Record<string, string>> = {};
