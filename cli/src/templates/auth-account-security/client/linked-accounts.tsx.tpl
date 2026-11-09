"use client";

/**
 * Settings → Sign-in methods: every way this account can sign in, linking
 * another, and unlinking one.
 *
 * What fails quietly if it is changed:
 *
 * - **The last way to sign in is never offered for unlinking.** better-auth
 *   refuses it on the server too (`allowUnlinkingAll: false` in auth.ts), but a
 *   button that always answers "failed" is a bug report. Note that the count
 *   is of account rows: a passkey, an email code or a magic link is tied to
 *   the address, not to a row, so an account that signs in only that way
 *   keeps at least one row anyway.
 * - **Linking is a browser redirect**, like signing in with the provider, so
 *   it cannot finish in a native or desktop shell. Those buttons are disabled
 *   there with a note; listing and unlinking are plain requests and work.
 * - **A guest has nothing to link.** Linking would attach the method to an
 *   account better-auth deletes on the guest's first real sign-in, so guests
 *   are sent to sign up instead, which keeps their data.
 * - **Which providers can be linked comes from the server** (`health.check`),
 *   never from a list in this file: a button for a provider the server has no
 *   credentials for fails after a full round trip to that provider.
 */

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import * as React from "react";
import { authClient, useSession } from "@/lib/auth-client";
import { isTokenShell } from "@/lib/shell";
import { trpc } from "@/lib/trpc";

/** The parts of `health.check.authConfig` this screen reads. Optional,
 *  because which of them exist depends on the options this project took. */
type LooseAuthConfig = {
  googleEnabled?: boolean;
  appleEnabled?: boolean;
  signInMethods?: {
    social?: string[];
    oauth?: { id: string; name: string } | null;
    steam?: boolean;
  };
};

export type AccountRow = { id: string; providerId: string; accountId: string };

export type LinkTarget = {
  providerId: string;
  label: string;
  kind: "social" | "oauth2" | "steam";
};

const LABELS: Record<string, string> = {
  credential: "Email and password",
  google: "Google",
  apple: "Apple",
  github: "GitHub",
  discord: "Discord",
  steam: "Steam",
};

const ERRORS: Record<string, string> = {
  "account_already_linked_to_different_user": "That sign-in already belongs to another account.",
  steam_already_linked: "That Steam account already belongs to another account.",
  steam_link_session_changed: "You signed out or switched accounts while linking. Try again.",
  steam_cancelled: "Steam linking was cancelled.",
  steam_sign_in_failed: "Steam could not confirm the sign-in. Try again.",
  "email_doesn't_match": "That sign-in uses a different address.",
};

/** Providers the server can complete, minus the ones already linked. Pure. */
export function linkTargets(config: LooseAuthConfig | undefined, linked: readonly string[]): LinkTarget[] {
  const all: LinkTarget[] = [
    ...(config?.googleEnabled ? [{ providerId: "google", label: "Google", kind: "social" as const }] : []),
    ...(config?.appleEnabled ? [{ providerId: "apple", label: "Apple", kind: "social" as const }] : []),
    ...(config?.signInMethods?.social ?? []).map((id) => ({
      providerId: id,
      label: LABELS[id] ?? id,
      kind: "social" as const,
    })),
    ...(config?.signInMethods?.oauth
      ? [{ providerId: config.signInMethods.oauth.id, label: config.signInMethods.oauth.name, kind: "oauth2" as const }]
      : []),
    ...(config?.signInMethods?.steam ? [{ providerId: "steam", label: "Steam", kind: "steam" as const }] : []),
  ];
  return all.filter((target) => !linked.includes(target.providerId));
}

/** Whether a row may be unlinked: never the only one. */
export function canUnlink(accounts: readonly AccountRow[]): boolean {
  return accounts.length > 1;
}

const noSubscription = (): (() => void) => () => {};
const never = (): boolean => false;
/** A provider sends a failed link back here as `?error=…`. */
const urlError = (): string | null => new URLSearchParams(window.location.search).get("error");
const noUrlError = (): string | null => null;

async function fetchAccounts(): Promise<AccountRow[]> {
  const { data, error } = await authClient.listAccounts();
  if (error || !Array.isArray(data)) throw new Error("Could not load your sign-in methods.");
  return data.map((row: { id: string; providerId: string; accountId: string }) => ({
    id: row.id,
    providerId: row.providerId,
    accountId: row.accountId,
  }));
}

export function LinkedAccounts(): React.JSX.Element {
  const session = useSession();
  const shell = React.useSyncExternalStore(noSubscription, isTokenShell, never);
  const health = trpc.health.check.useQuery(undefined, { staleTime: 5 * 60_000, retry: false });
  const returned = React.useSyncExternalStore(noSubscription, urlError, noUrlError);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState("");

  const guest = Boolean((session.data?.user as { isAnonymous?: boolean | null } | undefined)?.isAnonymous);
  const list = useQuery({
    queryKey: ["auth", "linked-accounts", session.data?.user.id],
    queryFn: fetchAccounts,
    enabled: Boolean(session.data) && !guest,
    retry: false,
  });
  const accounts = list.data ?? null;
  const shownError =
    error ||
    (list.error ? list.error.message : "") ||
    (returned ? (ERRORS[returned] ?? "Linking did not complete. Try again.") : "");

  if (guest) {
    return (
      <section className="space-y-2" data-testid="linked-accounts-guest">
        <h2 className="text-lg font-semibold">Sign-in methods</h2>
        <p className="text-sm text-muted-foreground">
          You are using a guest account. Create an account to keep what you made and to add
          sign-in methods.
        </p>
        <Link href="/signup" className="text-sm text-primary hover:underline">
          Create an account
        </Link>
      </section>
    );
  }

  const linkedIds = (accounts ?? []).map((row) => row.providerId);
  const targets = linkTargets(health.data?.authConfig as LooseAuthConfig | undefined, linkedIds);
  const back = (): string => `${window.location.origin}/settings/accounts`;

  async function link(target: LinkTarget): Promise<void> {
    setError("");
    setBusy(target.providerId);
    let url: string | undefined;
    if (target.kind === "social") {
      const result = await authClient.linkSocial({
        provider: target.providerId,
        callbackURL: back(),
        errorCallbackURL: back(),
      });
      if (result.error) setError(result.error.message ?? "Could not start linking.");
    } else {
      const path = target.kind === "steam" ? "/steam/start" : "/oauth2/link";
      const body =
        target.kind === "steam"
          ? { intent: "link", returnPath: "/settings/accounts" }
          : { providerId: target.providerId, callbackURL: back(), errorCallbackURL: back() };
      const { data, error: failed } = await authClient.$fetch<{ url?: string }>(path, {
        method: "POST",
        body,
      });
      url = data?.url;
      if (failed || !url) setError("Could not start linking.");
    }
    if (url) window.location.assign(url);
    else setBusy(null);
    // On success the browser is already on its way to the provider.
  }

  async function unlink(row: AccountRow): Promise<void> {
    setError("");
    setBusy(row.id);
    const { error: failed } = await authClient.unlinkAccount({
      providerId: row.providerId,
      accountId: row.accountId,
    });
    if (failed) setError(failed.message ?? "Could not unlink that method.");
    await list.refetch();
    setBusy(null);
  }

  const only = accounts !== null && !canUnlink(accounts);

  return (
    <section className="space-y-6" data-testid="linked-accounts">
      <div className="space-y-3">
        <h2 className="text-lg font-semibold">Ways you sign in</h2>
        {accounts === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {accounts.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-4 p-3" data-testid={`linked-${row.providerId}`}>
                <span className="text-sm font-medium">{LABELS[row.providerId] ?? row.providerId}</span>
                <button
                  type="button"
                  onClick={() => void unlink(row)}
                  disabled={only || busy !== null}
                  className="text-sm text-destructive hover:underline disabled:opacity-50 disabled:no-underline"
                  data-testid={`unlink-${row.providerId}`}
                >
                  {busy === row.id ? "Unlinking…" : "Unlink"}
                </button>
              </li>
            ))}
          </ul>
        )}
        {only && (
          <p className="text-xs text-muted-foreground" data-testid="linked-accounts-only">
            This is your only way to sign in. Link another one before you remove it.
          </p>
        )}
      </div>

      {targets.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">Add a way to sign in</h2>
          <div className="flex flex-wrap gap-2">
            {targets.map((target) => (
              <button
                key={target.providerId}
                type="button"
                onClick={() => void link(target)}
                disabled={shell || busy !== null}
                className="inline-flex h-10 items-center justify-center rounded-md border border-input px-4 text-sm font-medium hover:bg-accent disabled:opacity-50"
                data-testid={`link-${target.providerId}`}
              >
                {busy === target.providerId ? "Redirecting…" : `Link ${target.label}`}
              </button>
            ))}
          </div>
          {shell && (
            <p className="text-xs text-muted-foreground">
              Linking opens the provider in a browser. Do it in the web app; it applies here too.
            </p>
          )}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Passkeys, email codes and magic links belong to your address, so they are not listed here.
      </p>
      {shownError && (
        <p className="text-sm text-destructive" role="alert">
          {shownError}
        </p>
      )}
    </section>
  );
}
