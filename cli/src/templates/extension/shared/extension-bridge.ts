/**
 * The web app <-> browser extension bridge: the protocol both ends speak.
 *
 * The extension ships with no host permissions and no `cookies`
 * permission, so it cannot read the web app's session cookie and act as
 * that session. It lists the first-party web origins under
 * `externally_connectable` instead, and the web app — after mount, on
 * the web only — messages the extension by its pinned id
 * (`chrome.runtime.sendMessage(id, request)`). The extension never
 * initiates: a page has no listener it could reach without a content
 * script, so every exchange is one request from the page and one reply.
 *
 * Both ends treat every value that crosses the bridge as untrusted
 * input and run it through the decoders here. A decoder never throws;
 * anything it does not recognise is refused, never guessed at.
 *
 * What the bridge carries, and nothing more:
 *  - `sync`: the page's session state (who is signed in, since when,
 *    against which API origin). The extension answers with what the
 *    page should do: nothing, approve a device authorization it
 *    started, or sign out because the extension was signed out on
 *    purpose.
 *  - `device-approved`: the page approved (or failed to approve) that
 *    device authorization, which wakes the worker to fetch its own
 *    token.
 *
 * No credential ever crosses it. The extension's token comes from the
 * server's `/device/token`; the only secret-shaped value in a reply is
 * the short-lived user code, which only a session of the matching user
 * can approve.
 */

/** Marks a message as ours, so another sender's message is not misread as one. */
export const EXTENSION_BRIDGE_CHANNEL = "__HATCHKIT_STORAGE_PREFIX__.extension-bridge";

/**
 * The protocol version this build writes. Bump on any incompatible
 * change.
 *
 * Deliberately NOT the API level and not the release version: the web
 * app deploys when it deploys and the store update lands days later,
 * so the two ends of this bridge are almost never the same build. An
 * unknown `v` is answered `unsupported` rather than guessed at.
 */
export const EXTENSION_BRIDGE_VERSION = __HATCHKIT_BRIDGE_VERSION__;

/** Every version this build can read. */
export const EXTENSION_BRIDGE_SUPPORTED_VERSIONS: readonly number[] = [
  __HATCHKIT_BRIDGE_VERSION__,
];

/**
 * The shortest gap between two `sync` requests the page sends on focus
 * or visibility. A session TRANSITION (sign-in, sign-out, account
 * switch) is sent at once regardless.
 */
export const EXTENSION_BRIDGE_SYNC_MIN_INTERVAL_MS = 30_000;

/**
 * How long an explicit extension sign-out keeps asking the web app to
 * sign out too. Seven days is the browser session lifetime: no web
 * session that predates the sign-out can still be alive after it.
 */
export const EXTENSION_SIGN_OUT_MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** How long the extension waits before starting another device
 *  authorization after one failed. Caps what a misbehaving page can
 *  make the extension ask the server for. */
export const EXTENSION_BRIDGE_DEVICE_RETRY_MS = 60_000;

/** The web app origins a production extension build accepts messages from. */
export const EXTENSION_BRIDGE_PRODUCTION_WEB_ORIGINS: readonly string[] = [
  "__HATCHKIT_WEB_ORIGIN_PROD__",
];

/**
 * The hosts a development build accepts messages from, on any port: a
 * dev server or a worktree picks its own client port, and a Chrome
 * match pattern without a port matches every port.
 */
export const EXTENSION_BRIDGE_DEVELOPMENT_WEB_HOSTS: readonly string[] = [
  "localhost",
  "127.0.0.1",
];

/**
 * Which web origins a build's bridge accepts.
 *
 * `none` is the Firefox build: Gecko implements neither
 * `externally_connectable` for web pages nor `runtime.connect` from
 * one, so there is no bridge to have. It is a target rather than an
 * absent one so the checks below can refuse every origin explicitly — a
 * build with no listed origins must not fall through to the
 * development list.
 */
export type ExtensionBridgeTarget = "development" | "production" | "none";

/** The `externally_connectable.matches` a build target declares. */
export const extensionBridgeMatchPatterns = (target: ExtensionBridgeTarget): string[] => {
  if (target === "none") return [];
  return target === "production"
    ? EXTENSION_BRIDGE_PRODUCTION_WEB_ORIGINS.map((origin) => `${origin}/*`)
    : EXTENSION_BRIDGE_DEVELOPMENT_WEB_HOSTS.map((host) => `http://${host}/*`);
};

/**
 * True when `origin` (a `MessageSender.origin`) may drive the extension
 * of this build target. Chrome already filters by
 * `externally_connectable`; this is the second, explicit check, so a
 * manifest typo cannot widen trust.
 */
export const isAllowedExtensionBridgeOrigin = (
  origin: unknown,
  target: ExtensionBridgeTarget,
): boolean => {
  if (target === "none") return false;
  if (typeof origin !== "string" || origin.length > MAX_ORIGIN_LENGTH) return false;
  const parsed = parseOrigin(origin);
  if (parsed === null || parsed.origin !== origin) return false;
  if (target === "production") {
    return EXTENSION_BRIDGE_PRODUCTION_WEB_ORIGINS.includes(parsed.origin);
  }
  return (
    parsed.protocol === "http:" &&
    EXTENSION_BRIDGE_DEVELOPMENT_WEB_HOSTS.includes(parsed.hostname)
  );
};

/**
 * The extension-scheme origins that are a fresh random UUID per
 * install — Firefox's `moz-extension://<uuid>`, and Safari's
 * `safari-web-extension://<uuid>` for a later port.
 *
 * No trust list can hold one: nobody knows it before the install
 * exists and it differs for every person. The server therefore trusts
 * the SHAPE, narrowed by the absence of a session cookie and by never
 * answering such an origin with credentialed CORS
 * (`packages/server/src/auth/extension-origins.ts`).
 *
 * `chrome-extension:` is deliberately not in here: those ids are
 * derived from a pinned key, so a Chromium extension is trusted by its
 * exact origin or not at all.
 */
const RANDOM_EXTENSION_ORIGIN =
  /^(moz-extension|safari-web-extension):\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isRandomExtensionOrigin = (origin: unknown): boolean =>
  typeof origin === "string" &&
  origin.length <= MAX_ORIGIN_LENGTH &&
  RANDOM_EXTENSION_ORIGIN.test(origin.toLowerCase());

// -- Messages ---------------------------------------------------------

/** The page's session, as the page's own auth client resolved it. */
export type ExtensionBridgeWebSession = {
  /** The signed-in user's id, or `null` when the server said nobody is signed in. */
  userId: string | null;
  /** When that session was created (epoch ms); `null` exactly when `userId` is. */
  sessionCreatedAt: number | null;
};

type BridgeEnvelope = {
  channel: typeof EXTENSION_BRIDGE_CHANNEL;
  v: number;
};

/**
 * Sent on mount (once the session has RESOLVED), on every session
 * transition and on focus/visibility at most every
 * {@link EXTENSION_BRIDGE_SYNC_MIN_INTERVAL_MS}. Never sent while the
 * session is pending or its lookup failed: `userId: null` is a
 * statement that nobody is signed in, and the extension acts on it.
 */
export type ExtensionBridgeSyncRequest = BridgeEnvelope & {
  kind: "sync";
  /** The page's absolute API origin. */
  apiOrigin: string;
  web: ExtensionBridgeWebSession;
};

/** Sent after the page tried to approve the code a `sync` reply handed it. */
export type ExtensionBridgeDeviceApprovedRequest = BridgeEnvelope & {
  kind: "device-approved";
  apiOrigin: string;
  /** The `requestId` from the `approve-device` action. */
  requestId: string;
  /** `failed` lets the extension drop the pending authorization at once. */
  outcome: "approved" | "failed";
};

export type ExtensionBridgeRequest =
  | ExtensionBridgeSyncRequest
  | ExtensionBridgeDeviceApprovedRequest;

/** Why the extension did nothing. Informational: the page acts on none of them. */
export const EXTENSION_BRIDGE_IGNORE_REASONS = [
  /** Already signed in, through the web app, as that user. */
  "linked",
  /** Signed out, and so is the page. */
  "signed-out",
  /** The extension points at a different server than the page. */
  "other-server",
  /** The extension holds a session somebody signed in to on purpose. */
  "explicit-session",
  /** A device authorization failed recently; the extension waits before another. */
  "backing-off",
  /** The server could not be reached, or refused to start a device authorization. */
  "server-unavailable",
  /** The sender's origin is not the web app of the server the extension points at. */
  "origin-mismatch",
  /**
   * The extension was signed out on purpose after this web session
   * began, and nobody has signed it in since: the page's session is not
   * linked again.
   */
  "explicit-sign-out",
] as const;

export type ExtensionBridgeIgnoreReason = (typeof EXTENSION_BRIDGE_IGNORE_REASONS)[number];

export type ExtensionBridgeSyncAction =
  | { type: "none"; reason: ExtensionBridgeIgnoreReason }
  | {
      /** Approve this code with the page's own session, then send `device-approved`. */
      type: "approve-device";
      requestId: string;
      userCode: string;
      /** Epoch ms after which the code is dead. */
      expiresAt: number;
    }
  | {
      /** The extension was signed out on purpose after this page's session began. */
      type: "sign-out-web";
      /** When the extension signed out (epoch ms). */
      at: number;
    };

export type ExtensionBridgeSyncReply = BridgeEnvelope & {
  kind: "sync-result";
  action: ExtensionBridgeSyncAction;
};

export const EXTENSION_BRIDGE_DEVICE_STATUSES = [
  /** The extension fetched its own token and is signed in. */
  "signed-in",
  /** The server has not seen the approval yet; the extension keeps trying. */
  "pending",
  /** Denied, a different user approved it, or the request id is unknown. */
  "failed",
  /** The code expired before it was approved. */
  "expired",
] as const;

export type ExtensionBridgeDeviceStatus = (typeof EXTENSION_BRIDGE_DEVICE_STATUSES)[number];

export type ExtensionBridgeDeviceReply = BridgeEnvelope & {
  kind: "device-result";
  status: ExtensionBridgeDeviceStatus;
};

/** The answer to a request whose version this extension cannot read. */
export type ExtensionBridgeUnsupportedReply = BridgeEnvelope & {
  kind: "unsupported";
  supported: number[];
};

export type ExtensionBridgeReply =
  | ExtensionBridgeSyncReply
  | ExtensionBridgeDeviceReply
  | ExtensionBridgeUnsupportedReply;

// -- Builders ---------------------------------------------------------

const envelope = (): BridgeEnvelope => ({
  channel: EXTENSION_BRIDGE_CHANNEL,
  v: EXTENSION_BRIDGE_VERSION,
});

export const extensionBridgeSyncRequest = (
  apiOrigin: string,
  web: ExtensionBridgeWebSession,
): ExtensionBridgeSyncRequest => ({ ...envelope(), kind: "sync", apiOrigin, web });

export const extensionBridgeDeviceApprovedRequest = (
  apiOrigin: string,
  requestId: string,
  outcome: "approved" | "failed",
): ExtensionBridgeDeviceApprovedRequest => ({
  ...envelope(),
  kind: "device-approved",
  apiOrigin,
  requestId,
  outcome,
});

export const extensionBridgeSyncReply = (
  action: ExtensionBridgeSyncAction,
): ExtensionBridgeSyncReply => ({ ...envelope(), kind: "sync-result", action });

export const extensionBridgeDeviceReply = (
  status: ExtensionBridgeDeviceStatus,
): ExtensionBridgeDeviceReply => ({ ...envelope(), kind: "device-result", status });

export const extensionBridgeUnsupportedReply = (): ExtensionBridgeUnsupportedReply => ({
  ...envelope(),
  kind: "unsupported",
  supported: [...EXTENSION_BRIDGE_SUPPORTED_VERSIONS],
});

// -- Decoders ---------------------------------------------------------

const MAX_ORIGIN_LENGTH = 2048;
const MAX_USER_ID_LENGTH = 128;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const USER_CODE_PATTERN = /^[A-Z0-9]{4,32}$/;
/** Any C0 control character, or DEL. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export type ExtensionBridgeDecodeProblem =
  /** Not a bridge message at all (wrong channel, not an object). */
  | "not-bridge"
  /** A bridge message of a version this build cannot read. */
  | "unsupported-version"
  /** A bridge message of a readable version whose fields do not check out. */
  | "malformed";

export type ExtensionBridgeDecoded<T> =
  | { ok: true; message: T }
  | { ok: false; problem: ExtensionBridgeDecodeProblem };

/**
 * The WHATWG `URL` every runtime of this module has (browsers, the
 * extension worker, Node). This package compiles against plain ES with
 * no DOM or Node types, so the slice used here is declared locally.
 */
type ParsedUrl = { origin: string; protocol: string; hostname: string };
declare const URL: new (input: string) => ParsedUrl;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseOrigin = (value: string): ParsedUrl | null => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
};

/** An http(s) origin with no path, query, fragment or credentials. */
const isApiOrigin = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ORIGIN_LENGTH) {
    return false;
  }
  const parsed = parseOrigin(value);
  return parsed !== null && parsed.origin === value.replace(/\/+$/, "");
};

const isUserId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= MAX_USER_ID_LENGTH &&
  !CONTROL_CHARACTER.test(value);

const isEpochMs = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const isRequestId = (value: unknown): value is string =>
  typeof value === "string" && REQUEST_ID_PATTERN.test(value);

/**
 * A device user code as the page must send it to `/device/approve`:
 * upper case, dashes removed, 4-32 of `A-Z0-9`. `null` for anything else.
 */
export const normalizeExtensionBridgeUserCode = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length > 64) return null;
  const code = value.replace(/-/g, "").toUpperCase();
  return USER_CODE_PATTERN.test(code) ? code : null;
};

/** Channel and version, shared by both directions. */
const readEnvelope = (
  value: unknown,
):
  | { ok: true; record: Record<string, unknown> }
  | { ok: false; problem: ExtensionBridgeDecodeProblem } => {
  if (!isRecord(value) || value.channel !== EXTENSION_BRIDGE_CHANNEL) {
    return { ok: false, problem: "not-bridge" };
  }
  if (typeof value.v !== "number" || !EXTENSION_BRIDGE_SUPPORTED_VERSIONS.includes(value.v)) {
    return { ok: false, problem: "unsupported-version" };
  }
  return { ok: true, record: value };
};

const readWebSession = (value: unknown): ExtensionBridgeWebSession | null => {
  if (!isRecord(value)) return null;
  if (value.userId === null) {
    return value.sessionCreatedAt === null ? { userId: null, sessionCreatedAt: null } : null;
  }
  if (!isUserId(value.userId) || !isEpochMs(value.sessionCreatedAt)) return null;
  return { userId: value.userId, sessionCreatedAt: value.sessionCreatedAt };
};

/**
 * Decode a request the extension received from a page. Run it on every
 * `runtime.onMessageExternal` message, after the sender's origin passed
 * {@link isAllowedExtensionBridgeOrigin}. The result is a fresh object
 * holding only known fields.
 */
export const decodeExtensionBridgeRequest = (
  value: unknown,
): ExtensionBridgeDecoded<ExtensionBridgeRequest> => {
  const head = readEnvelope(value);
  if (!head.ok) return head;
  const { record } = head;
  const malformed = { ok: false, problem: "malformed" } as const;
  if (!isApiOrigin(record.apiOrigin)) return malformed;
  const apiOrigin = record.apiOrigin.replace(/\/+$/, "");

  if (record.kind === "sync") {
    const web = readWebSession(record.web);
    if (web === null) return malformed;
    return { ok: true, message: extensionBridgeSyncRequest(apiOrigin, web) };
  }
  if (record.kind === "device-approved") {
    if (!isRequestId(record.requestId)) return malformed;
    if (record.outcome !== "approved" && record.outcome !== "failed") return malformed;
    return {
      ok: true,
      message: extensionBridgeDeviceApprovedRequest(apiOrigin, record.requestId, record.outcome),
    };
  }
  return malformed;
};

const readSyncAction = (value: unknown): ExtensionBridgeSyncAction | null => {
  if (!isRecord(value)) return null;
  if (value.type === "none") {
    const reason = EXTENSION_BRIDGE_IGNORE_REASONS.find((known) => known === value.reason);
    return reason === undefined ? null : { type: "none", reason };
  }
  if (value.type === "approve-device") {
    const userCode = normalizeExtensionBridgeUserCode(value.userCode);
    if (userCode === null || !isRequestId(value.requestId) || !isEpochMs(value.expiresAt)) {
      return null;
    }
    return {
      type: "approve-device",
      requestId: value.requestId,
      userCode,
      expiresAt: value.expiresAt,
    };
  }
  if (value.type === "sign-out-web") {
    return isEpochMs(value.at) ? { type: "sign-out-web", at: value.at } : null;
  }
  return null;
};

/**
 * Decode a reply the page received from the extension. `undefined`
 * (Chrome's answer when no listener replied) and everything else
 * unrecognised come back as a refusal; the page then behaves as if no
 * extension were installed.
 */
export const decodeExtensionBridgeReply = (
  value: unknown,
): ExtensionBridgeDecoded<ExtensionBridgeReply> => {
  if (
    isRecord(value) &&
    value.channel === EXTENSION_BRIDGE_CHANNEL &&
    value.kind === "unsupported"
  ) {
    // Readable at ANY version: it is how an older or newer extension says so.
    const supported = Array.isArray(value.supported)
      ? value.supported.filter((v): v is number => typeof v === "number" && Number.isInteger(v))
      : [];
    return {
      ok: true,
      message: {
        channel: EXTENSION_BRIDGE_CHANNEL,
        v: typeof value.v === "number" ? value.v : 0,
        kind: "unsupported",
        supported,
      },
    };
  }
  const head = readEnvelope(value);
  if (!head.ok) return head;
  const { record } = head;
  const malformed = { ok: false, problem: "malformed" } as const;

  if (record.kind === "sync-result") {
    const action = readSyncAction(record.action);
    return action === null ? malformed : { ok: true, message: extensionBridgeSyncReply(action) };
  }
  if (record.kind === "device-result") {
    const status = EXTENSION_BRIDGE_DEVICE_STATUSES.find((known) => known === record.status);
    return status === undefined
      ? malformed
      : { ok: true, message: extensionBridgeDeviceReply(status) };
  }
  return malformed;
};
