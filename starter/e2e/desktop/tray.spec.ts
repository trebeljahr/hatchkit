import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";

import type { DesktopSettings, DesktopTrayState } from "../../packages/shared/src/desktop-bridge";
import { DEFAULT_DESKTOP_SHORTCUTS } from "../../packages/shared/src/desktop-shortcuts";
import {
  DESKTOP_SETTINGS_FILE,
  createAccount,
  launchApp,
  signInThroughForm,
  testHooks,
  type DesktopWindow,
} from "./support";

/*
 * The desktop shell beyond the window: the tray, the global shortcuts, the
 * per-device settings and the notifications a hidden window needs.
 *
 * Every launch is headless (support.ts), so none of these effects reaches the
 * machine: no tray icon is created, no chord is taken from another
 * application, no notification is posted and no login item is written. The
 * main process records each refusal on `globalThis.__desktopTestHooks`
 * (electron/src/test-hooks.ts), and these specs drive the same IPC handlers a
 * renderer calls and then read that record.
 */

let app: ElectronApplication | null = null;

test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = null;
});

/** A tray state shaped like the one the renderer publishes. */
const TRAY_STATE: DesktopTrayState = {
  signedIn: true,
  status: "Ready",
  items: [{ key: "open-dashboard", label: "Open the dashboard", hint: null }],
  badge: 0,
  labels: {
    open: "Open",
    settings: "Settings…",
    quit: "Quit",
    idleTooltip: "Nothing running",
    badgeDescription: "Unread items",
    itemsHeading: "Recent",
    quitPendingTitle: "",
    quitPendingBody: "",
    quitPendingButton: "",
    restartToUpdate: "Restart to update",
  },
};

async function signedIn(): Promise<{ page: Page; userDataDir: string }> {
  const launched = await launchApp();
  app = launched.app;
  await signInThroughForm(launched.page, await createAccount());
  return { page: launched.page, userDataDir: launched.userDataDir };
}

const settings = (page: Page) =>
  page.evaluate(() => (window as unknown as DesktopWindow).electronAPI.desktop.getSettings());

test("the tray is a view of renderer state, and a headless run draws no icon", async () => {
  const { page } = await signedIn();
  await page.evaluate(
    (state) => (window as unknown as DesktopWindow).electronAPI.desktop.publishTrayState(state),
    TRAY_STATE,
  );

  // The main process took the state — and refused the icon, because a tray
  // item appearing in somebody's menu bar is exactly what headless prevents.
  await expect.poll(async () => (await testHooks(app!)).tray).toContain("updated");
  expect((await testHooks(app!)).tray).not.toContain("created");
});

test("desktop settings persist to userData and come back on the next launch", async () => {
  const { page, userDataDir } = await signedIn();
  const before = await settings(page);
  expect(before.settings.shortcuts).toEqual(DEFAULT_DESKTOP_SHORTCUTS);

  const update = await page.evaluate(() =>
    (window as unknown as DesktopWindow).electronAPI.desktop.updateSettings({
      showBadge: true,
      shortcuts: { "open-settings": "Control+Alt+P" },
    }),
  );
  expect(update.refused).toEqual([]);
  expect(update.snapshot.settings.showBadge).toBe(true);
  expect(update.snapshot.settings.shortcuts["open-settings"]).toBe("Control+Alt+P");

  // Written where the app keeps it, not held in memory until quit: a crash
  // must not lose the person's choice.
  const stored = JSON.parse(readFileSync(join(userDataDir, DESKTOP_SETTINGS_FILE), "utf8")) as DesktopSettings;
  expect(stored.showBadge).toBe(true);
  expect(stored.shortcuts["open-settings"]).toBe("Control+Alt+P");

  // A relaunch applies what was saved before any page asks for it.
  await app!.close();
  const relaunched = await launchApp(userDataDir);
  app = relaunched.app;
  const after = await settings(relaunched.page);
  expect(after.settings.showBadge).toBe(true);
  expect(after.settings.shortcuts["open-settings"]).toBe("Control+Alt+P");
});

test("a chord bound twice is refused, and suspending turns every binding off", async () => {
  const { page } = await signedIn();
  const taken = DEFAULT_DESKTOP_SHORTCUTS["toggle-window"];
  expect(taken).not.toBeNull();

  // Two actions on one chord: whichever fired would be a coin toss, so the
  // second binding is refused before it is saved rather than saved and
  // shadowed.
  const clash = await page.evaluate(
    (chord) =>
      (window as unknown as DesktopWindow).electronAPI.desktop.updateSettings({
        shortcuts: { "open-palette": chord },
      }),
    taken,
  );
  expect(clash.refused.map((status) => status.action)).toEqual(["open-palette"]);
  expect(clash.refused[0].problem).toBe("duplicate");
  expect(clash.snapshot.settings.shortcuts["open-palette"]).toBeNull();

  // While the settings screen records a key, every registration stands down,
  // so the press reaches the page instead of firing the old binding.
  await page.evaluate(() => (window as unknown as DesktopWindow).electronAPI.desktop.suspendShortcuts(true));
  const suspended = await settings(page);
  expect(suspended.shortcutsSuspended).toBe(true);
  expect(suspended.shortcuts.filter((status) => status.registered)).toEqual([]);

  await page.evaluate(() => (window as unknown as DesktopWindow).electronAPI.desktop.suspendShortcuts(false));
  expect((await settings(page)).shortcutsSuspended).toBe(false);

  // Whatever the snapshot says, nothing was ever taken from the OS in a
  // headless run: the accelerators are recorded instead.
  const held = await app!.evaluate(
    ({ globalShortcut }, chords) => chords.filter((chord) => globalShortcut.isRegistered(chord)),
    [taken as string, "Control+Alt+P"],
  );
  expect(held).toEqual([]);
});

test("turning on Open at login is recorded, and no login item reaches the OS", async () => {
  const { page } = await signedIn();
  const update = await page.evaluate(() =>
    (window as unknown as DesktopWindow).electronAPI.desktop.updateSettings({ openAtLogin: true }),
  );
  expect(update.refused).toEqual([]);
  expect(update.snapshot.settings.openAtLogin).toBe(true);

  // The write the OS would have received is on the hook instead, and the
  // machine's own login items are untouched — a test run must not leave the
  // app starting at every boot.
  expect((await testHooks(app!)).loginItem.length).toBeGreaterThan(0);
  const openAtLogin = await app!.evaluate(({ app: electronApp }) => electronApp.getLoginItemSettings().openAtLogin);
  expect(openAtLogin).toBe(false);
});

test("a notification for the hidden window is recorded, never posted", async () => {
  const { page } = await signedIn();
  // A stub that throws proves the claim rather than assuming it: nothing may
  // construct a Notification while headless.
  await app!.evaluate((electron) => {
    (electron as unknown as { Notification: unknown }).Notification = class {
      constructor() {
        throw new Error("Notification constructed in a headless launch");
      }
      static isSupported(): boolean {
        return true;
      }
    };
  });

  const posted = await page.evaluate(() =>
    (window as unknown as DesktopWindow).electronAPI.desktop.notify({
      title: "Something needs you",
      body: "The window is hidden, so this would go to the notification centre.",
      tag: "attention",
    }),
  );
  // The window is hidden in every harness launch, so the shell answers that it
  // would have posted.
  expect(posted).toBe(true);
  expect((await testHooks(app!)).notifications).toEqual([
    {
      title: "Something needs you",
      body: "The window is hidden, so this would go to the notification centre.",
      tag: "attention",
    },
  ]);
});
