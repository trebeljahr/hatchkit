import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";

import { DEFAULT_DESKTOP_SHORTCUTS } from "../../packages/shared/src/desktop-shortcuts";
import {
  APP_ORIGIN,
  MAIN_JS,
  PRELOAD_JS,
  PROTECTED_ROUTES,
  WINDOW_STATE_FILE,
  collectPageProblems,
  createAccount,
  electronExecutable,
  freshUserDataDir,
  launchApp,
  launchEnv,
  openLogin,
  openedExternally,
  signInThroughForm,
  testHooks,
  type DesktopWindow,
} from "./support";

/*
 * The desktop shell itself: a window that navigates the static export over
 * `app://-`, a security baseline that holds, and a launch that touches
 * nothing on the machine it runs on.
 *
 * Every launch is headless (support.ts). The contract that makes this suite
 * safe to run on a working machine — never shown, never focused, no Dock
 * icon, no tray, no OS shortcut, no notification, no login item — is asserted
 * below, on every platform.
 */

let app: ElectronApplication;
let page: Page;

test.afterEach(async () => {
  await app?.close().catch(() => undefined);
});

/** Wait for a route to settle: the URL, then a rendered document. */
async function expectAt(target: Page, path: RegExp): Promise<void> {
  await expect(target).toHaveURL(path);
  await expect(target.locator("body")).not.toBeEmpty();
}

/** "/dashboard" → "Dashboard": the nav link the layout draws for a route. */
function linkName(route: string): string {
  const word = route.replace(/^\//, "");
  return word.charAt(0).toUpperCase() + word.slice(1);
}

test("opens on app://- and reaches the login screen", async () => {
  ({ app, page } = await launchApp());
  // The first document comes off the app scheme, which a file:// build cannot
  // match: that origin is the string "null", so sign-in is refused, and it has
  // no root, so root-absolute "/_next/…" resolves against the filesystem root
  // and every route but the first blanks.
  await expectAt(page, /^app:\/\/-\//);
  expect(await page.evaluate(() => [location.origin, isSecureContext])).toEqual([APP_ORIGIN, true]);
  await openLogin(page);
  await expect(page.getByTestId("login-email")).toBeVisible();
});

test("every protected route renders, by click and by hard load", async () => {
  ({ app, page } = await launchApp());
  await signInThroughForm(page, await createAccount());
  const problems = collectPageProblems(page);

  // Client-side: the nav link, which fetches the route's payload over app://.
  // Next falls back to a full document load when that fetch fails, which
  // would pass every URL check below, so a marker on `window` has to survive
  // the whole loop.
  await page.evaluate(() => Object.assign(window, { __sameDocument: true }));
  for (const route of PROTECTED_ROUTES) {
    await page.getByRole("link", { name: linkName(route), exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`^app://-${route}/?$`));
    await expect(page.getByTestId("sign-out")).toBeVisible();
  }
  expect(await page.evaluate(() => (window as { __sameDocument?: boolean }).__sameDocument)).toBe(true);

  // Hard loads: each document and its chunks straight off the scheme.
  for (const route of PROTECTED_ROUTES) {
    await page.goto(`${APP_ORIGIN}${route}/`);
    await expect(page).toHaveURL(new RegExp(`^app://-${route}/?$`));
    await expect(page.getByTestId("sign-out")).toBeVisible();
  }

  expect(problems).toEqual([]);
});

test("a reload on a deep route renders it again", async () => {
  ({ app, page } = await launchApp());
  await signInThroughForm(page, await createAccount());
  const route = PROTECTED_ROUTES[PROTECTED_ROUTES.length - 1];
  await page.goto(`${APP_ORIGIN}${route}/`);
  await expect(page.getByTestId("sign-out")).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(`${APP_ORIGIN}${route}/`);
  await expect(page.getByTestId("sign-out")).toBeVisible();
});

test("an unknown path answers 404 and shows the not-found page", async () => {
  ({ app, page } = await launchApp());
  await openLogin(page);
  const status = await page.evaluate(async () => (await fetch("/no/such/page/")).status);
  expect(status).toBe(404);
  await page.goto(`${APP_ORIGIN}/no/such/page/`);
  await expect(page.locator("body")).toContainText("404");
});

test("HTML is served with the CSP and nosniff", async () => {
  ({ app, page } = await launchApp());
  await openLogin(page);
  const headers = await page.evaluate(async () => {
    const html = await fetch("/login/");
    return {
      csp: html.headers.get("content-security-policy"),
      type: html.headers.get("content-type"),
      nosniff: html.headers.get("x-content-type-options"),
    };
  });
  expect(headers.type).toContain("text/html");
  expect(headers.csp).toContain("default-src 'self'");
  expect(headers.csp).toContain("frame-ancestors 'none'");
  expect(headers.nosniff).toBe("nosniff");
});

test("ipcMain refuses a frame outside app://-", async () => {
  ({ app, page } = await launchApp());
  await openLogin(page);

  // The app's own document may call the bridge.
  const own = await page.evaluate(() =>
    (window as unknown as DesktopWindow).electronAPI.secureStore.status().then((s) => typeof s.persistent),
  );
  expect(own).toBe("boolean");

  // A window with the very same preload, showing anything else, may not. The
  // preload is attached per window, not per URL, so without the guard in
  // electron/src/ipc.ts every handler stays reachable from a page that is not
  // ours.
  const refused = await app.evaluate(async ({ BrowserWindow }, preload) => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    try {
      await win.loadURL("data:text/html,<p>not the app</p>");
      return await win.webContents.executeJavaScript(
        `window.electronAPI.secureStore.status().then(() => "allowed", (e) => "refused: " + e.message)`,
      );
    } finally {
      win.destroy();
    }
  }, PRELOAD_JS);
  expect(refused).toMatch(/^refused: .*Refused secure-store:status/);
});

test("navigation off the app origin and permission requests are denied", async () => {
  ({ app, page } = await launchApp());
  await openLogin(page);
  const before = page.url();

  // file:// rather than https://, which would open the test machine's browser.
  await page.evaluate(() => {
    location.href = "file:///etc/hosts";
  });
  await page.waitForTimeout(500);
  expect(page.url()).toBe(before);

  const popup = await page.evaluate(() => window.open("file:///etc/hosts") === null);
  expect(popup).toBe(true);
  expect(app.windows()).toHaveLength(1);

  const geolocation = await page.evaluate(
    () =>
      new Promise<string>((done) => {
        navigator.geolocation.getCurrentPosition(
          () => done("granted"),
          (err) => done(`denied:${err.code}`),
        );
      }),
  );
  expect(geolocation).toBe("denied:1");
});

test("a generated file reaches the download manager", async () => {
  ({ app, page } = await launchApp());
  await openLogin(page);
  const before = page.url();
  // A blob: URL on an <a download>, which is how a CSV or PDF export leaves
  // the app. It must become a download, not a navigation the security
  // handlers refuse. The save path is set here, so no dialog opens.
  const dir = freshUserDataDir();
  await app.evaluate(({ session }, saveDir) => {
    const g = globalThis as { __downloads?: string[] };
    g.__downloads = [];
    session.defaultSession.once("will-download", (_event, item) => {
      item.setSavePath(`${saveDir}/${item.getFilename()}`);
      item.once("done", (_e, state) => g.__downloads?.push(`${item.getFilename()}:${state}`));
    });
  }, dir);
  await page.evaluate(() => {
    const url = URL.createObjectURL(new Blob(["a,b\n1,2\n"], { type: "text/csv" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "report.csv";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  });
  await expect
    .poll(() => app.evaluate(() => (globalThis as { __downloads?: string[] }).__downloads ?? []))
    .toEqual(["report.csv:completed"]);
  expect(readFileSync(join(dir, "report.csv"), "utf8")).toBe("a,b\n1,2\n");
  expect(page.url()).toBe(before);
});

test("a test launch touches nothing on the machine it runs on", async () => {
  let userDataDir: string;
  ({ app, page, userDataDir } = await launchApp());
  await openLogin(page);

  const state = await app.evaluate(({ app: electronApp, BrowserWindow }) => {
    const wins = BrowserWindow.getAllWindows();
    return {
      windows: wins.length,
      visible: wins.some((w) => w.isVisible()),
      focused: BrowserWindow.getFocusedWindow() !== null,
      dock: process.platform === "darwin" ? (electronApp.dock?.isVisible() ?? false) : false,
      loginItem: electronApp.getLoginItemSettings().openAtLogin,
    };
  });
  expect(state).toEqual({ windows: 1, visible: false, focused: false, dock: false, loginItem: false });

  // What the refusals left behind (electron/src/test-hooks.ts). A refusal that
  // leaves no trace cannot be told apart from a feature that stopped working.
  const hooks = await testHooks(app);
  expect(hooks.headless).toBe(true);
  expect(hooks.ready).toBe(true);
  expect(hooks.userDataDir).toBe(userDataDir);
  expect(hooks.tray).not.toContain("created");
  expect(hooks.notifications).toEqual([]);
  expect(hooks.loginItem).toEqual([]);

  // A recorded accelerator is one a non-headless run WOULD have registered.
  // None of them reached the OS, so no chord is taken from whoever is using
  // the machine.
  const chords = [
    ...new Set([...hooks.shortcutsRegistered, ...Object.values(DEFAULT_DESKTOP_SHORTCUTS)]),
  ].filter((chord): chord is string => typeof chord === "string");
  const held = await app.evaluate(
    ({ globalShortcut }, candidates) => candidates.filter((chord) => globalShortcut.isRegistered(chord)),
    chords,
  );
  expect(held).toEqual([]);

  // Everything above is the headless contract itself and is asserted on every
  // platform. Whether a frame can be read back OUT of a never-shown window is
  // not part of it, and is not the same answer everywhere: on macOS the window
  // keeps a compositor surface whatever its ordering, so `page.screenshot()`
  // resolves and a headless run can be screenshotted for the store and for
  // debugging. On X11 an unmapped window has no surface to copy from, the CDP
  // capture is queued and never answered, and the call sits there until
  // Playwright's timeout. That is the same limitation
  // `scripts/desktop-linux-smoke.mjs` runs the window SHOWN under Xvfb to work
  // around, and that smoke test — not this line — is the proof that the app
  // renders on Linux.
  //
  // Not skipped with `test.skip` on Linux: that would report the whole test as
  // skipped and hide the assertions above, which are the ones that matter.
  if (process.platform !== "linux") {
    expect((await page.screenshot()).byteLength).toBeGreaterThan(1000);
  }
});

test("DevTools cannot be opened and the menu has no reload or inspector", async () => {
  ({ app, page } = await launchApp());
  await openLogin(page);
  const result = await app.evaluate(async ({ BrowserWindow, Menu }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.webContents.openDevTools();
    await new Promise((r) => setTimeout(r, 500));
    const roles: string[] = [];
    const walk = (items: Electron.MenuItem[]): void => {
      for (const item of items) {
        if (item.role) roles.push(String(item.role).toLowerCase());
        if (item.submenu) walk(item.submenu.items);
      }
    };
    walk(Menu.getApplicationMenu()?.items ?? []);
    return { opened: win.webContents.isDevToolsOpened(), roles };
  });
  expect(result.opened).toBe(false);
  expect(result.roles).not.toContain("toggledevtools");
  expect(result.roles).not.toContain("reload");
  expect(result.roles).not.toContain("forcereload");
});

test("a second launch on the same profile exits and leaves the first running", async () => {
  let userDataDir: string;
  ({ app, page, userDataDir } = await launchApp());
  await openLogin(page);

  const second = spawn(electronExecutable(), [MAIN_JS], { env: launchEnv(userDataDir), stdio: "ignore" });
  const code = await new Promise<number | null>((done, reject) => {
    const timer = setTimeout(() => {
      second.kill("SIGKILL");
      reject(new Error("the second instance did not exit within 20s"));
    }, 20_000);
    second.once("exit", (exitCode) => {
      clearTimeout(timer);
      done(exitCode);
    });
  });
  expect(code).toBe(0);
  expect(await page.evaluate(() => location.origin)).toBe(APP_ORIGIN);
  expect(app.windows()).toHaveLength(1);
});

test("a mailto: link is handed to the OS, not dropped", async () => {
  ({ app, page } = await launchApp());
  await openLogin(page);
  const before = page.url();
  // Headless, the OS hand-off is recorded instead of opening a mail client
  // (electron/src/external.ts). A stub of shell.openExternal would never be
  // reached: nothing calls it while headless. And it really is never called —
  // a trap replaces it for the whole spec.
  await app.evaluate(({ shell }) => {
    shell.openExternal = async () => {
      throw new Error("shell.openExternal called in a headless launch");
    };
  });

  await page.evaluate(() => {
    const anchor = document.createElement("a");
    anchor.href = "mailto:support@example.com";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  });
  await expect.poll(() => openedExternally(app)).toEqual(["mailto:support@example.com"]);
  expect(page.url()).toBe(before);
});

test("a profile last closed maximised or fullscreen still launches hidden", async () => {
  // BrowserWindow.maximize() shows a hidden window, so restoring the saved
  // state before ready-to-show put a window on screen before the page painted.
  const userDataDir = freshUserDataDir();
  writeFileSync(
    join(userDataDir, WINDOW_STATE_FILE),
    JSON.stringify({ bounds: { x: 40, y: 40, width: 1000, height: 700 }, maximized: true, fullscreen: true }),
  );
  ({ app, page } = await launchApp(userDataDir));
  await openLogin(page);
  // Give a stray show or fullscreen transition time to happen.
  await page.waitForTimeout(1000);
  const state = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return {
      visible: win.isVisible(),
      fullscreen: win.isFullScreen(),
      focused: BrowserWindow.getFocusedWindow() !== null,
    };
  });
  expect(state).toEqual({ visible: false, fullscreen: false, focused: false });
});
