"use client";

/**
 * Sign in with Apple.
 *
 * Decided only AFTER mount, like the Google button: the client is prerendered
 * in Node, where neither the shell globals nor the server's configuration
 * exist, so a tree that branched on either would disagree with the served HTML
 * and tear at hydration.
 *
 * Unlike the Google button, this one renders NOTHING until the server says
 * Apple is configured. Sign in with Apple needs a paid developer account and
 * portal setup, so most deployments of a template will never have it, and a
 * permanently disabled Apple button reads as broken — to people and to App
 * Review alike.
 *
 * Four states:
 *  - `pending`      not mounted yet, or the server has not answered. Nothing.
 *  - `unconfigured` this server has no complete APPLE_* set. Nothing.
 *  - `shell`        a native or desktop shell. Apple returns with a
 *                   `form_post` to the web origin, which `capacitor://localhost`
 *                   or Electron's `app://-` can never be, so a sign-in started
 *                   here could not come back. Disabled WITH A NOTE. A native
 *                   Apple sign-in needs a plugin that returns an identity token;
 *                   see docs/account-security.md.
 *  - `enabled`      the web app, on a server with Apple configured.
 */

import * as React from "react";
import { signIn } from "@/lib/auth-client";
import { POST_AUTH_REDIRECT } from "@/lib/safe-next";
import { isElectron, isTokenShell } from "@/lib/shell";
import { trpc } from "@/lib/trpc";

export type AppleAvailability = "pending" | "unconfigured" | "shell" | "enabled";

/** Pure, so the state machine is testable without a DOM. */
export function appleAvailability(input: {
  mounted: boolean;
  shell: boolean;
  appleEnabled: boolean | undefined;
}): AppleAvailability {
  if (!input.mounted || input.appleEnabled === undefined) return "pending";
  if (!input.appleEnabled) return "unconfigured";
  return input.shell ? "shell" : "enabled";
}

const NOTES: Record<string, string> = {
  shell: "Sign in with Apple is only available in the web app for now.",
  desktop: "Sign in with Apple is only available in the web app. Open it in your browser to continue.",
};

/** The host never changes while the page is open, so there is nothing to
 *  subscribe to. */
const noSubscription = (): (() => void) => () => {};

/**
 * Read a host fact after hydration. The server snapshot (`false`) is what
 * the prerender and the hydrating render see; the client snapshot follows in
 * the next render. Same outcome as setting state in a mount effect, without
 * the cascading render the lint gate refuses.
 */
function useAfterHydration(read: () => boolean): boolean {
  return React.useSyncExternalStore(noSubscription, read, () => false);
}

const always = (): boolean => true;

export function AppleSignInButton(): React.JSX.Element | null {
  const mounted = useAfterHydration(always);
  const shell = useAfterHydration(isTokenShell);
  const desktop = useAfterHydration(isElectron);
  const [starting, setStarting] = React.useState(false);
  const [error, setError] = React.useState("");

  // Asked from a shell too: there the answer decides between a note and
  // nothing at all.
  const health = trpc.health.check.useQuery(undefined, {
    enabled: mounted,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const availability = appleAvailability({
    mounted,
    shell,
    appleEnabled: health.data?.authConfig?.appleEnabled,
  });

  if (availability === "pending" || availability === "unconfigured") return null;

  async function start(): Promise<void> {
    setError("");
    setStarting(true);
    const result = await signIn.social({
      provider: "apple",
      callbackURL: `${window.location.origin}${POST_AUTH_REDIRECT}`,
      errorCallbackURL: `${window.location.origin}/login`,
    });
    if (result.error) {
      setError(result.error.message ?? "Could not start Sign in with Apple.");
      setStarting(false);
    }
    // On success the browser is already navigating to Apple.
  }

  return (
    <div className="space-y-2" data-testid="apple-sign-in" data-availability={availability}>
      {/* Apple's guidelines: black (or white) background, the Apple logo, and
          a button no smaller than the other sign-in buttons. */}
      <button
        type="button"
        onClick={start}
        disabled={availability !== "enabled" || starting}
        className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-black text-sm font-medium text-white hover:bg-black/85 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-white/85"
        data-testid="apple-sign-in-button"
      >
        <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"
          />
        </svg>
        {starting ? "Redirecting..." : "Continue with Apple"}
      </button>
      {availability === "shell" && (
        <p className="text-xs text-muted-foreground" data-testid="apple-sign-in-note">
          {NOTES[desktop ? "desktop" : "shell"]}
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
