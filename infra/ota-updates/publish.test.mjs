import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants, createDecipheriv, createHash, generateKeyPairSync, publicDecrypt } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { brotliDecompressSync } from "node:zlib";
import { deltaSession, keyIdFromPublicKey, publicKeyFromPrivate } from "./publish.mjs";
import { FakeBucket, FakeCache, sha256Hex } from "./test-support.mjs";
import worker from "./worker.js";

console.log = () => {};
const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const APP = "com.ricoslabs.raptorrunner";
const TOKEN = "raptor-publish-token-0123456789abcdef";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
});

let env;
let server;
let endpoint;
let appDir;
let capgoLog;
let fileUploads;
let failures;

before(async () => {
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    if (req.method === "PUT" && req.url.includes("/files/")) {
      fileUploads++;
      // A dropped connection, then a Cloudflare error page.
      if (failures.drop > 0 && failures.drop--) return req.socket.destroy();
      if (failures.status > 0 && failures.status--) return res.writeHead(503).end("<html>busy</html>");
    }
    const request = new Request(`${endpoint}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    });
    const response = await worker.fetch(request, env, {});
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  endpoint = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

beforeEach(() => {
  globalThis.caches = { default: new FakeCache() };
  env = {
    BUCKET: new FakeBucket(),
    APPS: JSON.stringify([APP]),
    CHANNELS: JSON.stringify(["production", "beta"]),
    URL_SIGNING_KEY: "s".repeat(48),
    PUBLISH_TOKEN_HASHES: JSON.stringify({ [APP]: sha256Hex(TOKEN) }),
  };
  appDir = mkdtempSync(join(tmpdir(), "ota-app-"));
  mkdirSync(join(appDir, "dist"));
  writeFileSync(join(appDir, "dist", "index.html"), "<script src=main.js></script>");
  writeFileSync(join(appDir, "dist", "main.js"), "CapacitorUpdater.notifyAppReady(); window.VERSION='1.1.3-ota.4';");
  writeFileSync(join(appDir, "public-key.pem"), publicKey);
  capgoLog = join(appDir, "capgo.log");
  fileUploads = 0;
  failures = { drop: 0, status: 0 };
});

function publishCli(args, extraEnv = {}) {
  return run(process.execPath, [join(here, "publish.mjs"), ...args], {
    cwd: appDir,
    env: {
      ...process.env,
      OTA_ENDPOINT: endpoint,
      OTA_PUBLISH_TOKEN: TOKEN,
      OTA_SIGNING_KEY: privateKey,
      OTA_CAPGO_CLI: `${process.execPath} ${join(here, "fake-capgo.mjs")}`,
      FAKE_CAPGO_LOG: capgoLog,
      RUNNER_TEMP: appDir,
      OTA_RETRY_DELAY_MS: "1",
      ...extraEnv,
    },
  });
}

const PUBLISH = ["publish", "--app", APP, "--channel", "beta", "--native", "1.1.3", "--version", "1.1.3-ota.4"];

async function deviceCheck(overrides = {}) {
  const res = await fetch(`${endpoint}/updates`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      app_id: APP,
      platform: "android",
      version_build: "1.1.3",
      version_code: "7",
      version_name: "builtin",
      defaultChannel: "beta",
      key_id: keyIdFromPublicKey(publicKey),
      ...overrides,
    }),
  });
  return res.json();
}

describe("publish.mjs", () => {
  test("the key id matches the plugin's calcKeyId", () => {
    const id = keyIdFromPublicKey(publicKeyFromPrivate(privateKey));
    assert.equal(id.length, 20);
    assert.ok(id.startsWith("MIIBCgKCAQEA"));
    assert.equal(id, keyIdFromPublicKey(publicKey));
  });

  test("publish zips, encrypts, uploads and moves the beta pointer", async () => {
    const { stdout } = await publishCli([...PUBLISH, "--expect-public-key", "public-key.pem"]);
    const result = JSON.parse(stdout);
    assert.equal(result.version, "1.1.3-ota.4");
    assert.equal(result.promoted, true);

    const reply = await deviceCheck();
    assert.equal(reply.version, "1.1.3-ota.4");
    assert.equal(reply.session_key, "dGVzdC1pdg:ZmFrZS1zZXNzaW9uLWtleS1mb3ItdGVzdHM");
    assert.equal(reply.checksum.length, 128);

    // The device downloads exactly the encrypted file publish.mjs uploaded.
    const download = Buffer.from(await (await fetch(reply.url)).arrayBuffer());
    assert.equal(createHash("sha256").update(download).digest("hex"), result.sha256);

    // Another native line still gets nothing.
    assert.equal((await deviceCheck({ version_build: "1.1.2" })).kind, "up_to_date");
  });

  test("the private key reaches the Capgo CLI only as a 0600 file, deleted afterwards", async () => {
    await publishCli(PUBLISH);
    const calls = readFileSync(capgoLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const encrypt = calls.find((c) => c.args[1] === "encrypt");
    assert.equal(encrypt.keyMode, "600");
    for (const call of calls) assert.ok(!call.args.some((a) => a.includes("PRIVATE KEY")));
    assert.deepEqual(
      readdirSync(appDir).filter((f) => f.startsWith("ota-publish-")),
      [],
    );
  });

  test("a signing key that does not match the app's public key stops before upload", async () => {
    const other = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "pkcs1", format: "pem" },
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
    });
    await assert.rejects(
      publishCli([...PUBLISH, "--expect-public-key", "public-key.pem"], { OTA_SIGNING_KEY: other.privateKey }),
      /does not match public-key\.pem/,
    );
    assert.equal(env.BUCKET.objects.size, 0);
  });

  test("a build without notifyAppReady() is refused unless asked for", async () => {
    writeFileSync(join(appDir, "dist", "main.js"), "window.broken = true;");
    await assert.rejects(publishCli(PUBLISH), /notifyAppReady/);
    await publishCli([...PUBLISH, "--allow-missing-notify-app-ready"]);
    assert.equal((await deviceCheck()).version, "1.1.3-ota.4");
  });

  test("a wrong publish token fails without changing anything", async () => {
    await assert.rejects(publishCli(PUBLISH, { OTA_PUBLISH_TOKEN: "nope" }), /401/);
    assert.equal(env.BUCKET.objects.size, 0);
  });

  test("rollback and status move and read the pointer", async () => {
    await publishCli(PUBLISH);
    await publishCli([...PUBLISH.slice(0, -1), "1.1.3-ota.5"]);
    assert.equal((await deviceCheck()).version, "1.1.3-ota.5");

    const { stdout } = await publishCli(["rollback", "--app", APP, "--channel", "beta", "--native", "1.1.3"]);
    assert.equal(JSON.parse(stdout).pointer.version, "1.1.3-ota.4");
    assert.equal((await deviceCheck()).version, "1.1.3-ota.4");

    const status = JSON.parse((await publishCli(["status", "--app", APP, "--channel", "beta"])).stdout);
    assert.deepEqual(status.lines.map((l) => l.version), ["1.1.3-ota.4"]);
  });

  test("--no-promote uploads without moving the pointer; promote moves it later", async () => {
    await publishCli([...PUBLISH, "--no-promote"]);
    assert.equal((await deviceCheck()).kind, "up_to_date");
    await publishCli(["promote", "--app", APP, "--channel", "beta", "--version", "1.1.3-ota.4"]);
    assert.equal((await deviceCheck()).version, "1.1.3-ota.4");
  });

  test("--min-ios-build sets the iOS minimum next to --min-version-code", async () => {
    await publishCli([...PUBLISH, "--min-version-code", "213450507", "--min-ios-build", "21345.5.7"]);
    assert.equal((await deviceCheck({ platform: "ios", version_code: "21345.5.7" })).version, "1.1.3-ota.4");
    assert.equal((await deviceCheck({ platform: "ios", version_code: "21345.5.6" })).kind, "up_to_date");
    assert.equal((await deviceCheck({ platform: "android", version_code: "213450507" })).version, "1.1.3-ota.4");
  });
});

const DELTA = [...PUBLISH, "--delta"];
const deltaVersion = (version) => [...DELTA.slice(0, 8), version, "--delta"];
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The web build of a game: code, a large compressible file, a sprite that
 *  is already compressed, plus files a manifest leaves out. */
function writeGame(dist) {
  mkdirSync(join(dist, "assets", "sprites"), { recursive: true });
  writeFileSync(join(dist, "assets", "level.json"), JSON.stringify({ tiles: Array(4000).fill("grass") }));
  writeFileSync(join(dist, "assets", "sprites", "raptor.png"), Buffer.alloc(20_000, 7));
  writeFileSync(join(dist, "empty.txt"), "");
  writeFileSync(join(dist, ".DS_Store"), "finder");
}

/** What @capgo/capacitor-updater 8.53 does with a manifest reply
 *  (CapgoUpdater.downloadManifest): for each entry, decrypt file_hash with
 *  the public key; reuse the store build's file when its SHA-256 matches;
 *  otherwise download, decrypt with the session key, unpack `.br` and
 *  check the SHA-256. */
async function deviceInstall(reply, builtinDir) {
  const open = (bytes) => publicDecrypt({ key: publicKey, padding: constants.RSA_PKCS1_PADDING }, bytes);
  const [iv, sealedKey] = reply.session_key.split(":");
  const key = open(Buffer.from(sealedKey, "base64"));
  const files = new Map();
  const downloaded = [];
  for (const entry of reply.manifest) {
    const hash = open(Buffer.from(entry.file_hash, "hex")).toString("hex");
    const target = entry.file_name.replace(/\.br$/, "");
    const builtin = join(builtinDir, target);
    if (existsSync(builtin) && sha(readFileSync(builtin)) === hash) {
      files.set(target, readFileSync(builtin));
      continue;
    }
    const res = await fetch(entry.download_url);
    assert.equal(res.status, 200, target);
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.from(iv, "base64"));
    let bytes = Buffer.concat([decipher.update(Buffer.from(await res.arrayBuffer())), decipher.final()]);
    if (entry.file_name.endsWith(".br")) bytes = brotliDecompressSync(bytes);
    assert.equal(sha(bytes), hash, target);
    files.set(target, bytes);
    downloaded.push(target);
  }
  return { files, downloaded };
}

describe("publish.mjs --delta", () => {
  test("a device rebuilds the web build from the manifest's files", async () => {
    writeGame(join(appDir, "dist"));
    const result = JSON.parse((await publishCli([...DELTA, "--expect-public-key", "public-key.pem"])).stdout);
    assert.equal(result.kind, "manifest");
    assert.equal(result.files, 4);
    assert.equal(result.uploaded, 4);
    assert.equal(result.promoted, true);
    assert.equal(fileUploads, 4);

    const reply = await deviceCheck();
    assert.equal(reply.version, "1.1.3-ota.4");
    assert.equal(reply.session_key, deltaSession(privateKey, APP).ivSessionKey);
    // Large text travels brotli-compressed; the sprite and small files as they are.
    // Empty files and .DS_Store are left out.
    assert.deepEqual(
      reply.manifest.map((m) => m.file_name),
      ["assets/level.json.br", "assets/sprites/raptor.png", "index.html", "main.js"],
    );

    const { files, downloaded } = await deviceInstall(reply, mkdtempSync(join(appDir, "store-")));
    assert.equal(downloaded.length, 4);
    for (const [name, bytes] of files) assert.deepEqual(bytes, readFileSync(join(appDir, "dist", name)), name);
  });

  test("the next version uploads only changed files, and a device downloads only those", async () => {
    writeGame(join(appDir, "dist"));
    await publishCli(DELTA);
    // The store build ships this web build.
    const store = join(appDir, "store");
    cpSync(join(appDir, "dist"), store, { recursive: true });

    fileUploads = 0;
    writeFileSync(join(appDir, "dist", "main.js"), "CapacitorUpdater.notifyAppReady(); window.VERSION='1.1.3-ota.5';");
    const result = JSON.parse((await publishCli(deltaVersion("1.1.3-ota.5"))).stdout);
    assert.equal(result.files, 4);
    assert.equal(result.uploaded, 1);
    assert.equal(fileUploads, 1);

    const reply = await deviceCheck();
    assert.equal(reply.version, "1.1.3-ota.5");
    const { files, downloaded } = await deviceInstall(reply, store);
    assert.deepEqual(downloaded, ["main.js"]);
    assert.match(files.get("main.js").toString(), /1\.1\.3-ota\.5/);

    // A rollback to the first version needs no upload at all.
    const back = await publishCli(["rollback", "--app", APP, "--channel", "beta", "--native", "1.1.3"]);
    assert.equal(JSON.parse(back.stdout).pointer.version, "1.1.3-ota.4");
  });

  test("a dropped connection or a 503 during a file upload is retried", async () => {
    failures = { drop: 1, status: 2 };
    const result = JSON.parse((await publishCli(DELTA)).stdout);
    assert.equal(result.uploaded, 2);
    assert.equal(fileUploads, 5);
    assert.equal((await deviceCheck()).version, "1.1.3-ota.4");
  });

  test("delta mode runs no Capgo CLI and writes no key file", async () => {
    await publishCli(DELTA);
    assert.equal(existsSync(capgoLog), false);
    assert.deepEqual(
      readdirSync(appDir).filter((f) => f.startsWith("ota-publish-")),
      [],
    );
  });

  test("a build that cannot be a delta bundle stops before upload", async () => {
    writeFileSync(join(appDir, "dist", "main.js"), "window.broken = true;");
    await assert.rejects(publishCli(DELTA), /notifyAppReady/);

    writeFileSync(join(appDir, "dist", "main.js"), "CapacitorUpdater.notifyAppReady();");
    writeFileSync(join(appDir, "dist", "main.js.br"), "precompressed");
    await assert.rejects(publishCli(DELTA), /main\.js\.br: the plugin unpacks every \.br file/);

    const old = join(appDir, "node_modules", "@capgo", "capacitor-updater");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "package.json"), JSON.stringify({ version: "7.25.0" }));
    await assert.rejects(publishCli(DELTA), /needs @capgo\/capacitor-updater 7\.30/);
    assert.equal(env.BUCKET.objects.size, 0);
  });

  test("a version already published as a zip cannot become a manifest", async () => {
    await publishCli(PUBLISH);
    await assert.rejects(publishCli(DELTA), /409/);
    assert.equal((await deviceCheck()).manifest, undefined);
  });
});
