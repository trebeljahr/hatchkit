"use client";

/**
 * Sign in with a code mailed to the address.
 *
 * The one method here a stored-token client can complete unaided. Sending the
 * code sets no cookie, and `/sign-in/email-otp` takes `{ email, otp }` in the
 * request body and answers with a session — so a WebView or an extension gets
 * its `set-auth-token` from the bearer plugin exactly as the web app gets a
 * cookie. That is why this is the method to offer on a native shell, and why
 * it is NOT hidden there the way the Google button and the two-factor
 * challenge are.
 *
 * Signing up this way is disabled on the server (`disableSignUp`): a code
 * mailed to an unknown address would otherwise turn this form into an
 * unauthenticated way to create accounts.
 *
 * On a server with no mail transport the code is written to the server log
 * instead of being sent, and the form says so rather than pretending.
 */

import * as React from "react";
import { authClient } from "@/lib/auth-client";

export function EmailOtpSignIn({
  mailConfigured,
  onSignedIn,
}: {
  /** `health.check`'s `authConfig.emailVerificationRequired`; undefined while
   *  loading. Used only to word the confirmation honestly. */
  mailConfigured: boolean | undefined;
  onSignedIn: () => void | Promise<void>;
}): React.JSX.Element {
  const [step, setStep] = React.useState<"email" | "code">("email");
  const [email, setEmail] = React.useState("");
  const [code, setCode] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function sendCode(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError("");
    setBusy(true);
    const { error: refusal } = await authClient.emailOtp
      .sendVerificationOtp({ email, type: "sign-in" })
      .catch(() => ({ error: { code: "FAILED" } }));
    setBusy(false);
    if (refusal) {
      // Deliberately not "no such account": that would make this form an
      // account-enumeration oracle for anyone who can type an address.
      setError("Could not send a code. Check the address and try again.");
      return;
    }
    setStep("code");
  }

  async function verify(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError("");
    setBusy(true);
    const { error: refusal } = await authClient.signIn
      .emailOtp({ email, otp: code.replace(/\s+/g, "") })
      .catch(() => ({ error: { code: "FAILED" } }));
    if (refusal) {
      setBusy(false);
      setError("That code is not valid, or it has expired.");
      return;
    }
    await onSignedIn();
  }

  if (step === "email") {
    return (
      <form onSubmit={sendCode} className="space-y-4" data-testid="email-otp-request">
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <div className="space-y-2">
          <label htmlFor="email-otp-address" className="text-sm font-medium">
            Email
          </label>
          <input
            id="email-otp-address"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            data-testid="email-otp-address"
          />
        </div>
        <button
          type="submit"
          disabled={busy}
          className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          data-testid="email-otp-send"
        >
          {busy ? "Sending..." : "Email me a code"}
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={verify} className="space-y-4" data-testid="email-otp-verify">
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <p className="text-sm text-muted-foreground" data-testid="email-otp-sent">
        {mailConfigured === false
          ? `This server has no mail transport, so the code for ${email} was written to the server log.`
          : `We sent a code to ${email}.`}
      </p>
      <div className="space-y-2">
        <label htmlFor="email-otp-code" className="text-sm font-medium">
          Code
        </label>
        <input
          id="email-otp-code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          required
          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          data-testid="email-otp-code"
        />
      </div>
      <button
        type="submit"
        disabled={busy}
        className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        data-testid="email-otp-submit"
      >
        {busy ? "Signing in..." : "Sign in"}
      </button>
      <button
        type="button"
        onClick={() => {
          setStep("email");
          setCode("");
          setError("");
        }}
        className="text-sm text-muted-foreground hover:underline"
      >
        Use a different address
      </button>
    </form>
  );
}
