/*
 * cli/src/features/device-grant/patches.ts — the edits the shared
 * device-grant unit makes to files the starter already ships.
 *
 * Same contract as every other patch module in `cli/src/features/`:
 * pure `string -> { content, changed, problem }`, so
 *
 *  - a second apply reports `changed: false` instead of inserting a
 *    second `plugins:` key. `hatchkit update` re-applies every selected
 *    feature on every run, and this unit is applied once per DEPENDENT,
 *    so within a single run these functions are called twice whenever a
 *    project ships both the browser extension and a launcher extension.
 *    Non-idempotent here means corrupt on the first such project.
 *  - a project whose `auth.ts` a person has rearranged reports a
 *    `problem` line the CLI prints, rather than skipping in silence.
 *    Silence here scaffolds a client that shows a pairing code against a
 *    server with no device endpoint: the code just never turns green.
 *  - the tests drive them with no project on disk.
 */

export interface PatchResult {
  content: string;
  changed: boolean;
  /** Set when the anchor was missing: what the user has to do by hand. */
  problem?: string;
}

const unchanged = (content: string): PatchResult => ({ content, changed: false });

// ---------------------------------------------------------------------------
// packages/server/src/auth/auth.ts
// ---------------------------------------------------------------------------

/**
 * The server plugin imports.
 *
 * Inserted after the server's `../config/env.js` import, matched by
 * SHAPE rather than by its exact text: the browser extension rewrites
 * that same line to pull `trustsExtensionOrigins` in, so an anchor
 * pinned to the starter's spelling would miss it on a project where the
 * extension applied first and silently leave `auth.ts` importing
 * nothing while the plugin block below names `bearer`.
 */
const PLUGIN_IMPORTS = `import { bearer } from "better-auth/plugins";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";`;

/** `import { … } from "../config/env.js";`, whatever names it carries. */
const ENV_IMPORT_LINE = /^import \{[^}]*\} from "\.\.\/config\/env\.js";$/m;

/**
 * The property the plugin block is inserted BEFORE.
 *
 * Not `trustedOrigins: getTrustedOrigins(),`, which was the anchor while
 * this lived inside the extension feature: the extension replaces that
 * exact line with a per-request delegate of its own, so after its patch
 * the line is gone. `emailAndPassword` is untouched by every feature
 * that edits this file, and it is present in both the Mongo starter and
 * the Postgres overlay's rewritten `auth.ts`.
 */
const PLUGINS_ANCHOR = "\n\n    emailAndPassword: {";

/** Marks the block as already present. Also the import guard: the two
 *  are written together, so one without the other cannot happen. */
const APPLIED_MARKER = "better-auth/plugins/device-authorization";

/**
 * `validateClient`'s right-hand side, for `clientIds`.
 *
 * One id renders as a bare `===` comparison and several as a membership
 * test. That is not cosmetic: the single-client form is what a project
 * with only the browser extension has had in its `auth.ts` since before
 * this unit existed, and regenerating it into a different shape would
 * show up as a diff in every such project for no behavioural reason.
 *
 * Ids come from `ctx.identifiers.clientIds`. Never derived here — a
 * device-flow client id is in every token this server has already
 * issued, so a second rule for computing it would refuse clients that
 * are already paired (docs/feature-authoring.md → "Never derive a name").
 */
export function validateClientExpression(clientIds: readonly string[]): string {
  const unique = [...new Set(clientIds)];
  if (unique.length === 0) {
    // Refuse everything rather than accept everything. An empty
    // allowlist means a caller asked for the grant with no dependent
    // selected, which is a bug in the caller; `() => false` makes it a
    // refused pairing attempt instead of an open pairing endpoint.
    return "false";
  }
  if (unique.length === 1) return `clientId === ${JSON.stringify(unique[0])}`;
  return `[${unique.map((id) => JSON.stringify(id)).join(", ")}].includes(clientId)`;
}

/** Already-generated `validateClient` line, so a later dependent can be
 *  added to the allowlist without rewriting the rest of the block. */
const VALIDATE_CLIENT_LINE = /^(\s*validateClient: \(clientId: string\) => )(.*),$/m;

/**
 * The right-hand sides {@link validateClientExpression} can produce.
 *
 * The refresh below rewrites the allowlist only when what is there is
 * one of these. Anything else is a rule a person wrote — a lookup
 * against their own table, an environment switch — and replacing it with
 * a literal list would undo their work on an `update` they ran for an
 * unrelated reason, without failing.
 */
const GENERATED_RHS =
  /^(?:false|clientId === "[^"]*"|\["[^"]*"(?:, "[^"]*")*\]\.includes\(clientId\))$/;

function pluginBlock(clientIds: readonly string[]): string {
  return `    plugins: [
      // Lets a client with no cookie jar — the browser extension, a CLI
      // — sign in normally and then carry its session as
      // \`Authorization: Bearer <token>\`.
      //
      // \`requireSignature\` stays OFF, and that is deliberate: password
      // sign-in returns the SIGNED token on the \`set-auth-token\`
      // header, while the device grant returns the RAW session token as
      // \`access_token\`. Requiring a signature would accept only the
      // first and refuse every device-paired client. It costs nothing:
      // an unsigned value is looked up, and an unknown token matches no
      // session.
      bearer(),

      // RFC 8628, for the clients where typing a password is wrong: a
      // paired client's "Sign in with the web app", and any account with
      // two-factor authentication.
      deviceAuthorization({
        expiresIn: "10m",
        interval: "5s",
        // The code is approved in the WEB APP, which is a different
        // origin from this API in development and in any split
        // deployment. Without this, better-auth points people at the
        // API's own /device, which does not exist.
        verificationUri: \`\${env.FRONTEND_URL.replace(/\\/$/, "")}/device\`,
        // Only clients this server knows may start a flow.
        validateClient: (clientId: string) => ${validateClientExpression(clientIds)},
      }),
    ],`;
}

/**
 * Register `bearer()` and the device grant in `betterAuth({ … })`.
 *
 * Two paths, and the second is the one that matters on `update`: a
 * project that already has the block gets only its client allowlist
 * refreshed. Without that, adding a launcher extension to a project that
 * already ships the browser extension would leave `validateClient`
 * naming the extension alone — the launcher's pairing request is refused
 * with `invalid_client`, which reads to a person like a server outage.
 */
export function wireDeviceGrant(content: string, clientIds: readonly string[]): PatchResult {
  if (content.includes(APPLIED_MARKER)) {
    if (clientIds.length === 0) {
      // Never narrow a working allowlist to nothing. An empty list here
      // means the caller asked with no dependent selected; rewriting the
      // line would unpair every client this server has already issued a
      // token to, and the first anyone would hear of it is support mail.
      return unchanged(content);
    }
    const wanted = validateClientExpression(clientIds);
    let recognised = false;
    const refreshed = content.replace(VALIDATE_CLIENT_LINE, (line, lead: string, rhs: string) => {
      if (!GENERATED_RHS.test(rhs)) return line;
      recognised = true;
      return `${lead}${wanted},`;
    });
    if (recognised) {
      return refreshed === content ? unchanged(content) : { content: refreshed, changed: true };
    }
    // The block is there but its allowlist is not one this unit wrote —
    // somebody rewrote `validateClient` by hand. Leave their code alone
    // and say which ids it now has to accept, because the alternative is
    // a newly-added client whose pairing is refused with `invalid_client`
    // and no hint anywhere that the allowlist is why.
    return {
      content,
      changed: false,
      problem: `packages/server/src/auth/auth.ts: deviceAuthorization's validateClient must accept ${clientIds.join(", ")}.`,
    };
  }

  let out = content;
  const problems: string[] = [];

  if (ENV_IMPORT_LINE.test(out)) {
    out = out.replace(ENV_IMPORT_LINE, (line) => `${line}\n${PLUGIN_IMPORTS}`);
  } else {
    problems.push(
      'packages/server/src/auth/auth.ts: import { bearer } from "better-auth/plugins" and { deviceAuthorization } from "better-auth/plugins/device-authorization".',
    );
  }

  if (out.includes(PLUGINS_ANCHOR)) {
    // A replacer FUNCTION, not a replacement string: the generated block
    // contains `${env.FRONTEND_URL…}` and a `$` run in a replacement
    // string is read as a capture reference, which would silently eat
    // characters out of the emitted template literal.
    out = out.replace(PLUGINS_ANCHOR, () => `\n\n${pluginBlock(clientIds)}${PLUGINS_ANCHOR}`);
  } else {
    problems.push(
      "packages/server/src/auth/auth.ts: add `plugins: [bearer(), deviceAuthorization({ … })]` to the betterAuth({ … }) call.",
    );
  }

  return {
    content: out,
    changed: out !== content,
    problem: problems.length > 0 ? problems.join(" ") : undefined,
  };
}

// ---------------------------------------------------------------------------
// packages/client/src/lib/auth-client.ts
// ---------------------------------------------------------------------------

const AUTH_CLIENT_IMPORT =
  'import { deviceAuthorizationClient } from "better-auth/client/plugins";';
const AUTH_CLIENT_IMPORT_ANCHOR = 'import { createAuthClient } from "better-auth/react";';
/** `createAuthClient({ baseURL: <expr> });` — the expression is a template literal. */
const AUTH_CLIENT_CALL = /createAuthClient\(\{(\s*)baseURL: ([^\n]+?),?(\s*)\}\);/;

/**
 * Give the web app's auth client the device plugin.
 *
 * The approval page calls `authClient.device.approve(...)`. Without the
 * plugin that property does not exist, and because the device typings
 * are read structurally the failure is a runtime `TypeError` on the page
 * a person is staring at — not a build error anyone would catch first.
 */
export function addDeviceClientPlugin(content: string): PatchResult {
  let out = content;
  let changed = false;
  const problems: string[] = [];

  if (!out.includes("better-auth/client/plugins")) {
    if (out.includes(AUTH_CLIENT_IMPORT_ANCHOR)) {
      out = out.replace(
        AUTH_CLIENT_IMPORT_ANCHOR,
        `${AUTH_CLIENT_IMPORT_ANCHOR}\n${AUTH_CLIENT_IMPORT}`,
      );
      changed = true;
    } else {
      problems.push(
        'packages/client/src/lib/auth-client.ts: import { deviceAuthorizationClient } from "better-auth/client/plugins".',
      );
    }
  }

  if (!out.includes("deviceAuthorizationClient()")) {
    if (AUTH_CLIENT_CALL.test(out)) {
      out = out.replace(
        AUTH_CLIENT_CALL,
        (_match, lead: string, baseUrl: string, tail: string) =>
          `createAuthClient({${lead}baseURL: ${baseUrl},${lead}// The device flow a paired client signs in with. Without${lead}// it \`authClient.device\` does not exist and the approval page${lead}// fails at runtime, not at build time.${lead}plugins: [deviceAuthorizationClient()],${tail}});`,
      );
      changed = true;
    } else {
      problems.push(
        "packages/client/src/lib/auth-client.ts: pass `plugins: [deviceAuthorizationClient()]` to createAuthClient.",
      );
    }
  }

  return { content: out, changed, problem: problems.length > 0 ? problems.join(" ") : undefined };
}
