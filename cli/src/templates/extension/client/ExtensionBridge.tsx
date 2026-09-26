"use client";

import * as React from "react";

import { signOut, useSession } from "@/lib/auth-client";
import { approveDeviceCode } from "@/lib/device-approve";
import {
  createExtensionBridgeController,
  type BridgeSessionState,
  type ExtensionBridgeController,
} from "@/lib/extension-bridge";
import {
  apiOrigin,
  chromeRuntime,
  extensionIds,
  sendToExtension,
} from "@/lib/extension-bridge-transport";

type SessionLike = {
  data: { user?: { id?: unknown } | null; session?: { createdAt?: unknown } | null } | null;
  isPending: boolean;
  error: unknown;
};

/** better-auth's session hook, reduced to what the bridge may send. */
export const bridgeSessionState = (result: SessionLike): BridgeSessionState => {
  if (result.isPending) return { status: "pending" };
  if (result.error !== null && result.error !== undefined) return { status: "error" };
  const userId = result.data?.user?.id;
  if (typeof userId !== "string" || userId === "") {
    return { status: "resolved", session: null };
  }
  const raw = result.data?.session?.createdAt;
  const createdAt =
    raw instanceof Date || typeof raw === "string" || typeof raw === "number"
      ? new Date(raw).getTime()
      : Number.NaN;
  // A session with no readable start cannot be compared against an
  // extension sign-out, so it is not described at all rather than
  // described wrongly.
  if (!Number.isFinite(createdAt)) return { status: "error" };
  return { status: "resolved", session: { userId, createdAt } };
};

/**
 * Whether this document is the tab's top-level one. A frame — which any
 * site can make of the web app — gets no session cookie cross-site, so
 * it would describe a signed-out web app and sign a linked extension
 * out. The extension refuses frames too; this is the same rule on the
 * other end, because neither end can see what the other checked.
 */
export const isTopLevelDocument = (win: Window): boolean => {
  try {
    return win.top === win.self;
  } catch {
    // Reading a cross-origin `top` can throw: that is a frame.
    return false;
  }
};

/** A native shell (Capacitor, an Electron file:// window) is not the web app. */
const isNativeShell = (): boolean => {
  const scope = window as unknown as {
    Capacitor?: { isNativePlatform?: () => boolean };
    electron?: unknown;
  };
  if (scope.electron !== undefined) return true;
  try {
    return scope.Capacitor?.isNativePlatform?.() === true;
  } catch {
    return false;
  }
};

/** The top-level web app over http(s), in a browser that can message an extension. */
const bridgeAvailable = (): boolean =>
  typeof window !== "undefined" &&
  !isNativeShell() &&
  isTopLevelDocument(window) &&
  /^https?:$/.test(window.location.protocol) &&
  chromeRuntime() !== null;

/**
 * Keeps the browser extension signed in and out with this web app — see
 * `lib/extension-bridge.ts`.
 *
 * Renders nothing and decides everything in effects: the prerendered
 * HTML is the same on every host, and nothing runs before hydration.
 * Inert in a native shell, in a frame, and in every browser where no
 * extension connects to this origin. Mount it once.
 */
export function ExtensionBridge(): null {
  const session = useSession() as unknown as SessionLike;
  const controllerRef = React.useRef<ExtensionBridgeController | null>(null);

  React.useEffect(() => {
    if (!bridgeAvailable()) return;
    const ids = extensionIds();
    if (ids.length === 0) return;

    const controller = createExtensionBridgeController({
      enabled: bridgeAvailable,
      ids: () => ids,
      apiOrigin,
      send: (id, message) => sendToExtension(id, message),
      approve: async (userCode) =>
        (await approveDeviceCode(userCode, { alreadyApprovedIsOk: true })).ok,
      signOutWeb: async () => {
        await signOut();
      },
      now: () => Date.now(),
      onOutcomes:
        process.env.NODE_ENV === "development"
          ? (outcomes) => console.debug("[extension-bridge]", outcomes)
          : undefined,
    });
    controllerRef.current = controller;

    const onVisibility = (): void => {
      if (document.visibilityState === "visible") controller.wake();
    };
    const onFocus = (): void => controller.wake();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  const state = bridgeSessionState(session);
  const stateKey =
    state.status === "resolved"
      ? `resolved:${state.session?.userId ?? ""}:${state.session?.createdAt ?? ""}`
      : state.status;

  React.useEffect(() => {
    // Declared after the setup effect, so on mount the controller
    // exists by the time this runs. Keyed on a string, so a re-render
    // with an equal session is not a new update.
    controllerRef.current?.update(state);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateKey]);

  return null;
}
