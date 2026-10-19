#!/usr/bin/env -S npx tsx
/**
 * Delete Listmonk subscribers that never confirmed, 30 days after
 * Listmonk created them, across the whole shared instance. The deployed
 * server already does this once a day; run it by hand to see what it
 * would delete. The rule and its guards are in
 * packages/server/src/services/newsletter/prune.ts. This script deletes
 * whatever NODE_ENV says, so use --dry-run first.
 *
 * Usage:
 *
 *   pnpm newsletter:prune --dry-run        list what would be deleted
 *   pnpm newsletter:prune                  delete it
 *   pnpm newsletter:prune --days 45        a different age
 */
import { pruneUnconfirmed, UNCONFIRMED_TTL_DAYS } from "../packages/server/src/services/newsletter/prune.js";

function flagValue(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const daysRaw = flagValue("days");
  const days = daysRaw === undefined ? UNCONFIRMED_TTL_DAYS : Number(daysRaw);
  if (!Number.isInteger(days) || days < 1) {
    console.error(`[newsletter:prune] --days must be a whole number of days, got ${daysRaw}`);
    process.exit(1);
  }

  const result = await pruneUnconfirmed({ dryRun, days });
  console.info(
    `[newsletter:prune] ${result.total} subscriber(s) on the instance, ${result.candidates} on no list for more than ${days} days.`,
  );
  if (dryRun) for (const email of result.emails) console.info(`  ${email}`);
  if (result.refused) {
    console.error(`[newsletter:prune] ${result.refused}`);
    process.exit(1);
  }
  console.info(
    dryRun
      ? "[newsletter:prune] --dry-run: nothing deleted."
      : `[newsletter:prune] Deleted ${result.deleted}${result.deferred ? `; ${result.deferred} left for the next run` : ""}.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
