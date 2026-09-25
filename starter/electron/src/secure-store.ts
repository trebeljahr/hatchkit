/*
 * The session token's home: `userData/session.bin`, encrypted with Electron's
 * `safeStorage` (the macOS Keychain, DPAPI on Windows, libsecret or kwallet on
 * Linux). The renderer reaches it only through the bridge (preload.ts) and
 * never sees the file, the path or the key.
 *
 * Why a file and not `localStorage`: the token is a credential. `localStorage`
 * sits in the profile as plain LevelDB that anything able to read the person's
 * files can copy; `session.bin` is ciphertext whose key the OS guards.
 *
 * **The Linux trap.** With no keyring (a bare window manager, a headless box)
 * `safeStorage` still "works": `getSelectedStorageBackend()` answers
 * `basic_text`, which encrypts with a key hardcoded into Chromium. That is
 * obfuscation, and writing a credential under it would look secure and not be.
 * So this store refuses to persist there: the token lives in memory for this
 * run, the next launch starts signed out, and `status()` says so, which the
 * settings screen shows.
 *
 * No `electron` import. `safeStorage` and the file system are injected, so
 * every branch is a unit test in plain Node (secure-store.test.ts) — the test
 * runner is `node --test`, where importing `electron` throws. `main.ts` binds
 * the real one with `safeStorageEncryption(safeStorage, process.platform)`.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { DesktopSecureStoreStatus } from "../../packages/shared/src/desktop-bridge.ts";

export const SESSION_FILE = "session.bin";

/**
 * The Chromium command-line switch a headless launch appends before the app is
 * ready, so no real credential item is created on the machine running the
 * tests.
 *
 * Chromium's OSCrypt — cookie encryption, and `safeStorage` behind this store —
 * otherwise reads or creates a "<app name> Safe Storage" item in the login
 * keychain, and macOS may answer a binary whose signature differs from the
 * item's creator (a rebuilt ad-hoc signed app) with a system password prompt,
 * which takes focus. The mock keychain is a fixed in-process key: encryption
 * still round-trips, so a headless run exercises this same store, but its
 * ciphertext is readable only by another headless run. That is also why a
 * headless run gets its own profile (profile.ts) — the installed app's
 * `session.bin` would not decrypt here, and `createSecureStore` deletes a
 * ciphertext that does not decrypt.
 *
 * Measured by the reference implementation: with the switch no keychain item
 * is created, and without it one is.
 */
export const MOCK_KEYCHAIN_SWITCH = "use-mock-keychain";

/** Linux backends that are not encryption, whatever the API calls them. */
const INSECURE_BACKENDS: ReadonlySet<string> = new Set(["basic_text", "unknown"]);

export interface Encryption {
  isAvailable: () => boolean;
  /** The backend name, as `status().backend` reports it. */
  backend: () => string;
  encrypt: (plain: string) => Buffer;
  decrypt: (cipher: Buffer) => string;
}

export interface SessionFile {
  read: () => Buffer | null;
  write: (data: Buffer) => void;
  remove: () => void;
}

export interface SecureStore {
  getToken: () => string | null;
  setToken: (token: string) => DesktopSecureStoreStatus;
  deleteToken: () => void;
  status: () => DesktopSecureStoreStatus;
}

export interface SecureStoreOptions {
  /** The profile directory (`userData`); the token file is written inside it. */
  dir: string;
  encryption: Encryption;
  /** Overridden by the tests; `sessionFileAt(dir)` otherwise. */
  file?: SessionFile;
}

/**
 * Synchronous on purpose. The IPC handlers in `main.ts` return these values
 * straight from `ipcMain.handle`, which resolves a plain return value into the
 * promise the renderer's `DesktopSecureStore` awaits.
 */
export function createSecureStore(options: SecureStoreOptions): SecureStore {
  const { encryption } = options;
  const file = options.file ?? sessionFileAt(options.dir);

  /** This run's token. The only copy when the backend cannot persist. */
  let memory: string | null = null;
  let loaded = false;

  const status = (): DesktopSecureStoreStatus => {
    if (!encryption.isAvailable()) return { persistent: false, backend: "unavailable" };
    const backend = encryption.backend();
    return { persistent: !INSECURE_BACKENDS.has(backend), backend };
  };

  const load = (): void => {
    if (loaded) return;
    loaded = true;
    if (!status().persistent) {
      // A file left from a run that did persist (a keyring since removed)
      // cannot be read safely either way; it is not decrypted here.
      return;
    }
    const data = file.read();
    if (data === null || data.length === 0) return;
    try {
      const token = encryption.decrypt(data);
      memory = token.length > 0 ? token : null;
    } catch {
      // The key changed (a new keychain, a profile copied to another machine,
      // a headless run on the mock keychain): this ciphertext will never
      // decrypt again. Signed out, and the dead file goes, so the next launch
      // does not try again.
      memory = null;
      file.remove();
    }
  };

  return {
    getToken: () => {
      load();
      return memory;
    },
    setToken: (token) => {
      load();
      const current = status();
      if (token.length === 0) return current;
      memory = token;
      if (current.persistent) {
        file.write(encryption.encrypt(token));
      } else {
        // Never leave an older ciphertext behind a token that was not written.
        file.remove();
      }
      return current;
    },
    deleteToken: () => {
      loaded = true;
      memory = null;
      file.remove();
    },
    status,
  };
}

/** The file half, atomic and owner-only. */
export function sessionFileAt(userData: string): SessionFile {
  const target = path.join(userData, SESSION_FILE);
  return {
    read: () => {
      try {
        return readFileSync(target);
      } catch {
        return null;
      }
    },
    write: (data) => {
      mkdirSync(userData, { recursive: true });
      const temp = `${target}.${process.pid}.tmp`;
      writeFileSync(temp, data, { mode: 0o600 });
      renameSync(temp, target);
    },
    remove: () => {
      rmSync(target, { force: true });
    },
  };
}

/** The platform name for a backend `safeStorage` does not name itself. */
export function platformBackend(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "keychain";
  if (platform === "win32") return "dpapi";
  return "unknown";
}

/**
 * Electron's `safeStorage`, as much of it as this store uses. Structural, so
 * this module imports no `electron` and the test drives a fake.
 */
export interface SafeStorageLike {
  isEncryptionAvailable: () => boolean;
  encryptString: (plain: string) => Buffer;
  decryptString: (cipher: Buffer) => string;
  /** Linux only; `platformBackend` names the other two. */
  getSelectedStorageBackend?: () => string;
}

export function safeStorageEncryption(
  safeStorage: SafeStorageLike,
  platform: NodeJS.Platform,
): Encryption {
  return {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    backend: () => {
      if (platform !== "linux") return platformBackend(platform);
      try {
        return safeStorage.getSelectedStorageBackend?.() ?? "unknown";
      } catch {
        return "unknown";
      }
    },
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (cipher) => safeStorage.decryptString(cipher),
  };
}
