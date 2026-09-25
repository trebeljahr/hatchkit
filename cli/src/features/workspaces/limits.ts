/*
 * cli/src/features/workspaces/limits.ts — the invitation limits the
 * feature renders into a project's membership contract.
 *
 * They live here, in one place, because the CLI and the emitted app
 * both have to agree about them: the contract template carries them as
 * constants, and `cli/test-workspaces.ts` asserts the rendered file
 * actually enforces them. Two spellings of "50 pending" would let one
 * drift without failing anything.
 *
 * These are scaffold-time defaults the user's project then owns — a
 * project that wants a different cap edits its own
 * `packages/shared/src/membership.ts`. Changing them here only affects
 * projects scaffolded afterwards.
 */

/** Pending invitations one workspace may hold at a time. */
export const PENDING_INVITE_CAP = 50;

/** Invitations one inviter may send per rolling hour. */
export const INVITES_PER_HOUR = 20;

/** How long a pending invitation stays acceptable. */
export const INVITE_TTL_DAYS = 7;
