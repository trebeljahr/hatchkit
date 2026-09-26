// Minting, listing and revoking API tokens.
//
// Extracted like every other rule in this feature, for the same reason: the
// tRPC router below it is a translation layer and nothing else, so a second
// caller — an admin script, a seed, a future CLI — cannot get a token minted
// under different rules.
import { TRPCError } from "@trpc/server";
import { mintApiTokenValue } from "../../auth/api-token.js";
import {
  API_PERMISSIONS,
  isApiPermission,
  isApiTokenScope,
  type ApiPermission,
  type ApiTokenScope,
} from "../../auth/api-permissions.js";
import { ApiMember } from "../../models/ApiMember.js";
import { ApiToken } from "../../models/ApiToken.js";

export type ApiTokenSummary = {
  id: string;
  label: string;
  /** The non-secret half, so a person can tell two tokens apart in a list. */
  prefix: string;
  scopes: ApiTokenScope[];
  grantedPermissions: ApiPermission[];
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
};

type TokenRow = {
  _id: unknown;
  label: string;
  prefix: string;
  scopes: ApiTokenScope[];
  grantedPermissions: ApiPermission[];
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
};

function toSummary(row: TokenRow): ApiTokenSummary {
  return {
    id: String(row._id),
    label: row.label,
    prefix: row.prefix,
    scopes: row.scopes ?? [],
    grantedPermissions: row.grantedPermissions ?? [],
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Make sure the person minting a token is a member of the tenant they are
 * minting it for.
 *
 * A token whose member row does not exist is DEAD — `authenticateApiToken`
 * answers 401 — so without this, the very first token a single-user project
 * mints would be unusable and the reason would be invisible. The self-tenant
 * case gets every permission, because a person is not limited inside their own
 * tenant; a real multi-tenant app invites members through its own flow and
 * never reaches this branch.
 */
export async function ensureSelfMembership(
  tenantId: string,
  userId: string,
): Promise<ApiPermission[]> {
  const existing = await ApiMember.findOne({ tenantId, userId }).lean();
  if (existing) return existing.permissions ?? [];
  if (tenantId !== userId) {
    // Somebody is minting a token for a tenant they are not in. Refused rather
    // than silently enrolled: this function creates a self-membership, it is
    // not an invitation mechanism.
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You are not a member of that tenant.",
    });
  }
  const created = await ApiMember.create({
    tenantId,
    userId,
    permissions: [...API_PERMISSIONS],
  });
  return created.permissions;
}

export type MintApiTokenInput = {
  tenantId: string;
  userId: string;
  label: string;
  scopes: readonly string[];
  /** The requested ceiling. Narrowed to what the member actually holds. */
  permissions?: readonly string[];
  expiresAt?: Date | null;
};

export type MintedApiToken = {
  token: ApiTokenSummary;
  /** Shown exactly once. Never stored, never recoverable. */
  plaintext: string;
};

/**
 * Mint a token.
 *
 * The ceiling written onto the row is the requested set INTERSECTED with what
 * the member holds right now. Two consequences worth stating: a member cannot
 * mint a token more capable than themselves, and the ceiling never grows
 * afterwards — a permission granted to the member next month does not reach a
 * token they handed to a third party today.
 */
export async function mintApiToken(input: MintApiTokenInput): Promise<MintedApiToken> {
  const memberPermissions = await ensureSelfMembership(input.tenantId, input.userId);

  const scopes = input.scopes.filter(isApiTokenScope);
  if (scopes.length === 0) {
    // A token with no scopes can call nothing. Refusing beats handing somebody
    // a credential that 403s on every route and looks like a server bug.
    throw new TRPCError({ code: "BAD_REQUEST", message: "A token needs at least one scope." });
  }

  const held = new Set(memberPermissions);
  const requested = (input.permissions ?? memberPermissions).filter(isApiPermission);
  const grantedPermissions = requested.filter((permission) => held.has(permission));

  const { plaintext, prefix, tokenHash } = mintApiTokenValue();
  const created = await ApiToken.create({
    tenantId: input.tenantId,
    userId: input.userId,
    label: input.label,
    prefix,
    tokenHash,
    scopes,
    grantedPermissions,
    expiresAt: input.expiresAt ?? null,
  });

  return { token: toSummary(created as unknown as TokenRow), plaintext };
}

/** This member's tokens. Never the hash, and never anything derived from it. */
export async function listApiTokens(
  tenantId: string,
  userId: string,
): Promise<ApiTokenSummary[]> {
  const rows = (await ApiToken.find({ tenantId, userId })
    .sort({ _id: -1 })
    .select({ tokenHash: 0 })
    .lean()) as unknown as TokenRow[];
  return rows.map(toSummary);
}

/**
 * Revoke a token.
 *
 * A timestamp rather than a delete: the settings list should still show that
 * the credential existed and when it stopped working, which is the first thing
 * anybody wants after an incident.
 */
export async function revokeApiToken(
  tenantId: string,
  userId: string,
  tokenId: string,
): Promise<{ success: true; id: string }> {
  const result = await ApiToken.findOneAndUpdate(
    { _id: tokenId, tenantId, userId, revokedAt: null },
    { $set: { revokedAt: new Date() } },
    { returnDocument: "after" },
  )
    .lean()
    .catch(() => null);
  // Someone else's token and an already-revoked one take the same exit: a
  // distinction here confirms which ids exist.
  if (!result) throw new TRPCError({ code: "NOT_FOUND", message: "No such token." });
  return { success: true, id: tokenId };
}
