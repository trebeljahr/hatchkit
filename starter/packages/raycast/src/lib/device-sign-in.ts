/**
 * Pairing: RFC 8628 against the configured origin, then claim, then flush.
 *
 * ============================================================
 * THE ORDER IS THE WHOLE POINT
 * ============================================================
 *
 * 1. start the authorization and store the credential WITH the origin that
 *    issued it (`auth.ts`);
 * 2. CLAIM every queued row that predates having an account;
 * 3. only then flush.
 *
 * Two and three cannot swap. The flush filter refuses a row it cannot
 * attribute, so the rows pairing exists to rescue — everything the person did
 * before there was an account to stamp them with — are exactly the ones a
 * flush-first order leaves behind, counted as somebody else's and never sent.
 *
 * ============================================================
 * AND IT NEVER OPENS A BROWSER BY ITSELF
 * ============================================================
 *
 * {@link runDeviceSignIn} opens the approval page, and it is only ever reached
 * from an action a person chose. Nothing mounts it. A list that failed to load
 * must not throw an approval page at the browser on the person's behalf — that
 * is hostile, and it happens the moment pairing is wired to an empty state's
 * effect rather than to its action.
 */
import { ApiError } from "../vendor";
import { claimQueuedWork, flushQueue } from "./api";
import {
  type DeviceAuthorization,
  lookUpSessionUser,
  requestDeviceToken,
  startDeviceAuthorization,
} from "./auth-endpoints";
import { saveSession } from "./auth";
import { apiOrigin } from "./preferences";

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

export type PairingProgress =
  | { phase: "starting" }
  /** Show the code; the approval page has been opened with it prefilled. */
  | { phase: "waiting"; userCode: string; verificationUri: string }
  | { phase: "paired"; email: string | null; claimed: number };

export type PairingResult =
  { ok: true; email: string | null; claimed: number } | { ok: false; reason: string };

/**
 * Run one pairing attempt to completion.
 *
 * `openApproval` is injected rather than imported so the caller decides what
 * "open" means — and so nothing in this module can open a browser on its own.
 * The poll honours the server's own interval and expiry; `slow_down` doubles
 * it, which is what the RFC asks for and what stops a server from refusing the
 * exchange outright.
 */
export async function runDeviceSignIn(options: {
  openApproval: (url: string) => void | Promise<void>;
  onProgress?: (progress: PairingProgress) => void;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<PairingResult> {
  const origin = apiOrigin();
  const report = options.onProgress ?? (() => undefined);
  const now = options.now ?? Date.now;
  report({ phase: "starting" });

  let authorization: DeviceAuthorization;
  try {
    authorization = await startDeviceAuthorization(origin);
  } catch (error) {
    return { ok: false, reason: startFailureReason(error, origin) };
  }

  const approvalUrl =
    authorization.verificationUriComplete !== ""
      ? authorization.verificationUriComplete
      : authorization.verificationUri;
  if (isOpenableApprovalUrl(approvalUrl)) {
    await options.openApproval(approvalUrl);
  }
  report({
    phase: "waiting",
    userCode: authorization.userCode,
    verificationUri: approvalUrl,
  });

  const deadline = now() + authorization.expiresInSeconds * 1000;
  let intervalMs = Math.max(authorization.intervalSeconds, 1) * 1000;
  // Read through a function, never a narrowed expression: the value changes
  // under an `await`, and a control-flow narrowing from before one is stale.
  const cancelled = (): boolean => options.signal?.aborted ?? false;

  while (now() < deadline) {
    if (cancelled()) return { ok: false, reason: "Pairing cancelled." };
    await sleep(intervalMs, options.signal);
    if (cancelled()) return { ok: false, reason: "Pairing cancelled." };

    let outcome: Awaited<ReturnType<typeof requestDeviceToken>>;
    try {
      outcome = await requestDeviceToken(origin, authorization.deviceCode);
    } catch (error) {
      return { ok: false, reason: exchangeFailureReason(error) };
    }
    if (outcome.status === "pending") continue;
    if (outcome.status === "slow-down") {
      intervalMs *= 2;
      continue;
    }

    // `/device/token` does not always name the account, and the surface has to
    // be able to say who it paired as.
    const who = await lookUpSessionUser(origin, outcome.session.token);
    await saveSession({
      token: outcome.session.token,
      userId: outcome.session.userId ?? who?.userId ?? null,
      email: who?.email ?? null,
      // The origin that ISSUED it, stored beside it. See auth.ts.
      server: origin,
    });

    const owner = outcome.session.userId ?? who?.userId ?? null;
    // Claim BEFORE the flush — see the module header.
    const claimed = owner === null ? 0 : await claimQueuedWork(owner, origin);
    await flushQueue({ retryHeld: true });

    report({ phase: "paired", email: who?.email ?? null, claimed });
    return { ok: true, email: who?.email ?? null, claimed };
  }

  return { ok: false, reason: "The pairing code expired before it was approved. Try again." };
}

/**
 * The approval page may be an https page, or http on this machine.
 *
 * A server that answers with some other scheme is not handed to the browser:
 * the URL comes from a response, and opening whatever it says is how a
 * compromised or misconfigured server gets a person to click something.
 */
export function isOpenableApprovalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

function startFailureReason(error: unknown, origin: string): string {
  if (error instanceof ApiError) {
    if (error.code === "invalid_client") {
      return `${origin} does not know this client id. The server needs the launcher in its pairing allowlist.`;
    }
    if (error.httpStatus === 404) {
      return `${origin} has no pairing endpoint. It may be older than this extension, or not the server you meant.`;
    }
    return error.message;
  }
  return `Could not reach ${origin}. Check the API Origin preference and that the server is running.`;
}

function exchangeFailureReason(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "access_denied") return "The pairing request was declined.";
    if (error.code === "expired_token") return "The pairing code expired. Try again.";
    return error.message;
  }
  return "Lost contact with the server while waiting for approval. Try again.";
}
