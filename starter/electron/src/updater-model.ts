/*
 * Auto-update, as logic with no Electron in it: which copies update
 * themselves, what the status is after each updater event, and the controller
 * that checks on launch and every six hours. `updater.ts` binds it to
 * electron-updater; every rule here is a unit test (`updater-model.test.ts`)
 * with a fake updater.
 *
 * Two rules fail quietly if broken:
 *
 *   - **Only direct downloads update themselves.** A store or a package
 *     manager owns the files; an in-app updater there either cannot write
 *     (the MAS sandbox, MSIX, a read-only squashfs, Flatpak's /app) or fights
 *     the manager (`distribution.ts`, `selfUpdates`). A build without an
 *     update feed (`app-update.yml`, which electron-builder writes only when
 *     the config has a `publish` entry) does not check either: Squirrel.Mac
 *     refuses an unsigned app, and an unsigned test build must not replace
 *     itself with a release.
 *
 *   - **Never a forced restart.** A download installs when the person quits.
 *     The only call to `quitAndInstall` is `restart()`, and the only callers
 *     of that are the "Restart to update" button and tray item. A restart the
 *     person did not ask for loses whatever they were typing.
 */

import type {
  DesktopUpdateDisabledReason,
  DesktopUpdateSnapshot,
  DesktopUpdateStatus,
} from "../../packages/shared/src/desktop-bridge.ts";
import type { DistributionChannel } from "./distribution.ts";

/** How often a running app looks for a new release. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** The first check waits for the window and the socket, not the network race at launch. */
export const FIRST_CHECK_DELAY_MS = 30_000;
/** Set to 1 on a managed machine to keep the app from updating itself. */
export const DISABLE_UPDATES_ENV = "{{envPrefix}}_DISABLE_UPDATES";

export type UpdaterPolicy =
  | { enabled: true }
  | { enabled: false; reason: DesktopUpdateDisabledReason };

export function updaterPolicy(input: {
  channel: DistributionChannel;
  /** Whether `app-update.yml` is in the app's resources. */
  hasFeed: boolean;
  env: Record<string, string | undefined>;
}): UpdaterPolicy {
  switch (input.channel) {
    case "unpackaged":
      return { enabled: false, reason: "unpackaged" };
    case "mac-app-store":
    case "windows-store":
      return { enabled: false, reason: "store" };
    case "snap":
    case "flatpak":
      return { enabled: false, reason: "sandbox" };
    case "linux-package":
      return { enabled: false, reason: "package-manager" };
    case "mac-direct":
    case "windows-direct":
    case "appimage":
      break;
  }
  if (input.env[DISABLE_UPDATES_ENV] === "1") return { enabled: false, reason: "turned-off" };
  if (!input.hasFeed) return { enabled: false, reason: "no-feed" };
  return { enabled: true };
}

/** What electron-updater reports, reduced to what the status needs. */
export type UpdaterEvent =
  | { kind: "checking" }
  | { kind: "available"; version: string }
  | { kind: "not-available" }
  | { kind: "progress"; percent: number }
  | { kind: "downloaded"; version: string }
  | { kind: "error" };

const lastChecked = (status: DesktopUpdateStatus): string | null =>
  status.kind === "idle" || status.kind === "checking" || status.kind === "error"
    ? status.lastCheckedAt
    : null;

/**
 * The next status. A downloaded update stays "ready" through later checks and
 * their errors: it is still on disk and still installs on quit, and a failed
 * check six hours later must not take the button away. A newer download
 * replaces it.
 */
export function nextUpdateStatus(
  status: DesktopUpdateStatus,
  event: UpdaterEvent,
  nowIso: string,
): DesktopUpdateStatus {
  if (status.kind === "disabled") return status;
  if (status.kind === "ready") {
    return event.kind === "downloaded" ? { kind: "ready", version: event.version } : status;
  }
  switch (event.kind) {
    case "checking":
      return status.kind === "downloading"
        ? status
        : { kind: "checking", lastCheckedAt: lastChecked(status) };
    case "available":
      return { kind: "downloading", version: event.version, percent: null };
    case "not-available":
      return { kind: "idle", lastCheckedAt: nowIso };
    case "progress":
      if (status.kind !== "downloading") return status;
      return { ...status, percent: Math.max(0, Math.min(100, Math.round(event.percent))) };
    case "downloaded":
      return { kind: "ready", version: event.version };
    case "error":
      return {
        kind: "error",
        lastCheckedAt: status.kind === "downloading" ? null : lastChecked(status),
      };
  }
}

/** Whether a new check may start: never on top of one in flight or a download. */
export function mayCheck(status: DesktopUpdateStatus): boolean {
  return status.kind === "idle" || status.kind === "error" || status.kind === "ready";
}

/** The parts of electron-updater's `AppUpdater` the controller uses. */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  checkForUpdates: () => Promise<unknown>;
  quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

export interface Scheduler {
  setTimeout: (fn: () => void, ms: number) => unknown;
  setInterval: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

export interface UpdateController {
  snapshot: () => DesktopUpdateSnapshot;
  /** Starts a check unless one is running; returns the snapshot after starting it. */
  check: () => DesktopUpdateSnapshot;
  /**
   * Quits and installs, only when an update is ready. Called from a person's
   * click and nowhere else.
   */
  restart: () => boolean;
  /** Feeds an event as electron-updater would; the binding and the tests use it. */
  dispatch: (event: UpdaterEvent) => void;
  dispose: () => void;
}

function versionOf(info: unknown): string {
  if (
    typeof info === "object" &&
    info !== null &&
    typeof (info as { version?: unknown }).version === "string"
  ) {
    return (info as { version: string }).version.slice(0, 50);
  }
  return "";
}

export function createUpdateController(options: {
  policy: UpdaterPolicy;
  currentVersion: string;
  /** Called only when the policy allows updates, so a disabled app never loads electron-updater. */
  loadUpdater: () => UpdaterLike;
  scheduler: Scheduler;
  now: () => Date;
  onChange: (snapshot: DesktopUpdateSnapshot) => void;
  /** Right before `quitAndInstall`: lets the window close instead of hiding (window.ts). */
  beforeInstall: () => void;
  /**
   * Whether to check on its own (after `FIRST_CHECK_DELAY_MS` and every
   * `UPDATE_CHECK_INTERVAL_MS`). Default true; `false` in a headless run
   * (updater.ts), where the memory updater answers no event, so a scheduled
   * check would leave the status "checking" forever — a spec that reads the
   * status or counts checks would then fail on nothing but its own timing.
   */
  autoCheck?: boolean;
  log?: (message: string, err?: unknown) => void;
}): UpdateController {
  const log = options.log ?? (() => undefined);
  let status: DesktopUpdateStatus = options.policy.enabled
    ? { kind: "idle", lastCheckedAt: null }
    : { kind: "disabled", reason: options.policy.reason };
  const snapshot = (): DesktopUpdateSnapshot => ({
    currentVersion: options.currentVersion,
    status,
  });

  const dispatch = (event: UpdaterEvent): void => {
    const next = nextUpdateStatus(status, event, options.now().toISOString());
    if (JSON.stringify(next) === JSON.stringify(status)) return;
    status = next;
    options.onChange(snapshot());
  };

  let updater: UpdaterLike | null = null;
  const handles: unknown[] = [];

  if (options.policy.enabled) {
    updater = options.loadUpdater();
    // Download in the background, install on quit. Stable releases only, and
    // never back to an older version a later release was published over.
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.on("checking-for-update", () => dispatch({ kind: "checking" }));
    updater.on("update-available", (info) =>
      dispatch({ kind: "available", version: versionOf(info) }),
    );
    updater.on("update-not-available", () => dispatch({ kind: "not-available" }));
    updater.on("download-progress", (progress) => {
      const percent = (progress as { percent?: unknown } | null)?.percent;
      if (typeof percent === "number" && Number.isFinite(percent)) {
        dispatch({ kind: "progress", percent });
      }
    });
    updater.on("update-downloaded", (info) =>
      dispatch({ kind: "downloaded", version: versionOf(info) }),
    );
    updater.on("error", (err) => {
      log("[updater] error", err);
      dispatch({ kind: "error" });
    });
  }

  const check = (): DesktopUpdateSnapshot => {
    if (updater === null || !mayCheck(status)) return snapshot();
    // electron-updater emits checking-for-update itself; dispatching here too
    // makes the button's state change before the first network round trip.
    dispatch({ kind: "checking" });
    updater.checkForUpdates().catch((err: unknown) => {
      log("[updater] check failed", err);
      dispatch({ kind: "error" });
    });
    return snapshot();
  };

  if (updater !== null && options.autoCheck !== false) {
    handles.push(options.scheduler.setTimeout(check, FIRST_CHECK_DELAY_MS));
    handles.push(options.scheduler.setInterval(check, UPDATE_CHECK_INTERVAL_MS));
  }

  return {
    snapshot,
    check,
    restart: () => {
      if (updater === null || status.kind !== "ready") return false;
      options.beforeInstall();
      // isSilent false: the Windows installer shows its progress.
      // isForceRunAfter true: the app comes back after installing.
      updater.quitAndInstall(false, true);
      return true;
    },
    dispatch,
    dispose: () => {
      for (const handle of handles) options.scheduler.clear(handle);
      handles.length = 0;
    },
  };
}
