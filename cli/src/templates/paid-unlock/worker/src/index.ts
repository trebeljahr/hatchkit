// Paid unlock Worker: Stripe Checkout → a page, a download or an email.
// The logic is in core.ts (shared with the Express server); this file maps
// the Worker's bindings onto it. See README.md.
import {
  type FileStore,
  type Mailer,
  type PrivateAssets,
  type UnlockConfig,
  type UnlockDeps,
  handleUnlockRequest,
  listmonkMailer,
  parseUnlockConfig,
} from "./core";
import unlocksJson from "./unlocks.json";

/** Workers static assets binding: the private/ folder. */
interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

/** The part of an R2 bucket binding this Worker uses. */
interface FilesBucket {
  get(key: string): Promise<{
    body: ReadableStream;
    size: number;
    httpMetadata?: { contentType?: string };
  } | null>;
}

/** Workers rate limiting binding. */
interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  SITE_URL: string;
  SITE_NAME?: string;
  STRIPE_SECRET_KEY: string;
  /** Optional: a Stripe-Version other than the one core.ts pins. */
  STRIPE_API_VERSION?: string;
  UNLOCK_WEBHOOK_SECRET: string;
  UNLOCK_TOKEN_SECRET: string;
  LISTMONK_URL?: string;
  LISTMONK_API_USER?: string;
  LISTMONK_API_TOKEN?: string;
  LISTMONK_TX_TEMPLATE_ID?: string;
  LISTMONK_FROM?: string;
  ASSETS: AssetsBinding;
  FILES?: FilesBucket;
  RESTORE_LIMITER?: RateLimiter;
}

let config: UnlockConfig | null = null;

/** Replace unlocks.json for a test; `null` goes back to the file. */
export function _setConfigForTests(raw: unknown): void {
  config = raw === null ? null : parseUnlockConfig(raw);
}

function loadConfig(): UnlockConfig {
  config ??= parseUnlockConfig(unlocksJson);
  return config;
}

function assetsFrom(env: Env): PrivateAssets {
  return {
    async get(path) {
      // html_handling is "none" in wrangler.jsonc, so exact paths are served.
      const res = await env.ASSETS.fetch(new Request(`https://assets.local/${path}`));
      if (!res.ok || !res.body) return null;
      return { body: res.body, contentType: res.headers.get("Content-Type") ?? "application/octet-stream" };
    },
  };
}

function filesFrom(env: Env): FileStore {
  return {
    async get(object) {
      if (!env.FILES) return null;
      const stored = await env.FILES.get(object);
      if (!stored) return null;
      return {
        body: stored.body,
        size: stored.size,
        contentType: stored.httpMetadata?.contentType ?? "application/octet-stream",
      };
    },
  };
}

function mailerFrom(env: Env): Mailer | null {
  const templateId = Number(env.LISTMONK_TX_TEMPLATE_ID);
  if (!env.LISTMONK_URL || !env.LISTMONK_API_USER || !env.LISTMONK_API_TOKEN || !templateId) return null;
  return listmonkMailer({
    url: env.LISTMONK_URL,
    user: env.LISTMONK_API_USER,
    token: env.LISTMONK_API_TOKEN,
    templateId,
    from: env.LISTMONK_FROM,
  });
}

export function depsFromEnv(env: Env): UnlockDeps {
  return {
    config: loadConfig(),
    siteUrl: env.SITE_URL,
    siteName: env.SITE_NAME,
    stripeSecretKey: env.STRIPE_SECRET_KEY,
    stripeApiVersion: env.STRIPE_API_VERSION || undefined,
    webhookSecret: env.UNLOCK_WEBHOOK_SECRET,
    tokenSecret: env.UNLOCK_TOKEN_SECRET,
    assets: assetsFrom(env),
    files: filesFrom(env),
    mailer: mailerFrom(env),
    limit: env.RESTORE_LIMITER
      ? async (key) => (await env.RESTORE_LIMITER?.limit({ key }))?.success ?? true
      : undefined,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.STRIPE_SECRET_KEY || !env.UNLOCK_WEBHOOK_SECRET || !env.UNLOCK_TOKEN_SECRET) {
      return new Response("Paid unlock is not configured (missing Worker secrets).", { status: 503 });
    }
    const response = await handleUnlockRequest(request, depsFromEnv(env), {
      clientIp: request.headers.get("CF-Connecting-IP"),
    });
    return response ?? new Response("Not found", { status: 404 });
  },
};
