/**
 * `GET /api/avatars/:userId/:key` — the one unauthenticated read of user data.
 *
 * It has to be unauthenticated. An `<img>` sends no bearer token, and from the
 * shells' origins it sends no cookie either, so a picture behind a credential
 * simply does not render anywhere except the web app.
 *
 * What keeps it private enough is the address: `key` is 128 random bits, so
 * nothing enumerates pictures from a user id, and the key changes on every
 * upload, so a replaced picture stops being reachable.
 *
 * Mount this AFTER helmet, whose `Cross-Origin-Resource-Policy: same-origin`
 * it deliberately overrides for this route only — without that override no
 * other origin can load the image at all, which is every client but the API's
 * own.
 */

import type { Express, Request, Response } from "express";
import { AVATAR_PATH_PREFIX } from "__HATCHKIT_SHARED_SCOPE__/shared";
import { parseAvatarPath } from "./image.js";
import { type AvatarLookup, findAvatar } from "./store.js";

export function avatarHandler(lookup: AvatarLookup) {
  return async (req: Request, res: Response): Promise<void> => {
    const parsed = parseAvatarPath(req.params.userId, req.params.key);
    if (!parsed) {
      res.status(404).type("text/plain").send("Not found");
      return;
    }
    const row = await lookup(parsed.userId, parsed.key);
    if (!row) {
      res.status(404).type("text/plain").send("Not found");
      return;
    }

    // Immutable: the URL changes whenever the bytes do, so nothing ever needs
    // to revalidate and a stale picture cannot be served for a new one.
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("ETag", `"${row.key}"`);
    // The override helmet would otherwise prevent. See the header comment.
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    // Belt and braces for a decoder bug: this response is an image, never a
    // document, whatever the bytes turn out to be.
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("Content-Type", row.contentType);
    res.setHeader("Content-Length", String(row.size));

    if (req.method === "HEAD") {
      res.end();
      return;
    }
    res.end(row.bytes);
  };
}

export function registerAvatarRoutes(app: Express, lookup: AvatarLookup = findAvatar): void {
  app.get(`${AVATAR_PATH_PREFIX}/:userId/:key`, (req, res, next) => {
    avatarHandler(lookup)(req, res).catch(next);
  });
}
