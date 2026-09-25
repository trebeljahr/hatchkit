/*
 * `app://-`: the scheme the packaged app serves its static export from.
 *
 * Why not file://: a file:// document has the origin "null", which no server
 * trust list can match (sign-in answers 403 on a missing or null origin), and
 * it has no root, so root-absolute "/_next/…" resolves against the filesystem
 * root. A privileged *standard* scheme gives a real, constant origin and a
 * root.
 *
 * NEVER change the scheme or the host once released. The origin is the key of
 * `localStorage` and IndexedDB, and of every server's TRUSTED_ORIGINS entry.
 * An installed copy wakes up with an empty store and a server that refuses its
 * sign-in.
 */

import fs from "node:fs";
import { protocol } from "electron";

import { DESKTOP_APP_HOST, DESKTOP_APP_SCHEME } from "../../packages/shared/src/desktop-bridge.ts";
import { APP_CSP } from "./csp.ts";
import { contentTypeFor, resolveAppPath, type EntryKind } from "./resolve-app-path.ts";

/** Must run before `app` is ready. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: DESKTOP_APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        // Not what makes the API reachable; it governs requests *to* app://,
        // which workers and fonts make.
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

function kindOf(p: string): EntryKind {
  try {
    const stat = fs.statSync(p);
    return stat.isFile() ? "file" : stat.isDirectory() ? "dir" : null;
  } catch {
    return null;
  }
}

/** Serve `root` (the export directory, possibly inside app.asar) on app://-. */
export function handleAppScheme(root: string): void {
  protocol.handle(DESKTOP_APP_SCHEME, async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
    }
    const resolved = resolveAppPath(request.url, root, kindOf, DESKTOP_APP_HOST);
    if (resolved.file === null) {
      return new Response(resolved.status === 400 ? "Bad request" : "Not found", {
        status: resolved.status,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    const type = contentTypeFor(resolved.file);
    const headers: Record<string, string> = {
      "content-type": type,
      "x-content-type-options": "nosniff",
      "cache-control": "no-cache",
    };
    // HTML only: the CSP governs the document, and a header on every asset
    // costs bytes on every request without changing what the document may do.
    if (type.startsWith("text/html")) headers["content-security-policy"] = APP_CSP;
    const body = request.method === "HEAD" ? null : await fs.promises.readFile(resolved.file);
    return new Response(body, { status: resolved.status, headers });
  });
}
