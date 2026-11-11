"use client";

/**
 * Sign in with a passkey.
 *
 * Settings → Passkeys registers one; this is the other half, on the login
 * page. It asks the browser for any passkey this site holds, so the person
 * types nothing first.
 *
 * **Not rendered in a token shell.** A passkey is bound to the web origin's
 * domain (its RP ID), and a shell origin such as `capacitor://localhost` or
 * Electron's `app://-` is not a domain, so WebAuthn cannot use it there. The
 * check runs after hydration, like every other host check here: the page is
 * prerendered in Node, where the shell globals do not exist.
 */

import { KeyRound } from "lucide-react";
import * as React from "react";
import { authClient } from "@/lib/auth-client";
import { isTokenShell } from "@/lib/shell";
import { useMounted } from "@/lib/use-mounted";

const FAILED = "That passkey did not work. Try another way to sign in.";

export function PasskeySignIn({ onSignedIn }: { onSignedIn: () => void }): React.JSX.Element | null {
  const mounted = useMounted();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");

  if (mounted && isTokenShell()) return null;

  async function start(): Promise<void> {
    setError("");
    setBusy(true);
    try {
      const result = await authClient.signIn.passkey();
      if (result?.error) {
        setError(result.error.message ?? FAILED);
      } else {
        onSignedIn();
      }
    } catch {
      setError(FAILED);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2" data-testid="passkey-sign-in">
      <button
        type="button"
        onClick={start}
        // Disabled until hydrated, so the prerendered HTML and the first
        // client render agree.
        disabled={busy || !mounted}
        className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-input text-sm font-medium hover:bg-accent disabled:opacity-50"
        data-testid="sign-in-passkey"
      >
        <KeyRound className="size-4" aria-hidden="true" />
        {busy ? "Waiting for your passkey..." : "Sign in with a passkey"}
      </button>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
