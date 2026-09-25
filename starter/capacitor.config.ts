import type { CapacitorConfig } from "@capacitor/cli";

/*
 * Capacitor (iOS + Android) configuration.
 *
 * ── The only supported way to build ────────────────────────────────
 *
 * `pnpm build:mobile [ios|android]` — i.e. `node scripts/build-mobile.mjs`.
 * Never a bare `cap sync` / `cap run ios` / `cap run android`. The script
 * requires NEXT_PUBLIC_API_URL, proves the literal reached an emitted
 * chunk, preflights the toolchain, asserts the native identifiers and
 * versions still agree with this file and the root package.json, and
 * refuses to run while a dev server owns packages/client/.next. A bare
 * `cap` command skips every one of those and still produces an app that
 * installs and launches.
 *
 * ── webDir: the mobile export has its own directory ────────────────
 *
 * `packages/client/out-mobile`, written only by scripts/build-mobile.mjs.
 * `packages/client/out` is the web/Playwright export (Playwright bakes a
 * throwaway loopback API port into it) and `out-desktop` is Electron's.
 * `cap run` syncs implicitly, so a shared directory means a test run can
 * silently be installed as the app.
 *
 * ── The scheme IS the origin ───────────────────────────────────────
 *
 * iOS serves the bundle from `capacitor://localhost`, Android from
 * `https://localhost` (androidScheme defaults to https; an
 * `http://localhost` entry in a trust list would never match). Both are
 * listed in packages/client/src/mobile/origins.ts, which is the one place
 * that knows them.
 *
 * NEVER set a custom `iosScheme` / `androidScheme`. The document origin
 * keys the platform preference store, the WebView's own storage and the
 * server's trusted-origin list, so changing the scheme later orphans
 * every stored preference and invalidates the trust list at once, with no
 * migration path.
 *
 * ── Live reload is not the app ─────────────────────────────────────
 *
 * scripts/android-dev.sh / scripts/ios-dev.sh set CAP_DEV_URL, and the
 * WebView then loads the dev server instead of the bundle. The document
 * origin under live reload is therefore the DEV SERVER'S, not the app's,
 * so neither the real origin nor its place in the trust list is exercised.
 * Verify any auth change against a real `pnpm build:mobile` bundle.
 *
 * scripts/build-mobile.mjs deletes CAP_DEV_URL from the child environment
 * before syncing, so a stale value left in a shell cannot bake a
 * dev-server URL into a bundle build.
 */
const config: CapacitorConfig = {
  appId: "{{bundleId}}",
  // The LAUNCHER label, not the product name. `cap add` copies this
  // verbatim into CFBundleDisplayName and the Android app_name, and a
  // launcher elides past about twelve characters.
  appName: "{{shortName}}",
  webDir: "packages/client/out-mobile",

  android: {
    allowMixedContent: false,
  },

  backgroundColor: "#ffffff",

  ...(process.env.CAP_DEV_URL
    ? {
        server: {
          url: process.env.CAP_DEV_URL,
          // Dev only. Capacitor 8's Android runtime no longer reads this
          // at all — a debug build talking to a plain-http local API
          // needs android/app/src/debug/res/xml/network_security_config.xml,
          // which scripts/cap-add.mjs writes into the DEBUG source set.
          cleartext: true,
        },
      }
    : {}),

  plugins: {
    SplashScreen: {
      launchShowDuration: 2000,
      // The app hides the splash itself, once the bridge is up. Note the
      // consequence when debugging: anything that hangs before that call
      // leaves the app frozen on the splash with no console to read.
      launchAutoHide: false,
      backgroundColor: "#ffffff",
      androidScaleType: "CENTER_CROP",
      showSpinner: false,
      splashFullScreen: true,
      splashImmersive: true,
    },
  },
};

export default config;
