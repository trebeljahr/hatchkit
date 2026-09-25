"use client";

/**
 * Passkeys.
 *
 * **Web browsers only, and the row says so rather than offering a button that
 * fails.** WebAuthn binds a credential to an RP ID, which must be a registered
 * domain reached over a secure context. A shell origin — `capacitor://localhost`,
 * `file://`, Electron's `app://-` — is not a domain and cannot be an RP ID, so
 * a credential registered on the web origin is unusable from a shell and one
 * cannot be registered from a shell at all.
 *
 * Like every other host check here, it is made after mount: the page is
 * prerendered in Node, where the shell globals do not exist.
 */

import * as React from "react";
import { authClient } from "@/lib/auth-client";
import { isTokenShell } from "@/lib/shell";

type PasskeyRow = { id: string; name?: string | null; createdAt?: string | Date };

export function PasskeysRow(): React.JSX.Element {
  const [mounted, setMounted] = React.useState(false);
  const [shell, setShell] = React.useState(false);
  const [rows, setRows] = React.useState<PasskeyRow[]>([]);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    setShell(isTokenShell());
    setMounted(true);
  }, []);

  const refresh = React.useCallback(async (): Promise<void> => {
    const { data } = await authClient.passkey
      .listUserPasskeys()
      .catch(() => ({ data: [] as PasskeyRow[] }));
    setRows(Array.isArray(data) ? data : []);
  }, []);

  React.useEffect(() => {
    if (mounted && !shell) void refresh();
  }, [mounted, shell, refresh]);

  async function add(): Promise<void> {
    setError("");
    setBusy(true);
    const result = await authClient.passkey
      .addPasskey()
      .catch(() => ({ error: { code: "FAILED" } }));
    setBusy(false);
    // A person who dismisses the platform prompt is not an error worth
    // shouting about, but a real failure should say something.
    if (result && "error" in result && result.error) {
      setError("Could not add a passkey.");
      return;
    }
    await refresh();
  }

  async function remove(id: string): Promise<void> {
    setBusy(true);
    await authClient.passkey.deletePasskey({ id }).catch(() => undefined);
    setBusy(false);
    await refresh();
  }

  if (mounted && shell) {
    return (
      <div className="space-y-2" data-testid="setting-passkeys">
        <h2 className="text-lg font-semibold">Passkeys</h2>
        <p className="text-sm text-muted-foreground" data-testid="passkeys-shell-note">
          Passkeys are tied to a website address, so they can only be added and used in the web app.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="setting-passkeys">
      <h2 className="text-lg font-semibold">Passkeys</h2>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No passkeys yet.</p>
      ) : (
        <ul className="space-y-2" data-testid="passkeys-list">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center justify-between text-sm">
              <span>{row.name || "Passkey"}</span>
              <button
                type="button"
                onClick={() => remove(row.id)}
                disabled={busy}
                className="text-destructive hover:underline disabled:opacity-50"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={add}
        disabled={busy || !mounted}
        className="inline-flex h-10 items-center justify-center rounded-md border border-input px-4 text-sm font-medium hover:bg-accent disabled:opacity-50"
        data-testid="passkeys-add"
      >
        {busy ? "Working..." : "Add a passkey"}
      </button>
    </div>
  );
}
