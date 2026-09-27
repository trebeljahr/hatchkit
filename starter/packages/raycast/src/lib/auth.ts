/**
 * The stored credential, the origin that issued it, and this install's own id.
 *
 * ============================================================
 * A CREDENTIAL BELONGS TO EXACTLY ONE BACKEND
 * ============================================================
 *
 * The API origin is a preference, so it moves: a person tries the hosted
 * service, then points the extension at the server they run themselves. The
 * bearer token they already hold means nothing to the new server, and two
 * things then go wrong, both in silence:
 *
 *  - sending the old token to the new origin hands this account's session to a
 *    server that has no business holding it;
 *  - revoking on sign-out against the CURRENT origin leaves the real session
 *    alive on the old one, where it stays until it expires.
 *
 * So the issuing origin is stored beside the token. {@link loadSession}
 * compares it against the configured origin and reports SIGNED OUT on a
 * mismatch — not an error, because "you are not signed in to this server" is
 * exactly true — and {@link signOut} revokes against `session.server`, never
 * against `apiOrigin()`.
 *
 * ============================================================
 * WHAT A SIGN-OUT CLEARS
 * ============================================================
 *
 * The credential, the read cache and the optimistic overlay: the next person
 * to use this machine must see nothing of the last one's data, and every row in
 * those can be fetched again. The durable QUEUE is deliberately kept — its rows
 * are work that exists nowhere else, and dropping them to tidy up a sign-out
 * destroys it. They are stamped with their owner, so the next account cannot
 * replay them (`isReplayableBy`).
 */
import { createId } from "../vendor";
import { revokeSession } from "./auth-endpoints";
import { apiOrigin } from "./preferences";
import { CACHE_KEYS, clearOverlay, localCache } from "./queue";
import { clearStateEcho, raycastStorage } from "./storage";

/** Keys are contracts: never renamed, or every install is signed out at once. */
const SESSION_KEY = "starter.session";
const ORIGIN_ID_KEY = "starter.originId";

export type StoredSession = {
  token: string;
  /** Null only when the server would not name the account. */
  userId: string | null;
  email: string | null;
  /** The origin that ISSUED this token. Not "the origin we use now". */
  server: string;
};

/** Why a read came back with no session, for a surface that has to say. */
export type SessionState =
  | { status: "signed-in"; session: StoredSession }
  | { status: "signed-out" }
  /** A credential exists, but it was issued by a different server. */
  | { status: "other-server"; issuedBy: string; configured: string };

const decodeSession = (raw: string | null): StoredSession | null => {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { token, userId, email, server } = parsed as Record<string, unknown>;
    if (typeof token !== "string" || token === "") return null;
    // A record written before the origin was stored cannot be attributed to a
    // server, and attributing it to the current one is the bug this field
    // exists to prevent — so it reads as no session at all.
    if (typeof server !== "string" || server === "") return null;
    return {
      token,
      userId: typeof userId === "string" && userId !== "" ? userId : null,
      email: typeof email === "string" && email !== "" ? email : null,
      server,
    };
  } catch {
    return null;
  }
};

const sameOrigin = (a: string, b: string): boolean =>
  a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

/** The stored session, and whether it is this server's. */
export async function readSessionState(): Promise<SessionState> {
  const stored = decodeSession(await raycastStorage().getItem(SESSION_KEY));
  if (stored === null) return { status: "signed-out" };
  const configured = apiOrigin();
  if (!sameOrigin(stored.server, configured)) {
    return { status: "other-server", issuedBy: stored.server, configured };
  }
  return { status: "signed-in", session: stored };
}

/** The session to send with a request, or null. A mismatch is null. */
export async function loadSession(): Promise<StoredSession | null> {
  const state = await readSessionState();
  return state.status === "signed-in" ? state.session : null;
}

export async function saveSession(session: StoredSession): Promise<void> {
  await raycastStorage().setItem(SESSION_KEY, JSON.stringify(session));
}

/**
 * Forget the credential, and tell the server that issued it.
 *
 * The remote revoke is best-effort and goes to `session.server`. The local
 * removal happens either way: refusing to forget a token because the server is
 * unreachable would leave a person signed in to a server they cannot reach.
 */
export async function signOut(): Promise<void> {
  const stored = decodeSession(await raycastStorage().getItem(SESSION_KEY));
  if (stored !== null) {
    await revokeSession(stored.server, stored.token);
  }
  await raycastStorage().removeItem(SESSION_KEY);
  await localCache().clear(CACHE_KEYS);
  await clearOverlay();
  await clearStateEcho();
  // The durable queue is NOT cleared — see the module header.
}

/**
 * This install's stable id, minted once and kept.
 *
 * The server stamps every change with the origin id that caused it, so a client
 * can tell its own writes apart from another device's. It is per INSTALL, not
 * per command: every Raycast command of one install shares it, which is exactly
 * why the push socket must not filter on it — see `sync.ts`.
 */
export async function originId(): Promise<string> {
  const store = raycastStorage();
  const existing = await store.getItem(ORIGIN_ID_KEY);
  if (existing !== null && existing !== "") return existing;
  const minted = `raycast-${createId()}`;
  await store.setItem(ORIGIN_ID_KEY, minted);
  return minted;
}
