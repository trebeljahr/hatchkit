import { router, publicProcedure } from "../trpc.js";
import { isDatabaseReady } from "../../db/connection.js";
// ── client-core ──────────────────────────────────────────────────
import { API_LEVEL, MIN_CLIENT_API_LEVEL } from "@starter/shared";
// ── end client-core ──────────────────────────────────────────────

export const healthRouter = router({
  check: publicProcedure.query(() => {
    return {
      status: "ok" as const,
      db: isDatabaseReady(),
      timestamp: new Date().toISOString(),
      // ── client-core ────────────────────────────────────────────
      // The same two numbers as `/api/health`, for a client that already has a
      // tRPC client and no reason to build a second fetch. A client reads them
      // to decide which side is too old: its own level below
      // `minClientApiLevel` means "update the app", this server's `apiLevel`
      // below the client's own floor means "update the server".
      //
      // `health.*` is the one path the version floor never refuses (see
      // `trpc/trpc.ts`), precisely so a client that has just been refused can
      // still ask this and report which side to update. And, as on
      // `/api/health`, a client must not send the handshake REQUEST headers
      // here: a custom header forces a CORS preflight that an untrusted origin
      // fails, which the client reads as "unreachable".
      apiLevel: API_LEVEL,
      minClientApiLevel: MIN_CLIENT_API_LEVEL,
      // ── end client-core ────────────────────────────────────────
    };
  }),
});
