// Who is calling, and what they are allowed to ask for.
//
// This is the WHOLE boundary between an HTTP request and a `TenantScope`.
// Nothing below it takes a tenant id from the caller: the tenant comes off the
// token, and a token is bound to exactly one. That is what makes "a token can
// never address a tenant of its own choosing" structural rather than a rule
// every handler has to remember — the request never reaches a place where a
// tenant id is read from input, because on this path no such place exists.
import type { NextFunction, Request, RequestHandler, Response } from "express";
import {
  authenticateApiToken,
  isApiTokenAuth,
  parseApiToken,
  type ApiTokenAuth,
} from "../../auth/api-token.js";
import { has, type ApiTokenScope } from "../../auth/api-permissions.js";
import { tenantMemberIds, type TenantScope } from "../../services/tenancy.js";
import { sendProblemFor } from "./problem.js";
import {
  checkAuthFailureBudget,
  consumeRateLimit,
  recordAuthFailure,
  setRateLimitHeaders,
  type RateLimitResult,
} from "./rate-limit.js";

/**
 * A request that has passed {@link requireApiToken}.
 *
 * `apiQuery` exists because Express 5 defines `req.query` as a GETTER that
 * re-parses the URL on every access — deleting a key off the object it returns
 * is undone by the next read. So the sanitised copy is taken once, here, and
 * handlers read that. The real guarantee is still further down: the zod
 * schemas strip unknown keys and no service accepts a tenant id from input.
 * This is the outermost of three layers, not the only one.
 */
export type AuthedRequest = Request & {
  apiToken: ApiTokenAuth;
  apiScope: TenantScope;
  apiQuery: Record<string, unknown>;
};

/** Narrowing helper, so no handler has to cast. */
export function isAuthedRequest(req: Request): req is AuthedRequest {
  return "apiToken" in req && "apiScope" in req;
}

/**
 * The single 401 body.
 *
 * Every `ApiTokenFailure` variant lands here with the same wording. Telling
 * "no such token" apart from "wrong secret", or "expired" apart from
 * "revoked", turns the endpoint into an oracle that confirms which prefixes
 * exist. The distinctions are for the server log, never for the caller.
 *
 * A REMOVED MEMBER lands here too, and that is deliberate: there is nothing
 * left for the token to act as, so it is dead rather than merely unauthorized.
 * A 403 would confirm that the tenant exists and the credential is otherwise
 * good.
 */
function unauthorized(res: Response, instance: string): void {
  sendProblemFor(res, {
    slug: "invalid-token",
    status: 401,
    detail: "Provide a valid API token as `Authorization: Bearer sk_…`.",
    instance,
  });
}

/**
 * The client address half of a failure key.
 *
 * `req.ip` rather than a hand-read `X-Forwarded-For`, because the app sets
 * `trust proxy` — Express has already resolved which hop to believe. Reading
 * the header directly would either trust one the proxy config says not to, so
 * any caller picks their own key and the meter is decorative, or ignore the
 * proxy entirely, so every production request shares the load balancer's
 * address.
 */
function clientAddress(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

/**
 * What a failed authentication is charged to: the source address AND the token
 * prefix that was presented.
 *
 * Keyed on the address ALONE, this meter refuses valid credentials: thirty
 * rejected requests — one customer's revoked token, retried by its cron — burn
 * the budget for every other integration sharing that egress address. It is
 * also weaponisable on purpose by anyone who knows a victim shares one.
 *
 * Including the prefix makes the key name the credential that actually failed.
 * A valid token's key can only be burned by presenting that same prefix with a
 * bad secret, which needs the prefix — and a caller holding the prefix and
 * failing on the secret is exactly who this should ration.
 *
 * An unparseable or absent token falls back to the bare address, on purpose:
 * those cost no database lookup, and they must not share a key with any real
 * credential from the same address or the denial primitive comes straight
 * back.
 */
export function authFailureKey(
  address: string,
  authorizationHeader: string | undefined,
): string {
  const match = /^Bearer\s+(\S+)$/i.exec(authorizationHeader ?? "");
  const presented = match?.[1] ? parseApiToken(match[1]) : null;
  return presented === null ? address : `${address}:${presented.prefix}`;
}

function sendRateLimited(res: Response, result: RateLimitResult, instance: string): void {
  res.setHeader("Retry-After", String(result.resetSeconds));
  sendProblemFor(res, {
    slug: "rate-limited",
    status: 429,
    detail: `Rate limit of ${result.limit} requests per minute exceeded. Retry in ${result.resetSeconds}s.`,
    instance,
  });
}

/** A `tenantId` off an untrusted payload, or null when it was not a string. */
function tenantIdIn(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const named = (value as Record<string, unknown>).tenantId;
  return typeof named === "string" ? named : null;
}

/**
 * Meter, authenticate, rate-limit, and build the scope — in that order, which
 * is forced.
 *
 * Rate limiting is inside this middleware rather than beside it because the
 * authenticated counter is keyed on the token: there is no honest way to count
 * a request that way before knowing whose it is, and a separate middleware
 * could be mounted in the wrong order without anything failing loudly.
 *
 * The FAILED path is metered first and read BEFORE the token lookup —
 * otherwise every rejected request still buys an indexed `findOne`, at
 * whatever rate the caller likes, with no credential required to ask.
 */
export const requireApiToken: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  void (async () => {
    const instance = req.originalUrl;
    const failureKey = authFailureKey(clientAddress(req), req.headers.authorization);

    const failureBudget = await checkAuthFailureBudget(failureKey);
    if (!failureBudget.allowed) {
      sendRateLimited(res, failureBudget, instance);
      return;
    }

    const auth = await authenticateApiToken(req.headers.authorization);
    if (!isApiTokenAuth(auth)) {
      // Charged only on failure, and only to the credential that failed.
      await recordAuthFailure(failureKey);
      unauthorized(res, instance);
      return;
    }

    const limit = await consumeRateLimit(auth.tokenId);
    setRateLimitHeaders(res, limit);
    if (!limit.allowed) {
      sendRateLimited(res, limit, instance);
      return;
    }

    // Belt and braces on top of the schemas' unknown-key stripping: a caller
    // who went to the trouble of naming a tenant is refused rather than
    // quietly served a different one than they asked about. Same-tenant is
    // tolerated so a client mirroring its typed payloads still works.
    for (const named of [tenantIdIn(req.body), tenantIdIn(req.query)]) {
      if (named !== null && named !== auth.tenantId) {
        sendProblemFor(res, {
          slug: "tenant-not-addressable",
          status: 400,
          detail:
            "An API token is bound to one tenant and cannot address another. Remove `tenantId` from the request.",
          instance,
        });
        return;
      }
    }

    const apiQuery: Record<string, unknown> = { ...req.query };
    delete apiQuery.tenantId;
    if (req.body !== null && typeof req.body === "object") {
      delete (req.body as Record<string, unknown>).tenantId;
    }

    const authed = req as AuthedRequest;
    authed.apiToken = auth;
    authed.apiQuery = apiQuery;
    // The scope is built HERE and nowhere else on this path. Its `tenantId`
    // comes off the token row; there is no branch that reads one from the
    // request.
    authed.apiScope = {
      tenantId: auth.tenantId,
      actorId: auth.userId,
      memberIds: await tenantMemberIds(auth.tenantId),
      permissions: auth.permissions,
      source: "api",
    };
    next();
  })().catch(next);
};

/**
 * Gate a route on one scope.
 *
 * Delegates to `has` rather than re-spelling `.includes`, because
 * deny-by-default is pinned by that one function: a token whose `scopes` array
 * is empty passes nothing, and a `?? ALL_SCOPES` default anywhere would invert
 * that for every row written before the field existed.
 */
export function requireScope(scope: ApiTokenScope): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isAuthedRequest(req)) {
      unauthorized(res, req.originalUrl);
      return;
    }
    if (!has(req.apiToken.scopes, scope)) {
      sendProblemFor(res, {
        slug: "insufficient-scope",
        status: 403,
        detail: `This token does not carry the \`${scope}\` scope.`,
        instance: req.originalUrl,
      });
      return;
    }
    next();
  };
}

/** What every route module exports: one async function per table entry. */
export type ApiHandler = (req: AuthedRequest, res: Response) => Promise<void> | void;

/**
 * A route callable with no token — only the spec document is.
 *
 * A separate type, not a widened {@link ApiHandler}: giving public handlers a
 * request that merely happens to lack `apiToken` at runtime is how one grows a
 * read of it and starts throwing on every anonymous call.
 */
export type PublicApiHandler = (req: Request, res: Response) => Promise<void> | void;

export type ApiHandlers = Readonly<Record<string, ApiHandler>>;
export type PublicApiHandlers = Readonly<Record<string, PublicApiHandler>>;

/** The key both the table and the handler maps agree on. */
export function routeKey(method: string, path: string): string {
  return `${method} ${path}`;
}
