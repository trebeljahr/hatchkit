/*
 * The OS credential store, through `@napi-rs/keyring`:
 *   · macOS   → login Keychain (generic passwords; same items keytar wrote)
 *   · Windows → Credential Manager
 *   · Linux   → Secret Service over D-Bus (gnome-keyring, KWallet, KeePassXC)
 *
 * Prebuilt binaries ship for every platform, so `npm i -g hatchkit` needs
 * no compiler. Only secrets.ts imports this module, after the access guard
 * passes; the test runner redirects it to a fixture store.
 *
 * Linux is pinned to Secret Service. The library would otherwise fall back
 * to the kernel keyutils keyring on a box without D-Bus, which lives in
 * memory and loses every token on reboot. A store that forgets silently is
 * worse than one that fails, so that case throws and the error points at
 * `HATCHKIT_SECRET_STORE=file` or `HATCHKIT_SECRET_*` variables instead.
 */

import { AsyncEntry, type EntryOptions, findCredentialsAsync } from "@napi-rs/keyring";

const OPTIONS: EntryOptions = { linux: { store: "secret-service" } };

const entry = (service: string, account: string) => new AsyncEntry(service, account, OPTIONS);

const osKeyring = {
  getPassword(service: string, account: string): Promise<string | null> {
    return entry(service, account).getPassword();
  },
  setPassword(service: string, account: string, password: string): Promise<void> {
    return entry(service, account).setPassword(password);
  },
  deletePassword(service: string, account: string): Promise<boolean> {
    return entry(service, account).deletePassword();
  },
  findCredentials(service: string): Promise<Array<{ account: string; password: string }>> {
    return findCredentialsAsync(service);
  },
};

export type SecretBackend = typeof osKeyring;
export default osKeyring;
