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

  test("min_ios_build compares dotted iOS build numbers; Android keeps min_version_code", async () => {
    // Build 213450507 as Android versionCode and as Mesozoic's iOS CFBundleVersion.
    await publish("1.1.3-ota.1", "beta", { min_version_code: 213450507, min_ios_build: "21345.5.7" });
    const ios = (code) => check(device({ platform: "ios", version_code: code })).then((r) => r.json());
    const android = (code) => check(device({ platform: "android", version_code: code })).then((r) => r.json());
    assert.equal((await ios("21345.5.7")).version, "1.1.3-ota.1");
    assert.equal((await ios("21345.10.0")).version, "1.1.3-ota.1");
    assert.equal((await ios("21346")).version, "1.1.3-ota.1");
    assert.equal((await ios("21345.4.99")).kind, "up_to_date");
    assert.equal((await ios("21345")).kind, "up_to_date");
    assert.equal((await ios("not-a-build")).kind, "up_to_date");
    assert.equal((await android("213450507")).version, "1.1.3-ota.1");
    assert.equal((await android("213450506")).kind, "up_to_date");
    assert.equal((await admin("/channels/beta/promote", { version: "1.1.3-ota.1", min_ios_build: "1.2.3.4" })).status, 400);
  });

  test("without min_ios_build, iOS build numbers meet min_version_code as before", async () => {
    await publish("1.1.3-ota.1", "beta", { min_version_code: 9 });
    assert.equal((await (await check(device({ platform: "ios", version_code: "8" }))).json()).kind, "up_to_date");
    assert.equal((await (await check(device({ platform: "ios", version_code: "9" }))).json()).version, "1.1.3-ota.1");
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
    await publish("1.1.3-ota.1", "beta", { min_version_code: 5, min_ios_build: "5.0.1" });
    await publish("1.1.3-ota.2", "beta", { min_version_code: 7, min_ios_build: "7.0.1" });
    const res = await (await admin("/channels/beta/rollback", { native: "1.1.3", to: "1.1.3-ota.1" })).json();
    assert.equal(res.pointer.version, "1.1.3-ota.1");
    assert.equal(res.pointer.min_version_code, 5);
    assert.equal(res.pointer.min_ios_build, "5.0.1");
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

const bytesOf = (text) => new TextEncoder().encode(text);

function putFile(bytes, sha = sha256Hex(bytes), token = TOKEN, app = APP) {
  return call(`/admin/apps/${app}/files/${sha}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/octet-stream",
      "content-length": String(bytes.length),
    },
    body: bytes,
  });
}

async function missing(hashes) {
  const res = await admin("/files/missing", { sha256: hashes });
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()).missing;
}

function putManifest(version, files, extra = {}) {
  return call(`/admin/apps/${APP}/bundles/${version}/manifest`, {
    method: "PUT",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ native: "1.1.3", session_key: SESSION_KEY, key_id: KEY_ID, files, ...extra }),
  });
}

/** Stand-ins for encrypted files: the Worker never looks inside them. */
function entriesFor(files) {
  return Object.entries(files).map(([name, text]) => {
    const bytes = bytesOf(text);
    return { file_name: name, file_hash: sha256Hex(`plain ${name}`), sha256: sha256Hex(bytes), size: bytes.length, bytes };
  });
}

async function publishManifest(version, files, channel = "beta") {
  const entries = entriesFor(files);
  for (const e of entries) assert.ok([200, 201].includes((await putFile(e.bytes)).status));
  const res = await putManifest(version, entries.map(({ bytes, ...e }) => e));
  assert.equal(res.status, 201, await res.clone().text());
  assert.equal((await admin(`/channels/${channel}/promote`, { version })).status, 200);
  return entries;
}

const SITE = { "index.html": "<script src=main.js></script>", "main.js.br": "brotli bytes", "assets/a.png": "png" };

describe("delta bundles", () => {
  test("the missing check names only the files R2 lacks; a second upload stores nothing", async () => {
    const [a, b] = [bytesOf("file a"), bytesOf("file b")];
    assert.equal((await putFile(a)).status, 201);
    assert.deepEqual(await missing([sha256Hex(a), sha256Hex(b), sha256Hex(a)]), [sha256Hex(b)]);
    const again = await putFile(a);
    assert.equal(again.status, 200);
    assert.equal((await again.json()).stored, false);
    assert.equal(env.BUCKET.objects.size, 1);
  });

  test("file uploads must match their name, use the app's token and stay in batches", async () => {
    const bytes = bytesOf("file");
    assert.equal((await putFile(bytes, "0".repeat(64))).status, 400);
    assert.equal((await putFile(bytes, undefined, OTHER_TOKEN)).status, 401);
    assert.equal((await putFile(bytes, "not-a-hash")).status, 404);
    assert.equal(env.BUCKET.objects.size, 0);
    const tooMany = Array.from({ length: 41 }, (_, i) => sha256Hex(String(i)));
    assert.equal((await admin("/files/missing", { sha256: tooMany })).status, 400);
    assert.equal((await admin("/files/missing", { sha256: ["../x"] })).status, 400);
  });

  test("a device gets a manifest whose links download each file's bytes", async () => {
    const entries = await publishManifest("1.1.3-ota.1", SITE);
    const res = await check(device());
    assert.equal(res.headers.get("content-type"), "application/json");
    const body = await res.json();
    assert.equal(body.version, "1.1.3-ota.1");
    assert.equal(body.session_key, SESSION_KEY);
    assert.equal(body.error, undefined);
    assert.equal(body.kind, undefined);
    assert.equal(body.checksum, undefined);
    assert.deepEqual(
      body.manifest.map((m) => [m.file_name, m.file_hash]),
      entries.map((e) => [e.file_name, e.file_hash]),
    );
    for (const [i, m] of body.manifest.entries()) {
      assert.match(m.download_url, /^https:\/\/ota\.ricoslabs\.com\/dl\/apps\/com\.ricoslabs\.raptorrunner\/files\/[0-9a-f]{64}\?exp=\d+&sig=[\w-]+$/);
      const dl = await worker.fetch(new Request(m.download_url), env, {});
      assert.equal(dl.status, 200);
      assert.deepEqual(new Uint8Array(await dl.arrayBuffer()), entries[i].bytes);
    }
    // The plugin refuses a reply without a valid url; this one serves the manifest.
    const manifest = await (await worker.fetch(new Request(body.url), env, {})).json();
    assert.deepEqual(manifest.map((m) => m.file_name), Object.keys(SITE));
  });

  test("file names keep quotes and non-ASCII characters through the reply", async () => {
    const name = 'assets/"quoted" ü.js';
    await publishManifest("1.1.3-ota.1", { "index.html": "x", [name]: "y" });
    const body = await (await check(device())).json();
    assert.equal(body.manifest[1].file_name, name);
  });

  test("a manifest reply costs no R2 read while the edge cache is warm", async () => {
    await publishManifest("1.1.3-ota.1", SITE);
    await check(device());
    env.BUCKET.reads = 0;
    await check(device());
    await check(device({ platform: "android" }));
    assert.equal(env.BUCKET.reads, 0);
  });

  test("a device with another key or already on the version gets no manifest", async () => {
    await publishManifest("1.1.3-ota.1", SITE);
    assert.equal((await (await check(device({ key_id: "MIIBCgKCAQEAzzzzzzzz" }))).json()).kind, "up_to_date");
    assert.equal((await (await check(device({ version_name: "1.1.3-ota.1" }))).json()).kind, "up_to_date");
  });

  test("a files link opens every file of its app and nothing else", async () => {
    await publishManifest("1.1.3-ota.1", SITE);
    const { manifest } = await (await check(device())).json();
    const link = manifest[0].download_url;
    const sha = link.match(/files\/([0-9a-f]{64})/)[1];
    // Another app's file store.
    const otherBytes = bytesOf("tiao file");
    await putFile(otherBytes, undefined, OTHER_TOKEN, OTHER);
    const other = link.replace(`${APP}/files/${sha}`, `${OTHER}/files/${sha256Hex(otherBytes)}`);
    assert.equal((await worker.fetch(new Request(other), env, {})).status, 403);
    // A bundle zip, metadata or pointer of the same app.
    await upload("1.1.3-ota.2", bytesOf("zip"));
    for (const key of [keys.bundle(APP, "1.1.3-ota.2"), keys.bundleMeta(APP, "1.1.3-ota.1")]) {
      const forged = link.replace(`apps/${APP}/files/${sha}`, key);
      assert.equal((await worker.fetch(new Request(forged), env, {})).status, 403);
    }
    const longer = link.replace(/exp=(\d+)/, (_, n) => `exp=${Number(n) + 999}`);
    assert.equal((await worker.fetch(new Request(longer), env, {})).status, 403);
  });

  test("manifests are checked before anything is stored", async () => {
    const good = entriesFor(SITE).map(({ bytes, ...e }) => e);
    const cases = [
      [],
      good.filter((e) => e.file_name !== "index.html"),
      [...good, { ...good[2], file_name: "../escape.js" }],
      [...good, { ...good[2], file_name: "/abs.js" }],
      [...good, { ...good[2], file_name: "a//b.js" }],
      [...good, { ...good[2], file_name: "{{files}}.js" }],
      [...good, { ...good[2], file_name: "main.js" }],
      [...good, { ...good[2], file_name: "x.js", file_hash: "" }],
      [...good, { ...good[2], file_name: "x.js", size: 0 }],
      [...good, { ...good[2], file_name: "x.js", sha256: "abc" }],
    ];
    for (const files of cases) assert.equal((await putManifest("1.1.3-ota.1", files)).status, 400, JSON.stringify(files.at(-1)));
    assert.equal((await putManifest("1.1.3-ota.1", good, { session_key: "" })).status, 400);
    assert.equal((await putManifest("1.1.3-ota.1", good, { native: "../x" })).status, 400);
    // Files that were never uploaded.
    assert.equal((await putManifest("1.1.3-ota.1", good)).status, 400);
    assert.equal(env.BUCKET.objects.size, 0);
  });

  test("a version is published once, as a zip or as a manifest", async () => {
    await publishManifest("1.1.3-ota.1", SITE);
    assert.equal((await upload("1.1.3-ota.1", bytesOf("zip"))).status, 409);
    const files = entriesFor(SITE).map(({ bytes, ...e }) => e);
    assert.equal((await putManifest("1.1.3-ota.1", files)).status, 409);
    await upload("1.1.3-ota.2", bytesOf("zip"));
    assert.equal((await putManifest("1.1.3-ota.2", files)).status, 409);
  });

  test("rollback moves between manifest and zip bundles", async () => {
    await publish("1.1.3-ota.1");
    await publishManifest("1.1.3-ota.2", SITE);
    const back = await (await admin("/channels/beta/rollback", { native: "1.1.3" })).json();
    assert.equal(back.pointer.version, "1.1.3-ota.1");
    const zip = await (await check(device())).json();
    assert.equal(zip.manifest, undefined);
    assert.match(zip.url, /1\.1\.3-ota\.1\.zip/);
    await admin("/channels/beta/rollback", { native: "1.1.3", to: "1.1.3-ota.2" });
    assert.equal((await (await check(device())).json()).manifest.length, 3);
    const status = await (await admin("/channels/beta")).json();
    assert.equal(status.lines[0].kind, "manifest");
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
