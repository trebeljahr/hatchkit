/*
 * Paid unlock on the Express server: Stripe Checkout → a page, a download
 * or an email. The logic is in ./core.ts, the same file the Cloudflare
 * Worker runs; this file maps Node's request and response onto it.
 *
 * Mounted in src/app.ts BEFORE express.json(): the webhook needs the raw
 * body, and the forms are parsed by the core. Written by `hatchkit add
 * <project> paid-unlock`; see the "Paid unlock" section of CLAUDE.md.
 *
 * Env (server only):
 *   STRIPE_SECRET_KEY        the project's Stripe key for this mode
 *   UNLOCK_WEBHOOK_SECRET    whsec_… of the endpoint `hatchkit stripe sync` created
 *   UNLOCK_TOKEN_SECRET      random HMAC key for cookies and email links
 *   UNLOCK_SITE_URL          public origin (default BETTER_AUTH_URL)
 *   STRIPE_API_VERSION       optional: a Stripe-Version other than core.ts pins
 *   LISTMONK_URL / LISTMONK_API_USER / LISTMONK_API_TOKEN /
 *   LISTMONK_TX_TEMPLATE_ID / LISTMONK_FROM   purchase emails (optional)
 *   S3_BUCKET_NAME + AWS_*   download files from the bucket (presigned);
 *                            without them, from unlock-private/files/
 */

import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  type FileStore,
  type Mailer,
  type PrivateAssets,
  type UnlockConfig,
  type UnlockDeps,
  handleUnlockRequest,
  isUnlockPath,
  listmonkMailer,
  parseUnlockConfig,
} from "./core.js";
import unlocksJson from "./unlocks.json" with { type: "json" };

/** packages/server/unlock-private: from src/services/unlock and from
 *  dist/services/unlock alike. The Dockerfile copies it into the image. */
const DEFAULT_PRIVATE_DIR = fileURLToPath(new URL("../../../unlock-private/", import.meta.url));
const MAX_BODY_BYTES = 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".mp4": "video/mp4",
  ".woff2": "font/woff2",
};

export interface UnlockServerOptions {
  env?: Record<string, string | undefined>;
  /** unlocks.json contents; defaults to the file next to this one. */
  config?: unknown;
  /** Folder with paid/<key>/… pages, emails/… bodies and files/… */
  privateDir?: string;
  files?: FileStore;
  mailer?: Mailer | null;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
}

/** Read a file inside `root`, or null. Refuses anything outside it. */
async function readInside(root: string, rel: string): Promise<Buffer | null> {
  const base = resolve(root);
  const target = resolve(base, rel);
  if (!target.startsWith(base + sep)) return null;
  try {
    return await readFile(target);
  } catch {
    return null;
  }
}

function privateAssets(dir: string): PrivateAssets {
  return {
    async get(path) {
      const body = await readInside(dir, path);
      if (!body) return null;
      return {
        body: new Uint8Array(body),
        contentType: CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
      };
    },
  };
}

function localFiles(dir: string): FileStore {
  const base = resolve(dir, "files");
  return {
    async get(object) {
      const target = resolve(base, object);
      if (!target.startsWith(base + sep)) return null;
      try {
        const info = await stat(target);
        if (!info.isFile()) return null;
        return {
          body: Readable.toWeb(createReadStream(target)) as unknown as ReadableStream,
          size: info.size,
          contentType: CONTENT_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream",
        };
      } catch {
        return null;
      }
    },
  };
}

/** Presigned bucket download, the same helper the newsletter magnets use. */
function bucketFiles(): FileStore {
  return {
    async get(object, filename) {
      const { getPresignedDownloadUrl } = await import("../storage.js");
      return { redirect: await getPresignedDownloadUrl(object, filename, 600) };
    },
  };
}

function envMailer(env: Record<string, string | undefined>, fetchImpl?: typeof fetch): Mailer | null {
  const templateId = Number(env.LISTMONK_TX_TEMPLATE_ID);
  if (!env.LISTMONK_URL || !env.LISTMONK_API_USER || !env.LISTMONK_API_TOKEN || !templateId) return null;
  return listmonkMailer({
    url: env.LISTMONK_URL,
    user: env.LISTMONK_API_USER,
    token: env.LISTMONK_API_TOKEN,
    templateId,
    from: env.LISTMONK_FROM || env.LISTMONK_FROM_EMAIL,
    fetch: fetchImpl,
  });
}

/** Fixed one-minute windows, in memory: five restore requests per key. */
function memoryLimiter(limit = 5, windowMs = 60_000): (key: string) => Promise<boolean> {
  const windows = new Map<string, { start: number; count: number }>();
  return async (key) => {
    const now = Date.now();
    if (windows.size > 10_000) windows.clear();
    const current = windows.get(key);
    if (!current || now - current.start >= windowMs) {
      windows.set(key, { start: now, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= limit;
  };
}

function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolveBody(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function toHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else headers.set(name, value);
  }
  return headers;
}

async function sendResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  const cookies = response.headers.getSetCookie();
  response.headers.forEach((value, name) => {
    if (name.toLowerCase() !== "set-cookie") res.setHeader(name, value);
  });
  if (cookies.length) res.setHeader("Set-Cookie", cookies);
  if (!response.body) {
    res.end();
    return;
  }
  const body = Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream);
  await new Promise<void>((done, fail) => {
    body.on("error", fail);
    res.on("finish", done);
    res.on("close", done);
    body.pipe(res);
  });
}

/**
 * Connect/Express middleware. Anything outside /api/unlock and the page
 * prefix goes to `next()`. Missing secrets answer 503 on unlock paths
 * only, so the rest of the app is unaffected.
 */
export function createUnlockHandler(options: UnlockServerOptions = {}) {
  const env = options.env ?? process.env;
  // An invalid unlocks.json answers 503 on unlock paths and logs why; it
  // never takes the rest of the app down. `hatchkit add … paid-unlock`
  // validates the file with the same rules before writing it.
  let config: UnlockConfig;
  let configError = "";
  try {
    config = parseUnlockConfig(options.config ?? unlocksJson);
  } catch (err) {
    configError = (err as Error).message;
    console.error(JSON.stringify({ scope: "unlock", event: "config_invalid", message: configError }));
    config = { project: "invalid", currency: "eur", products: {} };
  }
  const privateDir = options.privateDir ?? env.UNLOCK_PRIVATE_DIR ?? DEFAULT_PRIVATE_DIR;
  const siteUrl = env.UNLOCK_SITE_URL || env.BETTER_AUTH_URL || "";
  const deps: UnlockDeps = {
    config,
    siteUrl,
    siteName: env.UNLOCK_SITE_NAME,
    stripeSecretKey: env.STRIPE_SECRET_KEY ?? "",
    stripeApiVersion: env.STRIPE_API_VERSION || undefined,
    webhookSecret: env.UNLOCK_WEBHOOK_SECRET ?? "",
    tokenSecret: env.UNLOCK_TOKEN_SECRET ?? "",
    assets: privateAssets(privateDir),
    files: options.files ?? (env.S3_BUCKET_NAME ? bucketFiles() : localFiles(privateDir)),
    mailer: options.mailer !== undefined ? options.mailer : envMailer(env, options.fetch),
    limit: memoryLimiter(),
    fetch: options.fetch,
    now: options.now,
    log: options.log,
  };
  const configured =
    !configError &&
    Boolean(siteUrl && deps.tokenSecret && deps.webhookSecret) &&
    Boolean(deps.stripeSecretKey) &&
    !deps.stripeSecretKey.startsWith("CHANGE_ME_");

  return async function unlockHandler(
    req: IncomingMessage,
    res: ServerResponse,
    next: (err?: unknown) => void,
  ): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", siteUrl || "http://localhost");
      if (!isUnlockPath(url.pathname, config)) return next();
      if (!configured) {
        res.statusCode = 503;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(
          configError
            ? "Paid unlock is not available: unlocks.json is not valid (see the server log).\n"
            : "Paid unlock is not configured: set STRIPE_SECRET_KEY, UNLOCK_WEBHOOK_SECRET, UNLOCK_TOKEN_SECRET and UNLOCK_SITE_URL.\n",
        );
        return;
      }
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const body = hasBody ? await readBody(req) : undefined;
      if (body === null) {
        res.statusCode = 413;
        res.end();
        return;
      }
      const request = new Request(url, {
        method: req.method,
        headers: toHeaders(req),
        body: hasBody ? new Uint8Array(body ?? Buffer.alloc(0)) : undefined,
      });
      const ip = (req as IncomingMessage & { ip?: string }).ip ?? req.socket.remoteAddress ?? null;
      const response = await handleUnlockRequest(request, deps, { clientIp: ip });
      if (!response) return next();
      await sendResponse(res, response);
    } catch (err) {
      next(err);
    }
  };
}
