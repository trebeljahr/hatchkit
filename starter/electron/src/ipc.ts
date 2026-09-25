/*
 * Every `ipcMain.handle` in this app goes through `handle()` here, which
 * refuses a call from any frame that is not the app's own document (trust.ts).
 *
 * Registering handlers directly on `ipcMain` is the quiet failure this
 * prevents: the preload is attached per window, so a window that ever showed
 * another page still holds a working bridge, and every handler is reachable
 * from it. One helper means the check cannot be forgotten on the handler
 * somebody adds next year.
 *
 * `handle()` takes a `DesktopIpcChannel`, so a handler registered under a name
 * the preload does not invoke is a type error rather than a channel that never
 * fires.
 */

import { ipcMain, type IpcMainInvokeEvent } from "electron";

import type { DesktopIpcChannel } from "../../packages/shared/src/desktop-bridge.ts";
import { isTrustedSenderUrl } from "./trust.ts";

export class UntrustedSenderError extends Error {
  constructor(channel: string, url: string | null) {
    super(`Refused ${channel} from ${url ?? "a detached frame"}`);
    this.name = "UntrustedSenderError";
  }
}

let devUrl: string | null = null;

/** Called once at startup, with the dev URL in an unpackaged run and null in a
 *  packaged one. */
export function configureIpcTrust(options: { devUrl: string | null }): void {
  devUrl = options.devUrl;
}

/** The dev URL the guard is currently using. Exported for the security guard
 *  and the tests, so neither re-derives it. */
export function ipcTrustDevUrl(): string | null {
  return devUrl;
}

export function senderUrl(event: IpcMainInvokeEvent): string | null {
  // `senderFrame` is null once the frame has navigated away or been destroyed.
  return event.senderFrame?.url ?? null;
}

export function handle<Args extends unknown[], Result>(
  channel: DesktopIpcChannel,
  handler: (event: IpcMainInvokeEvent, ...args: Args) => Result | Promise<Result>,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    const url = senderUrl(event);
    if (!isTrustedSenderUrl(url, devUrl)) {
      console.warn(`[ipc] ${channel} refused: sender ${url ?? "(no frame)"}`);
      throw new UntrustedSenderError(channel, url);
    }
    return handler(event, ...(args as Args));
  });
}
