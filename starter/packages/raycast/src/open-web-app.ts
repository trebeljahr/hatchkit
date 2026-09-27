/**
 * Open the web app.
 *
 * ============================================================
 * THE FIFTH COMMAND, AND WHY THERE IS NO SIXTH
 * ============================================================
 *
 * Everything this extension does not cover is web app work, reached in one
 * keystroke rather than rebuilt here. Adding a sixth command is the decision to
 * argue about, not adding capability to one of the five: Raycast has no runtime
 * visibility control, so every command is listed forever, in every launcher
 * search, whether or not it applies right now.
 *
 * It also drains the queue on the way out. A person who opens the web app is
 * about to look at the data, and sending what is waiting first is the
 * difference between seeing their own work and wondering where it went. The
 * drain is best-effort: the browser opens either way.
 */
import { open, showHUD } from "@raycast/api";
import { flushQueue } from "./lib/api";
import { webOrigin } from "./lib/preferences";

export default async function Command(): Promise<void> {
  const target = webOrigin();
  try {
    const result = await flushQueue({ retryHeld: true });
    if (result.flushed > 0) {
      await showHUD(`Sent ${result.flushed} queued change(s)`);
    }
  } catch {
    // Not paired, or no answer. Neither is a reason to refuse to open a browser.
  }
  await open(target);
}
