"use client";

/*
 * The translation hook, and the only place a translator is built.
 *
 * ```tsx
 * const t = useT("app");
 * t("dashboard.title");                       // key typed against the source
 * t("items.count", { count });                // ICU arguments typed too
 * t.rich("hint", { b: (c) => <b>{c}</b> });
 * translate("common")("errors.generic");      // non-component code
 * ```
 *
 * `createTranslator` from `use-intl/core` and NOTHING from use-intl's React
 * half. There is no provider to mount at the root, so every component test in
 * this project renders unchanged, in "__HATCHKIT_SOURCE_LOCALE__", and a
 * component lifted into a story or a server component keeps working. Never
 * reach for a routing-based i18n library either: this app is a static export
 * (`output: "export"`), and middleware cannot exist in one.
 *
 * `useLocale` answers "__HATCHKIT_SOURCE_LOCALE__" during hydration by
 * construction — see the long note in i18n/store.ts. A <FixedLocale> ancestor
 * overrides the store for its subtree; with no ancestor the context is `null`,
 * which means "follow the store", which is why nothing has to be mounted.
 */

import * as React from "react";
import { createTranslator, type _Translator } from "use-intl/core";
import type { LocalePreference, SupportedLocale } from "__HATCHKIT_PKG_SCOPE__/shared";

import { FixedLocaleContext } from "@/i18n/fixed-locale";
import {
  getMessageTransform,
  getServerSnapshot,
  getSnapshot,
  isPseudoActive,
  readStoredPreference,
  setPreference,
  subscribe,
} from "@/i18n/store";
import { messagesFor, type Messages, type Namespace } from "@/i18n/messages";

export type { Messages, Namespace };

/** `t("key", values)`, `t.rich(...)`, `t.markup(...)`, `t.has(...)`, with
 *  keys and ICU arguments checked against the source catalog. */
export type Translator<N extends Namespace> = _Translator<Messages, N>;

/**
 * The time zone `{d, date}` and `{t, time}` arguments render in.
 *
 * The device's own in a browser, UTC during a build — which is the reason a
 * prerendered page must never put a date into a message argument: the build
 * machine's zone would be baked into the HTML and disagree with hydration.
 * Format the date with i18n/format.ts and pass the resulting string.
 */
function timeZone(): string {
  if (typeof window === "undefined") return "UTC";
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

/** Applying the transform costs one pass over the catalog, so the result is
 *  built once per locale rather than per translator. Keyed by the transform
 *  as well, since registering a different one must not serve this copy. */
const transformed = new WeakMap<object, WeakMap<object, Messages>>();

function applyTransform(messages: Messages, transform: (message: string) => string): Messages {
  let perCatalog = transformed.get(transform);
  if (perCatalog === undefined) {
    perCatalog = new WeakMap();
    transformed.set(transform, perCatalog);
  }
  const cached = perCatalog.get(messages);
  if (cached !== undefined) return cached;
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return transform(value);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };
  const out = walk(messages) as Messages;
  perCatalog.set(messages, out);
  return out;
}

const translators = new Map<string, unknown>();
const DEV = process.env.NODE_ENV !== "production";

/**
 * A translator for one namespace in one locale, memoised.
 *
 * Building one parses no messages up front, but a render tree asks for the
 * same three every time, and a fresh object every render defeats every
 * `React.memo` below it.
 *
 * A missing message cannot type-check, so one at runtime means a catalog was
 * edited without running `tsc`. It renders as `namespace.key` — visible and
 * greppable — and logs in development; production stays quiet rather than
 * throwing in the middle of a render.
 */
function getTranslator<N extends Namespace>(
  locale: SupportedLocale,
  namespace: N,
  pseudo: boolean,
): Translator<N> {
  // The transform is part of the key, not just `pseudo`: i18n/pseudo.ts may
  // register itself after the first translator was built, and a stale cache
  // entry would leave the page un-accented with no way to tell why.
  const transform = pseudo ? getMessageTransform() : null;
  const key = `${locale}:${namespace}:${transform ? "p" : ""}`;
  const cached = translators.get(key);
  if (cached !== undefined) return cached as Translator<N>;

  const base = messagesFor(locale);
  const translator = createTranslator({
    locale,
    messages: transform ? applyTransform(base, transform) : base,
    namespace,
    timeZone: timeZone(),
    onError: (error) => {
      if (DEV) console.error(`[i18n] ${error.message}`);
    },
    getMessageFallback: ({ namespace: ns, key: messageKey }) =>
      ns ? `${ns}.${messageKey}` : messageKey,
  }) as unknown as Translator<N>;

  translators.set(key, translator);
  return translator;
}

/**
 * The locale this component renders in. Re-renders when it changes.
 *
 * `getServerSnapshot` is the whole hydration answer: it returns
 * "__HATCHKIT_SOURCE_LOCALE__", so React's first client render matches the
 * prerendered markup even though the reader's language is already known.
 */
export function useLocale(): SupportedLocale {
  const pinned = React.useContext(FixedLocaleContext);
  const current = React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return pinned ?? current;
}

/** Pseudo-locale only. Never true in a production build, and its
 *  server snapshot is `false`, so it cannot move the first render either. */
function usePseudo(): boolean {
  return React.useSyncExternalStore(subscribe, isPseudoActive, returnFalse);
}

function returnFalse(): boolean {
  return false;
}

export function useT<N extends Namespace>(namespace: N): Translator<N> {
  const locale = useLocale();
  const pseudo = usePseudo();
  return getTranslator(locale, namespace, pseudo);
}

/**
 * The same translator for code that is not a component — a toast in a
 * mutation callback, a filename, a string built in a plain function.
 *
 * Resolved at CALL time. Never call it at module scope: the locale switches
 * after hydration, and a string computed at import time stays in the source
 * language forever.
 */
export function translate<N extends Namespace>(namespace: N): Translator<N> {
  return getTranslator(getSnapshot(), namespace, isPseudoActive());
}

/** The stored preference, for the picker. "system" during hydration. */
export function useLocalePreference(): LocalePreference {
  return React.useSyncExternalStore(subscribe, readStoredPreference, returnSystem);
}

function returnSystem(): LocalePreference {
  return "system";
}

/** Setter for the picker. Stable, so it can sit in a dependency array. */
export function useSetLocalePreference(): (p: LocalePreference) => void {
  return setPreference;
}
