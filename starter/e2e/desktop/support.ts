import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron, type ElectronApplication, type Page } from "@playwright/test";

import { DESKTOP_APP_ORIGIN, type DesktopBridge } from "../../packages/shared/src/desktop-bridge";
import { TEST_HOOKS_GLOBAL, type DesktopTestHooks } from "../../electron/src/test-hooks";

/*
 * What every desktop spec shares: where the build is, how a launch is made,
 * and how to read what the server received.
 *
 * The one file in this folder that carries the project's own identifiers, so
 * the specs, the config and the request recorder stay free of them.
 */

export const REPO_ROOT = resolve(__dirname, "..", "..");
/*
 * The harness runs the UNPACKAGED bundle. A packaged build has the
 * CLI-inspect fuse off, and Playwright's `_electron.launch` needs `--inspect`
 * to attach: against a packaged app it never connects (the reference
 * implementation measured a 15 s timeout). This is the same main process,
 * the same app:// scheme and the same export that a packaged build runs —
 * only the fuses differ. Drive a packaged build with
 * `--remote-debugging-port` and `chromium.connectOverCDP` instead, or use
 * `pnpm test:desktop:linux`, which does exactly that in a container.
 */
export const MAIN_JS = join(REPO_ROOT, "electron", "dist", "main.js");
export const PRELOAD_JS = join(REPO_ROOT, "electron", "dist", "preload.js");
export const EXPORT_DIR = join(REPO_ROOT, "packages", "client", "out-desktop");

/**
 * The API the export is built against. Fixed rather than random, because the
 * URL is baked into the export and a random port would rebuild it every run.
 * Override with DESKTOP_E2E_API_PORT when it is taken.
 */
export const API_PORT = Number(process.env.DESKTOP_E2E_API_PORT ?? "49764");
export const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
export const APP_ORIGIN = DESKTOP_APP_ORIGIN;

/** Set by the harness on every launch (electron/src/headless.ts). */
export const HEADLESS_ENV = "{{envPrefix}}_HEADLESS";
/** Moves `userData`, and with it the single-instance lock (electron/src/profile.ts). */
export const USER_DATA_DIR_ENV = "{{envPrefix}}_USER_DATA_DIR";

/** Marks the harness's own requests in the server log (record-requests.mjs). */
export const HARNESS_UA = "desktop-e2e-harness";
/** The header the app names itself with; recorded for every request. */
export const CLIENT_HEADER = "{{clientHeader}}";

/** Files the main process keeps in `userData`, asserted by name in the specs.
 *  They mirror electron/src/desktop-settings.ts and electron/src/window-state.ts. */
export const DESKTOP_SETTINGS_FILE = "desktop-settings.json";
export const WINDOW_STATE_FILE = "window-state.json";
/** The encrypted session token (electron/src/secure-store.ts). */
export const SECURE_STORE_FILE = "session.bin";
/** electron/src/external.ts records here instead of opening a browser. */
export const OPENED_EXTERNALLY_GLOBAL = "__desktopOpenedExternally";

/**
 * The signed-in routes of the generated app. A hard-coded list rather than a
 * parse of the navigation component: this is a template, and the app it is
 * stamped into owns its own screens. Add a route here the day you add one.
 */
export const PROTECTED_ROUTES = ["/dashboard", "/profile", "/settings"] as const;

/** The electron executable, as scripts/ensure-electron.mjs installed it. */
export function electronExecutable(): string {
  const dir = resolve(REPO_ROOT, "node_modules", "electron");
  const executable = join(dir, "dist", readFileSync(join(dir, "path.txt"), "utf8").trim());
  if (!existsSync(executable)) throw new Error(`No Electron binary at ${executable}; run pnpm electron:ensure`);
  return executable;
}

export function freshUserDataDir(): string {
  return mkdtempSync(join(tmpdir(), "{{projectSlug}}-desktop-e2e-"));
}

export function launchEnv(userDataDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  // Never the dev URL: these specs are about the app:// build.
  delete env.ELECTRON_DEV_URL;
  // An inherited ELECTRON_RUN_AS_NODE (some tool runners set it) turns the
  // binary into plain Node and the launch hangs.
  delete env.ELECTRON_RUN_AS_NODE;
  // A fresh profile per launch, so one spec cannot inherit another's session,
  // settings or single-instance lock.
  env[USER_DATA_DIR_ENV] = userDataDir;
  // Never show, focus or activate a window while tests run on somebody's
  // machine (electron/src/headless.ts). shell.spec.ts asserts the contract.
  env[HEADLESS_ENV] = "1";
  return env;
}

/**
 * Uncaught page errors and CSP violations, collected from the moment of the
 * call. A route can "render" its shell while its own chunk was blocked, so the
 * navigation specs assert this stays empty.
 */
export function collectPageProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error" && /Content Security Policy|Refused to (load|execute|connect|apply)/i.test(text)) {
      problems.push(`csp: ${text}`);
    }
  });
  return problems;
}

export async function launchApp(userDataDir = freshUserDataDir()): Promise<{
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
}> {
  const app = await _electron.launch({
    executablePath: electronExecutable(),
    args: [MAIN_JS],
    env: launchEnv(userDataDir),
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page, userDataDir };
}

/** The hooks as they cross `evaluate`: the same record, minus the updater's
 *  callback, which is not serializable. */
export type SerializedTestHooks = Omit<DesktopTestHooks, "update"> & { update: { restarts: number } };

/**
 * What the main process recorded instead of touching the machine
 * (electron/src/test-hooks.ts). Read through JSON, because the hooks carry
 * the memory updater's callback and a function cannot cross `evaluate`.
 */
export async function testHooks(app: ElectronApplication): Promise<SerializedTestHooks> {
  const json = await app.evaluate(
    (_electron, name) => JSON.stringify((globalThis as Record<string, unknown>)[name] ?? null),
    TEST_HOOKS_GLOBAL,
  );
  const hooks = JSON.parse(json) as SerializedTestHooks | null;
  if (!hooks) throw new Error(`No ${TEST_HOOKS_GLOBAL} in the main process; is this build current?`);
  return hooks;
}

/**
 * What the app handed to the OS browser or mail client. Headless launches open
 * nothing (electron/src/external.ts); they record it here.
 */
export function openedExternally(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(
    (_electron, name) => ((globalThis as Record<string, unknown>)[name] as string[] | undefined) ?? [],
    OPENED_EXTERNALLY_GLOBAL,
  );
}

/**
 * `window` inside a page evaluate, with the bridge the preload exposed. The
 * renderer's own declaration lives in packages/client/src/types/electron.d.ts;
 * these specs state it themselves so a spec file compiles on its own.
 */
export type DesktopWindow = Window & { electronAPI: DesktopBridge };

export type Account = { email: string; password: string; name: string };

/** A fresh account on the harness API, created from Node. */
export async function createAccount(origin = API_ORIGIN): Promise<Account> {
  const account = {
    email: `desktop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
    password: "desktop-e2e-password-1",
    name: "Desktop E2E",
  };
  const response = await fetch(`${origin}/api/auth/sign-up/email`, {
    method: "POST",
    // Node's fetch sends `Sec-Fetch-Mode: cors`, which makes better-auth
    // demand a trusted Origin; the harness API trusts the app's.
    headers: { "content-type": "application/json", origin: APP_ORIGIN, "user-agent": HARNESS_UA },
    body: JSON.stringify(account),
  });
  if (!response.ok) throw new Error(`sign-up failed: ${response.status} ${await response.text()}`);
  return account;
}

/**
 * A second session for the same account, standing in for "the web app on
 * another machine": a bearer token. Everything a spec does from outside the
 * desktop app goes through it, so the app's own session stays the only thing
 * under test.
 */
export async function webSession(account: Account, origin = API_ORIGIN): Promise<string> {
  const response = await fetch(`${origin}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: APP_ORIGIN,
      "user-agent": HARNESS_UA,
      [CLIENT_HEADER]: "web",
    },
    body: JSON.stringify({ email: account.email, password: account.password }),
  });
  const token = response.headers.get("set-auth-token");
  if (!response.ok || !token) throw new Error(`sign-in failed: ${response.status} ${await response.text()}`);
  return token;
}

/** An auth API call as that session. */
export async function authCall(
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
  origin = API_ORIGIN,
): Promise<{ status: number; body: unknown; token: string | null }> {
  const response = await fetch(`${origin}/api/auth${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      "content-type": "application/json",
      origin: APP_ORIGIN,
      authorization: `Bearer ${token}`,
      "user-agent": HARNESS_UA,
      [CLIENT_HEADER]: "web",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: response.status, body, token: response.headers.get("set-auth-token") };
}

/**
 * Put the page on the login screen, wherever the shell opened. A generated app
 * may open on a public landing page or straight on /login, and the specs below
 * care about the login form rather than which of the two it is.
 */
export async function openLogin(page: Page): Promise<void> {
  if (!/^app:\/\/-\/login\//.test(page.url())) await page.goto(`${APP_ORIGIN}/login/`);
  await page.getByTestId("login-email").waitFor();
}

/** Sign in through the app's own login form, as a person would. */
export async function signInThroughForm(page: Page, account: Account): Promise<void> {
  await openLogin(page);
  await page.getByTestId("login-email").fill(account.email);
  await page.getByTestId("login-password").fill(account.password);
  await page.getByTestId("login-submit").click();
  await page.waitForURL(/^app:\/\/-\/dashboard\/?(\?.*)?$/);
}

export type LoggedRequest = {
  at: number;
  kind: "request" | "upgrade";
  method: string;
  url: string;
  origin: string | null;
  client: string | null;
  cookie: boolean;
  authorization: string | null;
  protocol: string | null;
  harness: boolean;
};

/** Requests the app itself sent: its origin, and not one of the harness's own. */
export function appRequests(since = 0, log = process.env.DESKTOP_E2E_REQUEST_LOG): LoggedRequest[] {
  return apiRequests(since, log).filter((r) => r.origin === APP_ORIGIN && !r.harness);
}

/** What the API received, from record-requests.mjs, optionally since a time. */
export function apiRequests(since = 0, log = process.env.DESKTOP_E2E_REQUEST_LOG): LoggedRequest[] {
  if (!log) throw new Error("DESKTOP_E2E_REQUEST_LOG is not set; run through the desktop Playwright config");
  return readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LoggedRequest)
    .filter((entry) => entry.at >= since);
}
