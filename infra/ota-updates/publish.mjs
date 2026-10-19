#!/usr/bin/env node
/*
 * Publish a live-update bundle to the ota-updates Worker, or move a
 * channel pointer. App CI runs this from the app's repository root (the
 * Capgo CLI reads capacitor.config and package.json from there).
 *
 *   node publish.mjs publish  --app <id> --channel <beta|production> \
 *        --native <X.Y.Z> --version <semver> [--dist dist] [--delta] \
 *        [--min-version-code <n>] [--min-ios-build <a.b.c>] [--expect-public-key <file>] \
 *        [--no-promote] [--allow-missing-notify-app-ready]
 *   node publish.mjs promote  --app <id> --channel <c> --version <v> [--min-version-code <n>]
 *        [--min-ios-build <a.b.c>]
 *   node publish.mjs rollback --app <id> --channel <c> --native <X.Y.Z> [--to <version|builtin>]
 *   node publish.mjs status   --app <id> --channel <c> [--native <X.Y.Z>]
 *
 * Environment:
 *   OTA_PUBLISH_TOKEN   per-app publish token (required)
 *   OTA_SIGNING_KEY     encryption v2 private key, PEM (publish only)
 *   OTA_ENDPOINT        default https://ota.ricoslabs.com
 *   OTA_CAPGO_CLI       command that runs the Capgo CLI (tests replace it)
 *
 * `publish` zips the web build with `@capgo/cli bundle zip`, encrypts it
 * with `bundle encrypt` (encryption v2: the checksum and the session key
 * are encrypted with the private key), uploads the encrypted zip and then
 * points the channel's native line at it. The private key only ever sits
 * in a 0600 temp file that is removed before the script exits.
 *
 * `publish --delta` builds a manifest bundle instead, the way
 * `@capgo/cli bundle upload --delta` does: every file is brotli-compressed
 * when that pays, encrypted with the session key, and uploaded once under
 * the SHA-256 of its bytes; the manifest lists each file's name, its
 * encrypted plain SHA-256 and that object. Devices fetch only the files
 * their store build and earlier updates do not hold. The session key is
 * derived from the private key, so an unchanged file encrypts to the same
 * bytes and is not uploaded again. No Capgo CLI runs and the private key
 * never leaves this process.
 *
 * Prints one JSON object on stdout; progress goes to stderr.
 */
import { spawnSync } from "node:child_process";
import {
  constants,
  createCipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  privateEncrypt,
} from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { brotliCompressSync } from "node:zlib";

export const CAPGO_CLI_VERSION = "8.87.2";
const DEFAULT_ENDPOINT = "https://ota.ricoslabs.com";
const DEFAULT_CAPGO = `npx --yes @capgo/cli@${CAPGO_CLI_VERSION}`;

// Delta bundles. Left-out names and the brotli threshold match @capgo/cli 8.87.2.
const IGNORED_NAMES = new Set([".DS_Store", ".git", ".gitignore", "node_modules"]);
const BROTLI_MIN_SIZE = 8192;
// Already compressed: brotli would burn minutes on large sprites for nothing.
const PRECOMPRESSED = /\.(png|jpe?g|gif|webp|avif|mp3|mp4|m4a|aac|ogg|oga|opus|webm|woff2?|zip|gz)$/i;
// Workers refuses request bodies above 100 MB.
const FILE_UPLOAD_LIMIT = 95 * 1024 * 1024;
// Matches the Worker's FILE_CHECK_LIMIT.
const FILE_CHECK_BATCH = 40;
const UPLOAD_CONCURRENCY = 6;

const log = (message) => process.stderr.write(`${message}\n`);

class UsageError extends Error {}

/** The key id the plugin sends: the first 20 base64 characters of the
 *  PKCS#1 public key, without PEM armour (CryptoCipher.calcKeyId). */
export function keyIdFromPublicKey(pem) {
  const body = pem
    .replace(/-----BEGIN RSA PUBLIC KEY-----/g, "")
    .replace(/-----END RSA PUBLIC KEY-----/g, "")
    .replace(/\s+/g, "");
  return body.slice(0, 20);
}

export function publicKeyFromPrivate(privatePem) {
  return createPublicKey(createPrivateKey(privatePem)).export({ type: "pkcs1", format: "pem" }).toString();
}

function normalizePem(pem) {
  return pem.replace(/\\n/g, "\n").replace(/\s+/g, "");
}

const rsa = (privatePem, bytes) => privateEncrypt({ key: privatePem, padding: constants.RSA_PKCS1_PADDING }, bytes);

/** The AES-128-CBC session key of an app's delta bundles, as encryption v2
 *  sends it: `base64(iv):base64(rsa(key))`. It is derived from the private
 *  key, and PKCS#1 v1.5 signing padding is deterministic, so it is the same
 *  on every run and an unchanged file encrypts to the same bytes. */
export function deltaSession(privatePem, app) {
  const der = createPrivateKey(privatePem).export({ type: "pkcs1", format: "der" });
  const okm = Buffer.from(hkdfSync("sha256", der, "ota-updates delta session key v1", app, 32));
  const key = okm.subarray(0, 16);
  const iv = okm.subarray(16, 32);
  return { key, iv, ivSessionKey: `${iv.toString("base64")}:${rsa(privatePem, key).toString("base64")}` };
}

/** A file's SHA-256, encrypted with the private key and hex-encoded: the
 *  checksum format the CLI uses for @capgo/capacitor-updater ≥ 7.30 (V3). */
export function encryptChecksum(privatePem, sha256Hex) {
  return rsa(privatePem, Buffer.from(sha256Hex, "hex")).toString("hex");
}

function encryptBytes(session, bytes) {
  const cipher = createCipheriv("aes-128-cbc", session.key, session.iv);
  return Buffer.concat([cipher.update(bytes), cipher.final()]);
}

const digestHex = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The web build's files, sorted, with forward-slash paths relative to `dist`. */
function listBundleFiles(dist) {
  const files = [];
  const walk = (dir, prefix) => {
    const names = readdirSync(dir).sort();
    for (const name of names) {
      if (IGNORED_NAMES.has(name)) continue;
      const path = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path, rel);
      else if (stat.isFile()) files.push({ name: rel, path, size: stat.size });
    }
  };
  walk(dist, "");
  return files;
}

/** Delta files are brotli + checksum V3; older plugins cannot read them. */
function checkUpdaterSupportsDelta(cwd) {
  const file = join(cwd, "node_modules", "@capgo", "capacitor-updater", "package.json");
  if (!existsSync(file)) return;
  const version = JSON.parse(readFileSync(file, "utf8")).version ?? "";
  const [major, minor] = version.split(".").map(Number);
  if (!(major >= 8 || ([5, 6, 7].includes(major) && minor >= 30))) {
    throw new Error(`--delta needs @capgo/capacitor-updater 7.30 or later; this app has ${version}.`);
  }
}

async function eachLimit(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

async function missingFiles(app, hashes) {
  const missing = [];
  for (let i = 0; i < hashes.length; i += FILE_CHECK_BATCH) {
    const res = await api("POST", `/admin/apps/${enc(app)}/files/missing`, {
      body: JSON.stringify({ sha256: hashes.slice(i, i + FILE_CHECK_BATCH) }),
      headers: { "content-type": "application/json" },
    });
    missing.push(...res.missing);
  }
  return missing;
}

function capgo(args, cwd) {
  const command = (process.env.OTA_CAPGO_CLI || DEFAULT_CAPGO).split(" ").filter(Boolean);
  const result = spawnSync(command[0], [...command.slice(1), ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CAPGO_DISABLE_TELEMETRY: "true" },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const out = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    throw new Error(`capgo ${args.slice(0, 2).join(" ")} failed:\n${out}`);
  }
  // --json prints one object, but some versions put log lines before it.
  const stdout = result.stdout.trim();
  const start = stdout.indexOf("{");
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    throw new Error(`capgo ${args.slice(0, 2).join(" ")} printed no JSON:\n${stdout}`);
  }
}

async function api(method, path, { body, headers = {} } = {}) {
  const endpoint = (process.env.OTA_ENDPOINT || DEFAULT_ENDPOINT).replace(/\/+$/, "");
  const token = process.env.OTA_PUBLISH_TOKEN;
  if (!token) throw new UsageError("OTA_PUBLISH_TOKEN is not set");
  const res = await fetch(endpoint + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...headers },
    body,
  });
  const text = await res.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    value = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${value.message ?? value.error ?? text}`);
  }
  return value;
}

const enc = encodeURIComponent;

function required(values, ...names) {
  for (const name of names) {
    if (!values[name]) throw new UsageError(`--${name} is required`);
  }
}

async function publish(values) {
  required(values, "app", "channel", "native", "version");
  const cwd = process.cwd();
  const dist = resolve(cwd, values.dist ?? "dist");
  const rawKey = process.env.OTA_SIGNING_KEY;
  if (!rawKey || !rawKey.includes("PRIVATE KEY")) {
    throw new UsageError("OTA_SIGNING_KEY must hold the encryption v2 private key (PEM)");
  }
  const privatePem = rawKey.replace(/\\n/g, "\n");
  const publicPem = publicKeyFromPrivate(privatePem);
  if (values["expect-public-key"]) {
    const expected = readFileSync(resolve(cwd, values["expect-public-key"]), "utf8");
    if (normalizePem(expected) !== normalizePem(publicPem)) {
      throw new Error(
        `The signing key does not match ${values["expect-public-key"]}: devices built with that public key would reject this bundle.`,
      );
    }
  }
  const keyId = keyIdFromPublicKey(publicPem);
  if (values.delta) return publishDelta(values, { cwd, dist, privatePem, keyId });

  const work = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "ota-publish-"));
  try {
    const keyFile = join(work, "signing-key.pem");
    writeFileSync(keyFile, privatePem, { mode: 0o600 });
    const zipFile = join(work, "bundle.zip");

    log(`Zipping ${dist} as ${values.app} ${values.version}`);
    const zipArgs = ["bundle", "zip", values.app, "--path", dist, "--bundle", values.version, "--name", zipFile, "--json"];
    if (values["allow-missing-notify-app-ready"]) zipArgs.push("--ignore-notify-app-ready");
    const zipped = capgo(zipArgs, cwd);
    if (!/^[0-9a-f]{64}$/.test(zipped.checksum ?? "")) throw new Error("bundle zip returned no SHA-256 checksum");

    log("Encrypting (encryption v2)");
    const encrypted = capgo(["bundle", "encrypt", zipped.filename ?? zipFile, zipped.checksum, "--key", keyFile, "--json"], cwd);
    rmSync(keyFile, { force: true });
    if (!encrypted.ivSessionKey || !encrypted.checksum || !encrypted.filename) {
      throw new Error("bundle encrypt returned no checksum, filename or ivSessionKey");
    }

    const bytes = readFileSync(encrypted.filename);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    log(`Uploading ${bytes.length} bytes`);
    const meta = await api("PUT", `/admin/apps/${enc(values.app)}/bundles/${enc(values.version)}`, {
      body: bytes,
      headers: {
        "content-type": "application/zip",
        "content-length": String(bytes.length),
        "x-ota-native": values.native,
        "x-ota-checksum": encrypted.checksum,
        "x-ota-session-key": encrypted.ivSessionKey,
        "x-ota-key-id": keyId,
        "x-ota-sha256": sha256,
      },
    });

    let promoted = null;
    if (!values["no-promote"]) {
      log(`Pointing ${values.channel} ${values.native} at ${values.version}`);
      promoted = await promote(values);
    }
    return {
      app_id: values.app,
      channel: values.channel,
      native: values.native,
      version: values.version,
      size: meta.size,
      sha256,
      key_id: keyId,
      previous: promoted?.previous ?? null,
      promoted: Boolean(promoted),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function publishDelta(values, { cwd, dist, privatePem, keyId }) {
  checkUpdaterSupportsDelta(cwd);
  if (!existsSync(join(dist, "index.html"))) throw new Error(`${dist} has no index.html`);
  const all = listBundleFiles(dist);
  // iOS refuses a file that decrypts to nothing; the CLI leaves them out too.
  const empty = all.filter((f) => f.size === 0);
  if (empty.length) log(`Leaving out empty files: ${empty.map((f) => f.name).join(", ")}`);
  const files = all.filter((f) => f.size > 0);
  const brotliNamed = files.find((f) => f.name.endsWith(".br"));
  if (brotliNamed) {
    throw new Error(`${brotliNamed.name}: the plugin unpacks every .br file of a manifest; remove precompressed files from the build`);
  }
  // Same check as `@capgo/cli bundle zip`: a bundle that never calls it is rolled back.
  if (
    !values["allow-missing-notify-app-ready"] &&
    !files.some((f) => f.name.endsWith(".js") && readFileSync(f.path, "utf8").includes("notifyAppReady"))
  ) {
    throw new Error(`notifyAppReady() is missing in the build folder (${dist})`);
  }

  const session = deltaSession(privatePem, values.app);
  const work = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "ota-publish-"));
  try {
    log(`Preparing ${files.length} files of ${values.app} ${values.version}`);
    const entries = [];
    for (const file of files) {
      const plain = readFileSync(file.path);
      let body = plain;
      let name = file.name;
      if (plain.length >= BROTLI_MIN_SIZE && !PRECOMPRESSED.test(name)) {
        const packed = brotliCompressSync(plain);
        if (packed.length < plain.length - 10) {
          body = packed;
          name = `${name}.br`;
        }
      }
      const bytes = encryptBytes(session, body);
      if (bytes.length > FILE_UPLOAD_LIMIT) throw new Error(`${file.name} is too large to upload (${bytes.length} bytes)`);
      const objectSha = digestHex(bytes);
      writeFileSync(join(work, objectSha), bytes);
      entries.push({
        file_name: name,
        file_hash: encryptChecksum(privatePem, digestHex(plain)),
        sha256: objectSha,
        size: bytes.length,
      });
    }

    const objects = [...new Set(entries.map((e) => e.sha256))];
    const missing = await missingFiles(values.app, objects);
    let uploadedBytes = 0;
    log(`Uploading ${missing.length} of ${objects.length} files`);
    await eachLimit(missing, UPLOAD_CONCURRENCY, async (sha) => {
      const bytes = readFileSync(join(work, sha));
      await api("PUT", `/admin/apps/${enc(values.app)}/files/${sha}`, {
        body: bytes,
        headers: { "content-type": "application/octet-stream", "content-length": String(bytes.length) },
      });
      uploadedBytes += bytes.length;
    });
    // The Worker cannot afford to check every file; do it here.
    const stillMissing = await missingFiles(values.app, objects);
    if (stillMissing.length) throw new Error(`${stillMissing.length} files are still missing after the upload`);

    const meta = await api("PUT", `/admin/apps/${enc(values.app)}/bundles/${enc(values.version)}/manifest`, {
      body: JSON.stringify({ native: values.native, session_key: session.ivSessionKey, key_id: keyId, files: entries }),
      headers: { "content-type": "application/json" },
    });

    let promoted = null;
    if (!values["no-promote"]) {
      log(`Pointing ${values.channel} ${values.native} at ${values.version}`);
      promoted = await promote(values);
    }
    return {
      app_id: values.app,
      channel: values.channel,
      native: values.native,
      version: values.version,
      kind: "manifest",
      files: entries.length,
      uploaded: missing.length,
      uploaded_bytes: uploadedBytes,
      size: meta.size,
      key_id: keyId,
      previous: promoted?.previous ?? null,
      promoted: Boolean(promoted),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function promote(values) {
  required(values, "app", "channel", "version");
  const body = { version: values.version };
  if (values.native) body.native = values.native;
  if (values["min-version-code"]) body.min_version_code = Number(values["min-version-code"]);
  if (values["min-ios-build"]) body.min_ios_build = values["min-ios-build"];
  return api("POST", `/admin/apps/${enc(values.app)}/channels/${enc(values.channel)}/promote`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

async function rollback(values) {
  required(values, "app", "channel", "native");
  const body = { native: values.native };
  if (values.to) body.to = values.to;
  return api("POST", `/admin/apps/${enc(values.app)}/channels/${enc(values.channel)}/rollback`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

async function status(values) {
  required(values, "app", "channel");
  const base = `/admin/apps/${enc(values.app)}/channels/${enc(values.channel)}`;
  return api("GET", values.native ? `${base}/${enc(values.native)}` : base);
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      app: { type: "string" },
      channel: { type: "string" },
      native: { type: "string" },
      version: { type: "string" },
      dist: { type: "string" },
      to: { type: "string" },
      "min-version-code": { type: "string" },
      "min-ios-build": { type: "string" },
      "expect-public-key": { type: "string" },
      "no-promote": { type: "boolean" },
      delta: { type: "boolean" },
      "allow-missing-notify-app-ready": { type: "boolean" },
    },
  });
  const commands = { publish, promote, rollback, status };
  if (!commands[command]) throw new UsageError(`Unknown command "${command ?? ""}". Use publish, promote, rollback or status.`);
  return commands[command](values);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((err) => {
      log(`ota-publish: ${err.message}`);
      process.exit(err instanceof UsageError ? 2 : 1);
    });
}
