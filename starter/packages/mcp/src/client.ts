/*
 * The REST client. Three failure classes, and nothing else in this file
 * decides anything.
 *
 * ── REST only, never tRPC ───────────────────────────────────────────
 *
 * Every call goes through the public `/api/v1` surface with a scoped bearer
 * token. The typed RPC the first-party clients use is deliberately out of
 * reach: authorization, row visibility and field projection are decided once,
 * on that surface, and a client that reached around it would be the one place
 * those rules are skipped. It would also fail silently — a model reports
 * whatever it is handed, so data that should have been withheld reads exactly
 * like data that was allowed.
 *
 * `@starter/core`'s `ApiError` is reused rather than re-declared for the two
 * classes that ARE an answer from the server, because `isTransportFailure` in
 * that package is defined as "not an `ApiError`", i.e. "no answer came back".
 * A second error class with the same name would make that function lie about
 * errors thrown here.
 *
 * ── The three classes, and why they are three ───────────────────────
 *
 *  1. {@link ApiRefusal} — the server answered, with a problem document. The
 *     slug names the failure and `problems.ts` turns it into one sentence.
 *  2. {@link ApiUnreachable} — nothing answered. DNS, refused connection, TLS,
 *     timeout. Node reports all of them as the same bare "fetch failed", so
 *     the real cause has to be dug out of the wrapped error or the user is
 *     told nothing at all.
 *  3. {@link ApiNotThisApi} — something answered and it was not this API. A
 *     proxy error page, a captive portal, the web app's HTML 404 because the
 *     origin points at the client rather than the server. Collapsing this into
 *     (1) would report a login page as a refusal and send the user looking at
 *     their token.
 */

import { ApiError, CLIENT_ID_HEADER } from "@starter/core";
import { type ApiProblem, isApiProblem } from "./problems.js";
import type { ApiRoute } from "./routes.js";

/** The server refused, in its own words. */
export class ApiRefusal extends ApiError {
  readonly problem: ApiProblem;

  constructor(problem: ApiProblem) {
    super(problem.detail, problem.type, problem.status);
    this.name = "ApiRefusal";
    this.problem = problem;
  }
}

/**
 * An answer arrived and it is not this API.
 *
 * `PARSE_ERROR` is the code `@starter/core` uses for exactly this case, and
 * the offline queue in that package treats it as "says nothing about the row"
 * — which is the right reading here too: an HTML page in front of the API is a
 * statement about the network, not about the request.
 */
export class ApiNotThisApi extends ApiError {
  readonly contentType: string;
  readonly bodyPreview: string;

  constructor(status: number, contentType: string, bodyPreview: string, url: string) {
    super(
      `${url} answered with ${contentType || "no content type"} instead of JSON. ` +
        "Check that the configured origin is the API and not the web app, and that no proxy or sign-in page sits in front of it.",
      "PARSE_ERROR",
      status,
    );
    this.name = "ApiNotThisApi";
    this.contentType = contentType;
    this.bodyPreview = bodyPreview;
  }
}

/**
 * Nothing answered.
 *
 * Deliberately NOT an `ApiError`: `isTransportFailure` from `@starter/core` is
 * "not an ApiError", and this is the only class here for which that is true.
 */
export class ApiUnreachable extends Error {
  readonly url: string;

  constructor(message: string, url: string, cause: unknown) {
    super(message, { cause });
    this.name = "ApiUnreachable";
    this.url = url;
  }
}

/** A runtime error's `code`, following the `cause` chain. */
function errorCode(error: unknown, depth = 0): string | null {
  if (depth > 5 || error === null || typeof error !== "object") return null;
  const candidate = error as { code?: unknown; cause?: unknown };
  if (typeof candidate.code === "string") return candidate.code;
  return errorCode(candidate.cause, depth + 1);
}

/**
 * One sentence naming the real transport failure.
 *
 * Node's `fetch` reports every one of these as `TypeError: fetch failed` with
 * the cause nested one or two levels down, so the message a caller would print
 * unaided is the same string for a typo in a hostname, a server that is not
 * running and an expired certificate. Those have three different fixes.
 */
export function describeTransportFailure(error: unknown, url: string, timeoutMs: number): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return `No answer from ${url} within ${timeoutMs}ms. The server may be starting, overloaded, or behind something that is not forwarding the request.`;
  }
  const code = errorCode(error);
  switch (code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `The host in ${url} does not resolve. Check the origin for a typo, and check this machine's DNS.`;
    case "ECONNREFUSED":
      return `Nothing is listening at ${url}. Start the server, or point the origin at the deployment you mean.`;
    case "ECONNRESET":
    case "UND_ERR_SOCKET":
      return `The connection to ${url} was closed before an answer arrived. Something between this machine and the server dropped it.`;
    case "UND_ERR_CONNECT_TIMEOUT":
      return `Connecting to ${url} timed out. The host is reachable by name but not answering on that port.`;
    case "CERT_HAS_EXPIRED":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "SELF_SIGNED_CERT_IN_CHAIN":
      return `The TLS certificate at ${url} was rejected (${code}). Use the https origin the certificate was issued for, or http for a local server.`;
    default:
      return `${url} could not be reached${code ? ` (${code})` : ""}: ${
        error instanceof Error ? error.message : String(error)
      }.`;
  }
}

export type RestRequest = {
  route: ApiRoute;
  /** Values for the `:name` segments in `route.path`. */
  params?: Record<string, string>;
  /** Query values. `undefined` entries are omitted, never sent as "undefined". */
  query?: Record<string, unknown>;
  body?: unknown;
};

export type RestClient = {
  /** The origin this client talks to, for messages that have to name it. */
  readonly baseUrl: string;
  request<T>(request: RestRequest): Promise<T>;
};

export type RestClientOptions = {
  baseUrl: string;
  token: string;
  /** Names this surface in the server's session list. Never a permission. */
  clientId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/**
 * Fill `:name` segments from `params`.
 *
 * A missing value throws rather than producing `/items/undefined`, which the
 * server would answer with a 404 that reads to a model as "no such record"
 * — a wrong answer that looks like a right one.
 */
function buildPath(route: ApiRoute, params: Record<string, string> | undefined): string {
  return route.path.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    const value = params?.[name];
    if (value === undefined || value === "") {
      throw new Error(`Route ${route.method} ${route.path} needs a "${name}" path parameter.`);
    }
    return encodeURIComponent(value);
  });
}

/** Absent values are omitted; arrays repeat the key, which is what the server's coercion reads. */
function buildQuery(query: Record<string, unknown> | undefined): string {
  if (!query) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item !== undefined && item !== null) search.append(key, String(item));
      continue;
    }
    search.append(key, String(value));
  }
  const rendered = search.toString();
  return rendered === "" ? "" : `?${rendered}`;
}

/** First line of a body, clipped, so a 4MB HTML page cannot land in a tool result. */
function preview(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, 200);
}

export function createRestClient(options: RestClientOptions): RestClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");

  return {
    baseUrl,
    async request<T>({ route, params, query, body }: RestRequest): Promise<T> {
      const url = `${baseUrl}${buildPath(route, params)}${buildQuery(query)}`;
      const headers: Record<string, string> = {
        authorization: `Bearer ${options.token}`,
        accept: "application/json",
        // Cosmetic: it names this surface in the server's session list so a
        // person can see which integration made a call. The token decides
        // everything that matters; this header decides nothing.
        [CLIENT_ID_HEADER]: options.clientId,
      };
      if (body !== undefined) headers["content-type"] = "application/json";

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: route.method.toUpperCase(),
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new ApiUnreachable(describeTransportFailure(error, url, timeoutMs), url, error);
      }

      const contentType = response.headers.get("content-type") ?? "";
      const text = await response.text();
      const looksJson = contentType.includes("json");

      if (!looksJson) {
        // Includes a 204 with no body, which none of these routes answer with:
        // if one ever does, this is the failure that says so out loud rather
        // than handing the tool an undefined it would report as an empty result.
        throw new ApiNotThisApi(response.status, contentType, preview(text), url);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        throw new ApiNotThisApi(response.status, contentType, preview(text), url);
      }

      if (!response.ok) {
        if (isApiProblem(parsed)) throw new ApiRefusal(parsed);
        // JSON, an error status, and not a problem document: something that
        // speaks JSON is in front of the API (an API gateway, a CDN's error
        // envelope). Not a refusal by this server.
        throw new ApiNotThisApi(response.status, contentType, preview(text), url);
      }
      return parsed as T;
    },
  };
}
