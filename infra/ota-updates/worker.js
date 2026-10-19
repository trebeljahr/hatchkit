/*
 * ota-updates — self-hosted live-update endpoint for @capgo/capacitor-updater.
 *
 * One Worker and one R2 bucket serve every app listed in APPS. Devices ask
 * `POST /updates`; CI publishes through `/admin/*` with a per-app bearer
 * token. README.md has the protocol, the R2 layout and the operations.
 *
 * A device gets a bundle only when all of these hold:
 *   · its app_id is in APPS and its channel is in CHANNELS;
 *   · a pointer exists for (app, channel, version_build), so the bundle was
 *     built for this native version line;
 *   · its version_code is at least the pointer's min_version_code (on iOS:
 *     its build number is at least min_ios_build, when the pointer has one);
 *   · its key_id matches the key the bundle was encrypted with;
 *   · its version_name differs from the pointer's version.
 *
 * Bundles are never public: `url` is a signed link to `/dl/…` that expires
 * after DOWNLOAD_TTL_SECONDS. Pointers are cached at the edge for
 * POINTER_CACHE_SECONDS, so a check costs no R2 read while the cache is
 * warm, and a promote or rollback reaches every location within that time.
 *
 * A bundle is either one encrypted zip or a manifest (delta bundle): one
 * encrypted file per web file, stored once per app under its SHA-256, so a
 * new version uploads only the files that changed, and a device downloads
 * only the files its store build and earlier updates do not already hold.
 */

const UPDATE_BODY_LIMIT = 16 * 1024;
const ADMIN_JSON_LIMIT = 16 * 1024;
const MANIFEST_JSON_LIMIT = 8 * 1024 * 1024;
const HISTORY_LIMIT = 20;
// Each file check is one R2 head; Workers Free counts every R2 call.
const FILE_CHECK_LIMIT = 40;
// Capgo's own limit for one manifest.
const MANIFEST_FILE_LIMIT = 10_000;
// Manifests are immutable, so their rendered replies can stay cached.
const MANIFEST_CACHE_SECONDS = 24 * 3600;
// Placeholders in a stored manifest reply, filled per request. File names
// cannot contain braces, so these only ever match where they were put.
const FILES_SLOT = "{{files}}";
const QUERY_SLOT = "{{query}}";

const APP_ID = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
const CHANNEL = /^[a-z][a-z0-9-]{0,31}$/;
// version_build as the app reports it (CFBundleShortVersionString / versionName).
const NATIVE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/;
// Bundle versions are semver; the plugin rejects anything else.
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
const HEX64 = /^[0-9a-f]{64}$/;
// Encrypted checksums are hex (CLI ≥ 7.30) or base64 (older).
const CHECKSUM = /^[0-9A-Za-z+/=]{8,1024}$/;
const SESSION_KEY = /^[0-9A-Za-z+/=]{8,1024}:[0-9A-Za-z+/=]{8,1024}$/;
const KEY_ID = /^[0-9A-Za-z+/=]{1,64}$/;
// CFBundleVersion: one to three period-separated integers.
const IOS_BUILD = /^\d{1,10}(\.\d{1,10}){0,2}$/;
const FILE_KEY = /^apps\/([^/]+)\/files\/[0-9a-f]{64}$/;

const encoder = new TextEncoder();

/** A manifest file name as the plugin resolves it inside the bundle folder:
 *  relative, no `.`/`..` segments, no control characters, backslashes or
 *  braces (the reply placeholders). A `.br` suffix marks brotli transport. */
function validFileName(name) {
  if (typeof name !== "string" || name.length === 0 || name.length > 512) return false;
  if (/[\u0000-\u001f\u007f\\{}]/.test(name)) return false;
  return name.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      console.log(JSON.stringify({ event: "error", message: String(err?.message ?? err) }));
      return json({ error: "server_error", message: "Internal error" }, 500);
    }
  },
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/updates" || path === "/") {
    if (method === "POST") return handleUpdate(request, env, ctx);
    if (method === "GET" && path === "/") return text("ota-updates\n");
    return methodNotAllowed();
  }
  if (path === "/stats") {
    if (method !== "POST") return methodNotAllowed();
    return handleStats(request);
  }
  if (path === "/channel_self") {
    // Channels are fixed per build (`defaultChannel`); devices cannot switch.
    return json({
      error: "channel_change_disabled",
      message: "This app's channel is set by its build.",
    });
  }
  if (path.startsWith("/dl/")) {
    if (method !== "GET" && method !== "HEAD") return methodNotAllowed();
    return handleDownload(request, env, url);
  }
  if (path.startsWith("/admin/")) return handleAdmin(request, env, url);
  return json({ error: "not_found", message: "Not found" }, 404);
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function config(env) {
  const apps = parseJson(env.APPS, []);
  const channels = parseJson(env.CHANNELS, ["production", "beta"]);
  return {
    apps: new Set(Array.isArray(apps) ? apps : []),
    channels: new Set(Array.isArray(channels) ? channels : []),
    defaultChannel: env.DEFAULT_CHANNEL || "production",
    downloadTtl: positiveInt(env.DOWNLOAD_TTL_SECONDS, 1800),
    pointerTtl: positiveInt(env.POINTER_CACHE_SECONDS, 60),
  };
}

function parseJson(value, fallback) {
  if (typeof value !== "string" || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// ---------------------------------------------------------------------------
// R2 layout
// ---------------------------------------------------------------------------

export const keys = {
  bundle: (app, version) => `apps/${app}/bundles/${version}.zip`,
  bundleMeta: (app, version) => `apps/${app}/bundles/${version}.json`,
  manifest: (app, version) => `apps/${app}/bundles/${version}.manifest.json`,
  manifestReply: (app, version) => `apps/${app}/bundles/${version}.manifest-reply.json`,
  file: (app, sha256) => `apps/${app}/files/${sha256}`,
  filePrefix: (app) => `apps/${app}/files/`,
  pointer: (app, channel, native) => `apps/${app}/channels/${channel}/${native}.json`,
  pointerPrefix: (app, channel) => `apps/${app}/channels/${channel}/`,
};

async function readJson(env, key) {
  const object = await env.BUCKET.get(key);
  if (!object) return null;
  return object.json();
}

async function writeJson(env, key, value) {
  await env.BUCKET.put(key, JSON.stringify(value, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Pointer cache (Cache API, per location)
// ---------------------------------------------------------------------------

function pointerCacheKey(origin, app, channel, native) {
  return `${origin}/__pointer/${encodeURIComponent(app)}/${encodeURIComponent(channel)}/${encodeURIComponent(native)}`;
}

function edgeCache() {
  return globalThis.caches?.default ?? null;
}

async function loadPointer(env, ctx, origin, app, channel, native, ttl) {
  const cache = edgeCache();
  const cacheKey = pointerCacheKey(origin, app, channel, native);
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const cached = await hit.json();
      return cached.pointer ?? null;
    }
  }
  const pointer = await readJson(env, keys.pointer(app, channel, native));
  if (cache) {
    // Cache misses too: devices on a line with no bundle must not cost an R2 read each.
    const put = cache.put(
      cacheKey,
      new Response(JSON.stringify({ pointer }), {
        headers: { "content-type": "application/json", "cache-control": `max-age=${ttl}` },
      }),
    );
    if (ctx?.waitUntil) ctx.waitUntil(put);
    else await put;
  }
  return pointer;
}

async function forgetPointer(origin, app, channel, native) {
  const cache = edgeCache();
  if (cache) await cache.delete(pointerCacheKey(origin, app, channel, native));
}

/** The stored manifest reply (a JSON array with placeholders), as text.
 *  It is rendered by string replacement: parsing and re-serialising a
 *  manifest of a thousand files costs more than Workers Free's CPU budget. */
async function loadManifestReply(env, ctx, origin, key) {
  const cache = edgeCache();
  const cacheKey = `${origin}/__manifest/${key.split("/").map(encodeURIComponent).join("/")}`;
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit.text();
  }
  const object = await env.BUCKET.get(key);
  if (!object) return null;
  const template = await object.text();
  if (cache) {
    const put = cache.put(
      cacheKey,
      new Response(template, {
        headers: { "content-type": "application/json", "cache-control": `max-age=${MANIFEST_CACHE_SECONDS}` },
      }),
    );
    if (ctx?.waitUntil) ctx.waitUntil(put);
    else await put;
  }
  return template;
}

// ---------------------------------------------------------------------------
// Update check
// ---------------------------------------------------------------------------

function noUpdate(message, kind = "up_to_date", error = "no_new_version_available") {
  // A reply with `error` or `kind` is never installed by the plugin.
  return json({ error, message, kind });
}

async function handleUpdate(request, env, ctx) {
  const cfg = config(env);
  const body = await readBodyJson(request, UPDATE_BODY_LIMIT);
  if (!body || typeof body !== "object") {
    return json({ error: "invalid_request", message: "Expected a JSON body", kind: "failed" }, 400);
  }
  const app = str(body.app_id);
  const native = str(body.version_build);
  const current = str(body.version_name);
  const channel = str(body.defaultChannel) || str(body.channel) || cfg.defaultChannel;
  const log = (decision, extra = {}) =>
    console.log(
      JSON.stringify({
        event: "update_check",
        app,
        platform: str(body.platform),
        channel,
        native,
        code: str(body.version_code),
        current,
        decision,
        ...extra,
      }),
    );

  if (!APP_ID.test(app) || !cfg.apps.has(app)) {
    log("unknown_app");
    return noUpdate("Unknown app", "blocked", "unknown_app");
  }
  if (!CHANNEL.test(channel) || !cfg.channels.has(channel)) {
    log("unknown_channel");
    return noUpdate("Unknown channel", "blocked", "unknown_channel");
  }
  if (!NATIVE.test(native)) {
    log("bad_native");
    return noUpdate("No live updates for this native version");
  }

  const origin = new URL(request.url).origin;
  const pointer = await loadPointer(env, ctx, origin, app, channel, native, cfg.pointerTtl);
  if (!pointer) {
    log("no_pointer");
    return noUpdate("No live update for this native version");
  }
  if (str(body.platform) === "ios" && pointer.min_ios_build) {
    // iOS build numbers may be dotted ("21345.67.89"), which no integer
    // minimum can describe; compare them the way the App Store does.
    const build = str(body.version_code);
    if (!IOS_BUILD.test(build) || compareIosBuilds(build, pointer.min_ios_build) < 0) {
      log("below_min_code", { min: pointer.min_ios_build });
      return noUpdate("This store build is older than the live update's native shell");
    }
  } else if (pointer.min_version_code != null) {
    const code = Number(str(body.version_code));
    if (!Number.isFinite(code) || code < pointer.min_version_code) {
      log("below_min_code", { min: pointer.min_version_code });
      return noUpdate("This store build is older than the live update's native shell");
    }
  }
  if (pointer.version === current) {
    log("current");
    return noUpdate("No new version available");
  }
  if (pointer.version === "builtin") {
    log("builtin");
    return json({ version: "builtin" });
  }
  if (pointer.key_id && str(body.key_id) !== pointer.key_id) {
    log("key_mismatch");
    return noUpdate("Bundle is signed with a key this app does not hold");
  }

  if (pointer.kind === "manifest") {
    const template = await loadManifestReply(env, ctx, origin, pointer.manifest_reply_key);
    if (!template) {
      log("manifest_missing", { version: pointer.version });
      return noUpdate("Bundle is unavailable", "failed", "bundle_unavailable");
    }
    // The plugin needs a valid `url` next to `manifest` but downloads only
    // the manifest's files; this link serves the manifest itself.
    const head = JSON.stringify({
      version: pointer.version,
      url: await signedUrl(env, origin, pointer.manifest_key, cfg.downloadTtl),
      session_key: pointer.session_key,
    });
    const files = await filesLink(env, origin, app, cfg.downloadTtl);
    const manifest = template.replaceAll(FILES_SLOT, () => files.prefix).replaceAll(QUERY_SLOT, () => files.query);
    log("update", { version: pointer.version, files: pointer.files });
    return new Response(`${head.slice(0, -1)},"manifest":${manifest}}`, {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  const reply = {
    version: pointer.version,
    url: await signedUrl(env, origin, pointer.bundle_key, cfg.downloadTtl),
    checksum: pointer.checksum,
  };
  if (pointer.session_key) reply.session_key = pointer.session_key;
  log("update", { version: pointer.version });
  return json(reply);
}

// ---------------------------------------------------------------------------
// Stats (accepted and logged; nothing is stored)
// ---------------------------------------------------------------------------

async function handleStats(request) {
  const body = await readBodyJson(request, 256 * 1024);
  const events = Array.isArray(body) ? body : Array.isArray(body?.events) ? body.events : [body];
  for (const e of events.slice(0, 50)) {
    if (!e || typeof e !== "object") continue;
    console.log(
      JSON.stringify({
        event: "stats",
        action: str(e.action),
        app: str(e.app_id),
        platform: str(e.platform),
        native: str(e.version_build),
        version: str(e.version_name),
        old_version: str(e.old_version_name),
        channel: str(e.defaultChannel),
      }),
    );
  }
  return json({ status: "ok" });
}

// ---------------------------------------------------------------------------
// Signed downloads
// ---------------------------------------------------------------------------

async function hmac(env, message) {
  const secret = env.URL_SIGNING_KEY;
  if (!secret || secret.length < 32) throw new Error("URL_SIGNING_KEY is not set");
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return base64url(new Uint8Array(sig));
}

export async function signedUrl(env, origin, objectKey, ttlSeconds, now = Date.now()) {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const sig = await hmac(env, `${objectKey}\n${exp}`);
  return `${origin}/dl/${objectKey.split("/").map(encodeURIComponent).join("/")}?exp=${exp}&sig=${sig}`;
}

/** One signature for every file of an app's file store, so a manifest reply
 *  costs one HMAC, not one per file. The files are the ones any device of
 *  the app may fetch anyway; the link only keeps the bucket from being a
 *  public download host. "*" never occurs in an object key. */
async function filesLink(env, origin, app, ttlSeconds, now = Date.now()) {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const sig = await hmac(env, `${keys.filePrefix(app)}*\n${exp}`);
  return {
    prefix: `${origin}/dl/${keys.filePrefix(app).split("/").map(encodeURIComponent).join("/")}`,
    query: `exp=${exp}&sig=${sig}`,
  };
}

async function handleDownload(request, env, url) {
  const objectKey = url.pathname
    .slice("/dl/".length)
    .split("/")
    .map((part) => decodeURIComponent(part))
    .join("/");
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") ?? "";
  const fileApp = objectKey.match(FILE_KEY)?.[1];
  const signed = fileApp ? `${keys.filePrefix(fileApp)}*` : objectKey;
  const valid =
    objectKey.startsWith("apps/") &&
    !objectKey.split("/").includes("..") &&
    Number.isInteger(exp) &&
    exp >= Math.floor(Date.now() / 1000) &&
    safeEqual(sig, await hmac(env, `${signed}\n${exp}`));
  if (!valid) return json({ error: "forbidden", message: "Link expired or invalid" }, 403);

  const object =
    request.method === "HEAD"
      ? await env.BUCKET.head(objectKey)
      : await env.BUCKET.get(objectKey, { range: request.headers });
  if (!object) return json({ error: "not_found", message: "Not found" }, 404);

  const headers = new Headers({
    "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
    "cache-control": "private, no-store",
    "accept-ranges": "bytes",
    etag: object.httpEtag,
  });
  const range = object.range;
  if (request.method !== "HEAD" && range && request.headers.has("range")) {
    const start = range.offset ?? object.size - range.suffix;
    const length = range.length ?? object.size - start;
    headers.set("content-range", `bytes ${start}-${start + length - 1}/${object.size}`);
    headers.set("content-length", String(length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("content-length", String(object.size));
  return new Response(request.method === "HEAD" ? null : object.body, { status: 200, headers });
}

// ---------------------------------------------------------------------------
// Admin API (per-app bearer tokens)
// ---------------------------------------------------------------------------

async function authorize(request, env, app) {
  const hashes = parseJson(env.PUBLISH_TOKEN_HASHES, {});
  const expected = typeof hashes?.[app] === "string" ? hashes[app] : "";
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!expected || !token) return false;
  return safeEqual(await sha256Hex(token), expected);
}

async function handleAdmin(request, env, url) {
  const cfg = config(env);
  const parts = url.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
  // ["admin", "apps", app, ...rest]
  if (parts[1] !== "apps" || !parts[2]) return json({ error: "not_found", message: "Not found" }, 404);
  const app = parts[2];
  if (!APP_ID.test(app) || !cfg.apps.has(app)) {
    return json({ error: "unknown_app", message: "Unknown app" }, 404);
  }
  if (!(await authorize(request, env, app))) {
    return json({ error: "unauthorized", message: "Missing or wrong publish token" }, 401);
  }
  const rest = parts.slice(3);
  const origin = url.origin;

  // PUT /admin/apps/:app/bundles/:version
  if (rest[0] === "bundles" && rest.length === 2) {
    if (request.method === "PUT") return uploadBundle(request, env, app, rest[1]);
    if (request.method === "GET") {
      const meta = await readJson(env, keys.bundleMeta(app, rest[1]));
      return meta ? json(meta) : json({ error: "not_found", message: "No such bundle" }, 404);
    }
    return methodNotAllowed();
  }

  // PUT|GET /admin/apps/:app/bundles/:version/manifest
  if (rest[0] === "bundles" && rest.length === 3 && rest[2] === "manifest") {
    if (request.method === "PUT") return createManifestBundle(request, env, app, rest[1]);
    if (request.method === "GET") {
      if (!VERSION.test(rest[1])) return badRequest("Version must be semver");
      const manifest = await readJson(env, keys.manifest(app, rest[1]));
      return manifest ? json(manifest) : json({ error: "not_found", message: "No such manifest" }, 404);
    }
    return methodNotAllowed();
  }

  // POST /admin/apps/:app/files/missing   PUT /admin/apps/:app/files/:sha256
  if (rest[0] === "files" && rest.length === 2) {
    if (rest[1] === "missing" && request.method === "POST") return missingFiles(request, env, app);
    if (HEX64.test(rest[1]) && request.method === "PUT") return uploadFile(request, env, app, rest[1]);
    return json({ error: "not_found", message: "Not found" }, 404);
  }

  if (rest[0] === "channels" && rest[1]) {
    const channel = rest[1];
    if (!cfg.channels.has(channel)) {
      return json({ error: "unknown_channel", message: "Unknown channel" }, 404);
    }
    // GET /admin/apps/:app/channels/:channel
    if (rest.length === 2 && request.method === "GET") return listPointers(env, app, channel);
    // GET /admin/apps/:app/channels/:channel/:native
    if (rest.length === 3 && request.method === "GET" && rest[2] !== "promote" && rest[2] !== "rollback") {
      if (!NATIVE.test(rest[2])) return badRequest("Bad native version");
      const pointer = await readJson(env, keys.pointer(app, channel, rest[2]));
      return pointer ? json(pointer) : json({ error: "not_found", message: "No pointer" }, 404);
    }
    // POST /admin/apps/:app/channels/:channel/promote|rollback
    if (rest.length === 3 && request.method === "POST") {
      const body = await readBodyJson(request, ADMIN_JSON_LIMIT);
      if (!body || typeof body !== "object") return badRequest("Expected a JSON body");
      if (rest[2] === "promote") return promote(env, origin, app, channel, body);
      if (rest[2] === "rollback") return rollback(env, origin, app, channel, body);
    }
  }
  return json({ error: "not_found", message: "Not found" }, 404);
}

async function uploadBundle(request, env, app, version) {
  if (!VERSION.test(version) || version.length > 64) return badRequest("Version must be semver");
  const h = (name) => (request.headers.get(name) ?? "").trim();
  const native = h("x-ota-native");
  const checksum = h("x-ota-checksum");
  const sessionKey = h("x-ota-session-key");
  const keyId = h("x-ota-key-id");
  const sha256 = h("x-ota-sha256").toLowerCase();
  const length = Number(h("content-length"));
  if (!NATIVE.test(native)) return badRequest("x-ota-native must be the native version line");
  if (!CHECKSUM.test(checksum)) return badRequest("x-ota-checksum is missing or malformed");
  if (!SESSION_KEY.test(sessionKey)) {
    return badRequest("x-ota-session-key is required: bundles must be encrypted (encryption v2)");
  }
  if (!KEY_ID.test(keyId)) return badRequest("x-ota-key-id is required");
  if (!HEX64.test(sha256)) return badRequest("x-ota-sha256 must be the hex SHA-256 of the body");
  if (!Number.isInteger(length) || length <= 0) return badRequest("content-length is required");
  if (!request.body) return badRequest("Empty body");

  const bundleKey = keys.bundle(app, version);
  // Published bundles are immutable; a new build needs a new version.
  if ((await env.BUCKET.head(bundleKey)) || (await env.BUCKET.head(keys.bundleMeta(app, version)))) {
    return json({ error: "exists", message: `Bundle ${version} already exists` }, 409);
  }
  let stored;
  try {
    // R2 checks the SHA-256 and rejects the write on mismatch.
    stored = await env.BUCKET.put(bundleKey, request.body, {
      sha256,
      httpMetadata: { contentType: "application/zip" },
    });
  } catch (err) {
    return badRequest(`Upload rejected: ${err?.message ?? err}`);
  }
  const meta = {
    schema: 1,
    app_id: app,
    version,
    native,
    bundle_key: bundleKey,
    size: stored?.size ?? length,
    sha256,
    checksum,
    session_key: sessionKey,
    key_id: keyId,
    uploaded_at: new Date().toISOString(),
  };
  await writeJson(env, keys.bundleMeta(app, version), meta);
  return json(meta, 201);
}

// Delta bundles: files are stored once per app under the SHA-256 of their
// uploaded (compressed, encrypted) bytes, so publish.mjs uploads only what
// R2 does not hold yet, then creates the manifest that names them.

async function missingFiles(request, env, app) {
  const body = await readBodyJson(request, ADMIN_JSON_LIMIT);
  const list = body?.sha256;
  if (!Array.isArray(list) || list.length > FILE_CHECK_LIMIT || !list.every((h) => typeof h === "string" && HEX64.test(h))) {
    return badRequest(`sha256 must list up to ${FILE_CHECK_LIMIT} hex SHA-256 values`);
  }
  const unique = [...new Set(list)];
  const found = await Promise.all(unique.map((h) => env.BUCKET.head(keys.file(app, h))));
  return json({ missing: unique.filter((_, i) => !found[i]) });
}

async function uploadFile(request, env, app, sha256) {
  const length = Number(request.headers.get("content-length"));
  if (!Number.isInteger(length) || length <= 0) return badRequest("content-length is required");
  if (!request.body) return badRequest("Empty body");
  const key = keys.file(app, sha256);
  // Same name, same bytes: a second upload has nothing to add.
  const existing = await env.BUCKET.head(key);
  if (existing) return json({ sha256, size: existing.size, stored: false });
  let stored;
  try {
    // R2 checks the SHA-256 against the bytes and rejects the write on mismatch.
    stored = await env.BUCKET.put(key, request.body, {
      sha256,
      httpMetadata: { contentType: "application/octet-stream" },
    });
  } catch (err) {
    return badRequest(`Upload rejected: ${err?.message ?? err}`);
  }
  return json({ sha256, size: stored?.size ?? length, stored: true }, 201);
}

async function createManifestBundle(request, env, app, version) {
  if (!VERSION.test(version) || version.length > 64) return badRequest("Version must be semver");
  const body = await readBodyJson(request, MANIFEST_JSON_LIMIT);
  if (!body || typeof body !== "object") return badRequest("Expected a JSON body");
  const native = str(body.native);
  const sessionKey = str(body.session_key);
  const keyId = str(body.key_id);
  if (!NATIVE.test(native)) return badRequest("native must be the native version line");
  if (!SESSION_KEY.test(sessionKey)) {
    return badRequest("session_key is required: bundles must be encrypted (encryption v2)");
  }
  if (!KEY_ID.test(keyId)) return badRequest("key_id is required");
  const files = body.files;
  if (!Array.isArray(files) || files.length === 0) return badRequest("files must list the bundle's files");
  if (files.length > MANIFEST_FILE_LIMIT) return badRequest(`A manifest holds at most ${MANIFEST_FILE_LIMIT} files`);

  const entries = [];
  const targets = new Map();
  let size = 0;
  for (const f of files) {
    const name = f?.file_name;
    // The plugin writes `x.br` to `x`; two entries for one path fail the download.
    const target = typeof name === "string" && name.endsWith(".br") ? name.slice(0, -3) : name;
    if (!validFileName(name) || !validFileName(target)) {
      return badRequest(`Bad file name: ${JSON.stringify(String(name).slice(0, 120))}`);
    }
    if (targets.has(target)) return badRequest(`Two entries for ${target}`);
    if (typeof f.file_hash !== "string" || !CHECKSUM.test(f.file_hash)) {
      return badRequest(`file_hash of ${target} is missing or malformed`);
    }
    if (typeof f.sha256 !== "string" || !HEX64.test(f.sha256)) return badRequest(`sha256 of ${target} is malformed`);
    if (!Number.isInteger(f.size) || f.size <= 0) return badRequest(`size of ${target} must be a positive integer`);
    targets.set(target, f.sha256);
    entries.push({ file_name: name, file_hash: f.file_hash, sha256: f.sha256, size: f.size });
    size += f.size;
  }
  if (!targets.has("index.html")) return badRequest("The bundle has no index.html at its root");

  if ((await env.BUCKET.head(keys.bundle(app, version))) || (await env.BUCKET.head(keys.bundleMeta(app, version)))) {
    return json({ error: "exists", message: `Bundle ${version} already exists` }, 409);
  }
  // One R2 call per file does not fit Workers Free; publish.mjs checks every
  // file after uploading. This catches a manifest sent without its files.
  if (!(await env.BUCKET.head(keys.file(app, targets.get("index.html"))))) {
    return badRequest("The files of this manifest are not uploaded");
  }

  const reply = entries.map((e) =>
    JSON.stringify({
      file_name: e.file_name,
      file_hash: e.file_hash,
      download_url: `${FILES_SLOT}${e.sha256}?${QUERY_SLOT}`,
    }),
  );
  const asJson = { contentType: "application/json" };
  await env.BUCKET.put(keys.manifest(app, version), JSON.stringify(entries), { httpMetadata: asJson });
  await env.BUCKET.put(keys.manifestReply(app, version), `[${reply.join(",")}]`, { httpMetadata: asJson });
  // The metadata goes last: promote only sees a bundle whose manifest exists.
  const meta = {
    schema: 1,
    app_id: app,
    version,
    native,
    kind: "manifest",
    manifest_key: keys.manifest(app, version),
    manifest_reply_key: keys.manifestReply(app, version),
    files: entries.length,
    size,
    session_key: sessionKey,
    key_id: keyId,
    uploaded_at: new Date().toISOString(),
  };
  await writeJson(env, keys.bundleMeta(app, version), meta);
  return json(meta, 201);
}

function historyEntry(pointer) {
  return {
    version: pointer.version,
    min_version_code: pointer.min_version_code ?? null,
    min_ios_build: pointer.min_ios_build ?? null,
    promoted_at: pointer.promoted_at,
  };
}

function pointerFrom(meta, { app, channel, native, minVersionCode, minIosBuild, history, now }) {
  const base = {
    schema: 1,
    app_id: app,
    channel,
    native,
    min_version_code: minVersionCode ?? null,
    min_ios_build: minIosBuild ?? null,
    promoted_at: now,
    history,
  };
  if (meta === "builtin") return { ...base, version: "builtin" };
  if (meta.kind === "manifest") {
    return {
      ...base,
      version: meta.version,
      kind: "manifest",
      manifest_key: meta.manifest_key,
      manifest_reply_key: meta.manifest_reply_key,
      files: meta.files,
      size: meta.size,
      session_key: meta.session_key,
      key_id: meta.key_id,
    };
  }
  return {
    ...base,
    version: meta.version,
    bundle_key: meta.bundle_key,
    checksum: meta.checksum,
    session_key: meta.session_key,
    key_id: meta.key_id,
    sha256: meta.sha256,
    size: meta.size,
  };
}

function minCode(value) {
  if (value == null || value === "") return { ok: true, value: null };
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? { ok: true, value: n } : { ok: false };
}

function minIosBuild(value) {
  if (value == null || value === "") return { ok: true, value: null };
  return typeof value === "string" && IOS_BUILD.test(value) ? { ok: true, value } : { ok: false };
}

/** Compares two CFBundleVersion strings component by component; a missing
 *  component counts as 0, so "7" equals "7.0.0". */
export function compareIosBuilds(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

async function promote(env, origin, app, channel, body) {
  const version = str(body.version);
  if (!VERSION.test(version)) return badRequest("version must be semver");
  const code = minCode(body.min_version_code);
  if (!code.ok) return badRequest("min_version_code must be a non-negative integer");
  const iosBuild = minIosBuild(body.min_ios_build);
  if (!iosBuild.ok) return badRequest("min_ios_build must be one to three period-separated integers");
  const meta = await readJson(env, keys.bundleMeta(app, version));
  if (!meta) return json({ error: "not_found", message: `No bundle ${version}` }, 404);
  const native = meta.native;
  if (body.native != null && str(body.native) !== native) {
    return badRequest(`Bundle ${version} targets native ${native}, not ${str(body.native)}`);
  }
  const key = keys.pointer(app, channel, native);
  const current = await readJson(env, key);
  const history = current
    ? [historyEntry(current), ...(current.history ?? [])].filter((e) => e.version !== version)
    : [];
  const pointer = pointerFrom(meta, {
    app,
    channel,
    native,
    minVersionCode: code.value,
    minIosBuild: iosBuild.value,
    history: history.slice(0, HISTORY_LIMIT),
    now: new Date().toISOString(),
  });
  await writeJson(env, key, pointer);
  await forgetPointer(origin, app, channel, native);
  return json({ previous: current?.version ?? null, pointer });
}

async function rollback(env, origin, app, channel, body) {
  const native = str(body.native);
  if (!NATIVE.test(native)) return badRequest("native is required");
  const key = keys.pointer(app, channel, native);
  const current = await readJson(env, key);
  if (!current) return json({ error: "not_found", message: "Nothing published on this line" }, 404);
  const history = current.history ?? [];
  let target;
  let rest;
  if (body.to == null || body.to === "") {
    // Step back one entry. The current version is dropped from history, so
    // a second rollback goes further back instead of returning to it.
    if (!history.length) return badRequest("No earlier version; pass to: \"builtin\"");
    target = history[0];
    rest = history.slice(1);
  } else {
    const to = str(body.to);
    if (to !== "builtin" && !VERSION.test(to)) return badRequest("to must be a version or builtin");
    target = history.find((e) => e.version === to) ?? { version: to, min_version_code: null, min_ios_build: null };
    rest = history.filter((e) => e.version !== to);
  }
  let meta = "builtin";
  if (target.version !== "builtin") {
    meta = await readJson(env, keys.bundleMeta(app, target.version));
    if (!meta) return json({ error: "not_found", message: `No bundle ${target.version}` }, 404);
    if (meta.native !== native) {
      return badRequest(`Bundle ${target.version} targets native ${meta.native}, not ${native}`);
    }
  }
  const pointer = pointerFrom(meta, {
    app,
    channel,
    native,
    minVersionCode: target.min_version_code ?? current.min_version_code ?? null,
    minIosBuild: target.min_ios_build ?? current.min_ios_build ?? null,
    history: rest.slice(0, HISTORY_LIMIT),
    now: new Date().toISOString(),
  });
  pointer.rolled_back_from = current.version;
  await writeJson(env, key, pointer);
  await forgetPointer(origin, app, channel, native);
  return json({ previous: current.version, pointer });
}

async function listPointers(env, app, channel) {
  const prefix = keys.pointerPrefix(app, channel);
  const listed = await env.BUCKET.list({ prefix });
  const lines = [];
  for (const object of listed.objects ?? []) {
    const pointer = await readJson(env, object.key);
    if (pointer) {
      lines.push({
        native: pointer.native,
        version: pointer.version,
        kind: pointer.version === "builtin" ? "builtin" : (pointer.kind ?? "zip"),
        min_version_code: pointer.min_version_code ?? null,
        min_ios_build: pointer.min_ios_build ?? null,
        promoted_at: pointer.promoted_at,
      });
    }
  }
  return json({ app_id: app, channel, lines });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function str(value) {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

async function readBodyJson(request, limit) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  const raw = await request.text();
  if (raw.length > limit) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function text(value, status = 200) {
  return new Response(value, { status, headers: { "content-type": "text/plain" } });
}

function badRequest(message) {
  return json({ error: "bad_request", message }, 400);
}

function methodNotAllowed() {
  return json({ error: "method_not_allowed", message: "Method not allowed" }, 405);
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
