/**
 * This device's session was revoked — or was it replaced?
 *
 * Something that watches sessions (a socket close, a 401 sweep) can tell you
 * that the credential this device opened with is gone. That is NOT the same as
 * "this person is signed out", and treating it as such signs people out of
 * work they are in the middle of.
 *
 * better-auth replaces the session outright when two-factor is switched on or
 * off: a new row and a new cookie, the old row deleted. A socket opened with
 * the old one is correctly closed as revoked — but the device is still signed
 * in, and in a browser every other tab shares the new cookie, so signing out
 * here would end the NEW session too.
 *
 * So: ask first, and only a clean "no session" signs out. A check that throws
 * signs out as before, because the server has already said revoked.
 *
 * Dependency-injected so the decision can be tested without a network.
 */

export type SessionRevokedNotice = { pending: number };

export type SessionRevokedDeps = {
  /** How much unsent work this device is holding, read BEFORE anything is
   *  touched — it is what the login screen says out loud, and every later
   *  step can fail. */
  pendingCount?: () => Promise<number>;
  signOut: () => Promise<unknown>;
  clearToken?: () => Promise<void>;
  notify: (notice: SessionRevokedNotice) => void;
  redirect: () => void;
  /** Whether the credential this device holds NOW still has a live session.
   *  Must ask with the cookie cache DISABLED, or it answers from the session
   *  that was just replaced. */
  stillSignedIn?: () => Promise<boolean>;
  /** Called instead of signing out when the session turned out to be live —
   *  rebuild whatever latched onto the closed connection. */
  resume?: () => void;
};

/** Handed to the login screen so it can explain why the person is looking at
 *  it. Module state rather than a query parameter: a reason in a URL is one a
 *  bookmark can resurrect months later. */
let notice: SessionRevokedNotice | null = null;

export const consumeSessionRevokedNotice = (): SessionRevokedNotice | null => {
  const current = notice;
  notice = null;
  return current;
};

let running: Promise<void> | null = null;

const run = async (deps: SessionRevokedDeps): Promise<void> => {
  if (deps.stillSignedIn && deps.resume) {
    const live = await deps.stillSignedIn().catch(() => false);
    if (live) {
      deps.resume();
      return;
    }
  }

  let pending = 0;
  try {
    pending = (await deps.pendingCount?.()) ?? 0;
  } catch {
    // Unreadable local state must not stop the user being signed out.
    pending = 0;
  }
  try {
    await deps.signOut();
  } catch {
    // Expected: the session this would end is the one that no longer exists.
  }
  try {
    await deps.clearToken?.();
  } catch {
    // Also expected to be harmless, and already done in the common case.
  }

  notice = { pending };
  deps.notify({ pending });
  deps.redirect();
};

/** Collapses concurrent reports of the same revocation into one run. */
export const handleSessionRevoked = (deps: SessionRevokedDeps): Promise<void> => {
  running ??= run(deps).finally(() => {
    running = null;
  });
  return running;
};

export const __resetSessionRevokedForTests = (): void => {
  notice = null;
  running = null;
};
