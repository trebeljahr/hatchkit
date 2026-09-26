"use client";

/*
 * Carries the language PREFERENCE between this device and the account, in
 * both directions. Renders nothing.
 *
 * THE SERVER STORES THE PREFERENCE, NEVER THE RESOLVED LANGUAGE. "system"
 * means "ask this device", and the server has no device to ask — so one
 * account reads __HATCHKIT_TARGET_LABEL_EN__ on a
 * __HATCHKIT_TARGET_LABEL_EN__ phone and "__HATCHKIT_SOURCE_LOCALE__" on a
 * source-language laptop, with nothing to reconcile. Storing "de" on the
 * account instead would make the phone's language follow the laptop.
 *
 * MOUNT IT INSIDE THE AUTHENTICATED SUBTREE, NOT IN THE ROOT LAYOUT. It calls
 * `profile.get`, which needs a session: on a public page that is a 401 on
 * every visit, and the public pages are prerendered per language and must not
 * follow the preference at all. Signed-out screens simply use this device's
 * stored copy.
 *
 * It cannot affect hydration even so: it renders `null`, contributes no
 * markup, and everything it does happens in effects — which run after the
 * first commit has already matched the served DOM.
 *
 * The synchronous mirror is localStorage, written by `setPreference` before
 * this component ever sees the server's answer. That mirror is what the
 * pre-paint script reads, so the language is right on the FIRST frame of the
 * next cold start rather than after a round trip. A browser evicting it costs
 * one gated frame, not data.
 */

import * as React from "react";
import { isSupportedLocale, type LocalePreference } from "__HATCHKIT_PKG_SCOPE__/shared";

import { readStoredPreference, setPreference } from "@/i18n/store";
import { useLocalePreference } from "@/i18n/use-t";
import { trpc } from "@/lib/trpc";

/** The stored value may predate the field, or come from an older client. */
function asPreference(value: unknown): LocalePreference | undefined {
  if (value === "system") return "system";
  return isSupportedLocale(value) ? value : undefined;
}

export function LocaleSync(): null {
  const utils = trpc.useUtils();
  const query = trpc.profile.get.useQuery(undefined, { staleTime: 60_000 });
  const { mutate } = trpc.profile.update.useMutation({
    onSuccess: (profile) => {
      utils.profile.get.setData(undefined, profile);
    },
  });

  const local = useLocalePreference();
  const remote = asPreference(query.data?.preferences?.locale);

  /** What this tab has sent and not yet seen confirmed. Without it the
   *  in-flight write looks like a stale server value and gets adopted
   *  back, which reverts the choice the person just made. */
  const pending = React.useRef<LocalePreference | null>(null);

  // Server → device.
  React.useEffect(() => {
    if (remote === undefined) return;
    if (pending.current !== null && pending.current !== remote) return;
    pending.current = null;
    if (remote !== readStoredPreference()) setPreference(remote);
  }, [remote]);

  // Device → server. Only once a server value is known: before that there is
  // nothing to compare against, and pushing the default would overwrite the
  // account's real preference from whichever device opened the app first.
  React.useEffect(() => {
    if (remote === undefined || local === remote) return;
    if (pending.current === local) return;
    pending.current = local;
    mutate({ preferences: { locale: local } });
  }, [local, remote, mutate]);

  return null;
}
