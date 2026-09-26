/**
 * Every request this extension makes, and how a failure is read.
 *
 * The extension holds no host permissions, so each of these is an
 * ordinary CROSS-ORIGIN request: the browser sends the extension's
 * origin, preflights anything carrying `content-type: application/json`
 * or `authorization`, and refuses the whole exchange when the server
 * does not trust that origin. Every request also sends
 * `credentials: "omit"` — the extension carries a bearer token, never a
 * cookie, and the server's rule for random extension origins depends on
 * no session cookie arriving.
 *
 * ## A refused origin looks exactly like being offline
 *
 * A CORS refusal reaches `fetch` as a bare `TypeError`. There is no
 * status, no body, and nothing to tell it apart from a server that is
 * down or a laptop on a plane — which is why {@link isTransportFailure}
 * is true for both. That is deliberate and must stay that way: a caller
 * that treated the TypeError as a REFUSAL would throw away work that a
 * real outage should have kept.
 *
 * So the untrusted case is answered elsewhere, by asking a question
 * that survives CORS: `/api/health` answers
 * `Access-Control-Allow-Origin: *` and reports `originTrusted` for the
 * caller, so a transport failure makes the worker re-check the server
 * (at most once a minute, `background/runtime.ts`) and the popup shows
 * "this server does not trust this extension" instead of an offline
 * badge that will never clear.
 */
import { ApiError, isTransportFailure } from "@starter/core";
import { APP_VERSION, CLIENT_HEADER, EXTENSION_CLIENT_ID } from "./config.js";

/**
 * Re-exported rather than redefined. `ApiError` is the shape the whole
 * client kit throws and the offline queue classifies on, so a second
 * copy here would be a second class with the same name: an
 * `instanceof` in core would answer false for an error this module
 * threw, and the queue would drop rows it should have kept.
 */
export { ApiError, isTransportFailure };

/** The stored token is no longer good for anything. */
export const isUnauthorized = (error: unknown): boolean =>
  error instanceof ApiError && error.httpStatus === 401;

const trimOrigin = (origin: string): string => origin.replace(/\/+$/, "");

const authUrl = (origin: string, path: string): string =>
  `${trimOrigin(origin)}/api/auth${path}`;

const baseHeaders = (): Record<string, string> => ({
  [CLIENT_HEADER]: EXTENSION_CLIENT_ID,
  "x-client-version": APP_VERSION,
});

const readJson = async (response: Response): Promise<Record<string, unknown>> => {
  try {
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

/** better-auth hands a bearer client its token on this response header. */
const SESSION_TOKEN_HEADER = "set-auth-token";

// -- the server itself -------------------------------------------------

export type ServerCheckProblem = "unreachable" | "not-ours" | "unhealthy";

export type ServerCheck =
  | {
      ok: true;
      origin: string;
      webUrl: string | null;
      /** Null from a server too old to report it. */
      originTrusted: boolean | null;
    }
  | { ok: false; problem: ServerCheckProblem; message: string };

/**
 * Ask `GET <origin>/api/health` what is there.
 *
 * This is the one request that still gets through when the origin is
 * not trusted, because that route answers `*` rather than echoing an
 * origin. Everything the popup says about a refusing server comes from
 * here.
 */
export async function checkServer(
  origin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ServerCheck> {
  let response: Response;
  try {
    response = await fetchImpl(`${trimOrigin(origin)}/api/health`, {
      method: "GET",
      headers: { accept: "application/json" },
      // Nothing to authenticate, and a cookie would make the answer
      // depend on who is asking.
      credentials: "omit",
    });
  } catch {
    return {
      ok: false,
      problem: "unreachable",
      message: `Could not reach ${origin}. Check the address, and that the server is running.`,
    };
  }

  const notOurs: ServerCheck = {
    ok: false,
    problem: "not-ours",
    message: `${origin} answered, but it is not a __HATCHKIT_PRODUCT_NAME__ server.`,
  };
  if (!response.ok) return notOurs;

  const body = await readJson(response);
  const marked = body.service === "__HATCHKIT_PROJECT_SLUG__";
  if (body.status !== "ok" || !marked) return notOurs;
  if (body.db === false) {
    return {
      ok: false,
      problem: "unhealthy",
      message: `${origin} cannot reach its database right now. Try again in a minute.`,
    };
  }

  return {
    ok: true,
    origin: trimOrigin(origin),
    webUrl: asString(body.webUrl),
    originTrusted: typeof body.originTrusted === "boolean" ? body.originTrusted : null,
  };
}

// -- sessions ----------------------------------------------------------

export type IssuedSession = { token: string; userId: string | null };

/**
 * Sign in with a password.
 *
 * A two-factor account answers a correct password with a challenge and
 * no token. The challenge is a cookie this client cannot carry, so the
 * failure names the reason and points at the device flow instead of
 * reporting a missing token.
 */
export async function signInWithPassword(
  origin: string,
  credentials: { email: string; password: string },
  fetchImpl: typeof fetch = fetch,
): Promise<IssuedSession> {
  const response = await fetchImpl(authUrl(origin, "/sign-in/email"), {
    method: "POST",
    headers: { ...baseHeaders(), "content-type": "application/json" },
    credentials: "omit",
    body: JSON.stringify(credentials),
  });
  const body = await readJson(response);
  if (!response.ok) {
    throw new ApiError(
      asString(body.message) ?? "Sign-in failed",
      asString(body.code) ?? `HTTP_${response.status}`,
      response.status,
    );
  }
  if (body.twoFactorRedirect === true) {
    throw new ApiError(
      'This account uses two-factor authentication. Use "Sign in with the web app" instead.',
      "TWO_FACTOR_UNSUPPORTED",
      response.status,
    );
  }
  const token = response.headers.get(SESSION_TOKEN_HEADER) ?? asString(body.token);
  if (token === null) {
    throw new ApiError("Signed in but no session token came back", "NO_SESSION_TOKEN", 200);
  }
  const user = typeof body.user === "object" && body.user !== null ? (body.user as Record<string, unknown>) : {};
  return { token, userId: asString(user.id) };
}

/** Who a token belongs to. `/device/token` does not say, so this asks. */
export async function lookUpSessionUser(
  origin: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ userId: string; email: string | null } | null> {
  try {
    const response = await fetchImpl(authUrl(origin, "/get-session"), {
      headers: { ...baseHeaders(), authorization: `Bearer ${token}` },
      credentials: "omit",
    });
    if (!response.ok) return null;
    const body = await readJson(response);
    const user =
      typeof body.user === "object" && body.user !== null
        ? (body.user as Record<string, unknown>)
        : {};
    const userId = asString(user.id);
    return userId === null ? null : { userId, email: asString(user.email) };
  } catch {
    return null;
  }
}

/** Revoke this extension's OWN session row. Best effort. */
export async function revokeSession(
  origin: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  try {
    await fetchImpl(authUrl(origin, "/sign-out"), {
      method: "POST",
      headers: { ...baseHeaders(), authorization: `Bearer ${token}` },
      credentials: "omit",
    });
  } catch {
    // The row expires on its own; a sign-out must not fail because the
    // server was unreachable.
  }
}

// -- the device flow (RFC 8628) ---------------------------------------

export type DeviceAuthorization = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresInSeconds: number;
  intervalSeconds: number;
};

export async function startDeviceAuthorization(
  origin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DeviceAuthorization> {
  const response = await fetchImpl(authUrl(origin, "/device/code"), {
    method: "POST",
    headers: { ...baseHeaders(), "content-type": "application/json" },
    credentials: "omit",
    body: JSON.stringify({ client_id: EXTENSION_CLIENT_ID }),
  });
  const body = await readJson(response);
  if (!response.ok) {
    throw new ApiError(
      asString(body.error_description) ?? "Could not start device authorization",
      asString(body.error) ?? `HTTP_${response.status}`,
      response.status,
    );
  }
  const deviceCode = asString(body.device_code);
  const userCode = asString(body.user_code);
  if (deviceCode === null || userCode === null) {
    throw new ApiError("Malformed device authorization response", "PARSE_ERROR", 200);
  }
  return {
    deviceCode,
    userCode,
    verificationUri: asString(body.verification_uri) ?? "",
    verificationUriComplete: asString(body.verification_uri_complete) ?? "",
    expiresInSeconds: typeof body.expires_in === "number" ? body.expires_in : 600,
    intervalSeconds: typeof body.interval === "number" ? body.interval : 5,
  };
}

export type DeviceTokenResult =
  | { status: "approved"; session: IssuedSession }
  | { status: "pending" }
  | { status: "slow-down" };

/**
 * Exchange the device code for a session ONCE.
 *
 * `pending` and `slow_down` are the RFC 8628 answers that mean "ask
 * again later"; everything else is terminal and thrown with the RFC's
 * own code (`access_denied`, `expired_token`). One exchange per wake-up
 * rather than a loop: an MV3 service worker is stopped after about
 * thirty idle seconds, and a `setTimeout` does not survive that.
 */
export async function requestDeviceToken(
  origin: string,
  deviceCode: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DeviceTokenResult> {
  const response = await fetchImpl(authUrl(origin, "/device/token"), {
    method: "POST",
    headers: { ...baseHeaders(), "content-type": "application/json" },
    credentials: "omit",
    body: JSON.stringify({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: EXTENSION_CLIENT_ID,
    }),
  });
  const body = await readJson(response);

  if (response.ok) {
    // The device grant returns the session token as `access_token`.
    const token = response.headers.get(SESSION_TOKEN_HEADER) ?? asString(body.access_token);
    if (token === null) {
      throw new ApiError("Device approved but no token came back", "NO_SESSION_TOKEN", 200);
    }
    const user =
      typeof body.user === "object" && body.user !== null
        ? (body.user as Record<string, unknown>)
        : {};
    return { status: "approved", session: { token, userId: asString(user.id) } };
  }

  const error = asString(body.error) ?? `HTTP_${response.status}`;
  if (error === "authorization_pending") return { status: "pending" };
  if (error === "slow_down") return { status: "slow-down" };
  throw new ApiError(
    asString(body.error_description) ?? "Device authorization failed",
    error,
    response.status,
  );
}
