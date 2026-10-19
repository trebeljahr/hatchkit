import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { keyIdFromPublicKey, publicKeyFromPrivate } from "./publish.mjs";
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

before(async () => {
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
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
});
