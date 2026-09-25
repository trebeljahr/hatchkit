/*
 * The session token on native, and the one bug that will cost you a day.
 *
 * WHERE IT LIVES: the platform keychain (Keychain Services on iOS, the
 * EncryptedSharedPreferences-backed keystore on Android), via
 * @aparajita/capacitor-secure-storage. Not the preference store — that is
 * plain UserDefaults / SharedPreferences and comes out of an unencrypted
 * device backup in readable form. A session token is a credential: it is
 * tier 1 in the scheme documented at the top of
 * `mobile/preferences-storage.ts`, and tier 1 is only ever the keychain.
 *
 * ---------------------------------------------------------------------------
 * THE CENTRAL TRAP — NEVER RETURN A CAPACITOR PLUGIN HANDLE FROM AN `async`
 * FUNCTION.
 *
 * A Capacitor plugin handle is a Proxy. It answers EVERY property access with
 * a callable, because that is how it forwards arbitrary method names across
 * the bridge. `then` is a property. So the handle is, as far as the language
 * is concerned, a thenable.
 *
 * `async function f() { return Plugin; }` does not resolve with `Plugin`. The
 * promise machinery sees a thenable and ADOPTS it: it calls
 * `Plugin.then(resolve, reject)`. That is a bridge message for a native method
 * called "then" that nobody implements. Nothing answers. The promise neither
 * resolves nor rejects — no error, no rejection, no unhandled-rejection
 * warning, no stack. Every `await` on it hangs forever.
 *
 * What that looks like in the field: with `launchAutoHide: false` on the
 * splash screen — which you want, so the app never flashes an unstyled frame —
 * the splash is hidden by app code that runs after boot. If boot awaits this,
 * boot never finishes, the splash never hides, and the app is a frozen logo on
 * a device with no console attached. The same code is perfectly fine in the
 * browser, where the handle is undefined and the import fails cleanly.
 *
 * The fix is one line of discipline: WRAP THE HANDLE IN A PLAIN OBJECT before
 * returning it. `loadSecureStorage` below does that, and
 * `native-session.test.ts` fails if anyone undoes it.
 * ---------------------------------------------------------------------------
 */

/** Storage key. Single constant so a rename cannot orphan a live session. */
export const SESSION_TOKEN_KEY = "session_token";

/** The plain-object surface callers get. Deliberately NOT the plugin handle. */
export interface SecureStorageApi {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** What the plugin handle looks like, as far as this file uses it. */
interface SecureStoragePlugin {
  get(key: string): Promise<unknown>;
  set(key: string, data: string): Promise<void>;
  remove(key: string): Promise<unknown>;
}

/** Shape of the imported module, or `null` when there is no native plugin. */
export type SecureStorageModule = { SecureStorage?: unknown } | null;

/** Loader contract. */
export type SecureStorageImporter = () => Promise<SecureStorageModule>;

function isNativeShell(): boolean {
  if (typeof window === "undefined") return false;
  const cap = (
    window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }
  ).Capacitor;
  return cap?.isNativePlatform?.() ?? false;
}

/**
 * Real importer. The native gate lives HERE and not in `loadSecureStorage`, so
 * that an injected importer works under a plain Node test runner where
 * `window` does not exist.
 */
const importSecureStorage: SecureStorageImporter = async () => {
  if (!isNativeShell()) return null;
  try {
    return await import("@aparajita/capacitor-secure-storage");
  } catch {
    // Plugin not installed in this build. On web the session rides in the
    // better-auth cookie, so there is nothing to store and nothing to warn
    // about.
    return null;
  }
};

/**
 * Resolves to a PLAIN OBJECT of bound keychain calls, or `null` off native.
 *
 * `importPlugin` is an INJECTION POINT THAT EXISTS FOR THE TEST AND FOR
 * NOTHING ELSE. Application code calls this with no arguments.
 */
export async function loadSecureStorage(
  importPlugin: SecureStorageImporter = importSecureStorage,
): Promise<SecureStorageApi | null> {
  let mod: SecureStorageModule;
  try {
    mod = await importPlugin();
  } catch {
    return null;
  }
  if (!mod || !mod.SecureStorage) return null;

  const plugin = mod.SecureStorage as SecureStoragePlugin;

  // The whole point of this file. `return plugin` here would deadlock every
  // caller — see THE CENTRAL TRAP above. Each method is re-declared on a plain
  // object literal, which has no `then` and is therefore not a thenable.
  return {
    async get(key) {
      try {
        const value = await plugin.get(key);
        return typeof value === "string" ? value : null;
      } catch {
        // Keychain read can fail while the device is locked. Absent, not fatal.
        return null;
      }
    },
    async set(key, value) {
      try {
        await plugin.set(key, value);
      } catch {
        /* keychain unavailable — the caller re-authenticates next launch */
      }
    },
    async remove(key) {
      try {
        await plugin.remove(key);
      } catch {
        /* nothing stored, or keychain unavailable */
      }
    },
  };
}

/** Loader type used by the token helpers, so tests can inject a fake store. */
export type SecureStorageLoader = () => Promise<SecureStorageApi | null>;

/** Reads the stored session token. `null` on web and when nothing is stored. */
export async function getSessionToken(
  load: SecureStorageLoader = loadSecureStorage,
): Promise<string | null> {
  const store = await load();
  if (!store) return null;
  return store.get(SESSION_TOKEN_KEY);
}

/** Persists the session token to the keychain. No-op on web. */
export async function setSessionToken(
  token: string,
  load: SecureStorageLoader = loadSecureStorage,
): Promise<void> {
  const store = await load();
  if (!store) return;
  await store.set(SESSION_TOKEN_KEY, token);
}

/**
 * Removes the token. Call on sign-out BEFORE clearing anything else: a token
 * left in the keychain outlives an app uninstall on iOS, so the next install
 * would silently resume a session the user believes they ended.
 */
export async function clearSessionToken(
  load: SecureStorageLoader = loadSecureStorage,
): Promise<void> {
  const store = await load();
  if (!store) return;
  await store.remove(SESSION_TOKEN_KEY);
}

/**
 * Cheap boot-time question: is there a session worth trying?
 * Lets the shell decide between the signed-in shell and the login screen
 * without a network round trip on a cold, possibly offline start.
 */
export async function hasStoredToken(
  load: SecureStorageLoader = loadSecureStorage,
): Promise<boolean> {
  return (await getSessionToken(load)) != null;
}
