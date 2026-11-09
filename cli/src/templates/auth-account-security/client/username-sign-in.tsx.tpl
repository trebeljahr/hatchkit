"use client";

/**
 * Sign in with a username and password, below the email form.
 *
 * `/sign-in/username` is body in, session out, so it also works in a native
 * shell — except for an account with two-factor, which this endpoint answers
 * with a challenge exactly like email sign-in. `onTwoFactor` hands that to the
 * login page's own second step; without it the form says what to do.
 */

import * as React from "react";
import { authClient, isTwoFactorChallenge } from "@/lib/auth-client";

export function UsernameSignIn(props: {
  onSignedIn: () => void;
  onTwoFactor?: () => void;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError("");
    setBusy(true);
    const { data, error: failed } = await authClient.$fetch("/sign-in/username", {
      method: "POST",
      body: { username: username.trim(), password },
    });
    setBusy(false);
    if (failed) {
      setError(failed.status === 401 ? "Wrong username or password." : "Could not sign in. Try again.");
      return;
    }
    if (isTwoFactorChallenge(data)) {
      if (props.onTwoFactor) props.onTwoFactor();
      else setError("This account uses two-factor authentication. Sign in with your email address instead.");
      return;
    }
    await authClient.getSession();
    props.onSignedIn();
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full text-center text-sm text-primary hover:underline"
        data-testid="username-sign-in-open"
      >
        Sign in with a username
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3" data-testid="username-sign-in">
      <input
        type="text"
        autoComplete="username"
        placeholder="Username"
        value={username}
        onChange={(event) => setUsername(event.target.value)}
        required
        className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
        data-testid="username-input"
      />
      <input
        type="password"
        autoComplete="current-password"
        placeholder="Password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        required
        className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
        data-testid="username-password-input"
      />
      <button
        type="submit"
        disabled={busy}
        className="inline-flex h-10 w-full items-center justify-center rounded-md border border-input text-sm font-medium hover:bg-accent disabled:opacity-50"
        data-testid="username-sign-in-submit"
      >
        {busy ? "Signing in..." : "Sign in"}
      </button>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
