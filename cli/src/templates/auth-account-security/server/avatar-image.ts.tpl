/**
 * Decode and judge an uploaded picture.
 *
 * **The client's declared content type is never consulted.** A browser
 * serving a stored file sniffs the bytes, so the bytes are what has to be
 * safe; trusting a declared `image/png` would let anything at all be stored
 * and then served under a type a browser might decide to execute.
 *
 * Pure — no database, no environment — so the rules can be tested directly.
 */

import {
  AVATAR_REFUSALS,
  type AvatarContentType,
  type AvatarRefusal,
  MAX_AVATAR_BYTES,
} from "__HATCHKIT_SHARED_SCOPE__/shared";

const ascii = (bytes: Uint8Array, start: number, end: number): string =>
  String.fromCharCode(...bytes.subarray(start, end));

/** The content type these bytes really are, or null when they are not one of
 *  the three formats we agree to store. Magic numbers only. */
export function sniffImageType(bytes: Uint8Array): AvatarContentType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= png.length && png.every((byte, index) => bytes[index] === byte)) {
    return "image/png";
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") {
    return "image/webp";
  }
  return null;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export type DecodedAvatar =
  | { ok: true; bytes: Buffer; contentType: AvatarContentType }
  | { ok: false; refusal: AvatarRefusal };

/**
 * Base64 in, validated bytes out.
 *
 * Order matters: the cheap structural checks run before the decode, and the
 * size check runs before the sniff, so a hostile payload is rejected at the
 * first step that can reject it rather than after being fully parsed.
 */
export function decodeAvatar(base64: string): DecodedAvatar {
  if (base64.length % 4 !== 0 || !BASE64.test(base64)) {
    return { ok: false, refusal: AVATAR_REFUSALS.INVALID_DATA };
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0) return { ok: false, refusal: AVATAR_REFUSALS.INVALID_DATA };
  if (bytes.length > MAX_AVATAR_BYTES) return { ok: false, refusal: AVATAR_REFUSALS.TOO_LARGE };
  const contentType = sniffImageType(bytes);
  if (!contentType) return { ok: false, refusal: AVATAR_REFUSALS.UNSUPPORTED_IMAGE };
  return { ok: true, bytes, contentType };
}

/** 128 bits, hex. Regenerated on every upload — see `store.ts`. */
export const AVATAR_KEY_PATTERN = /^[0-9a-f]{32}$/;
export const AVATAR_USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Absolute, because `user.image` is read by clients on other origins (and by
 *  shells with no origin at all), where a relative path would resolve against
 *  the wrong host. `origin` is the API's own public origin. */
export function avatarUrl(origin: string, userId: string, key: string): string {
  return `${origin.replace(/\/+$/, "")}/api/avatars/${userId}/${key}`;
}

/** Validate the two path segments before they reach a query. */
export function parseAvatarPath(
  userId: unknown,
  key: unknown,
): { userId: string; key: string } | null {
  if (typeof userId !== "string" || typeof key !== "string") return null;
  if (!AVATAR_USER_ID_PATTERN.test(userId) || !AVATAR_KEY_PATTERN.test(key)) return null;
  return { userId, key };
}
