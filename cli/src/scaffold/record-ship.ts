// The `record-ship` composite action: every workflow hatchkit generates
// that makes something live (a web deploy, a Worker switch, a TestFlight or
// Play upload) calls it right after that step, under the same `if:`, so the
// repository gets a GitHub Deployment per ship. launchdeck's Shipped view
// and the repo's Environments page read those.
//
// `starter/.github/actions/record-ship/action.yml` is the copy a scaffolded
// project gets with the rest of the starter. The one in templates/ is for
// the generators that write into a repo hatchkit did not scaffold (adopt,
// `hatchkit cloudflare`, migrate-client, signing), and ships in dist/ where
// the starter does not. test-record-ship.ts keeps the two identical.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the action lands in a project. Workflows call it as
 *  `uses: ./.github/actions/record-ship`. */
export const RECORD_SHIP_ACTION_REL_PATH = ".github/actions/record-ship/action.yml";

const TEMPLATE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "templates",
  "record-ship",
  "action.yml",
);

/** The action's source, as shipped in hatchkit's templates. */
export function recordShipActionSource(): string {
  return readFileSync(TEMPLATE, "utf-8");
}

/** Write the action into a project that has none. A copy already there is
 *  left as it is: the inputs never change, and a project may have edited
 *  its own. Returns true when it wrote the file. */
export function writeRecordShipAction(projectDir: string): boolean {
  const path = join(projectDir, RECORD_SHIP_ACTION_REL_PATH);
  if (existsSync(path)) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, recordShipActionSource(), "utf-8");
  return true;
}
