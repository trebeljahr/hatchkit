#!/usr/bin/env node
/*
 * Publish a live-update bundle to the ota-updates Worker, or move a
 * channel pointer. App CI runs this from the app's repository root (the
 * Capgo CLI reads capacitor.config and package.json from there).
 *
 *   node publish.mjs publish  --app <id> --channel <beta|production> \
 *        --native <X.Y.Z> --version <semver> [--dist dist] \
 *        [--min-version-code <n>] [--expect-public-key <file>] [--no-promote] \
 *        [--allow-missing-notify-app-ready]
 *   node publish.mjs promote  --app <id> --channel <c> --version <v> [--min-version-code <n>]
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
 * Prints one JSON object on stdout; progress goes to stderr.
 */
import { spawnSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const CAPGO_CLI_VERSION = "8.87.2";
const DEFAULT_ENDPOINT = "https://ota.ricoslabs.com";
const DEFAULT_CAPGO = `npx --yes @capgo/cli@${CAPGO_CLI_VERSION}`;

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
  const privatePem = process.env.OTA_SIGNING_KEY;
  if (!privatePem || !privatePem.includes("PRIVATE KEY")) {
    throw new UsageError("OTA_SIGNING_KEY must hold the encryption v2 private key (PEM)");
  }
  const publicPem = publicKeyFromPrivate(privatePem.replace(/\\n/g, "\n"));
  if (values["expect-public-key"]) {
    const expected = readFileSync(resolve(cwd, values["expect-public-key"]), "utf8");
    if (normalizePem(expected) !== normalizePem(publicPem)) {
      throw new Error(
        `The signing key does not match ${values["expect-public-key"]}: devices built with that public key would reject this bundle.`,
      );
    }
  }
  const keyId = keyIdFromPublicKey(publicPem);

  const work = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "ota-publish-"));
  try {
    const keyFile = join(work, "signing-key.pem");
    writeFileSync(keyFile, privatePem.replace(/\\n/g, "\n"), { mode: 0o600 });
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

async function promote(values) {
  required(values, "app", "channel", "version");
  const body = { version: values.version };
  if (values.native) body.native = values.native;
  if (values["min-version-code"]) body.min_version_code = Number(values["min-version-code"]);
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
      "expect-public-key": { type: "string" },
      "no-promote": { type: "boolean" },
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
