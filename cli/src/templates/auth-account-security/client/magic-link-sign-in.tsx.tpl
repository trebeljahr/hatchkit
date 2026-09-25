"use client";

/**
 * Sign in by following a link sent to the address.
 *
 * **Read this before offering it on a native shell.** The endpoint itself
 * cooperates with a token client: `/magic-link/verify` sets the session and,
 * when the request carries no `callbackURL`, answers with JSON rather than a
 * redirect, so `bearer` emits `set-auth-token` for it. What does not cooperate
 * is the delivery channel — the link is opened by the recipient's mail client
 * in the system browser, which is not this process, so the shell never sees
 * that response. Finishing here needs the shell to register a deep link for
 * the callback, capture the token and call verify itself. Until it does, this
 * component tells a shell user to use the web app instead of leaving them on a
 * screen that will never advance.
 *
 * Signing up this way is disabled on the server, for the same reason as email
 * codes: a link proves someone reads a mailbox, not that they are entitled to
 * an account here.
 */

import * as React from "react";
import { authClient } from "@/lib/auth-client";
import { POST_AUTH_REDIRECT } from "@/lib/safe-next";
import { isTokenShell } from "@/lib/shell";

export function MagicLinkSignIn({
  mailConfigured,
}: {
  /** `health.check`'s `authConfig.emailVerificationRequired`; undefined while
   *  loading. Used only to word the confirmation honestly. */
  mailConfigured: boolean | undefined;
}): React.JSX.Element {
  const [mounted, setMounted] = React.useState(false);
  const [shell, setShell] = React.useState(false);
  const [email, setEmail] = React.useState("");
  const [sent, setSent] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  // After mount, like every other host check: the page is prerendered in Node
  // where the shell globals do not exist.
  React.useEffect(() => {
    setShell(isTokenShell());
    setMounted(true);
  }, []);

  async function send(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError("");
    setBusy(true);
    const { error: refusal } = await authClient
      .signIn.magicLink({
        email,
        // Absolute, and pointed at the WEB origin: the API is a different
        // origin, and a relative path would land on its 404.
        callbackURL: `${window.location.origin}${POST_AUTH_REDIRECT}`,
      })
      .catch(() => ({ error: { code: "FAILED" } }));
    setBusy(false);
    if (refusal) {
      // Same reasoning as the OTP form: no account-enumeration oracle.
      setError("Could not send a link. Check the address and try again.");
      return;
    }
    setSent(email);
  }

  if (mounted && shell) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="magic-link-shell-note">
        Sign-in links open in your browser, so they cannot finish here. Use a code sent to your
        email, or sign in with the web app.
      </p>
    );
  }

  if (sent) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="magic-link-sent">
        {mailConfigured === false
          ? `This server has no mail transport, so the link for ${sent} was written to the server log.`
          : `We sent a sign-in link to ${sent}. It expires shortly and can be used once.`}
      </p>
    );
  }

  return (
    <form onSubmit={send} className="space-y-4" data-testid="magic-link-request">
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="space-y-2">
        <label htmlFor="magic-link-address" className="text-sm font-medium">
          Email
        </label>
        <input
          id="magic-link-address"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          data-testid="magic-link-address"
        />
      </div>
      <button
        type="submit"
        // Disabled until mounted, so the prerendered HTML and the first client
        // render agree.
        disabled={busy || !mounted}
        className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        data-testid="magic-link-send"
      >
        {busy ? "Sending..." : "Email me a sign-in link"}
      </button>
    </form>
  );
}
