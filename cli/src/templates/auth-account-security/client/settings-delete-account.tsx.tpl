"use client";

/**
 * Delete this account.
 *
 * An account WITH a password confirms with it — the server refuses one that
 * does not send it, because better-auth alone would delete on a merely fresh
 * session and a browser session lasts far longer than that.
 *
 * An account WITHOUT one (social sign-in) has nothing to type, so it types its
 * email address instead, and the server requires its session to be recent.
 *
 * `hasPassword` is resolved when the dialog opens rather than on mount: it
 * costs a request, and most visits to Settings never open this.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { type AccountDeletionRefusal, accountHasPassword, deleteAccount } from "@/lib/auth-client";
import { authClient } from "@/lib/auth-client";

const REFUSALS: Record<AccountDeletionRefusal, string> = {
  "password-required": "Enter your password to delete your account.",
  "invalid-password": "That password is wrong.",
  "session-expired": "For your security, sign in again before deleting your account.",
  failed: "Could not delete the account. Nothing has been removed.",
};

export function DeleteAccountCard(): React.JSX.Element {
  const router = useRouter();
  const session = authClient.useSession();
  const user = session.data?.user;

  const [open, setOpen] = React.useState(false);
  const [hasPassword, setHasPassword] = React.useState<boolean | null>(null);
  const [answer, setAnswer] = React.useState("");
  const [error, setError] = React.useState("");
  const [deleting, setDeleting] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void accountHasPassword().then((next) => {
      if (!cancelled) setHasPassword(next);
    });
    // The dialog can close before the answer arrives; writing state then would
    // be a leak and a React warning.
    return () => {
      cancelled = true;
    };
  }, [open]);

  const email = user?.email ?? "";
  const confirmed =
    hasPassword === null
      ? false
      : hasPassword
        ? answer.length > 0
        : email.length > 0 && answer.trim().toLowerCase() === email.toLowerCase();

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!user || !confirmed) return;
    setError("");
    setDeleting(true);

    const result = await deleteAccount({
      userId: user.id,
      password: hasPassword ? answer : undefined,
    });
    if (!result.ok) {
      setDeleting(false);
      // The server disagreed about whether this account has a password —
      // believe it, and show the field it is asking for.
      if (result.reason === "password-required") setHasPassword(true);
      setError(REFUSALS[result.reason]);
      return;
    }
    router.replace("/login");
  }

  return (
    <div className="space-y-4 rounded-md border border-destructive/40 p-4" data-testid="settings-danger-zone">
      <h2 className="text-lg font-semibold text-destructive">Delete account</h2>
      <p className="text-sm text-muted-foreground">
        This removes your account and the data attached to it. It cannot be undone.
      </p>

      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex h-10 items-center justify-center rounded-md border border-destructive px-4 text-sm font-medium text-destructive hover:bg-destructive/10"
          data-testid="delete-account"
        >
          Delete account
        </button>
      )}

      {open && (
        <form onSubmit={submit} className="space-y-3" data-testid="delete-account-dialog">
          {error && (
            <p className="text-sm text-destructive" role="alert" data-testid="delete-account-error">
              {error}
            </p>
          )}

          {hasPassword === null && (
            <p className="text-sm text-muted-foreground">Checking how this account signs in...</p>
          )}

          {hasPassword === true && (
            <input
              type="password"
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              placeholder="Your password"
              autoComplete="current-password"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              data-testid="delete-account-password"
            />
          )}

          {hasPassword === false && (
            <input
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              placeholder={`Type ${email} to confirm`}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              data-testid="delete-account-email"
            />
          )}

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={!confirmed || deleting}
              className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
              data-testid="delete-account-confirm"
            >
              {deleting ? "Deleting..." : "Delete my account"}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setAnswer("");
                setError("");
              }}
              disabled={deleting}
              className="text-sm text-muted-foreground hover:underline"
              data-testid="delete-account-cancel"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
