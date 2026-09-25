/*
 * The document origins a native shell loads this client from.
 *
 * This is the ONLY place that names them. The server's trusted-origin list,
 * the cookie domain, every stored preference and every keychain entry are all
 * keyed by origin, so a second copy of these strings somewhere else is a
 * second copy that will drift.
 *
 *   iOS bundle      capacitor://localhost
 *   Android bundle  https://localhost
 *
 * Android defaults `androidScheme` to `https`, which is why the Android entry
 * is `https://localhost` and not `http://localhost`. An `http://localhost`
 * entry in a trust list looks right, matches nothing, and fails as a silent
 * 401 on every authenticated request from the Android build.
 *
 * NEVER set a custom `iosScheme` / `androidScheme` in capacitor.config.
 * THE SCHEME IS THE ORIGIN. Changing it does all of this at once, in one
 * step, with no migration path:
 *   - every WebStorage/IndexedDB/cookie record written under the old origin
 *     is orphaned (the app boots signed-out with empty local state),
 *   - the server's trusted-origin list stops matching, so auth breaks for
 *     every already-installed copy of the app until the server is redeployed,
 *   - an already-shipped binary cannot be told about the change.
 * There is no rename path. Pick the defaults and keep them.
 */

/** Document origins for a real (bundled) native build. */
export const NATIVE_ORIGINS = {
  /** iOS WKWebView serves the bundle from the `capacitor` scheme. */
  ios: "capacitor://localhost",
  /** Android WebView serves the bundle over `https` (androidScheme default). */
  android: "https://localhost",
} as const;

export type NativeOrigin = (typeof NATIVE_ORIGINS)[keyof typeof NATIVE_ORIGINS];

/**
 * Origins a LIVE-RELOAD session runs under.
 *
 * Under live reload the WebView does not load the bundle at all — it loads the
 * dev server. So the document origin is the DEV SERVER'S origin, not the app's:
 *
 *   Android emulator  http://10.0.2.2:<port>   (10.0.2.2 is the host loopback
 *                                               as seen from inside the AVD)
 *   iOS Simulator     http://localhost:<port>  (shares the host's loopback)
 *   Physical device   http://<lan-ip>:<port>
 *
 * The consequence, and the reason this function exists next to NATIVE_ORIGINS:
 * live reload never exercises `capacitor://localhost` or `https://localhost`,
 * and therefore never exercises their place in the server's trust list, the
 * cookie's SameSite/Secure behaviour, or the keychain's per-origin isolation.
 * A live-reload session can pass while the shipped build cannot sign in.
 * Verify any auth, cookie or storage change against a REAL BUNDLE BUILD
 * (`build:mobile` + run from Xcode/Android Studio), never against live reload.
 */
export function liveReloadOrigins({
  port,
  lanIp,
}: {
  port: number;
  lanIp?: string;
}): string[] {
  const origins = [
    `http://10.0.2.2:${port}`, // Android emulator -> host loopback
    `http://localhost:${port}`, // iOS Simulator -> host loopback
  ];
  if (lanIp) origins.push(`http://${lanIp}:${port}`); // physical device on Wi-Fi
  return origins;
}

/** True when `origin` is one of the real bundle origins. */
export function isNativeOrigin(origin: string): boolean {
  return (Object.values(NATIVE_ORIGINS) as string[]).includes(origin);
}

/**
 * The rules above, in a form the app can print to a console or a diagnostics
 * screen. Kept as data so a support session can read back the same wording
 * this file enforces instead of a paraphrase of it.
 */
export const ORIGIN_RULES: readonly string[] = [
  `iOS bundle origin is ${NATIVE_ORIGINS.ios}.`,
  `Android bundle origin is ${NATIVE_ORIGINS.android} — androidScheme defaults to https, so an http://localhost entry never matches.`,
  "Never set a custom iosScheme or androidScheme: the scheme is the origin, and changing it orphans stored data and invalidates the server trust list in one step, with no migration path.",
  "Both bundle origins must be in the server's trusted-origin list for cookie auth to work.",
  "Under live reload the document origin is the dev server's, not the app's: http://10.0.2.2:<port> on the Android emulator, http://localhost:<port> on the iOS Simulator.",
  "Live reload therefore never exercises the real origin or its place in the trust list — verify auth changes against a real bundle build.",
];
