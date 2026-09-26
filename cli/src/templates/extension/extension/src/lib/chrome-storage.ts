/**
 * The two browser stores, bound to the client core's storage seam.
 *
 * `@starter/core` opens no store of its own — a host passes one in,
 * because only the host knows which of its stores answers which
 * question. For an extension there are two, and which one a value goes
 * in is a decision, not a detail:
 *
 *  - `chrome.storage.session` is cleared when the browser closes and is
 *    never written to disk. The session TOKEN and the in-flight device
 *    code live here. The cost is that a browser restart signs the
 *    extension out until a web tab relinks it (or somebody signs in
 *    again in the popup); the benefit is that a copied profile
 *    directory carries no usable session. Do not move the token to
 *    `local` to "fix" the restart without deciding that trade again.
 *  - `chrome.storage.local` survives a restart. The server choice, the
 *    sign-out marker and the link block live here, because they must
 *    outlive the worker being stopped — and none of them is a
 *    credential.
 *
 * Every read and write is wrapped: a quota error or a torn-down area
 * must not take down the popup, and a value that will not decode reads
 * as "signed out" rather than throwing.
 */
import { type KeyValueStorage, memoryStorage } from "@starter/core";

type ChromeArea = {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
};

/**
 * One `chrome.storage` area as the seam, or an in-memory store wherever
 * `chrome` is not there — a vitest run, or the module being imported by
 * a tool. The fallback keeps every caller free of "is this a browser?"
 * branches.
 */
const area = (pick: "local" | "session"): KeyValueStorage => {
  const scope = globalThis as { chrome?: typeof chrome };
  const backing = scope.chrome?.storage?.[pick] as ChromeArea | undefined;
  if (backing === undefined) return memoryStorage();
  return {
    async getItem(key) {
      try {
        const read = await backing.get([key]);
        const value = read[key];
        return typeof value === "string" ? value : null;
      } catch {
        return null;
      }
    },
    async setItem(key, value) {
      try {
        await backing.set({ [key]: value });
      } catch {
        /* quota exceeded or the area is gone — drop silently */
      }
    },
    async removeItem(key) {
      try {
        await backing.remove([key]);
      } catch {
        /* ignore */
      }
    },
  };
};

/** Survives a browser restart. Never the credential. */
export const localStore = (): KeyValueStorage => area("local");

/** Cleared when the browser closes, never written to disk. */
export const sessionStore = (): KeyValueStorage => area("session");
