import { useSyncExternalStore } from "react";

/** Whether the page has hydrated never changes once it has, so there is
 *  nothing to subscribe to. */
const noSubscription = (): (() => void) => () => undefined;

/**
 * False while prerendering and during hydration, true from the next render
 * on. Gate anything read from the browser on it (the shell globals in
 * `lib/shell.ts`, the URL, storage), so the first client render matches the
 * served HTML.
 *
 * The same outcome as `useEffect(() => setMounted(true), [])`, without the
 * extra render the lint gate refuses (`react-hooks/set-state-in-effect`).
 * Derive host facts from it rather than storing them:
 *
 *     const mounted = useMounted();
 *     const shell = mounted && isTokenShell();
 */
export function useMounted(): boolean {
  return useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
}
