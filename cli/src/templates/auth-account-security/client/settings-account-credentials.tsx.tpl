"use client";

/**
 * Change password and change email, from Settings.
 *
 * Neither of these signs the calling device out, and that takes deliberate
 * work in the password case — see `ChangePasswordRow`.
 */

import * as React from "react";
import { authClient, refreshSession } from "@/lib/auth-client";

/** better-auth's own minimum, repeated so the form can say it before the
 *  server does. */
export const MIN_PASSWORD_LENGTH = 8;

/** Pure, so the rules are testable without a DOM. */
export function passwordChangeProblem(input: {
  current: string;
  next: string;
  confirm: string;
}): string | null {
  if (!input.current) return "Enter your current password.";
  if (input.next.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (input.next !== input.confirm) return "The two new passwords do not match.";
  if (input.next === input.current) return "The new password is the same as the current one.";
  return null;
}

const passwordRefusal = (code: string | undefined): string => {
  switch (code) {
    case "INVALID_PASSWORD":
      return "That current password is wrong.";
    case "PASSWORD_TOO_SHORT":
      return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
    case "PASSWORD_TOO_LONG":
      return "That password is too long.";
    default:
      return "Could not change the password.";
  }
};

export function ChangePasswordRow({
  hasPassword,
}: {
  /** null while it is still being resolved. */
  hasPassword: boolean | null;
}): React.JSX.Element {
  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [revokeOthers, setRevokeOthers] = React.useState(true);
  const [error, setError] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError("");
    setStatus("");

    const problem = passwordChangeProblem({ current, next, confirm });
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);

    // ── The rule this whole component exists for ──────────────────────────
    // "Sign out other devices" is on by default, because the usual reason to
    // change a password is that somebody else might know it.
    //
    // That is TWO requests, and deliberately not `changePassword`'s own
    // `revokeOtherSessions` flag. better-auth's flag deletes THIS session too
    // and issues a new one; anything watching sessions then sees this device's
    // own credential revoked and signs the app out — every tab of the browser,
    // since they share the new cookie. `/revoke-other-sessions` keeps the
    // current session, so nothing here changes the caller's credential at all.
    const { error: refusal } = await authClient
      .changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: false })
      .catch(() => ({ error: { code: "FAILED" } }));
    if (refusal) {
      setBusy(false);
      setError(passwordRefusal(refusal.code));
      return;
    }

    if (revokeOthers) {
      const { error: revokeRefusal } = await authClient
        .revokeOtherSessions()
        .catch(() => ({ error: { code: "FAILED" } }));
      setBusy(false);
      setStatus(
        revokeRefusal
          ? "Password changed, but other devices may still be signed in."
          : "Password changed. Other devices have been signed out.",
      );
    } else {
      setBusy(false);
      setStatus("Password changed.");
    }

    setCurrent("");
    setNext("");
    setConfirm("");
  }

  if (hasPassword === false) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="setting-password">
        This account signs in with a social provider and has no password to change.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4" data-testid="setting-password">
      <h2 className="text-lg font-semibold">Password</h2>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {status && (
        <p className="text-sm text-muted-foreground" role="status">
          {status}
        </p>
      )}

      <input
        type="password"
        value={current}
        onChange={(event) => setCurrent(event.target.value)}
        placeholder="Current password"
        autoComplete="current-password"
        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        data-testid="change-password-current"
      />
      <input
        type="password"
        value={next}
        onChange={(event) => setNext(event.target.value)}
        placeholder="New password"
        autoComplete="new-password"
        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        data-testid="change-password-new"
      />
      <input
        type="password"
        value={confirm}
        onChange={(event) => setConfirm(event.target.value)}
        placeholder="Confirm new password"
        autoComplete="new-password"
        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        data-testid="change-password-confirm"
      />

      <label className="flex items-center gap-3 text-sm">
        <input
          type="checkbox"
          checked={revokeOthers}
          onChange={() => setRevokeOthers((value) => !value)}
          className="h-4 w-4 rounded border-input"
          data-testid="change-password-revoke"
        />
        Sign out other devices
      </label>

      <button
        type="submit"
        disabled={busy || hasPassword !== true}
        className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        data-testid="change-password-submit"
      >
        {busy ? "Changing..." : "Change password"}
      </button>
    </form>
  );
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Change the address on the account.
 *
 * The server mails a verification link to the NEW address and changes the
 * email only when that link is opened, so a typo cannot move the account to an
 * address nobody reads. On a server with no mail transport the link goes to
 * the server log instead, and the confirmation says so rather than leaving
 * somebody waiting for mail that was never sent.
 */
export function ChangeEmailRow({
  currentEmail,
  mailConfigured,
}: {
  currentEmail: string;
  /** `health.check`'s `authConfig.emailVerificationRequired`; undefined while
   *  loading. */
  mailConfigured: boolean | undefined;
}): React.JSX.Element {
  const [newEmail, setNewEmail] = React.useState("");
  const [sentTo, setSentTo] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError("");
    if (!EMAIL_PATTERN.test(newEmail)) {
      setError("That does not look like an email address.");
      return;
    }
    if (newEmail.toLowerCase() === currentEmail.toLowerCase()) {
      setError("That is already the address on this account.");
      return;
    }
    setBusy(true);
    const { error: refusal } = await authClient
      .changeEmail({
        newEmail,
        // Absolute, and pointed at the WEB origin: the API is a different
        // origin, so a relative path would land on its 404.
        callbackURL: `${window.location.origin}/settings`,
      })
      .catch(() => ({ error: { code: "FAILED" } }));
    setBusy(false);
    if (refusal) {
      setError("Could not start the email change.");
      return;
    }
    setSentTo(newEmail);
    setNewEmail("");
    // The address has not changed yet, but the pending state may be worth
    // re-reading; harmless when nothing changed.
    await refreshSession().catch(() => undefined);
  }

  return (
    <form onSubmit={submit} className="space-y-4" data-testid="setting-email">
      <h2 className="text-lg font-semibold">Email</h2>
      <p className="text-sm text-muted-foreground">{currentEmail}</p>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {sentTo && (
        <p className="text-sm text-muted-foreground" role="status" data-testid="change-email-sent">
          {mailConfigured === false
            ? `This server has no mail transport, so the confirmation link for ${sentTo} was written to the server log.`
            : `Confirm the change from the link we sent to ${sentTo}. Until then, this address stays.`}
        </p>
      )}

      <input
        type="email"
        value={newEmail}
        onChange={(event) => setNewEmail(event.target.value)}
        placeholder="New email address"
        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        data-testid="change-email-input"
      />
      <button
        type="submit"
        disabled={busy}
        className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        data-testid="change-email-submit"
      >
        {busy ? "Sending..." : "Change email"}
      </button>
    </form>
  );
}
