/**
 * The web app <-> extension bridge, the extension's half.
 *
 * The extension holds no host permission and no `cookies` permission,
 * so it cannot read the web app's session cookie. Instead the build's
 * first-party web origins are listed under `externally_connectable`,
 * and the web app — after mount, on the web only — tells the extension
 * who is signed in there (`sync`). The extension answers with what the
 * page should do: nothing, approve a device code the extension just
 * started, or sign out because the extension was signed out on purpose.
 * The protocol and its decoders are `@starter/shared/extension-bridge`.
 *
 * What it preserves from the cookie:
 *  - signing in on the web app signs a signed-out extension in (a
 *    device authorization the page approves with its own session —
 *    never a token over the bridge);
 *  - signing out of the web app signs out an extension that was linked
 *    to it;
 *  - a session somebody signed in to on purpose (password, device
 *    flow) is never displaced by the web app, in either direction;
 *  - signing out of the extension signs that person out of the web app
 *    — on the page's next `sync` rather than at once, and only the same
 *    person (`lib/sign-out-marker.ts`).
 *
 * Every message is untrusted input. It is accepted only from a page
 * (never another extension) whose origin is in THIS BUILD's allowlist
 * AND is the web app of the server the extension points at, and only
 * about that server. A message never changes the server or a setting,
 * and nothing in a reply is a credential.
 */
import {
  decodeExtensionBridgeRequest,
  extensionBridgeDeviceReply,
  extensionBridgeSyncReply,
  extensionBridgeUnsupportedReply,
  isAllowedExtensionBridgeOrigin,
  EXTENSION_BRIDGE_DEVICE_RETRY_MS,
  type ExtensionBridgeDeviceApprovedRequest,
  type ExtensionBridgeIgnoreReason,
  type ExtensionBridgeReply,
  type ExtensionBridgeRequest,
  type ExtensionBridgeSyncRequest,
  type ExtensionBridgeTarget,
} from "@starter/shared/extension-bridge";
import { sameServerOrigin } from "@starter/core";
import { BRIDGE_TARGET, loadServerInfo } from "../lib/config.js";
import {
  clearPendingDeviceAuth,
  isLivePendingDeviceAuth,
  loadDeviceAuthFailedAt,
  loadPendingDeviceAuth,
  noteDeviceAuthFailure,
  savePendingDeviceAuth,
  type PendingDeviceAuth,
} from "../lib/device-auth-store.js";
import {
  clearSignOutMarker,
  isLinkBlocked,
  loadLinkBlock,
  loadSignOutMarker,
  signOutMarkerVerdict,
} from "../lib/sign-out-marker.js";
import { beginDeviceAuthorization, exchangePendingDeviceAuth, serially } from "./device-sign-in.js";
import {
  ensureReady,
  getCachedServerInfo,
  resolveWebUrl,
  signOutLinkedWebSession,
  switchLinkedAccount,
} from "./runtime.js";

/** The parts of `chrome.runtime.MessageSender` the checks read. */
export type BridgeSender = {
  origin?: string;
  id?: string;
  /** 0 for a tab's top-level document. */
  frameId?: number;
  tab?: { id?: number; incognito?: boolean } | null;
};

export type BridgeOptions = {
  /** Gap between the exchanges after `device-approved`. */
  retryDelayMs?: number;
  /** Injectable clock, for the back-off and the marker. */
  now?: () => number;
};

/**
 * The synchronous half: who sent it, and is it a bridge message at all.
 *
 * Three checks, and each one closes a different door:
 *  1. the ORIGIN is in this build's allowlist — Chrome already filtered
 *     by `externally_connectable`, and this is the second, explicit
 *     check, so a manifest typo cannot widen trust;
 *  2. the sender is a PAGE IN A TAB — `sender.id` present means another
 *     extension, which this protocol never talks to;
 *  3. the sender is the tab's TOP-LEVEL document, and not incognito.
 *
 * `reply: undefined` means "say nothing" — a stranger learns nothing,
 * not even that an extension is listening.
 */
export const screenExternalMessage = (
  message: unknown,
  sender: BridgeSender,
  target: ExtensionBridgeTarget = BRIDGE_TARGET,
):
  | { ok: true; request: ExtensionBridgeRequest; origin: string }
  | { ok: false; reply: ExtensionBridgeReply | undefined } => {
  if (!isAllowedExtensionBridgeOrigin(sender.origin, target)) {
    return { ok: false, reply: undefined };
  }
  if (sender.id !== undefined || sender.tab === undefined || sender.tab === null) {
    return { ok: false, reply: undefined };
  }
  // FRAMES NEVER TALK TO THE EXTENSION. Any site can frame the web app,
  // and a cross-site frame gets no SameSite=Lax cookie — so a framed
  // app honestly believes nobody is signed in, and that honest answer
  // would sign a linked extension out. An incognito tab's session is
  // not this browser's either.
  if (sender.frameId !== 0 || sender.tab.incognito === true) {
    return { ok: false, reply: undefined };
  }
  const decoded = decodeExtensionBridgeRequest(message);
  if (!decoded.ok) {
    return {
      ok: false,
      reply:
        decoded.problem === "unsupported-version" ? extensionBridgeUnsupportedReply() : undefined,
    };
  }
  return { ok: true, request: decoded.message, origin: sender.origin as string };
};

/**
 * Whether `sender` is the web app of `webUrl`. A development build also
 * takes `localhost` and `127.0.0.1` as one host, on the same port: the
 * dev server may name either, and a person may type either.
 */
export const isWebAppOrigin = (
  sender: string,
  webUrl: string,
  target: ExtensionBridgeTarget,
): boolean => {
  let a: URL;
  let b: URL;
  try {
    a = new URL(sender);
    b = new URL(webUrl);
  } catch {
    return false;
  }
  if (a.origin === b.origin) return true;
  if (target !== "development") return false;
  const loopback = (host: string): boolean => host === "localhost" || host === "127.0.0.1";
  return a.protocol === b.protocol && a.port === b.port && loopback(a.hostname) && loopback(b.hostname);
};

/** The web app URL of `apiUrl`, from what is known, else from `/api/health`. */
const webUrlOf = async (apiUrl: string): Promise<string | null> => {
  const live = getCachedServerInfo();
  if (live !== null && sameServerOrigin(live.origin, apiUrl) && live.webUrl !== null) {
    return live.webUrl;
  }
  const stored = await loadServerInfo().catch(() => null);
  if (stored !== null && sameServerOrigin(stored.origin, apiUrl) && stored.webUrl !== null) {
    return stored.webUrl;
  }
  return resolveWebUrl();
};

const none = (reason: ExtensionBridgeIgnoreReason): ExtensionBridgeReply =>
  extensionBridgeSyncReply({ type: "none", reason });

const approve = (record: PendingDeviceAuth): ExtensionBridgeReply =>
  extensionBridgeSyncReply({
    type: "approve-device",
    requestId: record.requestId,
    userCode: record.userCode,
    expiresAt: record.expiresAt,
  });

/** Nobody is signed in to the extension, and the page is signed in as `userId`. */
const linkSignedOutExtension = async (
  apiUrl: string,
  userId: string,
  sessionCreatedAt: number | null,
  now: number,
): Promise<ExtensionBridgeReply> => {
  // Signed out here on purpose: a web session from BEFORE that stays
  // unlinked, whoever it belongs to. Only a newer web sign-in, or any
  // sign-in here, links again.
  if (isLinkBlocked(await loadLinkBlock(), apiUrl, sessionCreatedAt)) {
    return none("explicit-sign-out");
  }

  const pending = await loadPendingDeviceAuth();
  if (pending !== null && isLivePendingDeviceAuth(pending, apiUrl, now)) {
    // The popup's own sign-in is under way: do not start a second one.
    if (pending.purpose === "manual") return none("backing-off");
    if (pending.forUserId === userId) {
      // Another tab (or this one, before a lost reply) already has the
      // code. Hand it over again without polling here: the page
      // approves it — an already approved code counts — and its
      // `device-approved` makes the exchange. A poll now would put that
      // exchange inside the server's own polling interval, which
      // answers `slow_down` to every retry.
      return approve(pending);
    }
    await clearPendingDeviceAuth();
  } else if (pending !== null) {
    await clearPendingDeviceAuth();
  }

  const failedAt = await loadDeviceAuthFailedAt();
  if (failedAt !== null && now - failedAt < EXTENSION_BRIDGE_DEVICE_RETRY_MS) {
    return none("backing-off");
  }

  try {
    const { record } = await beginDeviceAuthorization(apiUrl, "web-link", userId, now);
    await savePendingDeviceAuth(record);
    return approve(record);
  } catch {
    await noteDeviceAuthFailure(now);
    return none("server-unavailable");
  }
};

const handleSync = async (
  request: ExtensionBridgeSyncRequest,
  now: number,
): Promise<ExtensionBridgeReply> => {
  const { web } = request;
  let current = await ensureReady();

  const marker = await loadSignOutMarker();
  if (marker !== null) {
    if (signOutMarkerVerdict(marker, current.apiUrl, web, now) === "sign-out-web") {
      return extensionBridgeSyncReply({ type: "sign-out-web", at: marker.at });
    }
    await clearSignOutMarker();
  }

  if (web.userId === null) {
    // The web app is signed out.
    const pending = await loadPendingDeviceAuth();
    if (pending?.purpose === "web-link") await clearPendingDeviceAuth();
    if (current.session === null) return none("signed-out");
    if (current.sessionSource !== "web") return none("explicit-session");
    await signOutLinkedWebSession();
    return none("signed-out");
  }

  if (current.session !== null) {
    // A session somebody chose is never displaced by the web app.
    if (current.sessionSource !== "web") return none("explicit-session");
    if (current.session.userId === web.userId) return none("linked");
    // The web app switched accounts: leave the old one, link the new.
    await switchLinkedAccount();
    current = await ensureReady();
    if (current.session !== null) return none("explicit-session");
  }

  // Signed in on the web, signed out here.
  return linkSignedOutExtension(current.apiUrl, web.userId, web.sessionCreatedAt, now);
};

const handleDeviceApproved = async (
  request: ExtensionBridgeDeviceApprovedRequest,
  retryDelayMs: number,
  now: number,
): Promise<ExtensionBridgeReply> => {
  const current = await ensureReady();
  const record = await loadPendingDeviceAuth();
  if (
    record === null ||
    record.purpose !== "web-link" ||
    record.requestId !== request.requestId ||
    !sameServerOrigin(record.apiOrigin, current.apiUrl)
  ) {
    return extensionBridgeDeviceReply("failed");
  }
  if (request.outcome === "failed") {
    await clearPendingDeviceAuth();
    await noteDeviceAuthFailure(now);
    return extensionBridgeDeviceReply("failed");
  }
  const outcome = await exchangePendingDeviceAuth(record, 3, retryDelayMs);
  return extensionBridgeDeviceReply(outcome);
};

/**
 * Everything after the sender and the shape checked out: the server,
 * the web app's origin, and then the decision — serialised with every
 * other device exchange, so two tabs cannot start two authorizations.
 */
export async function handleBridgeRequest(
  request: ExtensionBridgeRequest,
  origin: string,
  options: BridgeOptions = {},
  target: ExtensionBridgeTarget = BRIDGE_TARGET,
): Promise<ExtensionBridgeReply> {
  const now = options.now ?? Date.now;
  const refuse = (reason: ExtensionBridgeIgnoreReason): ExtensionBridgeReply =>
    request.kind === "sync" ? none(reason) : extensionBridgeDeviceReply("failed");

  const current = await ensureReady();
  // A message never moves the extension to another server.
  if (!sameServerOrigin(request.apiOrigin, current.apiUrl)) return refuse("other-server");

  const webUrl = await webUrlOf(current.apiUrl);
  if (webUrl === null) return refuse("server-unavailable");
  if (!isWebAppOrigin(origin, webUrl, target)) return refuse("origin-mismatch");

  return serially(() =>
    request.kind === "sync"
      ? handleSync(request, now())
      : handleDeviceApproved(request, options.retryDelayMs ?? 1000, now()),
  );
}

/**
 * Register the listener. Called at module scope from `index.ts`, like
 * every other listener: a page's message is an event that wakes a
 * stopped worker.
 *
 * A build with no bridge target registers NOTHING. That is the Firefox
 * build: Gecko has `onMessageExternal` (extensions may message each
 * other) but no `externally_connectable` for web pages, so a listener
 * there could only ever be reached by another add-on — exactly the
 * sender this protocol refuses. Not registering it at all is the
 * narrower statement, and it keeps the "the page drives" rule true on
 * an engine where no page can.
 *
 * Bridge kinds are never accepted on `onMessage` (the popup's channel),
 * and popup messages are never accepted here.
 */
export function registerBridgeListener(target: ExtensionBridgeTarget = BRIDGE_TARGET): void {
  if (target === "none") return;
  chrome.runtime.onMessageExternal.addListener(
    (
      message: unknown,
      sender: chrome.runtime.MessageSender,
      sendResponse: (reply: unknown) => void,
    ) => {
      const screened = screenExternalMessage(message, sender);
      if (!screened.ok) {
        if (screened.reply === undefined) return false;
        sendResponse(screened.reply);
        return false;
      }
      void handleBridgeRequest(screened.request, screened.origin)
        .catch(
          (): ExtensionBridgeReply =>
            screened.request.kind === "sync"
              ? none("server-unavailable")
              : extensionBridgeDeviceReply("failed"),
        )
        .then((reply) => {
          try {
            sendResponse(reply);
          } catch {
            // The page went away before the answer; nobody is left to tell.
          }
        });
      // Keeps the response channel open for the asynchronous reply.
      return true;
    },
  );
}
