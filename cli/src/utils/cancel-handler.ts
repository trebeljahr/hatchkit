/*
 * SIGINT handler — turn Ctrl+C during `hatchkit create` / `hatchkit adopt`
 * into the same recipe + rollback flow we already run on a thrown error.
 *
 * Why this exists: without it, Ctrl+C while we're awaiting an HTTP call
 * (Cloudflare, Coolify, Hetzner…) just terminates the process and leaves
 * whatever resources have been provisioned so far stranded. The ledger
 * still records them, but the user has to remember to run `hatchkit
 * destroy <project>` after the fact. Most don't, and residue accumulates.
 *
 * Behavior:
 *   - First Ctrl+C  → swap our handler for a force-exit handler (so the
 *                     user has an escape hatch), then run the same
 *                     "rollback / show recipe / leave it" prompt the
 *                     thrown-error path uses.
 *   - Second Ctrl+C → process.exit(130) immediately. Ledger is preserved
 *                     so the user can `hatchkit destroy` later.
 *
 * Concurrency note: when an inquirer prompt is the thing the user is
 * Ctrl+C-ing out of, inquirer throws `ExitPromptError` into the await
 * chain — that throw lands in handleCreate's catch block which would
 * normally call `handleCreateFailure`. We don't want a double-prompt,
 * so `handlePartialRunInterruption` in rollback.ts has a re-entrancy
 * guard (`isInterruptionHandled()`), and the create/adopt catch blocks
 * check it before exiting.
 */
import chalk from "chalk";
import {
  handleAdoptCancellation,
  handleCreateCancellation,
  isInterruptionHandled,
} from "../deploy/rollback.js";
import type { RunLedger } from "./run-ledger.js";

let activeLedger: RunLedger | null = null;
let activeVerb: "create" | "adopt" = "create";
let cancelInProgress = false;

/** True between SIGINT delivery and the cleanup-completion `process.exit`.
 *  Used by the create/adopt catch blocks to stand down so the SIGINT-driven
 *  cleanup is the sole path that prompts and exits. */
export function isCancelInProgress(): boolean {
  return cancelInProgress;
}

function forceExit(): void {
  console.log(chalk.red("\n  Force-exiting. Ledger preserved — run `hatchkit destroy` later.\n"));
  process.exit(130);
}

function onSigint(): void {
  // Synchronous setup before any await: capture local refs, swap the
  // listener so a second Ctrl+C is a hard exit, mark cancel in progress.
  if (cancelInProgress) return;
  cancelInProgress = true;
  const ledger = activeLedger;
  const verb = activeVerb;
  process.removeListener("SIGINT", onSigint);
  process.on("SIGINT", forceExit);

  console.log(chalk.yellow("\n\n  ⚠ Cancellation requested (Ctrl+C). Starting cleanup…\n"));

  // Kick off cleanup — handler itself isn't async (Node's signal handlers
  // don't await), so wrap in an IIFE that ends the process when done.
  void (async () => {
    try {
      if (ledger) {
        if (verb === "create") {
          await handleCreateCancellation(ledger);
        } else {
          await handleAdoptCancellation(ledger);
        }
      }
    } catch (err) {
      // Don't let an unhandled rejection escape the IIFE — surface and exit.
      console.error(chalk.red(`\n  Error during cleanup: ${(err as Error).message}\n`));
    } finally {
      process.exit(130);
    }
  })();
}

/** Register the Ctrl+C handler. Call once after constructing the ledger;
 *  pair with `uninstallCancelHandler()` on the success path. Idempotent —
 *  re-calling with a new ledger swaps the target but doesn't double-stack
 *  the listener (process.on appends each call). */
export function installCancelHandler(ledger: RunLedger, verb: "create" | "adopt"): void {
  activeLedger = ledger;
  activeVerb = verb;
  cancelInProgress = false;
  if (!process.listeners("SIGINT").includes(onSigint)) {
    process.on("SIGINT", onSigint);
  }
}

/** Remove the handler. Safe to call from the create/adopt finally block —
 *  if cancellation is already in progress, leaves the running cleanup
 *  alone (it removed the listener itself and now owns the exit). */
export function uninstallCancelHandler(): void {
  if (cancelInProgress) return;
  process.removeListener("SIGINT", onSigint);
  activeLedger = null;
}

export { isInterruptionHandled };
