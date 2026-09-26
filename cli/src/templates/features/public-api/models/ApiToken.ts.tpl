import mongoose, { Schema, type Document } from "mongoose";
import type { ApiPermission, ApiTokenScope } from "../auth/api-permissions.js";

/**
 * One API credential, bound to ONE tenant for its whole life.
 *
 * `tenantId` is stored here and nowhere else a caller can reach. That is what
 * makes "a token can never address a tenant of its own choosing" a property of
 * the schema rather than a rule each handler has to remember: there is no
 * request field the tenant is ever read from.
 *
 * The plaintext is never stored. `prefix` selects the row and is not secret;
 * `tokenHash` is a sha256 of the WHOLE plaintext, prefix included, so a leaked
 * prefix cannot be re-paired with a guessed secret against a hash computed
 * over the secret alone.
 */
export interface IApiToken extends Document {
  tenantId: string;
  /** The member this token acts as. Its live permissions gate every row. */
  userId: string;
  /** Human label, shown wherever tokens are listed. Never part of the secret. */
  label: string;
  /** Non-secret lookup key — unique, indexed, one document read per request. */
  prefix: string;
  tokenHash: string;
  scopes: ApiTokenScope[];
  /**
   * The permission CEILING, frozen at mint time.
   *
   * Never widened, by anything. A request's effective permissions are the
   * member's live set intersected with this, so a grant made after the mint
   * cannot reach a token that is already in somebody else's hands.
   */
  grantedPermissions: ApiPermission[];
  expiresAt: Date | null;
  revokedAt: Date | null;
  /** Diagnostics only, written at most once a minute per token. */
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const apiTokenSchema = new Schema<IApiToken>(
  {
    tenantId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    label: { type: String, required: true, maxlength: 120 },
    prefix: { type: String, required: true, unique: true, index: true },
    tokenHash: { type: String, required: true },
    // No `default` on either array. A default is how a row written before the
    // field existed would come back carrying permissions nobody granted it.
    scopes: { type: [String], required: true },
    grantedPermissions: { type: [String], required: true },
    expiresAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const ApiToken = mongoose.model<IApiToken>("ApiToken", apiTokenSchema);
