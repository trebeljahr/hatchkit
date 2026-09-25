/**
 * Where the sync socket lives, derived from whatever API base URL a client was
 * built against.
 *
 * Kept framework-free so a browser extension's service worker, a launcher
 * extension and the web app all derive the same URL from the same rule, rather
 * than each re-deriving it slightly differently and one of them being wrong on a
 * deployment nobody tested.
 */

import { SYNC_PATH } from "@starter/shared";

/**
 * `wss://example.com/api/sync` from `https://example.com`. An empty API URL
 * means the socket is same-origin, which is what the local dev proxy and
 * single-origin deployments want.
 *
 * The socket sits UNDER `/api` deliberately: the server mounts everything it
 * owns at that prefix, so `https://api.example.com` as the base yields
 * `wss://api.example.com/api/sync`. The doubled-looking segment is the mount,
 * not a stray path in the base URL. Keeping one prefix means one routing rule at
 * the proxy — a socket at `/sync` would need its own, and a rule nobody
 * remembers to add is a client that reconnects forever while every HTTP request
 * succeeds, which is the hardest shape of this bug to recognise.
 *
 * A base URL that does not parse returns `""` rather than throwing: the caller
 * is usually reading an environment variable, and a socket that never opens is a
 * better failure than a client that cannot start.
 */
export const resolveSyncUrl = (apiUrl: string, origin: string): string => {
  const base = apiUrl.trim() === "" ? origin : apiUrl.trim();
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return "";
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${SYNC_PATH}`;
  url.search = "";
  url.hash = "";
  return url.toString();
};
