import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";

import {
  API_ORIGIN,
  APP_ORIGIN,
  SECURE_STORE_FILE,
  appRequests,
  createAccount,
  launchApp,
  openLogin,
  signInThroughForm,
  type Account,
  type DesktopWindow,
} from "./support";

/*
 * Signed in on the desktop app, with a bearer token and no cookie anywhere.
 *
 * The app's document origin is `app://-`, so every API call is cross-site. A
 * cookie would need SameSite=None and would be a second, silent credential
 * that masks a broken bearer path. The claim "no cookie" can only be checked
 * where the requests arrive, so these specs read the server-side request log
 * (record-requests.mjs) rather than anything the page reports about itself.
 */

let app: ElectronApplication | null = null;

test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = null;
});

async function signedIn(): Promise<{ page: Page; account: Account; userDataDir: string; since: number }> {
  const since = Date.now();
  const launched = await launchApp();
  app = launched.app;
  const account = await createAccount();
  await signInThroughForm(launched.page, account);
  return { page: launched.page, account, userDataDir: launched.userDataDir, since };
}

test("control: the server-side log does see a cookie when one is sent", async () => {
  // Without this, "no request carried a Cookie" could be a recorder that never
  // notices one. The main process adds a cookie to prove the recorder works.
  const since = Date.now();
  const launched = await launchApp();
  app = launched.app;
  await openLogin(launched.page);
  await app.evaluate(({ session }, api) => {
    session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [`${api}/*`] }, (details, callback) => {
      callback({ requestHeaders: { ...details.requestHeaders, Cookie: "control=1" } });
    });
  }, API_ORIGIN);
  await launched.page.evaluate((api) => fetch(`${api}/api/health`).then((r) => r.status), API_ORIGIN);
  await expect.poll(() => appRequests(since).some((r) => r.url === "/api/health" && r.cookie)).toBe(true);
});

test("signs in from app://-; the server sees a bearer token and never a cookie", async () => {
  const { page, since } = await signedIn();

  // The document really is the app scheme's, not a dev server's and not
  // file://, whose origin is the string "null".
  expect(await page.evaluate(() => location.origin)).toBe(APP_ORIGIN);

  // The token is in the main process's store, not in the document.
  const stored = await page.evaluate(() =>
    (window as unknown as DesktopWindow).electronAPI.secureStore.getToken(),
  );
  expect(typeof stored).toBe("string");
  expect(stored?.length).toBeGreaterThan(10);

  // Traffic after sign-in: a reload has the app ask the API who it is.
  await page.reload();
  await expect(page.getByTestId("sign-out")).toBeVisible();

  const fromApp = appRequests(since);
  const signIn = fromApp.filter((r) => r.url.startsWith("/api/auth/sign-in/email") && r.method === "POST");
  expect(signIn).toHaveLength(1);

  // The whole claim: not one request from the app carried a Cookie.
  expect(fromApp.filter((r) => r.cookie)).toEqual([]);

  // And the session travels as a bearer token instead.
  const afterSignIn = fromApp.filter(
    (r) => r.at >= signIn[0].at && r.method !== "OPTIONS" && r.authorization !== null,
  );
  expect(afterSignIn.length).toBeGreaterThan(0);
  expect(afterSignIn.filter((r) => r.authorization !== "Bearer")).toEqual([]);
});

test("quit and relaunch stays signed in, and the token on disk is ciphertext", async () => {
  const { page, userDataDir } = await signedIn();
  const status = await page.evaluate(() =>
    (window as unknown as DesktopWindow).electronAPI.secureStore.status(),
  );
  await app!.close();
  app = null;

  const sessionFile = join(userDataDir, SECURE_STORE_FILE);
  if (!status.persistent) {
    // Linux with no keyring: safeStorage offers no real encryption, so nothing
    // is written, the next launch starts signed out, and the app says so
    // rather than storing a credential in plain sight.
    expect(existsSync(sessionFile)).toBe(false);
    const relaunched = await launchApp(userDataDir);
    app = relaunched.app;
    await relaunched.page.waitForURL(/\/login\//);
    return;
  }

  const bytes = readFileSync(sessionFile);
  expect(bytes.length).toBeGreaterThan(16);
  // A session token is "<id>.<signature>": no such text may be on disk.
  expect(bytes.toString("latin1")).not.toMatch(/[A-Za-z0-9]{20,}\.[A-Za-z0-9+/=_-]{20,}/);

  const relaunched = await launchApp(userDataDir);
  app = relaunched.app;
  await relaunched.page.waitForURL(/^app:\/\/-\/dashboard\//, { timeout: 20_000 });
  await expect(relaunched.page.getByTestId("sign-out")).toBeVisible();
});

test("signing out drops the stored token and lands on /login", async () => {
  const { page, userDataDir } = await signedIn();
  await page.getByTestId("sign-out").click();
  await page.waitForURL(/\/login\//);

  const token = await page.evaluate(() =>
    (window as unknown as DesktopWindow).electronAPI.secureStore.getToken(),
  );
  expect(token).toBeNull();
  // Nothing decryptable is left behind for the next launch to pick up.
  expect(existsSync(join(userDataDir, SECURE_STORE_FILE))).toBe(false);
});
