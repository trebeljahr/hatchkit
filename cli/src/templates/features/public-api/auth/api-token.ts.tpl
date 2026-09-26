// The API-token credential: how one is made, how one is checked, and what a
// checked one is allowed to see.
//
// Deliberately NOT a better-auth session, and it never becomes one. A session
// belongs to a person and follows them wherever they are a member; a token is
// bound to ONE tenant and to a permission ceiling fixed at mint time. Keeping
// the two apart is what makes "a token can never see more than its owner" a
// property of the type rather than of a code review.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ApiMember } from "../models/ApiMember.js";
import { ApiToken } from "../models/ApiToken.js";
import {
  narrowPermissions,
  type ApiPermission,
  type ApiTokenScope,
} from "./api-permissions.js";

/** `sk_` + 8-char prefix + `_` + 43-char secret. */
const TOKEN_SCHEME = "sk_";
/** 6 random bytes → 8 base64url chars. Non-secret; it only selects a row. */
const PREFIX_BYTES = 6;
const PREFIX_CHARS = 8;
/** 32 random bytes → 43 base64url chars. This is the whole secret. */
const SECRET_BYTES = 32;
const SECRET_CHARS = 43;
const TOKEN_LENGTH = TOKEN_SCHEME.length + PREFIX_CHARS + 1 + SECRET_CHARS;

/** sha256 is 32 bytes; both sides of the comparison are always this long. */
const HASH_BYTES = 32;

/**
 * How often `lastUsedAt` may be rewritten.
 *
 * A write per request would make this the hottest collection in the database
 * for a field nobody reads more precisely than "today".
 */
export const LAST_USED_THROTTLE_MS = 60_000;

/**
 * Hash the WHOLE plaintext, prefix included.
 *
 * sha256 rather than Argon2 or bcrypt, on purpose. Those exist to slow a
 * dictionary attack against something a human chose; this is 256 bits out of a
 * CSPRNG, so there is no dictionary and nothing to slow down — a per-request
 * KDF would add ~100ms to every single API call in exchange for nothing.
 */
export function hashApiToken(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

/** Mint a fresh credential. The plaintext is returned once and never stored. */
export function mintApiTokenValue(): {
  plaintext: string;
  prefix: string;
  tokenHash: string;
} {
  const prefix = randomBytes(PREFIX_BYTES).toString("base64url");
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  const plaintext = `${TOKEN_SCHEME}${prefix}_${secret}`;
  return { plaintext, prefix, tokenHash: hashApiToken(plaintext) };
}

/**
 * Pull the lookup prefix off a presented token, or null when it cannot be one.
 *
 * Parsed by POSITION, never by splitting on `_`: base64url includes `_`, so a
 * split-based parse addresses the wrong row — or none — for a perfectly valid
 * token whose secret happens to contain one.
 */
export function parseApiToken(raw: string): { prefix: string } | null {
  if (raw.length !== TOKEN_LENGTH) return null;
  if (!raw.startsWith(TOKEN_SCHEME)) return null;
  if (raw[TOKEN_SCHEME.length + PREFIX_CHARS] !== "_") return null;

  const prefix = raw.slice(TOKEN_SCHEME.length, TOKEN_SCHEME.length + PREFIX_CHARS);
  const secret = raw.slice(TOKEN_SCHEME.length + PREFIX_CHARS + 1);
  const base64url = /^[A-Za-z0-9_-]+$/;
  if (!base64url.test(prefix) || !base64url.test(secret)) return null;
  return { prefix };
}

/**
 * Constant-time comparison of a presented token against a stored hash.
 *
 * Both operands are a sha256 digest, so their length is a constant of the
 * algorithm — the length check is an assertion about a corrupt stored value,
 * not a branch on caller-controlled data, and it must come first because
 * `timingSafeEqual` throws on a length mismatch.
 */
export function verifyApiToken(plaintext: string, storedHash: string): boolean {
  const presented = Buffer.from(hashApiToken(plaintext), "hex");
  let stored: Buffer;
  try {
    stored = Buffer.from(storedHash, "hex");
  } catch {
    return false;
  }
  if (presented.length !== HASH_BYTES || stored.length !== HASH_BYTES) return false;
  return timingSafeEqual(presented, stored);
}

/**
 * A successfully authenticated token, resolved against live membership.
 *
 * `tenantId` came off the stored row. Nothing downstream ever reads a tenant
 * from request input, which is why no handler has to check one.
 */
export type ApiTokenAuth = {
  tokenId: string;
  tenantId: string;
  userId: string;
  scopes: ApiTokenScope[];
  /** Live membership permissions, intersected with the mint-time ceiling. */
  permissions: ApiPermission[];
};

/**
 * Why a token was refused.
 *
 * Every one of these answers the caller with the same 401 body. The
 * distinctions exist for the server log and for the docs, never for the
 * response: telling "no such token" apart from "wrong secret" turns a prefix
 * into an oracle, and telling "revoked" apart from "expired" confirms that the
 * prefix was real.
 */
export type ApiTokenFailure = {
  error: "missing" | "malformed" | "unknown" | "revoked" | "expired" | "no_membership";
};

export function isApiTokenAuth(
  value: ApiTokenAuth | ApiTokenFailure,
): value is ApiTokenAuth {
  return !("error" in value);
}

/**
 * Record that a token was used, at most once per throttle window.
 *
 * Unawaited and self-swallowing: `lastUsedAt` is diagnostics, and a write
 * failure must never turn a valid request into a 500. The `$lt` in the FILTER
 * is what makes the throttle correct under concurrency — two simultaneous
 * requests race on the same condition and exactly one write lands.
 */
function touchLastUsed(tokenId: string, now: Date): void {
  const cutoff = new Date(now.getTime() - LAST_USED_THROTTLE_MS);
  void ApiToken.updateOne(
    { _id: tokenId, $or: [{ lastUsedAt: null }, { lastUsedAt: { $lt: cutoff } }] },
    { $set: { lastUsedAt: now } },
  ).catch(() => {
    // Diagnostics only — never fail a request over it.
  });
}

/**
 * Authenticate an `Authorization: Bearer <token>` header value.
 *
 * The permissions this returns are LIVE, intersected with the ceiling the
 * token was minted under. A member who has been removed from the tenant makes
 * the token DEAD — 401, not 403. 403 would confirm that the tenant and the
 * route exist and that the credential is otherwise good, which is three facts
 * an ex-member is not entitled to; and it would describe the situation wrongly
 * anyway, because there is no longer anybody for the token to act as.
 */
export async function authenticateApiToken(
  authorizationHeader: string | undefined,
): Promise<ApiTokenAuth | ApiTokenFailure> {
  const match = /^Bearer\s+(\S+)$/i.exec(authorizationHeader ?? "");
  if (!match || !match[1]) return { error: "missing" };
  const presented = match[1];

  const parsed = parseApiToken(presented);
  if (!parsed) return { error: "malformed" };

  // Indexed single-document read, never a scan: the prefix is unique and
  // non-secret precisely so that finding the row costs one lookup and the
  // secret is only ever compared in constant time, once.
  const doc = await ApiToken.findOne({ prefix: parsed.prefix }).lean();
  // A prefix nobody has and a prefix whose secret is wrong take the same exit.
  if (!doc || !verifyApiToken(presented, doc.tokenHash)) return { error: "unknown" };

  if (doc.revokedAt) return { error: "revoked" };
  const now = new Date();
  if (doc.expiresAt && doc.expiresAt.getTime() <= now.getTime()) return { error: "expired" };

  // Live membership, read on every request. Its absence is the removed-member
  // case: 401 above, not a 403 further down.
  const member = await ApiMember.findOne({
    tenantId: doc.tenantId,
    userId: doc.userId,
  }).lean();
  if (!member) return { error: "no_membership" };

  const tokenId = String(doc._id);
  touchLastUsed(tokenId, now);

  return {
    tokenId,
    tenantId: doc.tenantId,
    userId: doc.userId,
    scopes: doc.scopes ?? [],
    permissions: narrowPermissions(member.permissions, doc.grantedPermissions),
  };
}
