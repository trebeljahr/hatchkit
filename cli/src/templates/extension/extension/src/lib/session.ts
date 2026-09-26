/**
 * The extension's own session, and where it came from.
 *
 * `source` is the field the bridge's whole "never displace an explicit
 * session" rule turns on:
 *
 *  - `web`     — linked by the web app through the bridge. The web app
 *                may sign it out again, and may switch it to another
 *                account, because following the web app is what it is
 *                for.
 *  - `password`— somebody typed an email and a password into the popup.
 *  - `device`  — somebody used "Sign in with the web app" here.
 *
 * A `password` or `device` session is a decision made IN the extension,
 * so web sign-in, web sign-out and a web account switch all leave it
 * alone (`explicit-session`). Before this field existed, opening the
 * web app in a private window could sign a deliberately separate
 * extension account out.
 *
 * The token lives in `chrome.storage.session`: see lib/chrome-storage.ts for
 * what that costs and why it is worth it.
 */
import { sessionStore } from "./chrome-storage.js";

export type SessionSource = "web" | "password" | "device";

export type StoredSession = {
  token: string;
  /** Null only for a session whose account the server would not name. */
  userId: string | null;
  source: SessionSource;
};

const SESSION_KEY = "__HATCHKIT_STORAGE_PREFIX__.session";

const store = sessionStore;

export const decodeSession = (raw: string | null): StoredSession | null => {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { token, userId, source } = parsed as Record<string, unknown>;
    if (typeof token !== "string" || token === "") return null;
    const known: SessionSource[] = ["web", "password", "device"];
    // A record written before `source` existed reads as `password`:
    // the conservative answer, since it means the web app will not
    // touch it.
    const resolved = known.find((value) => value === source) ?? "password";
    return {
      token,
      userId: typeof userId === "string" && userId !== "" ? userId : null,
      source: resolved,
    };
  } catch {
    return null;
  }
};

export async function loadSession(): Promise<StoredSession | null> {
  return decodeSession(await store().getItem(SESSION_KEY));
}

export async function saveSession(session: StoredSession): Promise<void> {
  await store().setItem(SESSION_KEY, JSON.stringify(session));
}

export async function clearSession(): Promise<void> {
  await store().removeItem(SESSION_KEY);
}
