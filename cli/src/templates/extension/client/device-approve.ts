/**
 * Approving an RFC 8628 user code with this page's session.
 *
 * better-auth requires the code to be CLAIMED by a signed-in session
 * (`GET /device?user_code=...`) before it accepts an approve. Approving
 * without it fails with `invalid_request`, which reads to a person like
 * a mistyped code — so claim first and report a bad code once.
 *
 * The extension is what calls this, indirectly: it hands the page a
 * user code in a bridge reply, and the page approves it with the cookie
 * session it already has. The extension then fetches its OWN token from
 * the server. No credential crosses the bridge in either direction.
 */
import { authClient } from "@/lib/auth-client";

/** The error shape better-auth's device endpoints answer with. */
export type DeviceAuthError = {
  /** The RFC 8628 code (`invalid_request`, `expired_token`, ...). */
  error?: string;
  error_description?: string;
  message?: string;
};

export type DeviceCodeResult =
  | { ok: true }
  | { ok: false; stage: "claim" | "decide"; error: DeviceAuthError }
  /** No answer at all — the request threw. */
  | { ok: false; stage: "network" };

export type DeviceCodeOptions = {
  /**
   * Treat a code that is already approved as a success. For the bridge
   * only: two tabs of one browser can be handed the same code, and the
   * one that loses the race has still got what it wanted.
   */
  alreadyApprovedIsOk?: boolean;
};

/**
 * better-auth returns `{ data, error }` rather than throwing, and its
 * typings for the device plugin are loose, so the result is read
 * structurally.
 */
type AuthResult = { data?: unknown; error?: DeviceAuthError | null };

const ALREADY_PROCESSED = "Device code already processed";

const claimedStatus = (result: AuthResult): string | null => {
  const data = result.data;
  if (typeof data !== "object" || data === null || !("status" in data)) return null;
  return typeof data.status === "string" ? data.status : null;
};

type DeviceClient = {
  device: ((input: { query: { user_code: string } }) => Promise<AuthResult>) & {
    approve: (input: { userCode: string }) => Promise<AuthResult>;
  };
};

const client = (): DeviceClient => authClient as unknown as DeviceClient;

const claim = async (userCode: string): Promise<AuthResult> =>
  client().device({ query: { user_code: userCode } });

/** Claim `userCode` for this session, then approve it. Never throws. */
export const approveDeviceCode = async (
  userCode: string,
  options: DeviceCodeOptions = {},
): Promise<DeviceCodeResult> => {
  try {
    const claimed = await claim(userCode);
    if (claimed.error) return { ok: false, stage: "claim", error: claimed.error };
    if (options.alreadyApprovedIsOk && claimedStatus(claimed) === "approved") {
      return { ok: true };
    }

    const result = await client().device.approve({ userCode });
    if (!result.error) return { ok: true };

    // Another tab approved between the claim and the approve. Ask once
    // more rather than trusting the message: "already processed" is
    // also what a DENIED code says.
    if (
      options.alreadyApprovedIsOk &&
      result.error.error === "invalid_request" &&
      result.error.error_description === ALREADY_PROCESSED
    ) {
      const again = await claim(userCode);
      if (!again.error && claimedStatus(again) === "approved") return { ok: true };
    }
    return { ok: false, stage: "decide", error: result.error };
  } catch {
    return { ok: false, stage: "network" };
  }
};
