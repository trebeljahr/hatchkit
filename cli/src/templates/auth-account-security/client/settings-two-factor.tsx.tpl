"use client";

/**
 * Turn two-factor on and off.
 *
 * Turning it on is three steps, and the ORDER is the safety:
 *
 *  1. the password proves it is the account holder;
 *  2. scanning and confirming a code proves the authenticator really holds
 *     the secret — the server switches two-factor on only at this point, so a
 *     dialog abandoned half-way locks nobody out;
 *  3. the backup codes are shown last and once, because the server stores them
 *     encrypted and genuinely cannot show them again.
 *
 * Turning it off asks for the password, as the server does.
 *
 * Note that both toggles REPLACE the current session: better-auth issues a new
 * one and deletes the old. Anything watching sessions will see this device's
 * old credential disappear — see `lib/session-revoked.ts`, which re-checks
 * before concluding that the person is signed out.
 */

import * as React from "react";
import { authClient } from "@/lib/auth-client";

/** The `secret` of an `otpauth://` URI, for typing into an app by hand when a
 *  QR cannot be scanned. */
export function totpSecretOf(uri: string): string {
  try {
    return new URL(uri).searchParams.get("secret") ?? "";
  } catch {
    return "";
  }
}

type EnableStep =
  | { kind: "idle" }
  | { kind: "password" }
  | { kind: "scan"; totpURI: string; backupCodes: string[] }
  | { kind: "codes"; backupCodes: string[] };

export function TwoFactorRow(): React.JSX.Element {
  const session = authClient.useSession();
  const enabled = session.data?.user?.twoFactorEnabled === true;

  const [step, setStep] = React.useState<EnableStep>({ kind: "idle" });
  const [password, setPassword] = React.useState("");
  const [code, setCode] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [status, setStatus] = React.useState("");

  function reset(): void {
    setStep({ kind: "idle" });
    setPassword("");
    setCode("");
    setError("");
    setBusy(false);
  }

  async function startEnable(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError("");
    setBusy(true);
    const { data, error: refusal } = await authClient.twoFactor
      .enable({ password })
      .catch(() => ({ data: null, error: { code: "FAILED" } }));
    setBusy(false);
    if (refusal || !data) {
      setError(refusal?.code === "INVALID_PASSWORD" ? "That password is wrong." : "Something went wrong.");
      return;
    }
    setPassword("");
    // Not on yet. `twoFactorEnabled` flips only once a code verifies below.
    setStep({ kind: "scan", totpURI: data.totpURI, backupCodes: data.backupCodes });
  }

  async function confirmCode(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (step.kind !== "scan") return;
    setError("");
    setBusy(true);
    const { error: refusal } = await authClient.twoFactor
      .verifyTotp({ code: code.replace(/\s+/g, "") })
      .catch(() => ({ error: { code: "FAILED" } }));
    setBusy(false);
    if (refusal) {
      setError(refusal.code === "INVALID_CODE" ? "That code is not valid." : "Something went wrong.");
      return;
    }
    setCode("");
    setStep({ kind: "codes", backupCodes: step.backupCodes });
    setStatus("Two-factor authentication is on.");
  }

  async function disable(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError("");
    setBusy(true);
    const { error: refusal } = await authClient.twoFactor
      .disable({ password })
      .catch(() => ({ error: { code: "FAILED" } }));
    setBusy(false);
    if (refusal) {
      setError(refusal.code === "INVALID_PASSWORD" ? "That password is wrong." : "Something went wrong.");
      return;
    }
    setStatus("Two-factor authentication is off.");
    reset();
  }

  return (
    <div className="space-y-4" data-testid="setting-two-factor">
      <h2 className="text-lg font-semibold">Two-factor authentication</h2>
      <p className="text-sm text-muted-foreground">
        {enabled ? "On. You are asked for a code when you sign in." : "Off."}
      </p>
      {status && (
        <p className="text-sm text-muted-foreground" role="status">
          {status}
        </p>
      )}
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {step.kind === "idle" && (
        <button
          type="button"
          onClick={() => setStep({ kind: "password" })}
          className="inline-flex h-10 items-center justify-center rounded-md border border-input px-4 text-sm font-medium hover:bg-accent"
          data-testid={enabled ? "two-factor-disable" : "two-factor-enable"}
        >
          {enabled ? "Turn off" : "Turn on"}
        </button>
      )}

      {step.kind === "password" && (
        <form onSubmit={enabled ? disable : startEnable} className="space-y-3">
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Your password"
            autoComplete="current-password"
            required
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            data-testid="two-factor-password"
          />
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy}
              className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              data-testid="two-factor-password-submit"
            >
              {busy ? "Working..." : "Continue"}
            </button>
            <button type="button" onClick={reset} className="text-sm text-muted-foreground hover:underline">
              Cancel
            </button>
          </div>
        </form>
      )}

      {step.kind === "scan" && (
        <form onSubmit={confirmCode} className="space-y-3">
          <p className="text-sm">
            Scan this in your authenticator app, or enter the secret by hand, then confirm the code
            it shows.
          </p>
          <p className="break-all rounded-md bg-muted p-3 font-mono text-xs" data-testid="two-factor-secret">
            {totpSecretOf(step.totpURI)}
          </p>
          <input
            value={code}
            onChange={(event) => setCode(event.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="6-digit code"
            required
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            data-testid="two-factor-verify-code"
          />
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy}
              className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              data-testid="two-factor-verify-submit"
            >
              {busy ? "Verifying..." : "Confirm"}
            </button>
            <button type="button" onClick={reset} className="text-sm text-muted-foreground hover:underline">
              Cancel
            </button>
          </div>
        </form>
      )}

      {step.kind === "codes" && (
        <div className="space-y-3">
          <p className="text-sm">
            Save these backup codes now. Each works once, and this is the only time they can be
            shown — the server stores them encrypted.
          </p>
          <ul
            className="grid grid-cols-2 gap-2 rounded-md bg-muted p-3 font-mono text-sm"
            data-testid="two-factor-backup-codes"
          >
            {step.backupCodes.map((backupCode) => (
              <li key={backupCode}>{backupCode}</li>
            ))}
          </ul>
          <button
            type="button"
            onClick={reset}
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            data-testid="two-factor-codes-done"
          >
            I have saved them
          </button>
        </div>
      )}
    </div>
  );
}
