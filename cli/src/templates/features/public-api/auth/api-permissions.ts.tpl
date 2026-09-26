// The two vocabularies the public API is gated on, and nothing else.
//
// They are deliberately separate, because they answer different questions and
// conflating them is how a "read-only" token ends up reading a colleague's
// rows:
//
//   SCOPES answer "may this credential call this ROUTE at all?". They live on
//   the token, are chosen at mint time, and never change. A scope refusal is a
//   403 on a route, decided before a handler runs.
//
//   PERMISSIONS answer "may the person behind this credential see this ROW?".
//   They live on the membership, are read LIVE on every request, and are
//   intersected with a ceiling frozen on the token. Revoking one narrows every
//   existing token on its next request; granting one never widens a token that
//   was minted before the grant.
//
// This module has no imports on purpose. The models, the auth layer, the route
// table and the OpenAPI document all name these values, and a shared leaf with
// no dependencies is the only version of that which cannot become a cycle.

/** What a route can require. Deny-by-default: a token with no scopes calls nothing. */
export const API_TOKEN_SCOPES = [
  "items:read",
  "items:write",
  "webhooks:read",
  "webhooks:write",
] as const;

export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

export function isApiTokenScope(value: string): value is ApiTokenScope {
  return (API_TOKEN_SCOPES as readonly string[]).includes(value);
}

/**
 * What a MEMBER of a tenant may do with rows that are not their own.
 *
 * `items:view-others` hides EXISTENCE, not just fields — a member without it
 * gets 404 for a colleague's item, because "this id exists but is not yours"
 * is itself the fact the permission withholds. `items:write-others` is the one
 * that produces an honest 403: the row is visible, the tenant owns it, and the
 * caller is being told about a permission rather than about existence.
 */
export const API_PERMISSIONS = [
  "items:view-others",
  "items:write-others",
  "webhooks:manage",
] as const;

export type ApiPermission = (typeof API_PERMISSIONS)[number];

export function isApiPermission(value: string): value is ApiPermission {
  return (API_PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Does this set carry `required`?
 *
 * Deny-by-default is a property of THIS function and never of a default value.
 * A `permissions ?? API_PERMISSIONS` fallback anywhere — for a row written
 * before the field existed, say — would invert the rule silently for exactly
 * the oldest and least-reviewed data in the database.
 */
export function has<T extends string>(
  granted: readonly T[] | null | undefined,
  required: T,
): boolean {
  return (granted ?? []).includes(required);
}

/**
 * Live permissions, narrowed by the ceiling the token was minted under.
 *
 * Intersection, in that direction, and never a union or a fallback. The
 * ceiling is frozen at mint time so a member who is later granted
 * `items:write-others` does not retroactively widen a token they handed to a
 * third party last month; the live set is read per request so revoking the
 * permission narrows that same token on its very next call.
 */
export function narrowPermissions(
  live: readonly ApiPermission[] | null | undefined,
  ceiling: readonly ApiPermission[] | null | undefined,
): ApiPermission[] {
  const allowed = new Set(ceiling ?? []);
  return (live ?? []).filter((permission) => allowed.has(permission));
}
