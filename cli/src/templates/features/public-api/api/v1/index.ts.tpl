// The public REST API's single mount point.
//
// `registerApiV1Routes` is the ONLY symbol `app.ts` imports from this layer, so
// the surface can grow without `app.ts` changing again.
//
// The architectural rule everything below follows: REST NEVER ENTERS tRPC. A
// token request authenticates in `auth.ts`, builds a `TenantScope`, and calls
// the same extracted services in `services/items/` that the tRPC resolvers
// call. There is no synthetic tRPC context and no token path through
// `protectedProcedure`, which is what makes it structurally impossible for a
// token request to reach a place where a tenant id is read from input.
import { Router, type Express, type Request, type Response } from "express";
import {
  isAuthedRequest,
  requireApiToken,
  requireScope,
  routeKey,
  type ApiHandler,
  type PublicApiHandler,
} from "./auth.js";
import { ApiProblemError, PROBLEM_BASE, problemFrom, sendProblem } from "./problem.js";
import { API_ROUTES, type ApiRoute } from "./routes-table.js";
import { itemHandlers } from "./routes/items.js";
import { metaHandlers, publicMetaHandlers } from "./routes/meta.js";
import { webhookHandlers } from "./routes/webhooks.js";

export const API_V1_BASE_PATH = "/api/v1";

/** Every authenticated handler, keyed the same way {@link API_ROUTES} is. */
const HANDLERS: Readonly<Record<string, ApiHandler>> = {
  ...metaHandlers,
  ...itemHandlers,
  ...webhookHandlers,
};

/** The handlers that need no credential. Only the spec document is one. */
const PUBLIC_HANDLERS: Readonly<Record<string, PublicApiHandler>> = {
  ...publicMetaHandlers,
};

/**
 * Run a handler and turn anything it throws into a problem document.
 *
 * REST answers its own errors rather than calling `next(err)`. The global
 * `errorHandler` returns `err.message` verbatim outside production, so a
 * mongoose or driver message would become part of an API response the moment
 * somebody ran the server with NODE_ENV unset. Here every 5xx `detail` is the
 * same fixed string and the real error goes to the log.
 */
function guard(
  handler: (req: Request, res: Response) => Promise<void> | void,
): (req: Request, res: Response) => void {
  return (req: Request, res: Response): void => {
    void (async () => {
      try {
        await handler(req, res);
      } catch (err) {
        const value = problemFrom(err, req.originalUrl);
        if (value.status >= 500) {
          console.error(
            JSON.stringify({
              scope: "api.v1",
              level: "error",
              event: "handler_failed",
              path: req.originalUrl,
              method: req.method,
              message: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        // A handler that already started writing cannot be given a status any
        // more; a second `sendProblem` here would throw inside the catch.
        if (res.headersSent) return;
        sendProblem(res, value);
      }
    })();
  };
}

/** An authenticated handler only ever sees a request that carries a token. */
function authed(handler: ApiHandler): (req: Request, res: Response) => void {
  return guard(async (req, res) => {
    // Unreachable: `requireApiToken` runs first and answers 401 itself. A type
    // guard rather than a cast, so that adding a field to `AuthedRequest`
    // cannot be papered over here — and if the chain is ever reordered, this
    // refuses with the same 401 instead of falling through to the handler.
    if (!isAuthedRequest(req)) {
      throw new ApiProblemError(
        "invalid-token",
        401,
        "Provide a valid API token as `Authorization: Bearer sk_…`.",
      );
    }
    await handler(req, res);
  });
}

function mount(router: Router, route: ApiRoute): void {
  const key = routeKey(route.method, route.path);

  if (route.isPublic) {
    const handler = PUBLIC_HANDLERS[key];
    // THROWING AT STARTUP, not 404-ing at request time. A route in the table
    // is a route the OpenAPI document advertises, so an unimplemented one is a
    // documented lie. Better to fail the boot — where a deploy notices — than
    // to ship it and let an integrator discover it.
    if (!handler) throw new Error(`No public handler registered for "${key}"`);
    router[route.method](route.path, guard(handler));
    return;
  }

  const handler = HANDLERS[key];
  if (!handler) throw new Error(`No handler registered for "${key}"`);

  const chain = route.scope
    ? [requireApiToken, requireScope(route.scope), authed(handler)]
    : [requireApiToken, authed(handler)];
  router[route.method](route.path, ...chain);
}

export function registerApiV1Routes(app: Express): void {
  const router = Router();

  // Mounted in TABLE ORDER, which is load-bearing: a literal segment must be
  // registered before a parameterised route that would also match it, or
  // Express matches the parameter first and the literal is looked up as an id.
  for (const route of API_ROUTES) mount(router, route);

  // A 404 inside /api/v1 answers problem+json like everything else here. Left
  // to the global handler it would come back as the app's own JSON shape, and
  // a client that parses one error format fails to parse the other.
  router.use((req: Request, res: Response) => {
    sendProblem(res, {
      type: `${PROBLEM_BASE}no-such-route`,
      title: "Not Found",
      status: 404,
      detail: `No API route matches ${req.method} ${req.originalUrl}. See ${API_V1_BASE_PATH}/openapi.json.`,
      instance: req.originalUrl,
    });
  });

  app.use(API_V1_BASE_PATH, router);
}
