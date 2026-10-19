import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { FakeBucket, FakeCache, sha256Hex } from "./test-support.mjs";
import worker, { keys, signedUrl } from "./worker.js";

const APP = "com.ricoslabs.raptorrunner";
const OTHER = "com.ricoslabs.tiao";
const TOKEN = "raptor-publish-token-0123456789abcdef";
const OTHER_TOKEN = "tiao-publish-token-0123456789abcdef";
const ORIGIN = "https://ota.ricoslabs.com";
const KEY_ID = "MIIBCgKCAQEAx1y2z3w4";
const SESSION_KEY = "dGVzdC1pdg:ZmFrZS1zZXNzaW9uLWtleS1mb3ItdGVzdHM";
const CHECKSUM = "4c455effb8565da6b7f1e22d1ad2811c16d3ba65be4edaa0599016693157f315";

// The Worker logs one JSON line per decision; keep test output readable.
console.log = () => {};

let env;
let cache;

beforeEach(() => {
  cache = new FakeCache();
  globalThis.caches = { default: cache };
  env = {
    BUCKET: new FakeBucket(),
    APPS: JSON.stringify([APP, OTHER]),
    CHANNELS: JSON.stringify(["production", "beta"]),
    URL_SIGNING_KEY: "k".repeat(48),
    PUBLISH_TOKEN_HASHES: JSON.stringify({ [APP]: sha256Hex(TOKEN), [OTHER]: sha256Hex(OTHER_TOKEN) }),
    DOWNLOAD_TTL_SECONDS: "1800",
    POINTER_CACHE_SECONDS: "60",
  };
});

const call = (path, init = {}) => worker.fetch(new Request(ORIGIN + path, init), env, {});

function device(overrides = {}) {
  return {
    platform: "ios",
    device_id: "6aa8b0f0-0000-4000-8000-000000000001",
    app_id: APP,
    custom_id: "",
    version_build: "1.1.3",
    version_code: "7",
    version_os: "26.0",
    version_name: "builtin",
    plugin_version: "8.53.0",
    is_emulator: false,
    is_prod: false,
    defaultChannel: "beta",
    key_id: KEY_ID,
    ...overrides,
  };
}

const check = (body) =>
  call("/updates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

function upload(version, bytes, overrides = {}) {
  const headers = {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/zip",
    "content-length": String(bytes.length),
    "x-ota-native": "1.1.3",
    "x-ota-checksum": CHECKSUM,
    "x-ota-session-key": SESSION_KEY,
    "x-ota-key-id": KEY_ID,
    "x-ota-sha256": sha256Hex(bytes),
    ...overrides,
  };
  for (const [k, v] of Object.entries(headers)) if (v === undefined) delete headers[k];
  return call(`/admin/apps/${APP}/bundles/${version}`, { method: "PUT", headers, body: bytes });
}

function admin(path, body, token = TOKEN) {
  return call(`/admin/apps/${APP}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function publish(version, channel = "beta", extra = {}) {
  const bytes = new TextEncoder().encode(`zip-bytes-of-${version}`);
  const up = await upload(version, bytes);
  assert.equal(up.status, 201, await up.clone().text());
  const res = await admin(`/channels/${channel}/promote`, { version, ...extra });
  assert.equal(res.status, 200, await res.clone().text());
  return bytes;
}

describe("update check", () => {
  test("a device on the published native line gets the beta bundle", async () => {
    await publish("1.1.3-ota.1");
    const res = await check(device());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.version, "1.1.3-ota.1");
    assert.equal(body.checksum, CHECKSUM);
    assert.equal(body.session_key, SESSION_KEY);
    assert.match(body.url, /^https:\/\/ota\.ricoslabs\.com\/dl\/apps\/com\.ricoslabs\.raptorrunner\/bundles\/1\.1\.3-ota\.1\.zip\?exp=\d+&sig=[\w-]+$/);
    // The plugin installs nothing from a reply that carries error or kind.
    assert.equal(body.error, undefined);
    assert.equal(body.kind, undefined);
  });

  test("a device on another native line gets no update", async () => {
    await publish("1.1.3-ota.1");
    const body = await (await check(device({ version_build: "1.1.2" }))).json();
    assert.deepEqual(body, {
      error: "no_new_version_available",
      message: "No live update for this native version",
      kind: "up_to_date",
    });
  });

  test("the production channel does not see a beta bundle", async () => {
    await publish("1.1.3-ota.1");
    const body = await (await check(device({ defaultChannel: "production" }))).json();
    assert.equal(body.kind, "up_to_date");
  });

  test("a device without defaultChannel uses production", async () => {
    await publish("1.1.3-ota.2", "production");
    const body = await (await check(device({ defaultChannel: undefined }))).json();
    assert.equal(body.version, "1.1.3-ota.2");
  });

  test("a device already on the pointer's version is up to date", async () => {
    await publish("1.1.3-ota.1");
    const body = await (await check(device({ version_name: "1.1.3-ota.1" }))).json();
    assert.equal(body.kind, "up_to_date");
  });

  test("unknown apps and channels are blocked without an R2 read", async () => {
    const a = await (await check(device({ app_id: "com.example.other" }))).json();
    assert.equal(a.error, "unknown_app");
    assert.equal(a.kind, "blocked");
    const c = await (await check(device({ defaultChannel: "nightly" }))).json();
    assert.equal(c.error, "unknown_channel");
    assert.equal(env.BUCKET.reads, 0);
  });

  test("a device holding a different public key gets no update", async () => {
    await publish("1.1.3-ota.1");
    const wrong = await (await check(device({ key_id: "MIIBCgKCAQEAzzzzzzzz" }))).json();
    assert.equal(wrong.kind, "up_to_date");
    const none = await (await check(device({ key_id: undefined }))).json();
    assert.equal(none.kind, "up_to_date");
  });

  test("min_version_code keeps older store builds of the same line out", async () => {
    await publish("1.1.3-ota.1", "beta", { min_version_code: 9 });
    assert.equal((await (await check(device({ version_code: "8" }))).json()).kind, "up_to_date");
    assert.equal((await (await check(device({ version_code: "9" }))).json()).version, "1.1.3-ota.1");
  });

  test("the pointer is cached at the edge, misses included", async () => {
    await publish("1.1.3-ota.1");
    env.BUCKET.reads = 0;
    await check(device());
    await check(device());
    await check(device({ platform: "android" }));
    assert.equal(env.BUCKET.reads, 1);
    await check(device({ version_build: "1.0.0" }));
    await check(device({ version_build: "1.0.0" }));
    assert.equal(env.BUCKET.reads, 2);
  });

  test("a body that is not JSON is a 400", async () => {
    const res = await call("/updates", { method: "POST", body: "nope" });
    assert.equal(res.status, 400);
  });

  test("a malformed version_build never reaches R2", async () => {
    const body = await (await check(device({ version_build: "../../x" }))).json();
    assert.equal(body.kind, "up_to_date");
    assert.equal(env.BUCKET.reads, 0);
  });
});

describe("signed downloads", () => {
  test("the signed url returns the bundle bytes", async () => {
    const bytes = await publish("1.1.3-ota.1");
    const { url } = await (await check(device())).json();
    const res = await worker.fetch(new Request(url), env, {});
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/zip");
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes);
  });

  test("a range request returns 206 with the slice", async () => {
    const bytes = await publish("1.1.3-ota.1");
    const { url } = await (await check(device())).json();
    const res = await worker.fetch(new Request(url, { headers: { range: "bytes=4-9" } }), env, {});
    assert.equal(res.status, 206);
    assert.equal(res.headers.get("content-range"), `bytes 4-9/${bytes.length}`);
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes.subarray(4, 10));
  });

  test("expired, tampered and unsigned links are refused", async () => {
    await publish("1.1.3-ota.1");
    const key = keys.bundle(APP, "1.1.3-ota.1");
    const expired = await signedUrl(env, ORIGIN, key, 60, Date.now() - 3600_000);
    assert.equal((await worker.fetch(new Request(expired), env, {})).status, 403);

    const { url } = await (await check(device())).json();
    const otherKey = url.replace("1.1.3-ota.1.zip", "1.1.3-ota.2.zip");
    assert.equal((await worker.fetch(new Request(otherKey), env, {})).status, 403);
    const longer = url.replace(/exp=(\d+)/, (_, n) => `exp=${Number(n) + 999}`);
    assert.equal((await worker.fetch(new Request(longer), env, {})).status, 403);
    assert.equal((await call(`/dl/${key}`)).status, 403);
  });

  test("bundle metadata is not downloadable through a forged link", async () => {
    await publish("1.1.3-ota.1");
    const meta = keys.bundleMeta(APP, "1.1.3-ota.1");
    const res = await call(`/dl/${meta}?exp=99999999999&sig=AAAA`);
    assert.equal(res.status, 403);
  });
});

describe("admin API", () => {
  test("publishing needs the app's own token", async () => {
    const bytes = new TextEncoder().encode("zip");
    assert.equal((await upload("1.1.3-ota.1", bytes, { authorization: undefined })).status, 401);
    assert.equal((await upload("1.1.3-ota.1", bytes, { authorization: `Bearer ${OTHER_TOKEN}` })).status, 401);
    assert.equal((await upload("1.1.3-ota.1", bytes, { authorization: `Bearer ${TOKEN}x` })).status, 401);
    assert.equal(env.BUCKET.objects.size, 0);
  });

  test("uploads must be encrypted, versioned and match their SHA-256", async () => {
    const bytes = new TextEncoder().encode("zip");
    assert.equal((await upload("1.1.3-ota.1", bytes, { "x-ota-session-key": undefined })).status, 400);
    assert.equal((await upload("1.1.3-ota.1", bytes, { "x-ota-key-id": undefined })).status, 400);
    assert.equal((await upload("1.1.3-ota.1", bytes, { "x-ota-sha256": "0".repeat(64) })).status, 400);
    assert.equal((await upload("latest", bytes)).status, 400);
    assert.equal((await upload("builtin", bytes)).status, 400);
    assert.equal(env.BUCKET.objects.size, 0);
  });

  test("a published version cannot be overwritten", async () => {
    await publish("1.1.3-ota.1");
    const res = await upload("1.1.3-ota.1", new TextEncoder().encode("other bytes"));
    assert.equal(res.status, 409);
  });

  test("promote refuses a bundle built for another native line", async () => {
    await upload("1.1.3-ota.1", new TextEncoder().encode("zip"));
    const res = await admin("/channels/beta/promote", { version: "1.1.3-ota.1", native: "1.2.0" });
    assert.equal(res.status, 400);
  });

  test("promote of an unknown version is a 404", async () => {
    assert.equal((await admin("/channels/beta/promote", { version: "9.9.9" })).status, 404);
  });

  test("rollback moves the pointer back one step at a time", async () => {
    await publish("1.1.3-ota.1");
    await publish("1.1.3-ota.2");
    await publish("1.1.3-ota.3");
    assert.equal((await (await check(device())).json()).version, "1.1.3-ota.3");

    const first = await (await admin("/channels/beta/rollback", { native: "1.1.3" })).json();
    assert.equal(first.previous, "1.1.3-ota.3");
    assert.equal(first.pointer.version, "1.1.3-ota.2");
    // The local cache entry was dropped, so this location sees it at once.
    assert.equal((await (await check(device())).json()).version, "1.1.3-ota.2");

    const second = await (await admin("/channels/beta/rollback", { native: "1.1.3" })).json();
    assert.equal(second.pointer.version, "1.1.3-ota.1");
    const third = await admin("/channels/beta/rollback", { native: "1.1.3" });
    assert.equal(third.status, 400);
  });

  test("rollback to builtin sends devices back to the store bundle", async () => {
    await publish("1.1.3-ota.1");
    await admin("/channels/beta/rollback", { native: "1.1.3", to: "builtin" });
    assert.deepEqual(await (await check(device({ version_name: "1.1.3-ota.1" }))).json(), {
      version: "builtin",
    });
    assert.equal((await (await check(device({ version_name: "builtin" }))).json()).kind, "up_to_date");
  });

  test("rollback to a named version keeps min_version_code from history", async () => {
    await publish("1.1.3-ota.1", "beta", { min_version_code: 5 });
    await publish("1.1.3-ota.2", "beta", { min_version_code: 7 });
    const res = await (await admin("/channels/beta/rollback", { native: "1.1.3", to: "1.1.3-ota.1" })).json();
    assert.equal(res.pointer.version, "1.1.3-ota.1");
    assert.equal(res.pointer.min_version_code, 5);
  });

  test("status lists the lines of a channel", async () => {
    await publish("1.1.3-ota.1");
    const res = await (await admin("/channels/beta")).json();
    assert.deepEqual(
      res.lines.map((l) => [l.native, l.version]),
      [["1.1.3", "1.1.3-ota.1"]],
    );
    const pointer = await (await admin("/channels/beta/1.1.3")).json();
    assert.equal(pointer.version, "1.1.3-ota.1");
  });

  test("one app's token cannot move another app's pointer", async () => {
    await publish("1.1.3-ota.1");
    const res = await call(`/admin/apps/${OTHER}/channels/beta/promote`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ version: "1.1.3-ota.1" }),
    });
    assert.equal(res.status, 401);
  });
});

describe("other endpoints", () => {
  test("stats are accepted", async () => {
    const res = await call("/stats", {
      method: "POST",
      body: JSON.stringify([{ action: "set", app_id: APP, version_name: "1.1.3-ota.1" }]),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  });

  test("channel changes are refused", async () => {
    const res = await call("/channel_self", { method: "PUT", body: "{}" });
    assert.equal((await res.json()).error, "channel_change_disabled");
  });

  test("GET / answers for uptime checks", async () => {
    assert.equal((await call("/")).status, 200);
  });
});
