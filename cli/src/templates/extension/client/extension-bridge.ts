/**
 * The web app's half of the web app <-> browser extension bridge.
 *
 * The extension has no host permissions and no `cookies` permission, so
 * it cannot read this app's session cookie. Instead the PAGE tells the
 * extension who is signed in (`sync`), and the extension answers with
 * what the page should do about it. The protocol and the reasons for
 * its shape are `@starter/shared/extension-bridge`; this module is only
 * the page's decisions, with every effect injected so the tests drive
 * it without Chrome, a server or React.
 *
 * What the page does with a reply, and nothing else:
 *
 *  - `approve-device`: the extension started a device authorization for
 *    itself and wants this page's session to approve it. The page
 *    checks the signed-in user is still the one it described, approves
 *    with its own cookie, and tells the extension how that went. The
 *    extension then fetches its OWN token. The code is never shown and
 *    never taken from anywhere but a reply of a pinned extension id —
 *    a `?user_code=` in the URL does not say which client it belongs
 *    to, so the reply's sender is the trust anchor.
 *  - `sign-out-web`: the extension was signed out on purpose after this
 *    session began. The page signs out through the app's own
 *    `signOut()`.
 *  - `none`: nothing.
 *
 * Everything unrecognised is ignored — an extension that is missing,
 * older, newer or somebody else's is indistinguishable from "no
 * extension".
 */
import {
  EXTENSION_BRIDGE_SYNC_MIN_INTERVAL_MS,
  decodeExtensionBridgeReply,
  extensionBridgeDeviceApprovedRequest,
  extensionBridgeSyncRequest,
  normalizeExtensionBridgeUserCode,
  type ExtensionBridgeSyncAction,
} from "@starter/shared/extension-bridge";

/** The page's signed-in session, as the bridge describes it. */
export type BridgeWebSession = { userId: string; createdAt: number } | null;

/**
 * The session lookup as the page sees it. Only `resolved` is ever sent:
 * a pending or failed lookup (offline, a server blip) is not a
 * statement that nobody is signed in, and the extension ACTS on that
 * statement by signing itself out.
 */
export type BridgeSessionState =
  | { status: "pending" }
  | { status: "error" }
  | { status: "resolved"; session: BridgeWebSession };

/** What happened with one extension id during one exchange. */
export type ExtensionSyncOutcome =
  /** No decodable reply: not installed, not listening, or not ours. */
  | "no-reply"
  /** The extension cannot read this protocol version. */
  | "unsupported"
  /** The extension answered `none`. */
  | "nothing-to-do"
  /** The page approved the extension's code and said so. */
  | "approved"
  /** Approval failed (or the signed-in user changed first), and the page said so. */
  | "approve-failed"
  /** The code was unusable or already expired; nothing was sent back. */
  | "approve-dropped"
  /** The page signed out, as the extension asked. */
  | "signed-out-web"
  /** The extension asked for a sign-out this session does not qualify for. */
  | "sign-out-refused";

export type ExtensionSyncDeps = {
  /** Validated extension ids, messaged one after another. */
  ids: readonly string[];
  /** The page's absolute API origin. */
  apiOrigin: string;
  /** The session this exchange describes. */
  session: BridgeWebSession;
  /**
   * The session right now. Read again before acting on a reply, because
   * a reply can arrive after the person signed out or switched
   * accounts.
   */
  currentSession: () => BridgeWebSession;
  /** Resolves the raw reply, `undefined` for none. Never rejects. */
  send: (id: string, message: unknown) => Promise<unknown>;
  /** Approve a normalised user code with this page's session. */
  approve: (userCode: string) => Promise<boolean>;
  /** The app's `signOut()`. */
  signOutWeb: () => Promise<void>;
  now: () => number;
};

/** Same person (or nobody). A refreshed session row of the same user still matches. */
const sameUser = (a: BridgeWebSession, b: BridgeWebSession): boolean =>
  (a?.userId ?? null) === (b?.userId ?? null);

const handleAction = async (
  id: string,
  action: ExtensionBridgeSyncAction,
  deps: ExtensionSyncDeps,
): Promise<ExtensionSyncOutcome> => {
  if (action.type === "none") return "nothing-to-do";

  if (action.type === "sign-out-web") {
    const current = deps.currentSession();
    // Only the session that was described, and only if it began before
    // the extension signed out: a sign-in made after that is a newer
    // decision, and signing it out would make signing back in on the
    // web impossible.
    if (
      current === null ||
      deps.session === null ||
      current.userId !== deps.session.userId ||
      !(current.createdAt < action.at)
    ) {
      return "sign-out-refused";
    }
    await deps.signOutWeb();
    return "signed-out-web";
  }

  // approve-device
  const userCode = normalizeExtensionBridgeUserCode(action.userCode);
  if (userCode === null || action.expiresAt < deps.now()) return "approve-dropped";

  const current = deps.currentSession();
  const stillSame =
    deps.session !== null && current !== null && current.userId === deps.session.userId;
  const approved = stillSame ? await deps.approve(userCode).catch(() => false) : false;

  // The reply is read for nothing but well-formedness: the extension
  // finishes (or retries) on its own, and the page shows nothing either
  // way.
  const reply = await deps.send(
    id,
    extensionBridgeDeviceApprovedRequest(
      deps.apiOrigin,
      action.requestId,
      approved ? "approved" : "failed",
    ),
  );
  decodeExtensionBridgeReply(reply);
  return approved ? "approved" : "approve-failed";
};

/**
 * One exchange: describe the session to every extension id and act on
 * each reply. Ids are handled in turn, never in parallel, so a machine
 * with both the unpacked and the store build installed approves one
 * code at a time. Stops after a sign-out: the session it described is
 * gone, and the sign-out produces a fresh exchange of its own.
 */
export const syncWithExtensions = async (
  deps: ExtensionSyncDeps,
): Promise<ExtensionSyncOutcome[]> => {
  const request = extensionBridgeSyncRequest(deps.apiOrigin, {
    userId: deps.session?.userId ?? null,
    sessionCreatedAt: deps.session?.createdAt ?? null,
  });
  const outcomes: ExtensionSyncOutcome[] = [];
  for (const id of deps.ids) {
    // Between ids the person may have signed out or switched: what was
    // about to be described is no longer true, and the next exchange
    // says what is.
    if (!sameUser(deps.session, deps.currentSession())) break;

    const decoded = decodeExtensionBridgeReply(await deps.send(id, request));
    if (!decoded.ok) {
      outcomes.push("no-reply");
      continue;
    }
    const reply = decoded.message;
    if (reply.kind === "unsupported") {
      outcomes.push("unsupported");
      continue;
    }
    if (reply.kind !== "sync-result") {
      outcomes.push("no-reply");
      continue;
    }
    const outcome = await handleAction(id, reply.action, deps);
    outcomes.push(outcome);
    if (outcome === "signed-out-web") break;
  }
  return outcomes;
};

// -- Controller: triggers, throttling, coalescing ---------------------

export type ExtensionBridgeHost = {
  /**
   * Whether the bridge may run at all, asked before every exchange: the
   * web app only (never a native shell), over http(s), with a
   * `chrome.runtime` that can message an extension.
   */
  enabled: () => boolean;
  ids: () => readonly string[];
  apiOrigin: () => string;
  send: (id: string, message: unknown) => Promise<unknown>;
  approve: (userCode: string) => Promise<boolean>;
  signOutWeb: () => Promise<void>;
  now: () => number;
  /** Called with each finished exchange's outcomes. */
  onOutcomes?: (outcomes: ExtensionSyncOutcome[]) => void;
};

export type ExtensionBridgeController = {
  /** The session lookup changed. A new user (or none) is sent at once. */
  update: (state: BridgeSessionState) => void;
  /** Focus or visibility: sent again, at most every {@link EXTENSION_BRIDGE_SYNC_MIN_INTERVAL_MS}. */
  wake: () => void;
  /** Resolves once no exchange is running or queued. For tests. */
  idle: () => Promise<void>;
  dispose: () => void;
};

/** `undefined`: nothing sent yet. `null`: signed out was sent. */
type SentUser = string | null | undefined;

export const createExtensionBridgeController = (
  host: ExtensionBridgeHost,
): ExtensionBridgeController => {
  let latest: BridgeSessionState = { status: "pending" };
  let sentUser: SentUser = undefined;
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let running: Promise<void> | null = null;
  let queued = false;
  let disposed = false;

  const resolvedSession = (): BridgeWebSession | undefined =>
    latest.status === "resolved" ? latest.session : undefined;

  const run = (): void => {
    if (disposed) return;
    if (running !== null) {
      // One exchange at a time. Whatever changed meanwhile is sent once
      // the running exchange ends, described as it is THEN — never a
      // backlog.
      queued = true;
      return;
    }
    const session = resolvedSession();
    if (session === undefined || !host.enabled()) return;
    const ids = host.ids();
    if (ids.length === 0) return;

    sentUser = session?.userId ?? null;
    lastSentAt = host.now();
    running = syncWithExtensions({
      ids,
      apiOrigin: host.apiOrigin(),
      session,
      currentSession: () => resolvedSession() ?? null,
      send: host.send,
      approve: host.approve,
      signOutWeb: host.signOutWeb,
      now: host.now,
    })
      .then((outcomes) => {
        if (!disposed) host.onOutcomes?.(outcomes);
      })
      .catch(() => undefined)
      .finally(() => {
        running = null;
        if (queued) {
          queued = false;
          const now = resolvedSession();
          // Re-send only when what the extension last heard is out of date.
          if (now !== undefined && (now?.userId ?? null) !== sentUser) run();
        }
      });
  };

  return {
    update: (state) => {
      latest = state;
      const session = resolvedSession();
      if (session === undefined) return;
      if ((session?.userId ?? null) !== sentUser) run();
    },
    wake: () => {
      if (resolvedSession() === undefined) return;
      if (host.now() - lastSentAt < EXTENSION_BRIDGE_SYNC_MIN_INTERVAL_MS) return;
      run();
    },
    idle: async () => {
      while (running !== null) await running;
    },
    dispose: () => {
      disposed = true;
    },
  };
};
