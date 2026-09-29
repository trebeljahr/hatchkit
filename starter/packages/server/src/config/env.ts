import { config as dotenvxConfig } from "@dotenvx/dotenvx";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// dotenvx handles encrypted .env files transparently. It looks for
// `DOTENV_PRIVATE_KEY_*` either in the process env (CI sets it there)
// or in a local .env.keys file (dev workstation).
//
// Load order mirrors conventional dotenv behavior:
//   - production: only .env.production (encrypted, committed to git)
//   - otherwise:  .env.development.local, then .env.development
// .env.development is committed and holds only local-dev defaults.
// .env.development.local is gitignored: `hatchkit add` writes the real
// development credentials it provisions there (Listmonk token, SES SMTP
// password, Stripe sandbox keys), and you can put your own overrides
// there too. A variable already set in the shell wins over both files.
// Any plaintext values in a production file stay plaintext — dotenvx
// only decrypts values whose cipher prefix starts with "encrypted:".
//
// In a deployed container there is normally NO .env.production on disk:
// the server Dockerfile deliberately doesn't copy it, and runtime
// values arrive as real environment variables that Coolify injects
// (`hatchkit sync` pushes them there, reading this file as its source).
// The existsSync guard below is what makes that work — dotenvx is a
// no-op in production and `process.env` already holds everything.
// So this block matters on a dev workstation and in CI, not in prod.
const __dirname = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(__dirname, "../..");
// Gitignored .env.development.local first: dotenvx keeps the first
// value it reads for a key, so provisioned credentials win over defaults.
const envFiles =
  process.env.NODE_ENV === "production"
    ? [".env.production"]
    : [".env.development.local", ".env.development"];
const envPaths = envFiles.map((f) => resolve(serverRoot, f)).filter((p) => existsSync(p));
if (envPaths.length > 0) {
  dotenvxConfig({ path: envPaths });
}

function getRequired(key: string): string {
  const value = process.env[key];
  if (!value && process.env.NODE_ENV === "production") {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value ?? "";
}

function getOptional(key: string, defaultValue = ""): string {
  return process.env[key] ?? defaultValue;
}

export const env = {
  NODE_ENV: getOptional("NODE_ENV", "development"),
  PORT: parseInt(getOptional("PORT", "5000"), 10),
  MONGODB_URI: getRequired("MONGODB_URI"),
  REDIS_URL: getOptional("REDIS_URL"),

  // Auth
  BETTER_AUTH_SECRET: getRequired("BETTER_AUTH_SECRET"),
  BETTER_AUTH_URL: getRequired("BETTER_AUTH_URL"),
  FRONTEND_URL: getRequired("FRONTEND_URL"),
  // Additional CORS / auth origins, comma-separated. Use this for
  // native clients:
  //   capacitor://localhost,https://localhost   (Capacitor iOS+Android)
  //   app://-                                    (custom Electron protocol)
  // Electron file:// sends Origin: null, which can't be allowed with
  // credentials:true — register a custom protocol in the main process
  // and list it here instead.
  TRUSTED_ORIGINS: getOptional("TRUSTED_ORIGINS"),
  // The origins of the published store clients: the phone shells
  // (capacitor://localhost on iOS, https://localhost on Android), the
  // desktop shell (app://-) and a published browser extension
  // (chrome-extension://<id>). Comma-separated, and parsed exactly like
  // TRUSTED_ORIGINS above. The self-host compose file fills this in from
  // the project's own features, so a self-hoster can read off which
  // clients their instance accepts instead of guessing. Empty on a deploy
  // that ships no store client, which makes TRUST_STORE_APPS below a
  // no-op there.
  STORE_CLIENT_ORIGINS: getOptional("STORE_CLIENT_ORIGINS"),
  // Whether STORE_CLIENT_ORIGINS is appended to the trusted list. ON
  // unless it is explicitly false, and that default is deliberate: a
  // person who installs the published apps and points them at their own
  // server expects them to work, and the alternative is a silent refusal
  // they cannot diagnose — a same-origin 403 INVALID_ORIGIN with no CORS
  // message in the console, which curl cannot even reproduce (better-auth
  // only force-validates Origin for requests carrying Sec-Fetch-*
  // headers, which browsers and WebViews send and curl does not). It
  // costs nothing on a deploy that ships no store client, because the
  // list it turns on is then empty. Set it to false to accept the web app
  // only.
  TRUST_STORE_APPS: getOptional("TRUST_STORE_APPS"),
  // Trust moz-extension://<uuid> and safari-web-extension://<uuid>
  // origins for requests that carry no session cookie — the only way an
  // extension whose origin is a fresh identifier per install can be
  // trusted at all, since nobody can list it in advance. The rule and
  // what narrows it are in auth/extension-origins.ts. Unset follows
  // TRUST_STORE_APPS, because a server that accepts the store clients
  // means to accept that one too; an explicit value wins either way.
  TRUST_EXTENSION_ORIGINS: getOptional("TRUST_EXTENSION_ORIGINS"),

  // The git commit this image was built from, baked in as a Docker build
  // arg (see packages/server/Dockerfile). Reported by /api/health so the
  // deploy pipeline can poll the running container until it reports the
  // commit CI just pushed. Empty outside a CI image build, which is
  // correct — a local `pnpm dev` has no commit it was built from.
  COMMIT_SHA: getOptional("COMMIT_SHA"),

  // Seconds the server keeps serving after SIGTERM while it fails the
  // health probe, so the proxy stops routing here before it closes (see
  // src/drain.ts). Set by packages/server/Dockerfile; unset or 0 shuts
  // down at once, which is what dev and tests want.
  SHUTDOWN_DRAIN_SECONDS: Math.max(0, Number(getOptional("SHUTDOWN_DRAIN_SECONDS", "0")) || 0),
  GOOGLE_CLIENT_ID: getOptional("GOOGLE_CLIENT_ID"),
  GOOGLE_CLIENT_SECRET: getOptional("GOOGLE_CLIENT_SECRET"),

  // Stripe
  // Hatchkit provisions one set per environment:
  //   .env.development → sandbox keys (STRIPE_MODE=test)
  //   .env.production  → live keys    (STRIPE_MODE=live, dotenvx-encrypted)
  // Each project gets its own pair (paste once at `hatchkit create` /
  // `hatchkit adopt`); STRIPE_WEBHOOK_SECRET is auto-minted by hatchkit.
  STRIPE_MODE: getOptional("STRIPE_MODE"),
  STRIPE_SECRET_KEY: getOptional("STRIPE_SECRET_KEY"),
  STRIPE_PUBLISHABLE_KEY: getOptional("STRIPE_PUBLISHABLE_KEY"),
  STRIPE_WEBHOOK_SECRET: getOptional("STRIPE_WEBHOOK_SECRET"),

  // Email — Listmonk + SES. Listmonk owns the API surface (tx + campaigns
  // + subscriber management); SES is the SMTP relay it sends through.
  // `hatchkit add <project> listmonk-ses` provisions the SES identity +
  // Listmonk lists/templates and writes these values.
  LISTMONK_URL: getOptional("LISTMONK_URL"),
  LISTMONK_API_USER: getOptional("LISTMONK_API_USER"),
  LISTMONK_API_TOKEN: getOptional("LISTMONK_API_TOKEN"),
  LISTMONK_FROM_EMAIL: getOptional("LISTMONK_FROM_EMAIL"),
  LISTMONK_FROM: getOptional("LISTMONK_FROM"),
  LISTMONK_LIVE_LIST_ID: getOptional("LISTMONK_LIVE_LIST_ID"),
  LISTMONK_TEST_LIST_ID: getOptional("LISTMONK_TEST_LIST_ID"),
  LISTMONK_TX_TEMPLATE_ID: getOptional("LISTMONK_TX_TEMPLATE_ID"),
  LISTMONK_CAMPAIGN_TEMPLATE_ID: getOptional("LISTMONK_CAMPAIGN_TEMPLATE_ID"),
  // Pre-filled into .env.development by `hatchkit add <project>
  // listmonk-ses` when a global default forwarding email is configured.
  // The bundled `pnpm newsletter:test-tx` / `newsletter:welcome` /
  // `newsletter:verify` scripts default to this address so a fresh
  // provision is one command away from a real send in your own inbox.
  LISTMONK_TEST_RECIPIENT: getOptional("LISTMONK_TEST_RECIPIENT"),

  // S3
  S3_ENDPOINT: getOptional("S3_ENDPOINT"),
  S3_BUCKET_NAME: getOptional("S3_BUCKET_NAME", "starter-assets"),
  S3_PUBLIC_URL: getOptional("S3_PUBLIC_URL"),
  S3_FORCE_PATH_STYLE: getOptional("S3_FORCE_PATH_STYLE") === "true",
  AWS_REGION: getOptional("AWS_REGION", "us-east-1"),
  AWS_ACCESS_KEY_ID: getOptional("AWS_ACCESS_KEY_ID"),
  AWS_SECRET_ACCESS_KEY: getOptional("AWS_SECRET_ACCESS_KEY"),

  // ML services (Modal/RunPod endpoints)
  ML_BACKGROUND_REMOVAL_ENDPOINT: getOptional("ML_BACKGROUND_REMOVAL_ENDPOINT"),
  ML_SUBTITLES_ENDPOINT: getOptional("ML_SUBTITLES_ENDPOINT"),
  ML_IMAGE_RECOGNITION_ENDPOINT: getOptional("ML_IMAGE_RECOGNITION_ENDPOINT"),
  ML_3D_EXTRACTION_ENDPOINT: getOptional("ML_3D_EXTRACTION_ENDPOINT"),
  ML_3D_SAM_OBJECTS_ENDPOINT: getOptional("ML_3D_SAM_OBJECTS_ENDPOINT"),
  ML_3D_SAM_BODY_ENDPOINT: getOptional("ML_3D_SAM_BODY_ENDPOINT"),
  ML_3D_HUNYUAN_ENDPOINT: getOptional("ML_3D_HUNYUAN_ENDPOINT"),
  ML_3D_TRELLIS_ENDPOINT: getOptional("ML_3D_TRELLIS_ENDPOINT"),

  // Monitoring
  SENTRY_DSN: getOptional("SENTRY_DSN"),

  isProduction: getOptional("NODE_ENV") === "production",
  isTest: getOptional("NODE_ENV") === "test",
} as const;

/** Read one of the origin CSVs the way better-auth needs them: split on
 *  commas, each entry trimmed, empties dropped. Order is preserved —
 *  better-auth matches these VERBATIM, so this is a reading and never a
 *  normalisation: a trailing slash left here is a silent 403 later, and
 *  quietly stripping it would hide the typo instead of the mismatch. */
function parseOriginList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Values that turn a switch on and off. Written out rather than a bare
 *  `=== "true"` because these are typed by hand into a .env file. */
const TRUE_FLAGS = ["true", "1", "yes", "on"];
const FALSE_FLAGS = ["false", "0", "no", "off"];

/**
 * Whether the store clients' origins are trusted. ON unless explicitly
 * off.
 *
 * A pure function of the raw value so the switch can be asserted without
 * rebooting the env module — the `env` object snapshots process.env once,
 * at import time.
 */
export function resolveTrustStoreApps(raw: string): boolean {
  return !FALSE_FLAGS.includes(raw.trim().toLowerCase());
}

/**
 * Whether extension-scheme origins (`moz-extension://<uuid>`,
 * `safari-web-extension://<uuid>`) are trusted for cookie-less requests.
 *
 * Unset follows TRUST_STORE_APPS; an explicit value wins either way, so a
 * server can accept the store clients and still refuse this rule, or
 * accept this rule while listing its other origins by hand.
 */
export function resolveTrustExtensionOrigins(
  raw: string,
  trustStoreApps: boolean,
): boolean {
  const value = raw.trim().toLowerCase();
  if (TRUE_FLAGS.includes(value)) return true;
  if (FALSE_FLAGS.includes(value)) return false;
  return trustStoreApps;
}

/** Everything {@link buildTrustedOrigins} reads, as raw values. */
export interface TrustedOriginSource {
  frontendUrl: string;
  /** The raw TRUSTED_ORIGINS CSV. */
  trustedOrigins: string;
  /** The raw STORE_CLIENT_ORIGINS CSV. */
  storeClientOrigins: string;
  trustStoreApps: boolean;
}

/**
 * The trusted-origin rule, as a pure function of its inputs so that the
 * TRUST_STORE_APPS switch can be asserted without rebooting the env
 * module.
 *
 * FRONTEND_URL leads, the hand-written CSV follows, and the store clients
 * come last. A duplicate — somebody who listed capacitor://localhost by
 * hand and also left the switch on — is kept once.
 */
export function buildTrustedOrigins(source: TrustedOriginSource): string[] {
  const extras = parseOriginList(source.trustedOrigins);
  const listed = source.frontendUrl
    ? [source.frontendUrl, ...extras]
    : extras;
  const store = source.trustStoreApps
    ? parseOriginList(source.storeClientOrigins)
    : [];
  return [...new Set([...listed, ...store])];
}

/** {@link resolveTrustStoreApps} for this process's environment. */
export function trustsStoreApps(): boolean {
  return resolveTrustStoreApps(env.TRUST_STORE_APPS);
}

/** {@link resolveTrustExtensionOrigins} for this process's environment. */
export function trustsExtensionOrigins(): boolean {
  return resolveTrustExtensionOrigins(
    env.TRUST_EXTENSION_ORIGINS,
    trustsStoreApps(),
  );
}

/** All origins trusted for CORS + better-auth. Merges FRONTEND_URL with
 *  the optional TRUSTED_ORIGINS CSV so native shells (Capacitor, custom
 *  Electron protocols) can authenticate against the same API, plus the
 *  published store clients when TRUST_STORE_APPS is on. Extension-scheme
 *  origins are NOT in this list — they are per-request, because each
 *  install has its own (auth/extension-origins.ts). */
export function getTrustedOrigins(): string[] {
  return buildTrustedOrigins({
    frontendUrl: env.FRONTEND_URL,
    trustedOrigins: env.TRUSTED_ORIGINS,
    storeClientOrigins: env.STORE_CLIENT_ORIGINS,
    trustStoreApps: trustsStoreApps(),
  });
}
