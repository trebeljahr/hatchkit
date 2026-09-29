/*
 * Which development env values are secrets, and where they live.
 *
 * `.env.development` is COMMITTED (the starter re-includes it with
 * `!.env.development`, so a machine-wide ignore cannot drop it), and it
 * holds only safe local defaults: localhost URLs, the MinIO login,
 * a dev-only auth secret. The real credentials `hatchkit add` provisions
 * for development go to `.env.development.local`, which every hatchkit
 * `.gitignore` covers through `.env.*.local`, and which the starter's
 * server, Next.js and Vite all load over `.env.development`.
 *
 * Before 2026-09-29 `hatchkit add` wrote those credentials into
 * `.env.development` itself. `findDevEnvSecrets` names the ones still
 * there; `provision/write-env.ts` moves them, and `hatchkit doctor`
 * reports them.
 */

/** The committed dev env file, and the gitignored file beside it that
 *  holds provisioned development credentials. */
export const DEV_ENV_FILE = ".env.development";
export const DEV_LOCAL_ENV_FILE = ".env.development.local";
/** `.gitignore` pattern that covers `DEV_LOCAL_ENV_FILE`. */
export const LOCAL_ENV_IGNORE_PATTERN = ".env.*.local";

/** Env keys whose development value is a live credential when
 *  hatchkit provisions it. A committed `.env.development` must not
 *  hold a real value for any of them. */
export const PROVISIONED_DEV_SECRET_KEYS: readonly string[] = [
  // Listmonk + SES (`renderListmonkSesEnv`): the Admin API token for the
  // whole Listmonk instance, and the SES SMTP password.
  "LISTMONK_API_TOKEN",
  "SES_SMTP_PASSWORD",
  "SES_PROJECT_SECRET_ACCESS_KEY",
  // OpenPanel, with `--enable-dev-obs`.
  "OPENPANEL_CLIENT_SECRET",
  // Stripe sandbox keys (`renderStripeEnv`). Test-mode keys still read
  // and write the sandbox account.
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  // S3 / R2 credentials under each prefix `envKeysForPrefix` knows.
  // The starter's MinIO default (`hatchkit-dev`) is a placeholder.
  "AWS_SECRET_ACCESS_KEY",
  "S3_SECRET_ACCESS_KEY",
  "R2_SECRET_ACCESS_KEY",
];

/** Values that are not credentials: empty, a `CHANGE_ME_*` placeholder,
 *  a dotenvx-encrypted value, or a local-only default the starter ships. */
const PLACEHOLDER_VALUES = new Set(["hatchkit-dev", "minioadmin", "minio123"]);

export function isPlaceholderValue(value: string): boolean {
  const v = unquote(value.trim());
  return (
    v === "" || /^CHANGE_ME/i.test(v) || v.startsWith("encrypted:") || PLACEHOLDER_VALUES.has(v)
  );
}

export interface DevEnvSecret {
  key: string;
  /** Zero-based index of the line in the file's text. */
  line: number;
}

/** The provisioned-secret keys in `text` that carry a real value. */
export function findDevEnvSecrets(text: string): DevEnvSecret[] {
  const out: DevEnvSecret[] = [];
  text.split("\n").forEach((raw, line) => {
    const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!m) return;
    const [, key, value] = m;
    if (PROVISIONED_DEV_SECRET_KEYS.includes(key) && !isPlaceholderValue(stripComment(value))) {
      out.push({ key, line });
    }
  });
  return out;
}

function unquote(v: string): string {
  const m = v.match(/^(["'`])(.*)\1$/);
  return m ? m[2] : v;
}

/** Drop a trailing ` # comment` from an unquoted value. */
function stripComment(v: string): string {
  const t = v.trim();
  if (/^["'`]/.test(t)) return t;
  return t.replace(/\s+#.*$/, "");
}
