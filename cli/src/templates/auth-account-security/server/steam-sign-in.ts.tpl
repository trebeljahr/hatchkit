/**
 * Sign in with Steam, and link Steam to an existing account.
 *
 * Steam speaks OpenID 2.0, not OAuth, so better-auth's social providers cannot
 * do it. This plugin adds two endpoints under `/api/auth/steam/`:
 *
 *   POST /steam/start     { intent: "sign-in" | "link", returnPath? } → { url }
 *   GET  /steam/callback  Steam returns here. The assertion is verified with
 *                         Steam itself, then the browser is sent back.
 *
 * A verified Steam ID becomes an ordinary better-auth account row
 * (`providerId: "steam"`, `accountId: <SteamID64>`), so the Linked accounts
 * page, `listAccounts` and `unlinkAccount` treat it like any other provider.
 *
 * Environment:
 *
 *   STEAM_SIGN_IN=true   Switches the endpoints on. Steam OpenID needs no
 *                        credentials, so this flag is the only gate.
 *   STEAM_WEB_API_KEY    Optional. Lets a new account start with the Steam
 *                        display name and avatar instead of a placeholder.
 *
 * Rules that fail quietly if they are changed:
 *
 * - **The assertion is checked with Steam, not parsed.** Every field Steam
 *   signs is required, the return URL must be exactly the one this server
 *   sent, and `check_authentication` must answer `is_valid:true`. Reading the
 *   claimed ID out of the query alone would let anybody type any Steam ID.
 * - **State is bound twice**: a signed cookie in THIS browser, and a single-use
 *   row in better-auth's verification table. Either alone is replayable.
 *   Steam's response nonce is stored too, so one assertion signs in once.
 * - **Linking re-checks the session at the callback.** The link targets the
 *   account and session that started it. A sign-out or account switch in
 *   between refuses the link instead of attaching Steam to someone else.
 * - **A new Steam account gets a placeholder address** under `steam.invalid`,
 *   a domain that can never receive mail. Signing up or changing an email to
 *   that domain is refused, so nobody can squat a Steam player's address.
 * - **Browser only.** The flow ends in a redirect that sets a cookie, which a
 *   native shell can neither follow back nor hold. Steam's desktop SDK
 *   tickets are a different flow and are not handled here.
 */

import { createHash, randomBytes } from "node:crypto";
import type { BetterAuthPlugin, Session, User } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";

export const STEAM_OPENID_ENDPOINT = "https://steamcommunity.com/openid/login";
const OPENID_NS = "http://specs.openid.net/auth/2.0";
const SELECT_ID = "http://specs.openid.net/auth/2.0/identifier_select";
const FLOW_TTL_MS = 10 * 60 * 1000;
/** Steam's nonces start with a timestamp; older than this is refused. */
const NONCE_MAX_AGE_MS = 5 * 60 * 1000;
/** The reserved domain of placeholder addresses (RFC 2606: never deliverable). */
export const STEAM_EMAIL_DOMAIN = "steam.invalid";

type Env = Readonly<Record<string, string | undefined>>;

/** Whether the endpoints answer. */
export function isSteamSignInEnabled(env: Env = process.env): boolean {
  return env.STEAM_SIGN_IN?.trim().toLowerCase() === "true";
}

type SteamFlow = {
  intent: "sign-in" | "link";
  returnTo: string;
  returnPath: string;
  targetUserId?: string;
  targetSessionId?: string;
};

const proof = (): string => randomBytes(32).toString("base64url");
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

/** A same-origin path to land on afterwards, or the fallback. Never a URL. */
export function steamReturnPath(value: unknown, fallback = "/dashboard"): string {
  if (
    typeof value !== "string" ||
    value.length > 1024 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\s]/.test(value)
  ) {
    return fallback;
  }
  const url = new URL(value, "https://app.invalid");
  if (url.origin !== "https://app.invalid" || url.pathname.startsWith("/api/")) return fallback;
  return url.pathname + url.search;
}

export function steamAuthorizationUrl(returnTo: string): string {
  const query = new URLSearchParams({
    "openid.ns": OPENID_NS,
    "openid.mode": "checkid_setup",
    "openid.return_to": returnTo,
    "openid.realm": new URL(returnTo).origin,
    "openid.identity": SELECT_ID,
    "openid.claimed_id": SELECT_ID,
  });
  return `${STEAM_OPENID_ENDPOINT}?${query}`;
}

type Post = (body: string) => Promise<{ ok: boolean; text: () => Promise<string> }>;

const postToSteam: Post = (body) =>
  fetch(STEAM_OPENID_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });

/**
 * Check a Steam assertion and return the SteamID64 it proves.
 *
 * Structure first — fixed endpoint, exact return URL, every signed field
 * present, a fresh nonce — then Steam's own `check_authentication`. `post` is
 * injectable for tests.
 */
export async function verifySteamAssertion(
  params: URLSearchParams,
  returnTo: string,
  options: { now?: number; post?: Post } = {},
): Promise<{ steamId: string; nonce: string }> {
  const invalid = new Error("Invalid Steam OpenID response");
  const now = options.now ?? Date.now();
  for (const [key] of params) if (params.getAll(key).length !== 1) throw invalid;
  if (
    params.get("openid.ns") !== OPENID_NS ||
    params.get("openid.mode") !== "id_res" ||
    params.get("openid.op_endpoint") !== STEAM_OPENID_ENDPOINT ||
    params.get("openid.return_to") !== returnTo
  ) {
    throw invalid;
  }
  const claimed = params.get("openid.claimed_id") ?? "";
  const steamId = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/.exec(claimed)?.[1];
  if (!steamId || params.get("openid.identity") !== claimed) throw invalid;
  const signed = new Set((params.get("openid.signed") ?? "").split(","));
  for (const field of [
    "op_endpoint",
    "claimed_id",
    "identity",
    "return_to",
    "response_nonce",
    "assoc_handle",
  ]) {
    if (!signed.has(field) || !params.get(`openid.${field}`)) throw invalid;
  }
  if (!params.get("openid.sig")) throw invalid;
  const nonce = params.get("openid.response_nonce") ?? "";
  const issued = Date.parse(nonce.slice(0, 20));
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z.+$/.test(nonce) ||
    nonce.length > 256 ||
    !Number.isFinite(issued) ||
    issued < now - NONCE_MAX_AGE_MS ||
    issued > now + 60_000
  ) {
    throw invalid;
  }

  const assertion = new URLSearchParams();
  for (const [key, value] of params) if (key.startsWith("openid.")) assertion.set(key, value);
  assertion.set("openid.mode", "check_authentication");
  const response = await (options.post ?? postToSteam)(assertion.toString());
  if (!response.ok || !(await response.text()).split(/\r?\n/).includes("is_valid:true")) {
    throw invalid;
  }
  return { steamId, nonce };
}

/** Name and avatar for a NEW account. Optional: no key, a private profile or a
 *  Steam outage must not stop the sign-in. */
async function steamProfile(steamId: string, env: Env): Promise<{ name: string; image?: string }> {
  const fallback = { name: `Steam player ${steamId.slice(-6)}` };
  const key = env.STEAM_WEB_API_KEY?.trim();
  if (!key) return fallback;
  try {
    const url = new URL("https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/");
    url.search = new URLSearchParams({ key, steamids: steamId }).toString();
    const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "error" });
    if (!response.ok) return fallback;
    const body = (await response.json()) as {
      response?: {
        players?: Array<{ steamid?: string; personaname?: string; avatarfull?: string }>;
      };
    };
    const player = body.response?.players?.find((p) => p.steamid === steamId);
    const name = typeof player?.personaname === "string" ? player.personaname.slice(0, 128).trim() : "";
    const avatar = typeof player?.avatarfull === "string" ? player.avatarfull : "";
    const image = /^https:\/\/avatars(\.akamai)?\.steamstatic\.com\//.test(avatar) ? avatar : undefined;
    return { name: name || fallback.name, ...(image ? { image } : {}) };
  } catch {
    return fallback;
  }
}

/** The slice of better-auth's internal adapter this plugin uses. Loose on
 *  purpose: the internal adapter's types are not part of its public API. */
type InternalAdapter = {
  createVerificationValue(data: { identifier: string; value: string; expiresAt: Date }): Promise<unknown>;
  findVerificationValue(identifier: string): Promise<VerificationRow | null>;
  deleteVerificationValue(id: string): Promise<unknown>;
  consumeVerificationValue?: (identifier: string) => Promise<VerificationRow | null>;
  findAccountByProviderId(accountId: string, providerId: string): Promise<{ userId: string } | null>;
  linkAccount(account: { userId: string; providerId: string; accountId: string }): Promise<unknown>;
  createOAuthUser(
    user: { email: string; emailVerified: boolean; name: string; image?: string },
    account: { providerId: string; accountId: string },
  ): Promise<{ user: User }>;
  findUserById(id: string): Promise<User | null>;
  createSession(userId: string, dontRememberMe?: boolean): Promise<Session>;
  deleteUser(id: string): Promise<unknown>;
};
type VerificationRow = { id: string; value: string; expiresAt: Date | string };

// The endpoint context's generics are not exported; `any` is allowed by the
// starter's lint config for exactly this kind of library seam.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

const adapterOf = (ctx: Ctx): InternalAdapter => ctx.context.internalAdapter as InternalAdapter;

/** Store a single-use value in better-auth's verification table, which every
 *  database adapter has — no collection of this plugin's own. */
async function store(ctx: Ctx, key: string, value: unknown): Promise<void> {
  await adapterOf(ctx).createVerificationValue({
    identifier: `steam:${hash(key)}`,
    value: JSON.stringify(value),
    expiresAt: new Date(Date.now() + FLOW_TTL_MS),
  });
}

/** Read and delete a value stored by {@link store}, or null. Atomic where the
 *  installed better-auth offers it. */
async function consume<T>(ctx: Ctx, key: string): Promise<T | null> {
  const identifier = `steam:${hash(key)}`;
  const adapter = adapterOf(ctx);
  let row: VerificationRow | null;
  if (typeof adapter.consumeVerificationValue === "function") {
    row = await adapter.consumeVerificationValue(identifier);
  } else {
    row = await adapter.findVerificationValue(identifier);
    if (row) await adapter.deleteVerificationValue(row.id);
  }
  if (!row || new Date(row.expiresAt).getTime() < Date.now()) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

/** A POST that changes who is signed in must come from a trusted page, even
 *  on a first sign-in that carries no cookie yet. */
function requireTrustedOrigin(ctx: Ctx): void {
  const origin = ctx.request?.headers.get("origin");
  if (
    !origin ||
    origin === "null" ||
    !ctx.context.isTrustedOrigin(origin, { allowRelativePaths: false })
  ) {
    throw new APIError("FORBIDDEN", { message: "Invalid sign-in origin." });
  }
}

/**
 * Sign the browser in as `userId`. A guest session in this browser is handed
 * to the guest plugin's `onLinkAccount` and then removed, as better-auth's
 * anonymous plugin does on its own sign-in paths — its after-hook does not
 * match `/steam/*`.
 */
async function signInAs(ctx: Ctx, userId: string): Promise<void> {
  const adapter = adapterOf(ctx);
  const previous = await getSessionFromCtx(ctx).catch(() => null);
  const user = await adapter.findUserById(userId);
  if (!user) throw new Error("Account unavailable");
  const session = await adapter.createSession(user.id, false);
  await setSessionCookie(ctx, { session, user });
  const guestUser = previous?.user as { id: string; isAnonymous?: boolean } | undefined;
  if (!guestUser?.isAnonymous || guestUser.id === user.id) return;
  const guestPlugin = (ctx.context.options.plugins ?? []).find(
    (plugin: { id: string }) => plugin.id === "anonymous",
  );
  const guest = guestPlugin?.options as
    | { onLinkAccount?: (args: unknown) => Promise<void>; disableDeleteAnonymousUser?: boolean }
    | undefined;
  await guest?.onLinkAccount?.({ anonymousUser: previous, newUser: { session, user }, ctx });
  if (!guest?.disableDeleteAnonymousUser) {
    await adapter.deleteUser(guestUser.id).catch(() => {
      ctx.context.logger.warn("[steam] guest cleanup deferred");
    });
  }
}

export function steamSignInPlugin(env: Env = process.env): BetterAuthPlugin {
  const requireEnabled = (): void => {
    if (!isSteamSignInEnabled(env)) {
      throw new APIError("NOT_FOUND", { message: "Steam sign-in is off." });
    }
  };

  return {
    id: "steam-sign-in",
    rateLimit: [{ pathMatcher: (path: string) => path.startsWith("/steam/"), window: 60, max: 20 }],
    hooks: {
      // A before-hook only refuses a request and never touches a session, so
      // its position relative to bearer() does not matter.
      before: [
        {
          matcher: (ctx) => ctx.path === "/sign-up/email" || ctx.path === "/change-email",
          handler: createAuthMiddleware(async (ctx) => {
            const body = (ctx.body ?? {}) as { email?: unknown; newEmail?: unknown };
            const email = String(body.email ?? body.newEmail ?? "").toLowerCase();
            if (email.endsWith(`@${STEAM_EMAIL_DOMAIN}`)) {
              throw new APIError("BAD_REQUEST", { message: "Use a real email address." });
            }
          }),
        },
      ],
    },
    endpoints: {
      steamStart: createAuthEndpoint("/steam/start", { method: "POST" }, async (ctx: Ctx) => {
        requireEnabled();
        requireTrustedOrigin(ctx);
        const body = (ctx.body ?? {}) as { intent?: unknown; returnPath?: unknown };
        const intent = body.intent === "link" ? "link" : "sign-in";
        const current = intent === "link" ? await getSessionFromCtx(ctx) : null;
        if (intent === "link" && (!current || (current.user as { isAnonymous?: boolean }).isAnonymous)) {
          throw new APIError("UNAUTHORIZED", { message: "Sign in to the account you want to link." });
        }
        const state = proof();
        const returnTo = `${ctx.context.baseURL}/steam/callback?state=${encodeURIComponent(state)}`;
        const flow: SteamFlow = {
          intent,
          returnTo,
          returnPath: steamReturnPath(
            body.returnPath,
            intent === "link" ? "/settings/accounts" : "/dashboard",
          ),
          ...(current ? { targetUserId: current.user.id, targetSessionId: current.session.id } : {}),
        };
        await store(ctx, `state:${state}`, flow);
        const cookie = ctx.context.createAuthCookie("steam_state", { maxAge: 600, sameSite: "lax" });
        await ctx.setSignedCookie(cookie.name, state, ctx.context.secret, cookie.attributes);
        return ctx.json({ url: steamAuthorizationUrl(returnTo) });
      }),

      steamCallback: createAuthEndpoint("/steam/callback", { method: "GET" }, async (ctx: Ctx) => {
        requireEnabled();
        const query = new URL(ctx.request?.url ?? "", ctx.context.baseURL).searchParams;
        const cookie = ctx.context.createAuthCookie("steam_state", { maxAge: 600, sameSite: "lax" });
        const state = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
        ctx.setCookie(cookie.name, "", { ...cookie.attributes, maxAge: 0 });
        const flow =
          typeof state === "string" && state === query.get("state")
            ? await consume<SteamFlow>(ctx, `state:${state}`)
            : null;
        // The web app, which may be another origin than this API in a split
        // deployment. FRONTEND_URL is the starter's name for it.
        const back = (path: string, error?: string): never => {
          const url = new URL(path, env.FRONTEND_URL?.trim() || ctx.context.baseURL);
          if (error) url.searchParams.set("error", error);
          throw ctx.redirect(url.href);
        };
        if (!flow) return back("/login", "steam_expired");
        if (query.get("openid.mode") === "cancel") return back(flow.returnPath, "steam_cancelled");

        let steamId: string;
        try {
          const verified = await verifySteamAssertion(query, flow.returnTo);
          // One assertion, one sign-in: a stored nonce means it was used.
          if (await consume(ctx, `nonce:${verified.nonce}`)) throw new Error("replayed");
          await store(ctx, `nonce:${verified.nonce}`, true);
          steamId = verified.steamId;
        } catch {
          return back(flow.returnPath, "steam_sign_in_failed");
        }

        const adapter = adapterOf(ctx);
        const existing = await adapter.findAccountByProviderId(steamId, "steam");

        if (flow.intent === "link") {
          const current = await getSessionFromCtx(ctx);
          if (
            !current ||
            current.user.id !== flow.targetUserId ||
            current.session.id !== flow.targetSessionId ||
            (current.user as { isAnonymous?: boolean }).isAnonymous
          ) {
            return back(flow.returnPath, "steam_link_session_changed");
          }
          if (existing && String(existing.userId) !== String(current.user.id)) {
            return back(flow.returnPath, "steam_already_linked");
          }
          if (!existing) {
            await adapter.linkAccount({ userId: current.user.id, providerId: "steam", accountId: steamId });
          }
          return back(flow.returnPath);
        }

        if (existing) {
          await signInAs(ctx, String(existing.userId));
          return back(flow.returnPath);
        }
        const profile = await steamProfile(steamId, env);
        const created = await adapter.createOAuthUser(
          {
            email: `${steamId}@${STEAM_EMAIL_DOMAIN}`,
            emailVerified: false,
            name: profile.name,
            ...(profile.image ? { image: profile.image } : {}),
          },
          { providerId: "steam", accountId: steamId },
        );
        await signInAs(ctx, created.user.id);
        return back(flow.returnPath);
      }),
    },
  };
}
