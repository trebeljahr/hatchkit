/**
 * The better-auth endpoints this extension speaks, as plain fetches.
 *
 * Storage-free on purpose: every function here takes the origin and the
 * credential as arguments, so `auth.ts` can call them against the origin that
 * ISSUED a credential rather than against whichever origin the preference names
 * today. Mixing the two is the failure `auth.ts` exists to prevent.
 *
 * The pairing half is RFC 8628, served by better-auth's `deviceAuthorization`
 * plugin, which the shared device grant installs on the server. Nothing here
 * invents a second way in: a launcher extension has no cookie jar and no form
 * worth typing a password into, so the device flow plus a bearer token is the
 * whole mechanism.
 */
import { ApiError } from "../vendor";
import { CLIENT_ID } from "./client-id";
import { EXTENSION_VERSION } from "./version";

const trimOrigin = (origin: string): string => origin.replace(/\/+$/, "");

const authUrl = (origin: string, path: string): string => `${trimOrigin(origin)}/api/auth${path}`;

/**
 * Sent on every auth request so the account's device list can name this
 * surface. A label, never a permission — the server decides nothing from it.
 */
const baseHeaders = (): Record<string, string> => ({
  "x-starter-client": CLIENT_ID,
  "x-starter-client-version": EXTENSION_VERSION,
});

/** better-auth hands a bearer client its token on this response header. */
const SESSION_TOKEN_HEADER = "set-auth-token";

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

export type DeviceAuthorization = {
  deviceCode: string;
  userCode: string;
  /** Where a person approves the code. Empty when the server did not say. */
  verificationUri: string;
  /** The same page with the code already filled in. */
  verificationUriComplete: string;
  expiresInSeconds: number;
  /** The server's own polling interval. Honour it: `slow_down` is the penalty. */
  intervalSeconds: number;
};

/** Start a device authorization against `origin`. */
export async function startDeviceAuthorization(
  origin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DeviceAuthorization> {
  const response = await fetchImpl(authUrl(origin, "/device/code"), {
    method: "POST",
    headers: { ...baseHeaders(), "content-type": "application/json" },
    // A launcher extension carries a bearer token, never a cookie.
    credentials: "omit",
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });
  const body = await readJson(response);
  if (!response.ok) {
    throw new ApiError(
      asString(body.error_description) ?? "Could not start pairing",
      asString(body.error) ?? `HTTP_${response.status}`,
      response.status,
    );
  }
  const deviceCode = asString(body.device_code);
  const userCode = asString(body.user_code);
  if (deviceCode === null || userCode === null) {
    throw new ApiError("Malformed pairing response", "PARSE_ERROR", 200);
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

export type IssuedSession = { token: string; userId: string | null };

export type DeviceTokenResult =
  { status: "approved"; session: IssuedSession } | { status: "pending" } | { status: "slow-down" };

/**
 * Exchange the device code for a session ONCE.
 *
 * `authorization_pending` and `slow_down` are RFC 8628's "ask again later";
 * everything else is terminal and is thrown with the RFC's own code, so the
 * caller can say `access_denied` and `expired_token` in different words.
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
      client_id: CLIENT_ID,
    }),
  });
  const body = await readJson(response);

  if (response.ok) {
    const token = response.headers.get(SESSION_TOKEN_HEADER) ?? asString(body.access_token);
    if (token === null) {
      throw new ApiError("Approved, but no session token came back", "NO_SESSION_TOKEN", 200);
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
  throw new ApiError(asString(body.error_description) ?? "Pairing failed", error, response.status);
}

/** Who a token belongs to. `/device/token` does not always say, so this asks. */
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

/**
 * Revoke this extension's own session row. Best effort.
 *
 * A sign-out must not fail because the server is unreachable — the row expires
 * on its own, and refusing to forget the local copy would leave a person signed
 * in to a server they cannot reach.
 */
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
    /* see the doc comment */
  }
}
