// What "this caller's data" means, resolved once per request.
//
// A `TenantScope` is the ONLY thing the extracted services accept as an
// identity. They never take a user object, a request, a tRPC context or a
// token — which is precisely what stops a second caller (the REST surface)
// from reaching a rule the first caller (tRPC) enforces on its way in. Both
// build one of these and hand it over; neither can build one that names a
// tenant it was not issued for, because the two constructors below are the
// only ones and neither reads a tenant id from caller input.
import { ApiMember } from "../models/ApiMember.js";
import { API_PERMISSIONS, type ApiPermission } from "../auth/api-permissions.js";

export type TenantScope = {
  /** Never from request input. From the session's user, or the token's row. */
  tenantId: string;
  /** Which member is acting. Row-level rules compare against this. */
  actorId: string;
  /**
   * Every member whose rows this tenant contains, resolved once per request.
   *
   * The starter's `Item` carries an `ownerId` and no tenant field, so "does
   * this tenant own that row" is answered by membership rather than by a
   * column. Resolving it once and carrying it means the answer cannot differ
   * between the existence check and the read that follows it.
   */
  memberIds: readonly string[];
  /** Live permissions, already intersected with any token ceiling. */
  permissions: readonly ApiPermission[];
  /** Which surface built this. Stamped onto events, never used to decide. */
  source: "trpc" | "api";
};

/**
 * The members of a tenant.
 *
 * Falls back to the tenant id itself when there are no rows: a project that
 * has never minted a token has no `ApiMember` documents, and a single-user
 * tenant whose id IS the user id must still be able to read its own items
 * through tRPC. Returning an empty list there would make every typed read
 * answer with nothing the day this feature was installed.
 */
export async function tenantMemberIds(tenantId: string): Promise<string[]> {
  const members = await ApiMember.find({ tenantId }).select({ userId: 1 }).lean();
  const ids = members.map((member) => member.userId);
  return ids.length > 0 ? ids : [tenantId];
}

/**
 * The scope a logged-in person acts under.
 *
 * Synchronous, and deliberately generous: a session IS the person, so they
 * hold every permission inside their own tenant. There is no ceiling to
 * intersect with — a ceiling exists to limit a credential handed to a third
 * party, and a browser session is not one.
 *
 * `tenantId` is the user's own id, which is the single-tenant default the
 * starter's `Item.ownerId` already implies. An app that groups people into
 * shared tenants replaces THIS FUNCTION and nothing else: every service below
 * reads the tenant off the scope and never off an argument.
 */
export function scopeForSession(user: { id: string }): TenantScope {
  return {
    tenantId: user.id,
    actorId: user.id,
    memberIds: [user.id],
    permissions: [...API_PERMISSIONS],
    source: "trpc",
  };
}
