/*
 * The store-client trust switch — what makes a published phone, desktop
 * or extension build able to sign in to a stranger's fresh instance with
 * no manual step.
 *
 * ---------------------------------------------------------------------
 * The failure this closes
 * ---------------------------------------------------------------------
 *
 * A native shell loads the web bundle from its OWN document origin:
 * `capacitor://localhost` on iOS, `https://localhost` on Android,
 * `app://-` in Electron, `tauri://localhost` in Tauri, a
 * `chrome-extension://<id>` for a published extension. better-auth
 * refuses a request whose `Origin` is not in its trusted list with
 * `403 INVALID_ORIGIN` — before it ever looks at the password.
 *
 * So on a fresh self-hosted instance every sign-in from a store-installed
 * client fails, the person has no way to know why (a same-origin request
 * produces no CORS message; it is a plain 403 with no explanation in the
 * console), and curl cannot reproduce it: better-auth only force-validates
 * `Origin` when the request carries `Sec-Fetch-*` headers, which browsers
 * and WebViews send and curl does not. The shell test therefore passes
 * against a server a phone cannot sign in to.
 *
 * ---------------------------------------------------------------------
 * How it is switched
 * ---------------------------------------------------------------------
 *
 * Every key here is read by the starter's own server, in
 * {@link SERVER_TRUST_CONFIG_REL} — `getTrustedOrigins()` appends
 * {@link STORE_CLIENT_ORIGINS_KEY} unless {@link TRUST_STORE_APPS_KEY} is
 * explicitly false, and the CORS delegate, better-auth's `trustedOrigins`
 * and the socket upgrade all ask one rule about the unlistable extension
 * shape. So these are settings, not a contract somebody still has to
 * implement: renaming one here without renaming it there gives a compose
 * file full of values the server ignores, which is the failure at the top
 * of this comment wearing a switch that looks like it is on. The test
 * greps that file for these constants for exactly that reason.
 *
 * ONE boolean, {@link TRUST_STORE_APPS_KEY}, defaulting to ON in the
 * self-host compose. The origins it turns on are derived from
 * `nativeClientOrigins` and the project's features — never a hardcoded
 * copy, because that list is also what the scaffolder writes into
 * `.env.example` and what `hatchkit` merges into TRUSTED_ORIGINS on the
 * owner's own deploy, and three copies of it would drift.
 *
 * {@link TRUST_EXTENSION_ORIGINS_KEY} is the companion for the extension
 * flavour whose origin is a fresh identifier per install
 * (`moz-extension://<uuid>`). No trust list can hold it: a value that
 * works on one machine is wrong on every other. That shape is trusted by
 * shape instead, and ONLY for requests carrying no session cookie — such
 * a client signs in with a bearer token, and a request from an unlistable
 * origin then never gets a credentialed answer. That restriction is what
 * stops any other extension in the same browser from riding the person's
 * signed-in session. Unset, the switch follows the main one.
 */

import { nativeClientOrigins } from "../../scaffold/native-origins.js";
import type { OperationalProject } from "../operational-context.js";
import type { SelfHostOptions } from "./compose.js";

/** Where the generated project's server reads these switches, relative to
 *  the project root. Exported so the test can grep that file for the keys
 *  below: the compose file and the server have to spell them the same
 *  way, and a rename on one side alone is silent — the stack boots, the
 *  switch reads as on, and every store client is still refused. */
export const SERVER_TRUST_CONFIG_REL = "packages/server/src/config/env.ts";

/** The one boolean. On by default in the self-host compose, and on by
 *  default in the server too when the key is absent entirely. */
export const TRUST_STORE_APPS_KEY = "TRUST_STORE_APPS";

/** The companion switch for origins that can only be matched by shape.
 *  Empty means "follow TRUST_STORE_APPS". */
export const TRUST_EXTENSION_ORIGINS_KEY = "TRUST_EXTENSION_ORIGINS";

/** The derived list itself, passed to the server so the switch has
 *  something concrete to turn on. Exposed as a variable rather than
 *  compiled into the image so a self-hoster can see exactly which
 *  origins their instance accepts, and override them. */
export const STORE_CLIENT_ORIGINS_KEY = "STORE_CLIENT_ORIGINS";

/** Extra origins on top of everything above. Almost everyone leaves it
 *  empty; it is where a self-built extension's id goes. */
export const TRUSTED_ORIGINS_KEY = "TRUSTED_ORIGINS";

/** The origin shape {@link TRUST_EXTENSION_ORIGINS_KEY} covers. Written
 *  into the generated comments so the reason it cannot be listed is
 *  visible at the switch. */
export const UNLISTABLE_EXTENSION_ORIGIN_SHAPE = "moz-extension://<uuid>";

/**
 * Origins of the project's published store clients, in a stable order.
 *
 * Derived, never hardcoded: the native shells come straight from
 * `nativeClientOrigins`, so changing the project's features changes this
 * list. A published browser extension's origin is a pinned identifier
 * that only the project knows, so it arrives through
 * {@link SelfHostOptions.extensionId} and is absent when no extension is
 * published.
 *
 * Every entry is a bare `scheme://host` with nothing after it: better-auth
 * matches these VERBATIM in production, so a trailing slash is a silent
 * 403.
 */
export function storeClientOrigins(
  project: OperationalProject,
  opts: SelfHostOptions = {},
): string[] {
  const origins = nativeClientOrigins(project.features);
  const id = opts.extensionId?.trim();
  if (id) {
    const origin = id.includes("://") ? id.replace(/\/+$/, "") : `chrome-extension://${id}`;
    if (!origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

export interface TrustSwitch {
  key: string;
  /** Value the self-host compose defaults to. */
  default: string;
  /** Comment lines emitted above it, without the leading `#`. */
  comment: readonly string[];
}

/** The trust block as it appears in the compose file and the env
 *  example: the switch, its companion, the derived list and the escape
 *  hatch, in that order. */
export function trustSwitches(
  project: OperationalProject,
  opts: SelfHostOptions = {},
): TrustSwitch[] {
  const origins = storeClientOrigins(project, opts);
  const named =
    origins.length > 0 ? origins.join(", ") : "none — this project ships no store client";
  return [
    {
      key: TRUST_STORE_APPS_KEY,
      default: "true",
      comment: [
        `Accept sign-ins from the published store clients with no extra step: ${named}.`,
        "",
        "Each of those lets a person type in this server's address, and",
        "without their origins in the trust list every sign-in from them is",
        "refused with 403 INVALID_ORIGIN before the password is checked —",
        "with nothing in the browser console that names the cause, and with",
        "curl unable to reproduce it. Set it to false to accept the web app",
        "only.",
      ],
    },
    {
      key: TRUST_EXTENSION_ORIGINS_KEY,
      default: "",
      comment: [
        "The extension flavour whose origin cannot be listed: every install",
        `gets its own ${UNLISTABLE_EXTENSION_ORIGIN_SHAPE} address, so a value that works on`,
        "your machine is wrong on everybody else's. Those origins are",
        "trusted by SHAPE instead, and only for requests carrying no session",
        "cookie — such a client signs in with a bearer token, and a request",
        "from an unlistable origin then never gets a credentialed answer,",
        "which is what stops any other extension in the same browser from",
        `riding your session. Unset, it follows ${TRUST_STORE_APPS_KEY} above.`,
      ],
    },
    {
      key: STORE_CLIENT_ORIGINS_KEY,
      default: origins.join(","),
      comment: [
        `The list ${TRUST_STORE_APPS_KEY} turns on, spelled out so you can see exactly`,
        "what your instance accepts. Derived from the project's features —",
        "edit it only to remove a client you do not want.",
      ],
    },
    {
      key: TRUSTED_ORIGINS_KEY,
      default: "",
      comment: [
        "Extra origins allowed to sign in, comma-separated, on top of the",
        "web app's own and the store clients above. Empty is right for",
        "almost everyone. Add an extension id here only for a build you made",
        "yourself, whose id differs from the published one.",
      ],
    },
  ];
}

/** The trust switches as compose `environment:` lines, comments included,
 *  with no indentation — the compose renderer indents them. */
export function trustComposeLines(
  project: OperationalProject,
  opts: SelfHostOptions = {},
): string[] {
  const lines: string[] = [""];
  for (const sw of trustSwitches(project, opts)) {
    for (const line of sw.comment) lines.push(line ? `# ${line}` : "#");
    lines.push(`${sw.key}: \${${sw.key}:-${sw.default}}`);
    lines.push("");
  }
  lines.pop();
  return lines;
}
