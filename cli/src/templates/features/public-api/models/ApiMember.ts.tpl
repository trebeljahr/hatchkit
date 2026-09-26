import mongoose, { Schema, type Document } from "mongoose";
import type { ApiPermission } from "../auth/api-permissions.js";

/**
 * Who belongs to a tenant, and what they may do inside it.
 *
 * The starter has no membership concept of its own — an `Item` carries an
 * `ownerId` and that is the whole story. This collection is the smallest thing
 * that makes the public API's permission rules mean something: a tenant is a
 * set of members, and a token acts as one of them.
 *
 * For a single-user project the tenant id IS the user id and there is exactly
 * one row, created by `ensureSelfMembership` when the first token is minted.
 * Nothing about the API changes when a second member appears later.
 *
 * The ROW IS THE MEMBERSHIP. There is no `enabled` flag, deliberately: a
 * removed member is a deleted row, and `authenticateApiToken` answers 401 for
 * a token whose member is gone. A soft-delete flag invites the one query that
 * forgets to filter on it, and that query is the one that resurrects a revoked
 * person's access.
 */
export interface IApiMember extends Document {
  tenantId: string;
  userId: string;
  /** Live. Read on EVERY request and intersected with the token's ceiling. */
  permissions: ApiPermission[];
  createdAt: Date;
  updatedAt: Date;
}

const apiMemberSchema = new Schema<IApiMember>(
  {
    tenantId: { type: String, required: true },
    userId: { type: String, required: true },
    permissions: { type: [String], required: true },
  },
  { timestamps: true },
);

// One membership per person per tenant, enforced by the database rather than
// by the code path that creates them: a duplicate row would make "the member's
// permissions" depend on which one `findOne` happened to return.
apiMemberSchema.index({ tenantId: 1, userId: 1 }, { unique: true });

export const ApiMember = mongoose.model<IApiMember>("ApiMember", apiMemberSchema);
