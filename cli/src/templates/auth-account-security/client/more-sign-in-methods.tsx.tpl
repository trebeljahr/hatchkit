"use client";

/**
 * The login page's extra sign-in buttons: GitHub, Discord, a generic OAuth or
 * OIDC provider, Steam, and "Continue as guest" — each one only when the
 * server says it can work (`health.check.authConfig.signInMethods`).
 *
 * Like the Google and Apple buttons, this decides after mount: the page is
 * prerendered in Node, where neither the shell nor the server's answer exist.
 * Nothing renders until the server has answered.
 *
 * In a native or desktop shell the redirect methods are disabled with a note:
 * each ends in a browser redirect back to the web origin, which a shell is
 * not. The guest button stays live there — it is one request, body in and
 * session out.
 */

import { useRouter } from "next/navigation";
import * as React from "react";
import { authClient, signIn } from "@/lib/auth-client";
import { POST_AUTH_REDIRECT, safeNextFromSearch } from "@/lib/safe-next";
import { isTokenShell } from "@/lib/shell";
import { trpc } from "@/lib/trpc";

type Methods = {
  social?: string[];
  oauth?: { id: string; name: string } | null;
  steam?: boolean;
  guest?: boolean;
};

const LABELS: Record<string, string> = { github: "GitHub", discord: "Discord" };

const noSubscription = (): (() => void) => () => {};
const never = (): boolean => false;

export function MoreSignInMethods(): React.JSX.Element | null {
  const router = useRouter();
  const shell = React.useSyncExternalStore(noSubscription, isTokenShell, never);
  const health = trpc.health.check.useQuery(undefined, { staleTime: 5 * 60_000, retry: false });
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState("");

  const methods = (health.data?.authConfig as { signInMethods?: Methods } | undefined)?.signInMethods;
  if (!methods) return null;
  const social = methods.social ?? [];
  const redirects = social.length + (methods.oauth ? 1 : 0) + (methods.steam ? 1 : 0);
  if (redirects === 0 && !methods.guest) return null;

  // Back to the page that sent this visitor to sign in, when the guard
  // accepts it. Read at click time, from the page's own URL.
  const destination = (): string => safeNextFromSearch(window.location.search) ?? POST_AUTH_REDIRECT;
  const home = (): string => `${window.location.origin}${destination()}`;
  const login = (): string => `${window.location.origin}/login`;

  async function go(id: string, start: () => Promise<string | undefined | null>): Promise<void> {
    setError("");
    setBusy(id);
    try {
      const url = await start();
      if (url) {
        window.location.assign(url);
        return; // The browser is on its way to the provider.
      }
    } catch {
      // Reported below.
    }
    setError("Could not start that sign-in. Try again.");
    setBusy(null);
  }

  const startSocial = (provider: string) => async (): Promise<string | undefined> => {
    const result = await signIn.social({ provider, callbackURL: home(), errorCallbackURL: login() });
    if (result.error) throw new Error(result.error.message);
    return result.data?.url;
  };

  const startFetch = (path: string, body: Record<string, unknown>) => async (): Promise<string | undefined> => {
    const { data, error: failed } = await authClient.$fetch<{ url?: string }>(path, { method: "POST", body });
    if (failed) throw new Error(failed.message);
    return data?.url;
  };

  async function guest(): Promise<void> {
    setError("");
    setBusy("guest");
    const { error: failed } = await authClient.$fetch("/sign-in/anonymous", { method: "POST", body: {} });
    if (failed) {
      setError("Could not start a guest session. Try again.");
      setBusy(null);
      return;
    }
    await authClient.getSession();
    router.replace(destination());
  }

  const button =
    "inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-input text-sm font-medium hover:bg-accent disabled:opacity-50";

  return (
    <div className="space-y-2" data-testid="more-sign-in-methods">
      {social.map((provider) => (
        <button
          key={provider}
          type="button"
          className={button}
          disabled={shell || busy !== null}
          onClick={() => void go(provider, startSocial(provider))}
          data-testid={`sign-in-${provider}`}
        >
          {busy === provider ? "Redirecting..." : `Continue with ${LABELS[provider] ?? provider}`}
        </button>
      ))}
      {methods.oauth && (
        <button
          type="button"
          className={button}
          disabled={shell || busy !== null}
          onClick={() =>
            methods.oauth &&
            void go(
              methods.oauth.id,
              startFetch("/sign-in/oauth2", {
                providerId: methods.oauth.id,
                callbackURL: home(),
                errorCallbackURL: login(),
              }),
            )
          }
          data-testid="sign-in-oauth"
        >
          {busy === methods.oauth.id ? "Redirecting..." : `Continue with ${methods.oauth.name}`}
        </button>
      )}
      {methods.steam && (
        <button
          type="button"
          className={button}
          disabled={shell || busy !== null}
          onClick={() =>
            void go("steam", startFetch("/steam/start", { intent: "sign-in", returnPath: destination() }))
          }
          data-testid="sign-in-steam"
        >
          {busy === "steam" ? "Redirecting..." : "Continue with Steam"}
        </button>
      )}
      {shell && redirects > 0 && (
        <p className="text-xs text-muted-foreground">These sign-in methods are only available in the web app.</p>
      )}
      {methods.guest && (
        <button
          type="button"
          className={button}
          disabled={busy !== null}
          onClick={() => void guest()}
          data-testid="sign-in-guest"
        >
          {busy === "guest" ? "Starting..." : "Continue as guest"}
        </button>
      )}
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
