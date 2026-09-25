/*
 * Headless mode for tests and agents: the app runs, loads and answers IPC, but
 * no window is ever shown or focused and, on macOS, no Dock icon appears and
 * the app never activates.
 *
 * Without it every test run steals keyboard focus from whoever is using the
 * machine and flashes a window across their screen. The rest of the contract
 * is enforced elsewhere and asserted together in `headless.test.ts`:
 *
 *   - no tray icon, no global shortcut, no notification, no login item
 *     (each is recorded on `__desktopTestHooks` instead — test-hooks.ts)
 *   - the Chromium mock keychain, so no real credential item is created
 *     (secure-store.ts)
 *   - external opens recorded, not performed (external.ts)
 *   - a separate profile, so a test run cannot touch the installed app's
 *     data (profile.ts)
 *   - a memory updater that reaches no network (updater.ts)
 *
 * Chromium keeps painting a hidden window (`paintWhenInitiallyHidden` is on by
 * default), but reading a frame back OUT of one is a per-platform question.
 * On macOS the window keeps a compositor surface whatever its ordering, so
 * Playwright screenshots and `capturePage()` work. On X11 an unmapped window
 * has no surface to copy from: the capture is queued, never answered, and the
 * caller hangs until it times out. That is why `scripts/desktop-linux-smoke.mjs`
 * runs the window SHOWN under Xvfb rather than headless, and why the paint
 * assertion in `e2e/desktop/shell.spec.ts` does not run on Linux. The headless
 * contract itself — never shown, never focused, no Dock icon — is asserted on
 * every platform.
 */

export const HEADLESS_ENV = "{{envPrefix}}_HEADLESS";

export function isHeadless(env: Record<string, string | undefined> = process.env): boolean {
  return env[HEADLESS_ENV] === "1";
}
