// GENERATED — DO NOT EDIT.
//
// A byte-for-byte copy of a file in the shared client core, with its import
// specifiers rewritten for this flat directory. Written by
// `scripts/vendor-core.mjs`; `npm test` fails when it is stale.
//
// Edit the source package and re-run the generator. An edit made here is
// silently overwritten on the next run, and until then this surface behaves
// differently from every other client.

import { CLIENT_ID_HEADER, CLIENT_TOO_OLD, versionHeaders } from "./api-level";
import type { VersionRefusal } from "./api-level";

/**
 * Thin caller over the tRPC HTTP endpoints, for clients that cannot use the
 * tRPC React bindings — a launcher extension, a browser extension's service
 * worker, a CLI, a native shell's background worker. The web client uses
 * `@trpc/react-query` instead, and both end up sending the same headers and
 * reading the same error shape, which is the whole point of putting this here
 * rather than in each host.
 */

export class ApiError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  /**
   * `CLIENT_TOO_OLD` when the server refused this build's declared API level
   * (`data.versionRefusal`), null for every other error. The status is 412
   * (`VERSION_REFUSAL_HTTP_STATUS`), which is NOT a permanent rejection, so a
   * queued row refused this way is kept for the build that can send it.
   */
  readonly versionRefusal: VersionRefusal | null;

  constructor(
    message: string,
    code: string,
    httpStatus: number,
    versionRefusal: VersionRefusal | null = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.versionRefusal = versionRefusal;
  }
}

/**
 * HTTP statuses that mean "this request can never succeed", so a queued
 * mutation carrying one must be dropped rather than retried forever.
 *
 * 401 is deliberately absent: a lapsed session is recoverable, and discarding
 * somebody's offline work because their token expired would be a far worse bug
 * than a queue that waits. 5xx are absent for the same reason.
 *
 * 403 is present, and it is the entry that is easiest to get wrong. In a shared
 * tenant a FORBIDDEN is a verdict on ONE row by a session that is perfectly
 * valid — a role change took away a permission that row needed — so it cannot
 * become valid by waiting or by signing in again. Treating it as "the session
 * is gone" stops the flush at that row, wedges every row behind it, and tells
 * the person to sign in to a session they are already signed in to. A tenant
 * the person has LEFT is a different case with a different answer: those rows
 * are held by the client before they are sent, never refused one at a time
 * here.
 */
const PERMANENT_REJECTIONS = new Set([400, 403, 404, 409, 410, 422]);

/**
 * True when the server refused a mutation for good.
 *
 * The case this exists for: a row whose target was deleted on the server while
 * this device was offline. The queued edit resolves against a record that is no
 * longer there, answers 404, and will answer 404 for as long as the queue holds
 * it. A queue that stops at that row wedges every mutation behind it —
 * including the ones that would have replayed fine.
 */
export const isPermanentRejection = (error: unknown): boolean =>
  error instanceof ApiError &&
  isPermanentRejectionStatus(error.code, error.httpStatus);

/**
 * The same verdict from a tRPC code and HTTP status, for a client whose errors
 * are not `ApiError` — the web app's `TRPCClientError` carries both in `data`.
 * One set for every queue, so a 500 or a 429 is kept in the phone build exactly
 * as it is in a browser extension or a launcher extension.
 */
export const isPermanentRejectionStatus = (
  code: string,
  httpStatus: number,
): boolean =>
  // A status is only a verdict when the tRPC server gave it. A body that is not
  // a tRPC envelope (`PARSE_ERROR`) came from something in FRONT of the API — a
  // WAF's HTML 403, a captive portal's sign-in page, a proxy answering `/api`
  // with the web app's 404 page mid-deploy — and says nothing at all about the
  // row. Dropping on it would delete a person's work because a network was in
  // the way.
  code !== "PARSE_ERROR" && PERMANENT_REJECTIONS.has(httpStatus);

/**
 * True when a call never reached the server, so keeping the mutation is safe.
 *
 * `createApiClient` throws `ApiError` for everything the server answered — 4xx
 * and 5xx included — and lets the transport's own failure through untouched. So
 * "not an ApiError" is exactly "no answer came back", with no message sniffing
 * and no `navigator.onLine` to be wrong about. That matters on Node, where
 * `fetch` reports every transport failure as the same bare "fetch failed":
 * unreachable host, refused connection and bad DNS are indistinguishable by
 * message and identical in what they mean for a queue.
 *
 * A caller with errors of its own to exclude — "no session stored", say, which
 * is raised before a request exists — narrows this further rather than
 * replacing it.
 */
export const isTransportFailure = (error: unknown): boolean =>
  !(error instanceof ApiError);

export type ApiClientOptions = {
  /** Origin of the server, e.g. `https://app.example.com`. */
  baseUrl: string;
  /**
   * Session token, for a client with no cookie. Omit to fall back to cookie
   * auth (the web app's path).
   */
  token?: string;
  /** Names this client in the device list. Cosmetic, never a permission. */
  clientId?: string;
  /**
   * This build's release, e.g. `0.3.1`, sent as the client-version header
   * beside the API level. Shown in the device list; never a permission.
   */
  clientVersion?: string;
  fetchImpl?: typeof fetch;
  /**
   * The tenant this client is pointed at, read per request.
   *
   * Filled into any input that names none — an object without a `tenantId`, or
   * no input at all — and never over one that does, so a replayed offline row
   * addressed to the tenant it was queued in keeps that address. A getter,
   * because the choice lives in the host's own storage and can change between
   * two calls. Returning null sends the input unchanged, and the server
   * resolves the session's default tenant.
   *
   * Per client on purpose: a launcher extension and a browser extension each
   * keep their own choice, and neither follows the web app's active tenant.
   */
  tenantId?: () => string | null;
};

/**
 * `input` with `tenantId` filled in when it names none.
 *
 * Only a plain object or `undefined` is addressed: a procedure whose input is a
 * bare string or an array has nowhere to carry a tenant, and wrapping it would
 * change what the server parses.
 */
export const withTenantId = (
  input: unknown,
  tenantId: string | null,
): unknown => {
  if (tenantId === null || tenantId === "") return input;
  if (input === undefined) return { tenantId };
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return input;
  }
  const record = input as { tenantId?: unknown };
  if (typeof record.tenantId === "string" && record.tenantId !== "") {
    return input;
  }
  return { ...record, tenantId };
};

export type ApiClient = {
  query<TResult>(path: string, input?: unknown): Promise<TResult>;
  mutate<TResult>(path: string, input?: unknown): Promise<TResult>;
};

type TrpcEnvelope = {
  result?: { data?: unknown };
  error?: {
    message?: string;
    data?: { code?: string; versionRefusal?: unknown };
  };
};

const unwrap = (body: unknown, httpStatus: number): unknown => {
  if (typeof body !== "object" || body === null) {
    throw new ApiError("Malformed API response", "PARSE_ERROR", httpStatus);
  }
  const envelope = body as TrpcEnvelope;
  if (envelope.error) {
    throw new ApiError(
      envelope.error.message ?? "Request failed",
      envelope.error.data?.code ?? "INTERNAL_SERVER_ERROR",
      httpStatus,
      envelope.error.data?.versionRefusal === CLIENT_TOO_OLD
        ? CLIENT_TOO_OLD
        : null,
    );
  }
  return envelope.result?.data;
};

export const createApiClient = ({
  baseUrl,
  token,
  clientId,
  clientVersion,
  fetchImpl,
  tenantId,
}: ApiClientOptions): ApiClient => {
  const doFetch =
    fetchImpl ??
    (globalThis as { fetch?: typeof fetch }).fetch?.bind(globalThis);

  if (!doFetch) {
    throw new Error("No fetch implementation available — pass `fetchImpl`.");
  }

  const headers = (): Record<string, string> => {
    const base: Record<string, string> = {
      "content-type": "application/json",
      ...versionHeaders(clientVersion),
    };
    if (token) base.authorization = `Bearer ${token}`;
    // The client id is deliberately untouched by the handshake: the two version
    // headers are read by the server's floor, this one only drives the label a
    // person sees in a device list. It is a name, never a permission.
    if (clientId) base[CLIENT_ID_HEADER] = clientId;
    return base;
  };

  const call = async <TResult>(
    path: string,
    raw: unknown,
    method: "GET" | "POST",
  ): Promise<TResult> => {
    const input = tenantId ? withTenantId(raw, tenantId()) : raw;
    const url = new URL(`${baseUrl.replace(/\/$/, "")}/api/trpc/${path}`);
    if (method === "GET" && input !== undefined) {
      url.searchParams.set("input", JSON.stringify(input));
    }

    const response = await doFetch(url.toString(), {
      method,
      headers: headers(),
      // Cookie auth for same-site browser callers; harmless with a token.
      credentials: token ? "omit" : "include",
      body: method === "POST" ? JSON.stringify(input ?? {}) : undefined,
    });

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      throw new ApiError(
        `Request to ${path} failed (${response.status})`,
        "PARSE_ERROR",
        response.status,
      );
    }

    return unwrap(body, response.status) as TResult;
  };

  return {
    query: (path, input) => call(path, input, "GET"),
    mutate: (path, input) => call(path, input, "POST"),
  };
};
