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

// The health route's opening, before and after it read the request (the
// shutdown drain checks where the probe comes from). The patch needs `req`.
const HEALTH_ROUTE_UNUSED_REQ = `app.get("/api/health", (_req, res) => {`;
const HEALTH_ROUTE = `app.get("/api/health", (req, res) => {`;

// The start of the normal answer — after the drain's early return, in a
// starter that has one.
const HEALTH_ANCHOR = `    res.json({
      status: "ok",
      db: isDatabaseReady(),`;

const HEALTH_READY_ANCHOR = `    res.status(dbReady && redisReady ? 200 : 503).json({
      status: dbReady && redisReady ? "ok" : "degraded",
      db: dbReady,`;

const HEALTH_REPLACEMENT = `    // Answers EVERY origin, deliberately. A client whose origin this
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

const HEALTH_READY_REPLACEMENT = HEALTH_REPLACEMENT.replace(
  '    res.json({\n      status: "ok",',
  '    res.status(dbReady && redisReady ? 200 : 503).json({\n      status: dbReady && redisReady ? "ok" : "degraded",',
).replace("      db: isDatabaseReady(),", "      db: dbReady,");

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
    if (
      (out.includes(HEALTH_ANCHOR) || out.includes(HEALTH_READY_ANCHOR)) &&
      (out.includes(HEALTH_ROUTE) || out.includes(HEALTH_ROUTE_UNUSED_REQ))
    ) {
      out = out
        .replace(HEALTH_ROUTE_UNUSED_REQ, HEALTH_ROUTE)
        .replace(HEALTH_ANCHOR, HEALTH_REPLACEMENT)
        .replace(HEALTH_READY_ANCHOR, HEALTH_READY_REPLACEMENT);
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

// `bearer()` and better-auth's device grant used to be registered from
// here too, and their own comment said who they were for: "a client with
// no cookie jar — the browser extension, a CLI". Neither is a
// browser-extension concern, so both moved to the shared device-grant
// unit (`cli/src/features/device-grant/`), which this feature's `apply`
// invokes. What is left here is the part that genuinely is the
// extension's: an origin whose trust is decided per REQUEST.
const AUTH_IMPORTS = `import { trustedOriginsForRequest } from "./extension-origins.js";`;

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
      trustedOriginsForRequest(getTrustedOrigins(), request, trustsExtensionOrigins()),`;

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
        "packages/server/src/auth/auth.ts: import trustedOriginsForRequest from ./extension-origins.js, and trustsExtensionOrigins from ../config/env.js.",
      );
    }
  }

  if (!out.includes("trustedOriginsForRequest(")) {
    if (out.includes(AUTH_TRUSTED_ANCHOR)) {
      out = out.replace(AUTH_TRUSTED_ANCHOR, AUTH_TRUSTED_REPLACEMENT);
      changed = true;
    } else {
      problems.push(
        "packages/server/src/auth/auth.ts: pass trustedOrigins as a per-request function (see trustedOriginsForRequest).",
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

// The web app's auth client needs better-auth's
// `deviceAuthorizationClient()` before the approval page can call
// `authClient.device.approve(...)`. That patch is not here: it belongs
// to the shared device-grant unit, which applies it for whichever
// pairing client is selected.

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
