"use client";

/**
 * Settings → Sign-in methods → Username. Sets or changes the username this
 * account can sign in with. better-auth's username plugin validates it
 * (length, characters, uniqueness) and stores it lower-cased; the form shows
 * the server's refusal as it is.
 */

import * as React from "react";
import { authClient, useSession } from "@/lib/auth-client";

export function UsernameSettings(): React.JSX.Element | null {
  const session = useSession();
  const user = session.data?.user as
    | { username?: string | null; displayUsername?: string | null; isAnonymous?: boolean | null }
    | undefined;
  const current = user?.displayUsername ?? user?.username ?? "";
  const [value, setValue] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");

  if (!user || user.isAnonymous) return null;
  const shown = value ?? current;

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setMessage("");
    setBusy(true);
    const { error } = await authClient.$fetch("/update-user", {
      method: "POST",
      body: { username: shown.trim() },
    });
    setBusy(false);
    if (error) {
      setMessage(error.message ?? "Could not save that username.");
      return;
    }
    await authClient.getSession({ query: { disableCookieCache: true } });
    setValue(null);
    setMessage("Saved. You can now sign in with this username.");
  }

  return (
    <section className="space-y-3" data-testid="username-settings">
      <h2 className="text-lg font-semibold">Username</h2>
      <form onSubmit={save} className="flex gap-2">
        <input
          type="text"
          autoComplete="username"
          value={shown}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Choose a username"
          className="h-10 flex-1 rounded-md border border-input bg-background px-3 text-sm"
          data-testid="username-settings-input"
        />
        <button
          type="submit"
          disabled={busy || shown.trim() === "" || shown.trim() === current}
          className="inline-flex h-10 items-center justify-center rounded-md border border-input px-4 text-sm font-medium hover:bg-accent disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </form>
      {message && <p className="text-sm text-muted-foreground">{message}</p>}
    </section>
  );
}
