/**
 * Profile-picture limits and refusals, shared so the browser can enforce the
 * same numbers it will be judged by and name the same failures back to the
 * person.
 */
import { z } from "zod";

/** Stored edge length. Square, so every client can crop to a circle without
 *  deciding which part of a rectangle to keep. */
export const AVATAR_SIZE = 512;

/** Decoded byte ceiling. The browser re-encodes before upload, so a 12
 *  megapixel phone photo arrives well under this; the limit exists to bound
 *  what a hand-written client can post. */
export const MAX_AVATAR_BYTES = 256_000;

/** No SVG: it can carry script, and these bytes are served to a browser. */
export const AVATAR_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type AvatarContentType = (typeof AVATAR_CONTENT_TYPES)[number];

export const AVATAR_PATH_PREFIX = "/api/avatars";

/** Base64 inflates by 4/3. Bounding the STRING keeps an oversized upload from
 *  being decoded at all, rather than decoded and then rejected. */
const MAX_AVATAR_BASE64_LENGTH = Math.ceil(MAX_AVATAR_BYTES / 3) * 4;

export const setAvatarSchema = z.object({
  data: z.string().min(1).max(MAX_AVATAR_BASE64_LENGTH),
});

export const AVATAR_REFUSALS = {
  UNSUPPORTED_IMAGE: "AVATAR_UNSUPPORTED_IMAGE",
  TOO_LARGE: "AVATAR_TOO_LARGE",
  INVALID_DATA: "AVATAR_INVALID_DATA",
} as const;
export type AvatarRefusal = (typeof AVATAR_REFUSALS)[keyof typeof AVATAR_REFUSALS];
