/*
 * Where an `app://-/…` request is answered from — as a pure function, so every
 * rule is unit-tested without Electron (resolve-app-path.test.ts).
 *
 * The rules are the static export's, because `trailingSlash: true`
 * (packages/client/next.config.ts) is where the asset-path bugs live:
 *
 *   /                 → index.html
 *   /settings/        → settings/index.html
 *   /settings         → settings/index.html (a directory without the slash)
 *   /privacy          → privacy.html, when only that exists
 *   /_next/static/x   → the file itself
 *   anything else     → 404.html with a 404 status
 *
 * and a request may never leave the export directory: `..`, encoded `%2e%2e`,
 * encoded separators and NUL bytes are refused before the filesystem is asked
 * anything. A malformed percent-escape is a bad request, not a path.
 */

import path from "node:path";

export type AppPathResolution =
  | { status: 200; file: string }
  | { status: 404; file: string | null }
  | { status: 400; file: null };

/** "file" / "dir" for an existing entry, null for nothing there. */
export type EntryKind = "file" | "dir" | null;

/**
 * @param requestUrl the full request URL, e.g. `app://-/settings/?x=1`
 * @param root       absolute path of the export directory
 * @param kindOf     filesystem probe (injected so tests need no disk)
 * @param expectedHost the scheme's host; any other host is not this app
 */
export function resolveAppPath(
  requestUrl: string,
  root: string,
  kindOf: (absolutePath: string) => EntryKind,
  expectedHost = "-",
): AppPathResolution {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return { status: 400, file: null };
  }
  if (url.host !== expectedHost) return notFound(root, kindOf);

  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return { status: 400, file: null };
  }
  if (decoded.includes("\0")) return { status: 400, file: null };

  // Split on BOTH separators: a decoded "%5C" is a path separator to
  // `path.win32`, so "..\\" must be caught on every OS, not only Windows.
  const segments = decoded.split(/[\\/]+/).filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === "..")) return { status: 400, file: null };

  const rootResolved = path.resolve(root);
  const candidate = path.resolve(rootResolved, ...segments);
  if (candidate !== rootResolved && !candidate.startsWith(rootResolved + path.sep)) {
    return { status: 400, file: null };
  }

  if (kindOf(candidate) === "file") return { status: 200, file: candidate };

  const asIndex = path.join(candidate, "index.html");
  if (kindOf(asIndex) === "file") return { status: 200, file: asIndex };

  if (candidate !== rootResolved) {
    const asHtml = `${candidate}.html`;
    if (kindOf(asHtml) === "file") return { status: 200, file: asHtml };
  }

  return notFound(rootResolved, kindOf);
}

function notFound(root: string, kindOf: (p: string) => EntryKind): AppPathResolution {
  const page = path.join(path.resolve(root), "404.html");
  return { status: 404, file: kindOf(page) === "file" ? page : null };
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  // Next's RSC payloads for client-side navigation (`index.txt`).
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".xml": "application/xml; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

export function contentTypeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}
