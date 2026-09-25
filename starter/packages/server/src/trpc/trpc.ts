import { initTRPC, TRPCError } from "@trpc/server";
import type { Context } from "./context.js";
// ── client-core ──────────────────────────────────────────────────
import type { VersionRefusal } from "@starter/shared";
import { CLIENT_TOO_OLD_MESSAGE, versionRefusalFor } from "../auth/client-version.js";

/**
 * Carried as a `TRPCError`'s cause so the formatter below can put the refusal
 * code on the wire as `data.versionRefusal`.
 *
 * tRPC serialises a `cause` no further than its message, so a refusal that is
 * only an error class reaches the client as English prose. The formatter is
 * what turns it into a code, and this class is how the formatter recognises it.
 */
export class VersionRefusalError extends Error {
  readonly refusal: VersionRefusal;

  constructor(refusal: VersionRefusal) {
    super(CLIENT_TOO_OLD_MESSAGE);
    this.name = "VersionRefusalError";
    this.refusal = refusal;
  }
}
// ── end client-core ──────────────────────────────────────────────

const t = initTRPC.context<Context>().create({
  // ── client-core ──────────────────────────────────────────────────
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        // `CLIENT_TOO_OLD` when the request declared an API level below this
        // server's floor, null on every other error. A STABLE CODE, so every
        // client can say "update the app" without parsing a message — a client
        // that matches on prose breaks the next time the wording is improved,
        // and in a translated build it never worked at all.
        versionRefusal: error.cause instanceof VersionRefusalError ? error.cause.refusal : null,
      },
    };
  },
  // ── end client-core ──────────────────────────────────────────────
});

export const router = t.router;

// ── client-core ──────────────────────────────────────────────────
/**
 * The client API-level floor, on every procedure but `health.*`.
 *
 * `health.*` stays answerable to ANY client, however old. A refused client has
 * to be able to learn the server's own level to say which side needs updating —
 * refuse the health check too and the only thing it can tell the person is
 * "something is wrong", which is what a network error already says. A request
 * that declares no level at all is a pre-handshake client and passes (see
 * `versionRefusalFor`).
 *
 * PRECONDITION_FAILED (412), deliberately: the offline queue drops a row on a
 * permanent rejection status (400/403/404/409/410/422), and version skew must
 * never delete work somebody did with no signal. A 412 keeps the row for the
 * build that can send it. See `isPermanentRejectionStatus` in `@starter/core`.
 */
const versionFloor = t.middleware(({ ctx, path, next }) => {
  if (!path.startsWith("health.")) {
    const refusal = versionRefusalFor(ctx.req?.headers);
    if (refusal !== null) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: CLIENT_TOO_OLD_MESSAGE,
        cause: new VersionRefusalError(refusal),
      });
    }
  }
  return next();
});
// ── end client-core ──────────────────────────────────────────────

// The terminating `;` sits on its own line on purpose: everything between the
// markers is removed when the `client-core` feature is not selected, and a
// statement whose terminator went with it would not compile. Keep it there.
export const publicProcedure = t.procedure
  // ── client-core ──────────────────────────────────────────────────
  // Every procedure but `health.*` carries the API-level floor. It rides on
  // `publicProcedure` so that `protectedProcedure`, built from it below,
  // inherits the floor without either name changing meaning for existing code.
  .use(versionFloor)
  // ── end client-core ──────────────────────────────────────────────
;

/**
 * Protected procedure — throws UNAUTHORIZED if no session exists.
 * Narrows the context type so `ctx.session` and `ctx.user` are non-null.
 */
export const protectedProcedure = publicProcedure.use(async ({ ctx, next }) => {
  if (!ctx.session || !ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({
    ctx: {
      ...ctx,
      session: ctx.session,
      user: ctx.user,
    },
  });
});
