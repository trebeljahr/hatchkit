/**
 * Store a picture, and point better-auth's `user.image` at it.
 *
 * Two things here are load-bearing.
 *
 * **The key is 128 random bits, new on every upload.** That is what lets the
 * bytes be served without a credential (see `route.ts`): nobody can enumerate
 * pictures from a user id, and a picture that has been replaced is no longer
 * reachable at the address a page may have cached.
 *
 * **`user.image` is written through the adapter, not through
 * `auth.api.updateUser`.** The API call would need the caller's request
 * headers and would answer with a `Set-Cookie` that nothing here could
 * forward. The consequence is that the session cookie cache still holds the
 * old value when this returns, so the client must re-read the session with
 * the cache disabled straight afterwards — `refreshSession()` does that.
 */

import { randomBytes } from "node:crypto";
import { AVATAR_REFUSALS, type AvatarRefusal } from "__HATCHKIT_SHARED_SCOPE__/shared";
import { env } from "../../config/env.js";
import { getAuth } from "../../auth/auth.js";
import { Avatar } from "../../models/Avatar.js";
import { avatarUrl, decodeAvatar } from "./image.js";

const newAvatarKey = (): string => randomBytes(16).toString("hex");

export type StoredAvatar = { ok: true; image: string } | { ok: false; refusal: AvatarRefusal };

/** Write the user row through better-auth's adapter. `null` clears the field,
 *  which is also right for a picture that arrived with a social sign-in: the
 *  person is asking for no picture, not for the provider's one back. */
async function setUserImage(userId: string, image: string | null): Promise<void> {
  const context = await getAuth().$context;
  await context.adapter.update({
    model: "user",
    where: [{ field: "id", value: userId }],
    update: { image, updatedAt: new Date() },
  });
}

export async function storeAvatar(userId: string, base64: string): Promise<StoredAvatar> {
  const decoded = decodeAvatar(base64);
  if (!decoded.ok) return { ok: false, refusal: decoded.refusal };

  const key = newAvatarKey();
  // The picture row is written first and the user row second, so a crash in
  // between leaves an orphaned picture that nothing links to — which the next
  // upload replaces — rather than a link to bytes that are not there.
  await Avatar.findOneAndUpdate(
    { userId },
    { $set: { key, contentType: decoded.contentType, size: decoded.bytes.length, bytes: decoded.bytes } },
    { upsert: true, returnDocument: "after" },
  );

  const image = avatarUrl(env.BETTER_AUTH_URL, userId, key);
  await setUserImage(userId, image);
  return { ok: true, image };
}

/** Idempotent: removing a picture that is not there is a success. */
export async function removeAvatar(userId: string): Promise<void> {
  await Avatar.deleteOne({ userId });
  await setUserImage(userId, null);
}

export type AvatarBytes = { key: string; contentType: string; size: number; bytes: Buffer };
export type AvatarLookup = (userId: string, key: string) => Promise<AvatarBytes | null>;

export const findAvatar: AvatarLookup = async (userId, key) => {
  const row = await Avatar.findOne({ userId, key }).lean();
  if (!row) return null;
  // `.lean()` hands back mongoose's Binary wrapper rather than a Buffer.
  const raw = row.bytes as unknown as { buffer?: Buffer } | Buffer;
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer ?? []);
  return { key: row.key, contentType: row.contentType, size: row.size, bytes };
};

export { AVATAR_REFUSALS };
