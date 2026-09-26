#!/usr/bin/env node
/**
 * Package and publish the browser extension to the Chrome Web Store.
 *
 *   node scripts/extension-package.mjs id [--dir packages/extension/dist]
 *   node scripts/extension-package.mjs package --tag vX.Y.Z --out <zip> [--dir <dir>]
 *   node scripts/extension-package.mjs publish --tag vX.Y.Z --zip <zip> [--upload-only]
 *
 * `id` prints the `chrome-extension://<id>` origin a build gets — the
 * value that has to be in the server's `TRUSTED_ORIGINS` before the
 * extension can make a single request.
 *
 * `package` checks the built manifest's version against the tag, checks
 * the `key` field PINS THE STORE ITEM and only then removes it, and
 * zips the directory CONTENTS with the manifest at the root. The order
 * matters: once the key is stripped there is nothing left to check, and
 * a build made with a fork's `EXTENSION_KEY` would be uploaded over
 * your listing.
 *
 * `publish` needs `CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET`,
 * `CHROME_REFRESH_TOKEN` and `CHROME_EXTENSION_ID`. It exchanges the
 * refresh token for an access token, uploads, and submits for review
 * unless `--upload-only`. Half a credential set is an error, never a
 * skip: a green run that uploaded nothing is the failure this guards.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const DEFAULT_DIR = join(repoRoot, "packages/extension/dist-prod");
const STORE_CONFIG = join(repoRoot, "packages/extension/store.config.json");
// The Chrome Web Store publishing API. v1.1 is the one an OAuth client
// with a refresh token talks to; it answers the upload synchronously,
// so there is no async status to poll.
const CWS_API = "https://www.googleapis.com/chromewebstore/v1.1";
const CWS_UPLOAD_API = "https://www.googleapis.com/upload/chromewebstore/v1.1";
const TOKEN_URI = "https://oauth2.googleapis.com/token";

const fail = (message) => {
  // `::error::` shows on the run summary; the plain line keeps local runs readable.
  console.error(process.env.GITHUB_ACTIONS ? `::error::${message}` : `error: ${message}`);
  process.exit(1);
};

// -- ids ---------------------------------------------------------------

/** Chrome maps each of the first 32 hex digits of the sha256 onto a-p. */
const idFromBytes = (bytes) =>
  [...createHash("sha256").update(bytes).digest("hex").slice(0, 32)]
    .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
    .join("");

/** The id a manifest `key` (base64 DER public key) pins. */
const extensionIdFromKey = (key) => idFromBytes(Buffer.from(key, "base64"));

const readStoreConfig = () => {
  try {
    return JSON.parse(readFileSync(STORE_CONFIG, "utf8"));
  } catch {
    return { storeExtensionId: "", storeExtensionKey: "" };
  }
};

/** The store item this build updates: the release secret when CI set
 *  one, else the id committed beside the key it is pinned by. */
const itemId = () =>
  process.env.CHROME_EXTENSION_ID?.trim() || readStoreConfig().storeExtensionId?.trim() || "";

const readManifest = (dir) => {
  const path = join(dir, "manifest.json");
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`cannot read ${path}: ${error.message}. Build the extension first.`);
  }
};

// -- versions ----------------------------------------------------------

const parseReleaseTag = (tag) => {
  const match = /^v(\d+\.\d+\.\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(tag.trim());
  if (!match) throw new Error(`"${tag}" is not a vX.Y.Z tag.`);
  return { version: match[1], prerelease: match[2] ?? null, full: match[2] ? `${match[1]}-${match[2]}` : match[1] };
};

/**
 * The manifest must claim the version the tag names.
 *
 * A prerelease is `version` + `version_name` (Chrome's `version` is
 * integers only), so the comparison is against whichever the build
 * produced. Without this check a forgotten version bump surfaces only
 * as the store refusing an upload, minutes into a release.
 */
const manifestVersionProblems = (manifest, tag) => {
  let parsed;
  try {
    parsed = parseReleaseTag(tag);
  } catch (error) {
    return [error.message];
  }
  const claimed = manifest.version_name ?? manifest.version;
  return claimed === parsed.full
    ? []
    : [`the manifest says ${claimed} but the tag says ${parsed.full}. Bump the root package.json version.`];
};

/** Paths that must never be in the upload, whatever the build emitted. */
const forbiddenPackagePaths = (paths) =>
  paths.filter((path) => /(^|\/)([^/]*\.pem|[^/]*\.crx|\.env[^/]*)$/i.test(path));

/** A private key in any file body — checked on every file, not by name only. */
const containsPrivateKey = (text) => /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(text);

/**
 * The manifest as the store gets it: no `key`.
 *
 * Chrome assigns the id from the uploaded package's own signature, and
 * a `key` in an uploaded manifest is at best ignored. Before it goes,
 * it must name the item being updated.
 */
const manifestForUpload = (manifest, item) => {
  if (typeof manifest.key === "string" && manifest.key !== "") {
    const id = extensionIdFromKey(manifest.key);
    if (item === "") {
      throw new Error(
        `the build pinned extension id ${id}, but store.config.json names no store item to check it against. ` +
          "Fill in storeExtensionId (and storeExtensionKey) before releasing.",
      );
    }
    if (id !== item) {
      throw new Error(
        `manifest key belongs to extension ${id}, not store item ${item}. Was the build run with EXTENSION_KEY set?`,
      );
    }
  }
  const { key: _key, ...rest } = manifest;
  return rest;
};

const listFiles = (dir) =>
  readdirSync(dir, { recursive: true })
    .map(String)
    .filter((path) => statSync(join(dir, path)).isFile())
    .sort();

// -- commands ----------------------------------------------------------

const idCommand = (values) => {
  const dir = resolve(values.dir ?? join(repoRoot, "packages/extension/dist"));
  const manifest = readManifest(dir);
  const key = typeof manifest.key === "string" && manifest.key !== "" ? manifest.key : null;
  // With no pinned key an unpacked extension's id is derived from its
  // PATH, which is why the dev build's out dir must not move.
  const id = key ? extensionIdFromKey(key) : idFromBytes(dir);
  console.log(`chrome-extension://${id}`);
  console.log(
    key
      ? "  (pinned by the manifest key: the same id unpacked, uploaded or installed from the store)"
      : `  (derived from ${dir}; moving that directory changes the id)`,
  );
};

const packageCommand = (values) => {
  const dir = resolve(values.dir ?? DEFAULT_DIR);
  if (!values.tag) fail("package needs --tag vX.Y.Z");
  if (!values.out) fail("package needs --out <zip>");

  const manifest = readManifest(dir);
  const problems = manifestVersionProblems(manifest, values.tag);
  if (problems.length > 0) fail(problems.join(" "));

  const staging = mkdtempSync(join(tmpdir(), "cws-package-"));
  try {
    cpSync(dir, staging, { recursive: true });
    let uploadManifest;
    try {
      uploadManifest = manifestForUpload(manifest, itemId());
    } catch (error) {
      fail(error.message);
    }
    writeFileSync(join(staging, "manifest.json"), `${JSON.stringify(uploadManifest, null, 2)}\n`);

    const files = listFiles(staging);
    const forbidden = forbiddenPackagePaths(files);
    if (forbidden.length > 0) fail(`refusing to package ${forbidden.join(", ")}`);
    const withKeys = files.filter((path) =>
      containsPrivateKey(readFileSync(join(staging, path), "latin1")),
    );
    if (withKeys.length > 0) fail(`private key material in ${withKeys.join(", ")}`);

    const out = resolve(values.out);
    rmSync(out, { force: true });
    // -X drops extra file attributes; run inside the directory so the
    // manifest sits at the zip root, which is what the store requires.
    execFileSync("zip", ["-q", "-X", "-r", out, "."], { cwd: staging, stdio: "inherit" });

    console.log(`packaged ${relative(repoRoot, dir) || dir} -> ${out}`);
    console.log(
      `  version ${uploadManifest.version}${uploadManifest.version_name ? ` (${uploadManifest.version_name})` : ""}, ` +
        `${files.length} entries, key field removed: ${"key" in manifest}`,
    );
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
};

const readBody = async (response) => {
  const text = await response.text();
  try {
    return text === "" ? null : JSON.parse(text);
  } catch {
    return { raw: text };
  }
};

/**
 * An access token from the refresh token.
 *
 * The refresh token is long-lived and issued once, by a one-time
 * browser consent for the OAuth client — Google does not issue a second
 * one for the same client, which is why it is a repo secret rather than
 * something a job re-derives.
 */
const accessTokenFromRefreshToken = async ({ clientId, clientSecret, refreshToken }) => {
  const response = await fetch(TOKEN_URI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });
  const body = await readBody(response);
  if (!response.ok || typeof body?.access_token !== "string") {
    throw new Error(
      `token exchange failed: HTTP ${response.status} ${JSON.stringify(body)}. ` +
        "A refresh token is revoked by changing the OAuth client or the account's password.",
    );
  }
  return body.access_token;
};

const createStoreClient = ({ accessToken, item }) => {
  const call = async (label, url, init) => {
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "x-goog-api-version": "2",
        ...init.headers,
      },
    });
    const body = await readBody(response);
    if (!response.ok) {
      throw new Error(`${label} failed: HTTP ${response.status} ${JSON.stringify(body)}`);
    }
    return body ?? {};
  };
  return {
    upload: (zip) =>
      call("upload", `${CWS_UPLOAD_API}/items/${encodeURIComponent(item)}`, {
        method: "PUT",
        body: zip,
      }),
    publish: () =>
      call("publish", `${CWS_API}/items/${encodeURIComponent(item)}/publish`, {
        method: "POST",
        headers: { "Content-Length": "0" },
      }),
  };
};

/** Store statuses that mean the submission was accepted. */
const ACCEPTED_PUBLISH_STATUSES = new Set([
  "OK",
  "PUBLISHED",
  "ITEM_PENDING_REVIEW",
  "PUBLISHED_WITH_FRICTION_WARNING",
]);

const publishCommand = async (values) => {
  if (!values.tag) fail("publish needs --tag vX.Y.Z");
  if (!values.zip) fail("publish needs --zip <file>");
  let tag;
  try {
    tag = parseReleaseTag(values.tag);
  } catch (error) {
    fail(error.message);
  }
  if (tag.prerelease) {
    fail(`${values.tag} is a prerelease; the store has one public channel, so prereleases are not uploaded.`);
  }

  const item = itemId();
  if (item === "") {
    fail(
      "no store item id: set CHROME_EXTENSION_ID, or fill in storeExtensionId in packages/extension/store.config.json.",
    );
  }
  const clientId = process.env.CHROME_CLIENT_ID?.trim();
  const clientSecret = process.env.CHROME_CLIENT_SECRET?.trim();
  const refreshToken = process.env.CHROME_REFRESH_TOKEN?.trim();
  if (!clientId || !clientSecret || !refreshToken) {
    fail("publish needs CHROME_CLIENT_ID, CHROME_CLIENT_SECRET and CHROME_REFRESH_TOKEN.");
  }

  let accessToken;
  try {
    accessToken = await accessTokenFromRefreshToken({ clientId, clientSecret, refreshToken });
  } catch (error) {
    fail(error.message);
  }
  const client = createStoreClient({ accessToken, item });
  const zip = readFileSync(resolve(values.zip));

  try {
    const uploaded = await client.upload(zip);
    const state = uploaded.uploadState ?? "UNKNOWN";
    console.log(`upload: ${state}`);
    if (state === "FAILURE") {
      const details = (uploaded.itemError ?? [])
        .map((e) => e.error_detail ?? e.error_code ?? "")
        .filter(Boolean)
        .join("; ");
      fail(`the store refused the package${details ? `: ${details}` : "."}`);
    }
    if (state !== "SUCCESS") {
      // IN_PROGRESS means a previous upload is still being processed;
      // publishing on top of it would submit the wrong bytes.
      fail(`upload state ${state} — not submitting. Check the Developer Dashboard.`);
    }

    if (values["upload-only"]) {
      console.log("uploaded as a draft; not submitted for review (--upload-only).");
      return;
    }

    const result = await client.publish();
    const statuses = Array.isArray(result.status) ? result.status : [];
    console.log(`publish: ${statuses.join(", ") || "no status"}`);
    for (const detail of result.statusDetail ?? []) console.log(`  ${detail}`);
    if (!statuses.some((status) => ACCEPTED_PUBLISH_STATUSES.has(status))) {
      fail(`publish answered ${statuses.join(", ") || "(nothing)"}, not an accepted status.`);
    }
  } catch (error) {
    fail(error.message);
  }
};

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    tag: { type: "string" },
    out: { type: "string" },
    dir: { type: "string" },
    zip: { type: "string" },
    "upload-only": { type: "boolean" },
  },
});

const command = positionals[0];
if (command === "id") idCommand(values);
else if (command === "package") packageCommand(values);
else if (command === "publish") await publishCommand(values);
else fail(`unknown command "${command ?? ""}". Use id, package or publish.`);
