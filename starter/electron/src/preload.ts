/*
 * The preload: it builds a `DesktopBridge` and exposes it to the page as
 * `window.electronAPI` through `contextBridge`.
 *
 * The object's type is `DesktopBridge` from
 * `packages/shared/src/desktop-bridge.ts`, which is also the type
 * `packages/client/src/types/electron.d.ts` declares on `Window`. One type on
 * both sides means a method this file stops exposing is a type error in the
 * page that calls it, rather than an "undefined is not a function" in a
 * shipped desktop build.
 *
 * This script runs SANDBOXED (`sandbox: true`, security-model.ts). There is no
 * `require`, no Node built-in and no `app` here — only `electron`'s renderer
 * half and whatever esbuild bundles in, which is why the shared types are
 * imported from source and nothing else is. The app's version therefore
 * arrives as a command-line argument (app-version.ts).
 *
 * Every method below is one `ipcRenderer.invoke`, and every main → renderer
 * push is an `ipcRenderer.on` subscription that returns its own unsubscribe.
 * A caller that drops the returned function leaks a listener, so each
 * subscriber owns exactly the one it made.
 *
 * Exposing the bridge is not the trust decision. A preload is attached per
 * window, not per URL, so a window that ever showed another page still holds a
 * working bridge. The main process checks the calling frame's URL on every
 * handler (ipc.ts).
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import {
  DESKTOP_IPC,
  type DesktopBridge,
  type DesktopCommand,
  type DesktopIdlePayload,
  type DesktopIpcChannel,
  type DesktopSettingsSnapshot,
  type DesktopUpdateSnapshot,
} from "../../packages/shared/src/desktop-bridge.ts";
import { appVersionFrom } from "./app-version.ts";

/**
 * One subscription, one unsubscribe.
 *
 * The listener is wrapped rather than passed to `ipcRenderer.on` directly, so
 * the renderer never receives the `IpcRendererEvent` — it carries `sender`,
 * which would hand the page an object with `send` on it across the context
 * bridge.
 */
function subscribe<Payload>(
  channel: DesktopIpcChannel,
  listener: (payload: Payload) => void,
): () => void {
  const handler = (_event: IpcRendererEvent, payload: Payload): void => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const bridge: DesktopBridge = {
  isDesktop: true,
  platform: process.platform,
  appVersion: appVersionFrom(process.argv),

  quit: () => ipcRenderer.invoke(DESKTOP_IPC.quit),
  openExternal: (url) => ipcRenderer.invoke(DESKTOP_IPC.openExternal, url),

  getIdleState: () => ipcRenderer.invoke(DESKTOP_IPC.getIdle),
  onIdleState: (listener) => subscribe<DesktopIdlePayload>(DESKTOP_IPC.idleState, listener),

  secureStore: {
    getToken: () => ipcRenderer.invoke(DESKTOP_IPC.tokenGet),
    setToken: (token) => ipcRenderer.invoke(DESKTOP_IPC.tokenSet, token),
    deleteToken: () => ipcRenderer.invoke(DESKTOP_IPC.tokenDelete),
    status: () => ipcRenderer.invoke(DESKTOP_IPC.tokenStatus),
  },

  desktop: {
    publishTrayState: (state) => ipcRenderer.invoke(DESKTOP_IPC.desktopPublishState, state),
    onCommand: (listener) => subscribe<DesktopCommand>(DESKTOP_IPC.desktopCommand, listener),
    getSettings: () => ipcRenderer.invoke(DESKTOP_IPC.desktopSettingsGet),
    updateSettings: (patch) => ipcRenderer.invoke(DESKTOP_IPC.desktopSettingsUpdate, patch),
    onSettingsChanged: (listener) =>
      subscribe<DesktopSettingsSnapshot>(DESKTOP_IPC.desktopSettingsChanged, listener),
    suspendShortcuts: (suspended) =>
      ipcRenderer.invoke(DESKTOP_IPC.desktopSuspendShortcuts, suspended),
    showWindow: () => ipcRenderer.invoke(DESKTOP_IPC.desktopShowWindow),
    notify: (notice) => ipcRenderer.invoke(DESKTOP_IPC.desktopNotify, notice),

    updates: {
      getStatus: () => ipcRenderer.invoke(DESKTOP_IPC.updateGetStatus),
      onStatus: (listener) =>
        subscribe<DesktopUpdateSnapshot>(DESKTOP_IPC.updateStatusChanged, listener),
      check: () => ipcRenderer.invoke(DESKTOP_IPC.updateCheck),
      restart: () => ipcRenderer.invoke(DESKTOP_IPC.updateRestart),
    },
  },
};

contextBridge.exposeInMainWorld("electronAPI", bridge);
