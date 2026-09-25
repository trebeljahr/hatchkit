/*
 * OS idle state, behind the bridge's optional `getIdleState` / `onIdleState`
 * (desktop-bridge.ts).
 *
 * The renderer cannot work this out for itself. A page only knows about input
 * that reaches it, so a person typing all afternoon in another application
 * looks idle to the web app. `powerMonitor.getSystemIdleTime()` is the OS's own
 * answer and counts every application.
 *
 * This process does the detecting and the renderer does the deciding. Nothing
 * here pauses, saves or changes anything: it reports "the machine has seen no
 * input for N seconds" and lets the renderer apply the person's settings to
 * that. The bridge methods are optional because the same client code runs in a
 * browser and in the mobile shells, where there is no such answer.
 */

import { BrowserWindow, powerMonitor } from "electron";

import { DESKTOP_IPC, type DesktopIdlePayload } from "../../packages/shared/src/desktop-bridge.ts";
import { handle } from "./ipc.ts";

export type IdleState = "active" | "idle" | "locked";

/** How often the idle counter is sampled. Cheap: the call is a syscall. */
export const IDLE_POLL_MS = 15_000;

let poll: ReturnType<typeof setInterval> | null = null;
/** Sticky until the screen unlocks — the OS idle counter does not report a lock. */
let screenLocked = false;

/*
 * "Active" means input landed inside the last polling window, not that the
 * counter reads exactly zero. `getSystemIdleTime()` returns 0 only in the
 * second after a keystroke, so a poller testing for zero would report "idle"
 * at somebody typing continuously.
 */
export function readIdle(): DesktopIdlePayload {
  const idleSeconds = powerMonitor.getSystemIdleTime();
  const state: IdleState = screenLocked
    ? "locked"
    : idleSeconds * 1000 >= IDLE_POLL_MS
      ? "idle"
      : "active";
  return { state, idleSeconds };
}

function broadcast(): void {
  const payload = readIdle();
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(DESKTOP_IPC.idleState, payload);
  }
}

/** `powerMonitor` is only usable once the app is ready. Calling twice is a no-op. */
export function startIdleMonitor(): void {
  if (poll !== null) return;

  // A lock or a suspend is the deliberate walk-away. Both are forwarded at once
  // rather than at the next poll, because the renderer may treat a lock as away
  // without waiting for the threshold.
  const lock = (): void => {
    screenLocked = true;
    broadcast();
  };
  const unlock = (): void => {
    screenLocked = false;
    broadcast();
  };

  powerMonitor.on("lock-screen", lock);
  powerMonitor.on("suspend", lock);
  powerMonitor.on("unlock-screen", unlock);
  powerMonitor.on("resume", unlock);

  poll = setInterval(broadcast, IDLE_POLL_MS);

  handle(DESKTOP_IPC.getIdle, () => readIdle());
}

/** Stops the poll. The app's own quit does not need this; a test harness does. */
export function stopIdleMonitor(): void {
  if (poll === null) return;
  clearInterval(poll);
  poll = null;
}
