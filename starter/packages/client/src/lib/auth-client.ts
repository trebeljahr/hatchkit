import { createAuthClient } from "better-auth/react";

// better-auth validates `baseURL` with `new URL()` and rejects anything
// relative ("Invalid base URL: /api/auth"). Because `createAuthClient` runs at
// module scope, a relative value throws during Next's Node prerender — and with
// `output: "export"` (every desktop/mobile build) *every* page prerenders, so a
// single protected page takes the whole build down. Resolve an ABSOLUTE origin,
// most specific first:
//
//   1. NEXT_PUBLIC_API_URL — inlined at BUILD time (Dockerfile build args /
//      release-workflow env). Production builds fail loudly in next.config.ts
//      when it's missing, so the localhost fallbacks below only ever apply to
//      local dev and to prerender.
//   2. `next dev` — the client and the API run on different ports, so keep
//      pointing at the dev server rather than at same-origin. This check has to
//      come before the browser branch or dev auth would hit the Next port.
//   3. window.location.origin — the browser same-origin case. This preserves
//      the intent of the old "" fallback (same-origin /api paths, matching
//      trpc.ts) for web deploys that front client and API with one proxy.
//      Skipped when the document has an OPAQUE origin: the desktop shell
//      loads the static export with `win.loadFile()` (electron/main.ts), so
//      the document is `file://` and `window.location.origin` is the literal
//      string "null". That is not a usable base — `${"null"}/api/auth` is
//      relative and better-auth's `new URL()` rejects it — and no server
//      would trust `Origin: null` with credentials anyway. Such a build is
//      already broken (it shipped without NEXT_PUBLIC_API_URL, which
//      next.config.ts fails the build over); falling through keeps the
//      failure a plain unreachable-host error instead of a URL parse throw.
//   4. A throwaway absolute origin for Node prerender, where `window` is
//      undefined (and for the opaque-origin case above). Nothing ever fetches
//      from it during prerender: rendering produces markup only, and no auth
//      request is issued. It exists purely so `new URL()` succeeds. It cannot
//      leak into the browser bundle of a correctly configured build — the
//      module is re-evaluated client-side, where step 1 or step 3 wins.
function resolveAuthOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_API_URL;
  // Trailing slashes would produce a doubled "//api/auth" path, which some
  // reverse proxies do not normalize.
  if (configured) return configured.replace(/\/+$/, "");
  if (process.env.NODE_ENV === "development") return "http://localhost:5000";
  if (typeof window !== "undefined") {
    // Opaque origins serialize to the string "null" (file://, sandboxed
    // iframes). Treat that — and the empty string — as "no usable origin".
    const origin = window.location.origin;
    if (origin && origin !== "null") return origin;
  }
  return "http://localhost";
}

export const authClient = createAuthClient({
  baseURL: `${resolveAuthOrigin()}/api/auth`,
});

// Re-export commonly used methods
export const { signIn, signUp, signOut, useSession } = authClient;
