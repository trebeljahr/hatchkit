/*
 * How the running app's version reaches the preload.
 *
 * `DesktopBridge.appVersion` is a plain string, so an About screen needs no
 * round trip. The preload cannot read it: it runs sandboxed, where `electron`
 * exposes `contextBridge` and `ipcRenderer` and no `app`. Chromium's sandbox
 * does expose `process.argv`, and `webPreferences.additionalArguments` is what
 * puts a value there, so window.ts appends the version and preload.ts reads it
 * back.
 *
 * Both ends import the same two functions, because a flag spelled in two
 * places drifts the day one of them is edited — and the failure is an empty
 * version string in a shipped build, which nothing else notices.
 *
 * No imports at all, so bundling this into the sandboxed preload costs nothing.
 */

const PREFIX = "--app-version=";

/** What window.ts appends to `additionalArguments`. */
export function appVersionArg(version: string): string {
  return `${PREFIX}${version}`;
}

/**
 * The version in a renderer's `process.argv`, or "" when the window was made
 * without the argument. Empty rather than a throw: a window created by a test
 * or by a future caller still gets a usable bridge.
 */
export function appVersionFrom(argv: readonly string[]): string {
  const found = argv.find((arg) => arg.startsWith(PREFIX));
  return found === undefined ? "" : found.slice(PREFIX.length);
}
