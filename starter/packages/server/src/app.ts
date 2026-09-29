import express, { type RequestHandler } from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { toNodeHandler } from "better-auth/node";
import { getAuth } from "./auth/auth.js";
import { appRouter } from "./trpc/router.js";
import { createContext } from "./trpc/context.js";
import { handleStripeWebhook } from "./services/stripe.js";
import { registerNewsletterRoutes } from "./services/newsletter/routes.js";
import { isDatabaseReady } from "./db/connection.js";
import { isDraining, isLoopback } from "./drain.js";
import { notFoundHandler, errorHandler } from "./middleware/error-handler.js";
import { env, getTrustedOrigins } from "./config/env.js";
// ── client-core ──────────────────────────────────────────────────
import { API_LEVEL, MIN_CLIENT_API_LEVEL } from "@starter/shared";
// ── end client-core ──────────────────────────────────────────────

export function createApp() {
  const app = express();

  app.set("trust proxy", 1);

  // ── 0. CORS — must be before all route handlers so preflight works ─
  const trustedOrigins = getTrustedOrigins();
  app.use(
    cors({
      origin: trustedOrigins.length > 0 ? trustedOrigins : false,
      credentials: true,
    }),
  );

  // ── 1. better-auth — BEFORE express.json() ────────────────────────
  // better-auth handles its own body parsing. Mounting express.json()
  // before this will consume the body and break auth.
  app.all("/api/auth/{*any}", (req, res, next) => {
    try {
      const auth = getAuth();
      return toNodeHandler(auth)(req, res);
    } catch (err) {
      next(err);
    }
  });

  // ── 2. Stripe webhook — needs raw body for signature verification ──
  app.post(
    "/api/stripe/webhook",
    express.raw({ type: "application/json" }),
    handleStripeWebhook,
  );

  // ── 3. Body parsing (for everything else) ──────────────────────────
  app.use(express.json({ limit: "100kb" }));
  app.use(express.urlencoded({ extended: true }));

  // ── 4. Security + logging ──────────────────────────────────────────
  app.use(helmet());
  app.use(morgan(env.isProduction ? "combined" : "dev"));

  // ── 5. tRPC ────────────────────────────────────────────────────────
  const trpcMiddleware = createExpressMiddleware({
    router: appRouter,
    createContext,
  }) as RequestHandler;
  app.use("/api/trpc", trpcMiddleware);

  // ── 5b. Newsletter (Listmonk + SES double-opt-in subscribe + confirm)
  registerNewsletterRoutes(app);

  // ── 6. Health endpoint ─────────────────────────────────────────────
  app.get("/api/health", (req, res) => {
    // Shutting down: fail the in-container probe so Traefik stops routing
    // here before the server closes. Everyone else still gets the answer
    // below — see ./drain.ts.
    if (isDraining() && isLoopback(req.socket.remoteAddress)) {
      res.status(503).json({ status: "draining" });
      return;
    }
    res.json({
      status: "ok",
      db: isDatabaseReady(),
      // The commit this image was built from. The deploy pipeline polls
      // this until it matches the commit it just pushed — without it, a
      // deploy that silently kept the previous container reported success
      // everywhere. Empty for a locally-run server, which has no build
      // commit; consumers must treat the field as optional.
      version: env.COMMIT_SHA,
      timestamp: new Date().toISOString(),
      // ── client-core ──────────────────────────────────────────────
      // The version handshake, from the server's side. A client reads these
      // two to decide WHICH SIDE is too old: its own level below
      // `minClientApiLevel` means "update the app", this server's `apiLevel`
      // below the client's own floor means "update the server". Without them a
      // client only knows that a request failed.
      //
      // This endpoint is also the one a client may reach before it is trusted,
      // which is why the handshake REQUEST headers must NEVER be sent to it. A
      // custom header turns a plain GET into a preflighted request, an
      // untrusted origin's preflight fails, and the client reads that as
      // "server unreachable" — so the check that exists to explain the problem
      // becomes the thing that hides it. See `versionHeaders` in
      // `@starter/shared`.
      apiLevel: API_LEVEL,
      minClientApiLevel: MIN_CLIENT_API_LEVEL,
      // ── end client-core ──────────────────────────────────────────
    });
  });

  // ── 7. Error handlers (must be last) ───────────────────────────────
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
