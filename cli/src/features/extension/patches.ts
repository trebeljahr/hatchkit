/*
 * cli/src/features/extension/patches.ts — the edits the extension
 * feature makes to files the starter already ships.
 *
 * Everything here is a pure string -> string function returning
 * `{ content, changed, problem }`, for three reasons:
 *
 *  - `hatchkit update` runs the same code as `hatchkit create`, so each
 *    patch has to be idempotent: applied twice, the second run reports
 *    `changed: false` rather than inserting a second copy.
 *  - a project whose files a user has edited may not have the anchor
 *    the patch looks for. That is reported as a `problem` — a line the
 *    CLI prints for the user to wire by hand — and never as a silent
 *    skip, because the feature does not work without it and nothing
 *    else would say so.
 *  - the tests drive them without a project on disk.
 */

export interface PatchResult {
  content: string;
  changed: boolean;
  /** Set when the anchor was missing: what the user has to do by hand. */
  problem?: string;
}

const unchanged = (content: string): PatchResult => ({ content, changed: false });

// ---------------------------------------------------------------------------
// packages/shared
// ---------------------------------------------------------------------------

const SHARED_EXPORT = 'export * from "./extension-bridge.js";';

/** Re-export the bridge protocol from the shared package's barrel. */
export function addSharedBridgeExport(content: string): PatchResult {
  if (content.includes("./extension-bridge.js")) return unchanged(content);
  const trimmed = content.endsWith("\n") ? content : `${content}\n`;
  return { content: `${trimmed}${SHARED_EXPORT}\n`, changed: true };
}

// ---------------------------------------------------------------------------
// packages/server/src/config/env.ts
// ---------------------------------------------------------------------------
//
// Nothing to patch. The starter ships `TRUST_EXTENSION_ORIGINS` itself,
// as a RAW string resolved by `trustsExtensionOrigins()`, because unset
// has to follow `TRUST_STORE_APPS` — a server that accepts the published
// store clients means to accept this rule too — and a bare `=== "true"`
// coercion cannot express that. So every patch below reads the RESOLVER
// and never the raw env value, which is a string and would be truthy for
// the literal "false".

// ---------------------------------------------------------------------------
// packages/server/src/app.ts
// ---------------------------------------------------------------------------

const APP_IMPORT =
  'import { corsDecisionFor, extensionOriginTrusted } from "./auth/extension-origins.js";';
/** The starter's env import, which also has to grow the resolver. */
const APP_IMPORT_ANCHOR = 'import { env, getTrustedOrigins } from "./config/env.js";';
const APP_IMPORT_ANCHOR_WIRED =
  'import { env, getTrustedOrigins, trustsExtensionOrigins } from "./config/env.js";';

const CORS_ANCHOR = `  app.use(
    cors({
      origin: trustedOrigins.length > 0 ? trustedOrigins : false,
      credentials: true,
    }),
  );`;

const CORS_REPLACEMENT = `  // A per-request delegate rather than a static list. An extension
  // origin is decided by its SHAPE plus the absence of a session
  // cookie, and — this is the load-bearing half — its answer must never
  // carry \`Access-Control-Allow-Credentials\`. Both halves come out of
  // one function, so the CORS answer and better-auth's trusted-origin
  // answer cannot disagree about the same request.
  app.use((req, res, next) => {
    const decision = corsDecisionFor(
      req.headers.origin,
      req.headers.cookie,
      trustedOrigins,
      trustsExtensionOrigins(),
    );
    return cors({
      origin: decision.allowed ? (req.headers.origin ?? false) : false,
      credentials: decision.credentials,
    })(req, res, next);
  });`;

const HEALTH_ANCHOR = `  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      db: isDatabaseReady(),`;

const HEALTH_REPLACEMENT = `  app.get("/api/health", (req, res) => {
    // Answers EVERY origin, deliberately. A client whose origin this
    // server does not trust has all its other requests refused by CORS
    // as a bare TypeError, which is indistinguishable from the server
    // being down — so this route is how it finds out which of the two
    // it is, and it has to get through before the trust decision
    // applies. It carries nothing about any account.
    res.setHeader("Access-Control-Allow-Origin", "*");
    const origin = req.headers.origin;
    res.json({
      status: "ok",
      // Marks this as one of ours, so a client's server picker can tell
      // this API from anything else answering on the same host.
      service: "__HATCHKIT_PROJECT_SLUG__",
      // Where the web app lives. A client that has to check a message
      // came from the web app of THIS server asks here.
      webUrl: env.FRONTEND_URL,
      // Whether the asking origin is trusted. \`null\` means the request
      // carried no Origin header at all (curl, a server-side caller) —
      // which is not the same as untrusted.
      originTrusted:
        origin === undefined
          ? null
          : trustedOrigins.includes(origin) ||
            extensionOriginTrusted({
              origin,
              cookie: req.headers.cookie,
              enabled: trustsExtensionOrigins(),
            }),
      db: isDatabaseReady(),`;

export function wireServerApp(content: string): PatchResult {
  let out = content;
  let changed = false;
  const problems: string[] = [];

  if (!out.includes("./auth/extension-origins.js")) {
    if (out.includes(APP_IMPORT_ANCHOR)) {
      out = out.replace(APP_IMPORT_ANCHOR, `${APP_IMPORT_ANCHOR_WIRED}\n${APP_IMPORT}`);
      changed = true;
    } else {
      problems.push(
        "packages/server/src/app.ts: import corsDecisionFor + extensionOriginTrusted from ./auth/extension-origins.js, and trustsExtensionOrigins from ./config/env.js.",
      );
    }
  }

  if (!out.includes("corsDecisionFor(")) {
    if (out.includes(CORS_ANCHOR)) {
      out = out.replace(CORS_ANCHOR, CORS_REPLACEMENT);
      changed = true;
    } else {
      problems.push(
        "packages/server/src/app.ts: make the cors() call a per-request delegate (see corsDecisionFor).",
      );
    }
  }

  if (!out.includes("originTrusted")) {
    if (out.includes(HEALTH_ANCHOR)) {
      out = out.replace(HEALTH_ANCHOR, HEALTH_REPLACEMENT);
      changed = true;
    } else {
      problems.push(
        "packages/server/src/app.ts: add `service`, `webUrl` and `originTrusted` to the /api/health body, and answer it with `Access-Control-Allow-Origin: *`.",
      );
    }
  }

  return { content: out, changed, problem: problems.length > 0 ? problems.join(" ") : undefined };
}

// ---------------------------------------------------------------------------
// packages/server/src/auth/auth.ts
// ---------------------------------------------------------------------------

const AUTH_IMPORTS = `import { bearer } from "better-auth/plugins";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";
import { trustedOriginsForRequest } from "./extension-origins.js";`;

const AUTH_IMPORT_ANCHOR = 'import { env, getTrustedOrigins } from "../config/env.js";';
const AUTH_IMPORT_ANCHOR_WIRED =
  'import { env, getTrustedOrigins, trustsExtensionOrigins } from "../config/env.js";';

const AUTH_TRUSTED_ANCHOR = "    trustedOrigins: getTrustedOrigins(),";

const AUTH_TRUSTED_REPLACEMENT = `    // Per request, because one of the trusted origins is not a value —
    // it is a shape. A \`moz-extension://<uuid>\` origin is trusted only
    // when the request carries no session cookie, which is a fact about
    // THIS request, so the list is built for it.
    // \`request\` is optional in better-auth's own signature — it calls
    // this with nothing for the paths that have no request in hand.
    trustedOrigins: (request?: Request) =>
      trustedOriginsForRequest(getTrustedOrigins(), request, trustsExtensionOrigins()),

    plugins: [
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

      // RFC 8628, for the clients where typing a password is wrong: the
      // extension's "Sign in with the web app", and any account with
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
        validateClient: (clientId: string) => clientId === "__HATCHKIT_DEVICE_CLIENT_ID__",
      }),
    ],`;

export function wireAuth(content: string): PatchResult {
  let out = content;
  let changed = false;
  const problems: string[] = [];

  if (!out.includes("./extension-origins.js")) {
    if (out.includes(AUTH_IMPORT_ANCHOR)) {
      out = out.replace(AUTH_IMPORT_ANCHOR, `${AUTH_IMPORT_ANCHOR_WIRED}\n${AUTH_IMPORTS}`);
      changed = true;
    } else {
      problems.push(
        "packages/server/src/auth/auth.ts: import bearer, deviceAuthorization, trustedOriginsForRequest and trustsExtensionOrigins.",
      );
    }
  }

  if (!out.includes("trustedOriginsForRequest(")) {
    if (out.includes(AUTH_TRUSTED_ANCHOR)) {
      out = out.replace(AUTH_TRUSTED_ANCHOR, AUTH_TRUSTED_REPLACEMENT);
      changed = true;
    } else {
      problems.push(
        "packages/server/src/auth/auth.ts: pass trustedOrigins as a per-request function and add the bearer() + deviceAuthorization() plugins.",
      );
    }
  }

  return { content: out, changed, problem: problems.length > 0 ? problems.join(" ") : undefined };
}

// ---------------------------------------------------------------------------
// packages/client
// ---------------------------------------------------------------------------

const LAYOUT_IMPORT = 'import { ExtensionBridge } from "@/components/ExtensionBridge";';
const LAYOUT_IMPORT_ANCHOR = 'import { AuthProvider } from "@/providers/auth-provider";';
const LAYOUT_MOUNT_ANCHOR = "<AuthProvider>{children}</AuthProvider>";
const LAYOUT_MOUNT_REPLACEMENT = `<AuthProvider>
            {/* Renders nothing. Keeps the browser extension signed in
                and out with this app; inert without one. */}
            <ExtensionBridge />
            {children}
          </AuthProvider>`;

export function mountExtensionBridge(content: string): PatchResult {
  let out = content;
  let changed = false;
  const problems: string[] = [];

  if (!out.includes("@/components/ExtensionBridge")) {
    if (out.includes(LAYOUT_IMPORT_ANCHOR)) {
      out = out.replace(LAYOUT_IMPORT_ANCHOR, `${LAYOUT_IMPORT_ANCHOR}\n${LAYOUT_IMPORT}`);
      changed = true;
    } else {
      problems.push(
        'packages/client/src/app/layout.tsx: import { ExtensionBridge } from "@/components/ExtensionBridge".',
      );
    }
  }

  if (!out.includes("<ExtensionBridge")) {
    if (out.includes(LAYOUT_MOUNT_ANCHOR)) {
      out = out.replace(LAYOUT_MOUNT_ANCHOR, LAYOUT_MOUNT_REPLACEMENT);
      changed = true;
    } else {
      problems.push(
        "packages/client/src/app/layout.tsx: render <ExtensionBridge /> inside <AuthProvider>.",
      );
    }
  }

  return { content: out, changed, problem: problems.length > 0 ? problems.join(" ") : undefined };
}

const AUTH_CLIENT_IMPORT =
  'import { deviceAuthorizationClient } from "better-auth/client/plugins";';
const AUTH_CLIENT_IMPORT_ANCHOR = 'import { createAuthClient } from "better-auth/react";';
/** `createAuthClient({ baseURL: <expr> });` — the expression is a template literal. */
const AUTH_CLIENT_CALL = /createAuthClient\(\{(\s*)baseURL: ([^\n]+?),?(\s*)\}\);/;

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
          `createAuthClient({${lead}baseURL: ${baseUrl},${lead}// The device flow the browser extension signs in with. Without${lead}// it \`authClient.device\` does not exist and the approval page${lead}// fails at runtime, not at build time.${lead}plugins: [deviceAuthorizationClient()],${tail}});`,
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

// ---------------------------------------------------------------------------
// .env.example files
// ---------------------------------------------------------------------------
//
// The SERVER file needs nothing: the starter documents
// TRUST_EXTENSION_ORIGINS beside TRUST_STORE_APPS, where the two switches
// only make sense together. Appending a second copy here would state the
// older, coarser rule under the newer one.

const CLIENT_ENV_BLOCK = `
# The browser extension ids this web app may message, comma-separated
# (32 letters a-p each). Empty means the bridge does nothing. Inlined at
# BUILD time, so changing it needs a rebuild, not a restart.
# NEXT_PUBLIC_EXTENSION_IDS=
`;

export function addClientEnvExample(content: string): PatchResult {
  if (content.includes("NEXT_PUBLIC_EXTENSION_IDS")) return unchanged(content);
  const trimmed = content.endsWith("\n") ? content : `${content}\n`;
  return { content: `${trimmed}${CLIENT_ENV_BLOCK}`, changed: true };
}

// ---------------------------------------------------------------------------
// .github/workflows/build-and-deploy.yml
// ---------------------------------------------------------------------------

/** The line the CI block is inserted after. */
export const CI_ANCHOR = "- run: pnpm run test:client";

/**
 * The steps CI needs, as the body of a managed block.
 *
 * A managed block rather than a fixed-point insert, because this file
 * is one a project edits constantly: the markers keep hatchkit's two
 * lines replaceable by a later version without it having to guess which
 * of the surrounding steps were once its own.
 *
 * The extension's own tests pin what may reach a store listing — the
 * exact permission list, and the Firefox differences that otherwise
 * fail silently. They are worth nothing unless CI runs them, and the
 * build step catches a vite config that stopped emitting a manifest.
 */
export const CI_BLOCK_ID = "extension-ci";
export const CI_BLOCK_BODY = `      - run: pnpm run test:extension
      - run: pnpm run build:extension`;
export const CI_COMMENT_PREFIX = "      #";
