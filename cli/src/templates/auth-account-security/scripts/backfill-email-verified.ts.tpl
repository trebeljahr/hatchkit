/**
 * Mark accounts created before mail existed as verified.
 *
 * Why it exists: `auth/auth.ts` sets `requireEmailVerification` to whatever
 * `isEmailDeliveryConfigured()` says. better-auth then refuses a password
 * sign-in from any user whose `emailVerified` is not `true` — and every
 * account made while verification was off has `false`. So without this, the
 * first deploy that configures mail locks out every existing user and sends
 * them a verification link instead of letting them in.
 *
 * `--before` is the cutoff: accounts created before it are marked verified,
 * accounts created after it verify themselves. It defaults to "now", which is
 * right when the script runs straight after the deploy. Accounts that signed
 * up between the deploy and this run are also covered by that default; pass
 * the deploy time explicitly to exclude them.
 *
 * Idempotent: the filter only matches accounts that are not verified yet, so a
 * re-run changes nothing and reports 0. It never un-verifies.
 *
 *   pnpm --filter @starter/server run backfill:email-verified -- --before 2026-01-31T09:00:00Z
 */

import { pathToFileURL } from "node:url";

type Where = { field: string; value: unknown; operator?: "ne" | "lt" }[];

export type BackfillAdapter = {
  count: (args: { model: string; where: Where }) => Promise<number>;
  updateMany: (args: {
    model: string;
    where: Where;
    update: Record<string, unknown>;
  }) => Promise<unknown>;
};

export async function backfillEmailVerified(
  adapter: BackfillAdapter,
  before: Date,
): Promise<number> {
  const where: Where = [
    { field: "emailVerified", operator: "ne", value: true },
    { field: "createdAt", operator: "lt", value: before },
  ];
  // Counted rather than read off updateMany, whose return value differs per
  // adapter — a modified count on Mongo, something else in memory.
  const pending = await adapter.count({ model: "user", where });
  if (pending === 0) return 0;
  await adapter.updateMany({ model: "user", where, update: { emailVerified: true } });
  return pending;
}

export function parseCutoff(argv: readonly string[], now: Date = new Date()): Date {
  const index = argv.indexOf("--before");
  if (index === -1) return now;
  const value = argv[index + 1];
  const parsed = value ? new Date(value) : new Date(Number.NaN);
  if (!value || Number.isNaN(parsed.getTime())) {
    throw new Error(`--before needs an ISO date, got ${value ?? "nothing"}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  // Imported lazily so that this module stays importable by a test without
  // opening a database connection as a side effect.
  const { default: mongoose } = await import("mongoose");
  const { env } = await import("../config/env.js");
  const { disconnectAuth, getAuth, initAuth } = await import("../auth/auth.js");

  const before = parseCutoff(process.argv.slice(2));
  await mongoose.connect(env.MONGODB_URI);
  try {
    await initAuth();
    const context = await getAuth().$context;
    const count = await backfillEmailVerified(context.adapter, before);
    console.log(
      `[backfill:email-verified] marked ${count} account(s) created before ${before.toISOString()} as verified`,
    );
  } finally {
    await disconnectAuth();
    await mongoose.disconnect();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error("[backfill:email-verified] failed:", error);
    process.exitCode = 1;
  });
}
