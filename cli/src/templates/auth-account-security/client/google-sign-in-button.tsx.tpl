"use client";

/**
 * Sign in with Google.
 *
 * Rendered in every build and every host, and decided only AFTER mount. The
 * client is prerendered in Node, where neither the shell globals nor the
 * server's configuration exist, so a tree that branched on either would
 * disagree with the served HTML and tear at hydration. The button therefore
 * ships disabled and becomes live — or explains itself — once it knows where
 * it is running.
 *
 * Four states:
 *  - `pending`      not mounted yet, or the server has not answered. Disabled,
 *                   which is exactly what the prerendered HTML shows.
 *  - `unconfigured` this server has no Google client id and secret.
 *  - `shell`        a native or desktop shell. The OAuth redirect returns to
 *                   the web origin, and `capacitor://localhost` or Electron's
 *                   `app://-` can never be that origin, so a sign-in started
 *                   here could not come back. Disabled WITH A NOTE rather than
 *                   hidden: a missing button is a bug report, an explained one
 *                   is an answer.
 *  - `enabled`      the web app, on a server with Google configured.
 */

import * as React from "react";
import { signIn } from "@/lib/auth-client";
import { POST_AUTH_REDIRECT } from "@/lib/safe-next";
import { isElectron, isTokenShell } from "@/lib/shell";
import { trpc } from "@/lib/trpc";

export type GoogleAvailability = "pending" | "unconfigured" | "shell" | "enabled";

/** Pure, so the state machine is testable without a DOM. */
export function googleAvailability(input: {
  mounted: boolean;
  shell: boolean;
  googleEnabled: boolean | undefined;
}): GoogleAvailability {
  if (!input.mounted) return "pending";
  if (input.shell) return "shell";
  if (input.googleEnabled === undefined) return "pending";
  return input.googleEnabled ? "enabled" : "unconfigured";
}

const NOTES: Record<string, string> = {
  shell: "Google sign-in is only available in the web app.",
  desktop: "Google sign-in is only available in the web app. Open it in your browser to continue.",
  unconfigured: "Google sign-in is not configured on this server.",
};

export function GoogleSignInButton(): React.JSX.Element {
  const [mounted, setMounted] = React.useState(false);
  const [shell, setShell] = React.useState(false);
  const [desktop, setDesktop] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    setShell(isTokenShell());
    setDesktop(isElectron());
    setMounted(true);
  }, []);

  // Not asked from a shell at all: the answer could not change the outcome.
  const health = trpc.health.check.useQuery(undefined, {
    enabled: mounted && !shell,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const availability = googleAvailability({
    mounted,
    shell,
    googleEnabled: health.data?.authConfig?.googleEnabled,
  });

  const note =
    availability === "shell"
      ? NOTES[desktop ? "desktop" : "shell"]
      : availability === "unconfigured"
        ? NOTES.unconfigured
        : "";

  async function start(): Promise<void> {
    setError("");
    setStarting(true);
    const result = await signIn.social({
      provider: "google",
      callbackURL: `${window.location.origin}${POST_AUTH_REDIRECT}`,
      errorCallbackURL: `${window.location.origin}/login`,
    });
    if (result.error) {
      setError(result.error.message ?? "Could not start Google sign-in.");
      setStarting(false);
    }
    // On success the browser is already navigating to Google.
  }

  return (
    <div className="space-y-2" data-testid="google-sign-in" data-availability={availability}>
      <button
        type="button"
        onClick={start}
        disabled={availability !== "enabled" || starting}
        className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-input text-sm font-medium hover:bg-accent disabled:opacity-50"
        data-testid="google-sign-in-button"
      >
        <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
          <path
            fill="currentColor"
            d="M21.35 11.1H12v2.9h5.35c-.25 1.45-1.7 4.25-5.35 4.25-3.2 0-5.8-2.65-5.8-5.9s2.6-5.9 5.8-5.9c1.8 0 3.05.8 3.75 1.45l2.55-2.45C16.7 3.95 14.55 3 12 3 6.95 3 2.9 7.05 2.9 12s4.05 9 9.1 9c5.25 0 8.7-3.7 8.7-8.9 0-.6-.05-1.05-.15-1.5z"
          />
        </svg>
        {starting ? "Redirecting..." : "Continue with Google"}
      </button>
      {note && (
        <p className="text-xs text-muted-foreground" data-testid="google-sign-in-note">
          {note}
        </p>
      )}
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
