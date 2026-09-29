// Writes the tRPC contract snapshot. Run from the repo root:
//
//   pnpm run contract:emit
//
// The file is COMMITTED; `tests/trpc-contract.test.ts` fails when it is stale
// and says which versioning rule the difference falls under. `hatchkit create`
// runs it once after `pnpm install`. Run it again in every change that touches
// a procedure's input, a procedure's name or a sync event kind.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { appRouter } from "../trpc/router.js";
import { TRPC_CONTRACT_PATH, buildTrpcContract, trpcContractJson } from "./trpc-contract.js";

mkdirSync(dirname(TRPC_CONTRACT_PATH), { recursive: true });
writeFileSync(TRPC_CONTRACT_PATH, trpcContractJson(buildTrpcContract(appRouter)), "utf8");
console.log(`wrote ${TRPC_CONTRACT_PATH}`);
// Importing the router opens nothing, but some modules keep timers alive.
process.exit(0);
