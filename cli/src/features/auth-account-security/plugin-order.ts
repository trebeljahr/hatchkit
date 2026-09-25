/*
 * cli/src/features/auth-account-security/plugin-order.ts — the one rule
 * in this feature that fails silently when it is broken.
 *
 * better-auth runs plugin `after` hooks in REGISTRATION ORDER. Several of
 * the plugins here replace the session that the sign-in endpoint just
 * created:
 *
 *   • `twoFactor` deletes the session password sign-in made and answers
 *     `{ twoFactorRedirect: true }` instead. The real session appears
 *     only after `/two-factor/verify-totp`.
 *   • `emailOTP` and `magicLink` each create their own session on verify.
 *
 * `bearer` emits the `set-auth-token` response header for whatever
 * session exists when ITS after-hook runs. Register it before any of the
 * above and it hands a token client a credential for a session that a
 * later hook has already deleted — every subsequent request answers 401,
 * the client believes it is signed in, and nothing anywhere logs an
 * error. So `bearer` goes LAST, after every plugin that can swap the
 * session out from under it.
 *
 * `ORDERED_SERVER_PLUGINS` is the single source of truth for that order.
 * It is enforced three ways: the generator emits it, `assertPluginOrder`
 * refuses to build a wrong plan, and `findPluginOrderViolation` reads the
 * GENERATED `auth.ts` back off disk in the test suite — a rule proven
 * against the source, not against the code that wrote it.
 */

import type { AuthSecurityOption } from "./types.js";

/** Server plugin call expressions, in mandatory registration order.
 *  Index in this array IS the ordering contract. */
export const ORDERED_SERVER_PLUGINS: readonly string[] = [
  "twoFactorPlugin",
  "emailOtpPlugin",
  "magicLinkPlugin",
  "passkeyPlugin",
  // Always last. See the file header.
  "bearer",
] as const;

/** Client plugin call expressions, in the same order. better-auth's
 *  client plugins carry no after-hooks, so the order is cosmetic there —
 *  keeping it identical is what makes a side-by-side diff of the two
 *  files readable. */
export const ORDERED_CLIENT_PLUGINS: readonly string[] = [
  "twoFactorClient",
  "emailOTPClient",
  "magicLinkClient",
  "passkeyClient",
] as const;

/** Which option contributes which server plugin. Options that add no
 *  plugin (account deletion, avatars, credentials) are absent. */
const SERVER_PLUGIN_BY_OPTION: Partial<Record<AuthSecurityOption, string>> = {
  "two-factor": "twoFactorPlugin",
  "email-otp": "emailOtpPlugin",
  "magic-link": "magicLinkPlugin",
  passkeys: "passkeyPlugin",
};

const CLIENT_PLUGIN_BY_OPTION: Partial<Record<AuthSecurityOption, string>> = {
  "two-factor": "twoFactorClient",
  "email-otp": "emailOTPClient",
  "magic-link": "magicLinkClient",
  passkeys: "passkeyClient",
};

/** Sort an unordered set of plugin names into the mandatory order.
 *  Unknown names are an internal error, not something to pass through —
 *  a typo would otherwise sort to the end and land after `bearer`. */
function sortByContract(names: Iterable<string>, contract: readonly string[]): string[] {
  const seen = new Set(names);
  for (const name of seen) {
    if (!contract.includes(name)) {
      throw new Error(
        `Unknown better-auth plugin "${name}". Add it to the ordered contract in plugin-order.ts — plugins outside the contract have no defined position relative to bearer().`,
      );
    }
  }
  return contract.filter((name) => seen.has(name));
}

/** The server plugin list for a selection, already in mandatory order.
 *  `bearer` is added when the project ships a native shell: only a
 *  client that cannot hold a cookie needs a token. */
export function serverPluginsFor(
  options: readonly AuthSecurityOption[],
  opts: { hasNativeClient: boolean },
): string[] {
  const names = new Set<string>();
  for (const option of options) {
    const plugin = SERVER_PLUGIN_BY_OPTION[option];
    if (plugin) names.add(plugin);
  }
  if (opts.hasNativeClient) names.add("bearer");
  return sortByContract(names, ORDERED_SERVER_PLUGINS);
}

/** The client plugin list for a selection, in the same order. */
export function clientPluginsFor(options: readonly AuthSecurityOption[]): string[] {
  const names = new Set<string>();
  for (const option of options) {
    const plugin = CLIENT_PLUGIN_BY_OPTION[option];
    if (plugin) names.add(plugin);
  }
  return sortByContract(names, ORDERED_CLIENT_PLUGINS);
}

/** Throw unless `plugins` is a subsequence of the mandatory order.
 *  Called by the planner before anything is written, so a bad plan can
 *  never reach a file.
 *
 *  Stricter than {@link describeOrderViolation}, which forgives a name it
 *  does not govern: that leniency is right when reading a project's own
 *  `auth.ts`, where an app may legitimately register plugins of its own,
 *  but wrong here. A name this module does not know has no defined
 *  position relative to `bearer()`, and silently allowing it is how a new
 *  plugin ends up registered after the token is already issued. */
export function assertPluginOrder(plugins: readonly string[]): void {
  for (const name of plugins) {
    if (!ORDERED_SERVER_PLUGINS.includes(name)) {
      throw new Error(
        `Unknown better-auth plugin "${name}" in a generated plugin list. Add it to ORDERED_SERVER_PLUGINS in plugin-order.ts, deciding explicitly whether it belongs before or after bearer() — a plugin that can replace the session must come first.`,
      );
    }
  }
  const violation = describeOrderViolation(plugins, ORDERED_SERVER_PLUGINS);
  if (violation) throw new Error(violation);
}

/** Shared comparison: returns a message when `found` is not in contract
 *  order, or null when it is. Exported for the disk-reading test. */
export function describeOrderViolation(
  found: readonly string[],
  contract: readonly string[] = ORDERED_SERVER_PLUGINS,
): string | null {
  let previousRank = -1;
  let previousName = "";
  for (const name of found) {
    const rank = contract.indexOf(name);
    if (rank === -1) continue; // Not a plugin we govern.
    if (rank < previousRank) {
      return (
        `better-auth plugin order is wrong: ${previousName}() is registered before ${name}(), ` +
        `but after-hooks run in registration order and the required order is ${contract.join(" → ")}. ` +
        `With bearer() ahead of a plugin that replaces the session, a token client stores a credential ` +
        `for a session the later hook has already deleted.`
      );
    }
    previousRank = rank;
    previousName = name;
  }
  return null;
}

/** Extract the registered plugin names, in source order, from a
 *  better-auth `auth.ts`. Deliberately reads TEXT rather than importing
 *  the module: the test that pins the order must fail when somebody
 *  reorders the source, whether or not the project it came from can be
 *  imported in isolation.
 *
 *  Scoped to the `plugins: [...]` array so an unrelated `bearer` in a
 *  comment or an import line cannot register a false position. */
export function extractRegisteredPlugins(source: string): string[] {
  const start = source.search(/\bplugins\s*:\s*\[/);
  if (start === -1) return [];
  const open = source.indexOf("[", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return [];
  const body = source.slice(open + 1, end);
  const found: string[] = [];
  // `name(` at the start of an element. Conditional spreads
  // (`...(x ? [bearer()] : [])`) match too, which is the point — a
  // plugin registered conditionally still occupies a position.
  for (const match of body.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[1];
    if (ORDERED_SERVER_PLUGINS.includes(name)) found.push(name);
  }
  return found;
}

/** Read an `auth.ts` source and return an explanation when its plugin
 *  registration order breaks the contract, or null when it holds.
 *  This is what the test suite calls against generated output. */
export function findPluginOrderViolation(authSource: string): string | null {
  return describeOrderViolation(extractRegisteredPlugins(authSource));
}
