"use client";

/**
 * The second step of a password sign-in.
 *
 * Reached only in a browser. The challenge is the signed cookie
 * `better-auth.two_factor`, and `/two-factor/verify-*` reads nothing else, so
 * a host that cannot hold a cookie cannot complete this at all — `/login`
 * checks for that before it ever renders this component and says so instead.
 *
 * A challenge lasts about ten minutes. Once it has expired the server answers
 * `INVALID_TWO_FACTOR_COOKIE`, and the only way on is the password again — so
 * that answer goes back to the page rather than reading as a wrong code.
 */

import * as React from "react";
import { authClient } from "@/lib/auth-client";

export type ChallengeOutcome = "verified" | "expired";

export function TwoFactorChallenge({
  onDone,
  onCancel,
}: {
  onDone: (outcome: ChallengeOutcome) => void | Promise<void>;
  onCancel: () => void;
}): React.JSX.Element {
  const [method, setMethod] = React.useState<"totp" | "backup">("totp");
  const [code, setCode] = React.useState("");
  const [error, setError] = React.useState("");
  const [verifying, setVerifying] = React.useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError("");
    setVerifying(true);

    // Authenticator apps space their digits and people paste what they see.
    const trimmed = code.replace(/\s+/g, "");
    const result =
      method === "totp"
        ? await authClient.twoFactor.verifyTotp({ code: trimmed })
        : await authClient.twoFactor.verifyBackupCode({ code: trimmed });

    if (result.error) {
      if (result.error.code === "INVALID_TWO_FACTOR_COOKIE") {
        await onDone("expired");
        return;
      }
      setError(method === "totp" ? "That code is not valid." : "That backup code is not valid.");
      setVerifying(false);
      return;
    }
    // `verifying` stays true through the navigation, so the button cannot be
    // pressed twice while the page changes.
    await onDone("verified");
  }

  function switchMethod(): void {
    setMethod((current) => (current === "totp" ? "backup" : "totp"));
    setCode("");
    setError("");
  }

  return (
    <form onSubmit={submit} className="space-y-4" data-testid="login-two-factor">
      {error && (
        <div
          className="rounded-md bg-destructive/10 p-3 text-sm text-destructive"
          role="alert"
          data-testid="two-factor-error"
        >
          {error}
        </div>
      )}

      <div className="space-y-2">
        <label htmlFor="two-factor-code" className="text-sm font-medium">
          {method === "totp" ? "Authenticator code" : "Backup code"}
        </label>
        <input
          id="two-factor-code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          inputMode={method === "totp" ? "numeric" : "text"}
          autoComplete="one-time-code"
          autoFocus
          required
          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          data-testid="two-factor-code"
        />
      </div>

      <button
        type="submit"
        disabled={verifying}
        className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        data-testid="two-factor-submit"
      >
        {verifying ? "Verifying..." : "Verify"}
      </button>

      <div className="flex justify-between text-sm">
        <button
          type="button"
          onClick={switchMethod}
          className="text-primary hover:underline"
          data-testid="two-factor-switch"
        >
          {method === "totp" ? "Use a backup code" : "Use your authenticator"}
        </button>
        <button type="button" onClick={onCancel} className="text-muted-foreground hover:underline">
          Cancel
        </button>
      </div>
    </form>
  );
}
