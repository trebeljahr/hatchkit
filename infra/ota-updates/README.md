# ota-updates — live updates for the Capacitor apps

A self-hosted backend for [`@capgo/capacitor-updater`](https://github.com/Cap-go/capacitor-updater):
one Cloudflare Worker plus one R2 bucket at `https://ota.ricoslabs.com`, shared by every app in
`APPS` (Raptor Runner, Track Your Time, Tiao, Mesozoic Protocol). It replaces Capgo Cloud; the
plugin and the app-side setup are the same.

- `worker.js` — the Worker (no dependencies, no build step).
- `publish.mjs` — what app CI runs: zip, encrypt, upload, move the pointer (or, with `--delta`,
  upload only the changed files and a manifest); also `promote`, `rollback`, `status`.
- `../terraform/stacks/ota-updates/` — the Cloudflare resources. Run it with
  `hatchkit infra plan ota-updates`, then `hatchkit infra apply ota-updates`.
- `make check` — syntax check plus the offline tests (`node --test`; no network, no credentials).

## What a device gets

The plugin POSTs to `/updates` on every launch and return to the foreground. The body carries
`app_id`, `platform`, `version_build` (native version, `CFBundleShortVersionString` /
`versionName`), `version_code` (build number), `version_name` (current bundle, `builtin` for the
store bundle), `defaultChannel` (from `capacitor.config`) and `key_id` (first 20 characters of the
app's public key).

The Worker answers with a bundle only when all of these hold:

1. `app_id` is in `APPS` and the channel is in `CHANNELS` (`production`, `beta`). A request
   without `defaultChannel` counts as `production`.
2. A pointer exists for that app, channel and `version_build`: the bundle was built for this
   native version line. A device on any other line gets "no update".
3. `version_code` is at least the pointer's `min_version_code`, when one is set. Use it when two
   store builds share a marketing version but not the same native code.
4. `key_id` matches the key the bundle was encrypted with. A device that would fail to decrypt
   the bundle is never offered it.
5. `version_name` differs from the pointer's version.

A bundle reply is `{ version, url, checksum, session_key }`. For a delta bundle it is
`{ version, url, session_key, manifest: [{ file_name, file_hash, download_url }] }` (see
[Delta bundles](#delta-bundles)). The plugin reads `session_key`, not `sessionKey`. A no-update reply is
`{ error: "no_new_version_available", message, kind: "up_to_date" }`; the plugin installs nothing
from any reply that has `error` or `kind`. Unknown apps and channels get `kind: "blocked"`. The
Worker never answers 429, the one status that makes the plugin back off.

`url` points at `/dl/<key>?exp=…&sig=…`: an HMAC-signed link, valid for `DOWNLOAD_TTL_SECONDS`
(30 minutes), that streams the object from R2 (with `Range` support). Nothing in the bucket is
public.

`POST /stats` is accepted and logged (Workers Logs), not stored. `/channel_self` refuses every
change: the channel is fixed by the build.

Workers Logs keep only the Worker's own lines: app, platform, channel and versions. Invocation
logs are off, because they would store each device's IP address, user agent and IP-derived
location. The apps' privacy pages and store privacy labels rely on that, so keep them off.
Workers Logs delete entries after 3 days on Workers Free and 7 days on Workers Paid.

## Pointers and rollback

```
apps/<app>/bundles/<version>.zip           encrypted bundle (immutable)
apps/<app>/bundles/<version>.json          its checksum, session key, key id, native line, size
apps/<app>/bundles/<version>.manifest.json        a delta bundle's file list (immutable)
apps/<app>/bundles/<version>.manifest-reply.json  the same list as devices get it, with placeholders
apps/<app>/files/<sha256>                  one encrypted file of a delta bundle, named by the
                                           SHA-256 of its bytes; shared by every version (immutable)
apps/<app>/channels/<channel>/<native>.json   the pointer for one native line
```

A version is either a zip or a delta bundle, never both. `promote`, `rollback` and `status` work
the same for both kinds.

A pointer names one bundle version and keeps the last 20 earlier ones in `history`. Each
Cloudflare location caches a pointer, or its absence, for `POINTER_CACHE_SECONDS` (60 s), so an
update check costs no R2 read while the cache is warm. A promote or rollback reaches every
location within that time.

- `promote` points a line at an uploaded version. The line comes from the bundle's metadata.
- `rollback` without `--to` moves the pointer to the previous version and drops the current one
  from history, so a second rollback goes one step further back.
- `rollback --to <version>` picks a version from the same line; `--to builtin` sends devices back
  to the bundle in their store build.

Devices running a bad bundle switch on their next check, after the cache time. A bundle that never
calls `notifyAppReady()` is rolled back on the device by the plugin itself.

## Publishing

App CI runs `publish.mjs` from the app repository root (the Capgo CLI reads `capacitor.config` and
`package.json` there):

```sh
OTA_PUBLISH_TOKEN=… OTA_SIGNING_KEY="$(cat key.pem)" \
node publish.mjs publish --app com.ricoslabs.raptorrunner --channel beta \
  --native 1.1.3 --version 1.1.3-ota.42 --dist dist --expect-public-key ota/public-key.pub
```

1. `npx @capgo/cli@8.87.2 bundle zip` (telemetry off). It fails when the build never calls
   `notifyAppReady()`; `--allow-missing-notify-app-ready` exists only for the rollback test.
2. `bundle encrypt` with the private key (encryption v2). The key is written to a 0600 temp file
   for the CLI and removed before the script exits; it is never an argument.
3. `PUT /admin/apps/<app>/bundles/<version>` with the encrypted zip. R2 checks its SHA-256. A
   version is uploaded once; a new build needs a new version.
4. `POST …/channels/<channel>/promote`. Skip with `--no-promote` and promote later.

`--expect-public-key` stops the run when the signing key does not match the public key in the app.
Without it, the Worker still refuses to offer the bundle to devices with another key.

Other commands, same environment:

```sh
node publish.mjs status   --app <id> --channel beta [--native 1.1.3]
node publish.mjs promote  --app <id> --channel production --version 1.1.3-ota.42
node publish.mjs rollback --app <id> --channel production --native 1.1.3 [--to 1.1.3-ota.40|builtin]
```

Each app has its own publish token (Terraform output `publish_tokens`, stored as
`OTA_PUBLISH_TOKEN` in that app's GitHub environment). A token can only write its own app's
bundles and pointers.

## Delta bundles

A full zip makes every device download the whole web build for every update, and the upload must
stay below 100 MB. A delta (manifest) bundle sends each file on its own: a device downloads only
the files that its store build and earlier updates do not already hold, and CI uploads only the
files R2 does not hold yet. Use it for large builds (Mesozoic Protocol) or to cut download size.

```sh
OTA_PUBLISH_TOKEN=… OTA_SIGNING_KEY="$(cat key.pem)" \
node publish.mjs publish --delta --app com.ricoslabs.mesozoicprotocol --channel beta \
  --native 1.0.0 --version 1.0.0-ota.7 --dist dist --expect-public-key ota/public-key.pub
```

Same flags as a zip publish. The JSON result adds `files` (in the manifest), `uploaded` (files
that were new to R2) and `uploaded_bytes`. What it does, in the same format as
`@capgo/cli bundle upload --delta` (CLI 8.87.2):

1. Lists the files under `--dist`. It leaves out `.DS_Store`, `.git`, `.gitignore`,
   `node_modules` and empty files (iOS refuses a file that decrypts to nothing). It stops when
   there is no `index.html`, when no `.js` file calls `notifyAppReady()`, when a file already ends
   in `.br`, or when the app's `@capgo/capacitor-updater` is older than 7.30.
2. Compresses each file of 8 KB or more with brotli when that saves bytes, and names it `<file>.br`
   (images, audio, video, fonts and archives are sent as they are). The plugin unpacks it to
   `<file>`.
3. Encrypts each file with AES-128-CBC and the session key, and encrypts the file's SHA-256 with
   the private key (hex, the "V3" checksum format). The session key is derived from the private
   key, so an unchanged file encrypts to the same bytes every time.
4. `POST /admin/apps/<app>/files/missing` (40 hashes per call) asks which files R2 lacks, then
   `PUT /admin/apps/<app>/files/<sha256>` uploads only those. R2 checks each SHA-256. It asks
   again afterwards and stops if a file is still missing: the Worker checks only `index.html`,
   because one R2 call per file does not fit Workers Free.
5. `PUT /admin/apps/<app>/bundles/<version>/manifest` stores the manifest, then `promote` moves
   the pointer as for a zip.

No Capgo CLI runs in this mode, so nothing is sent to Capgo, and the private key stays in the
publishing process.

On the device (`CapgoUpdater.downloadManifest`, plugin 8.53), for every manifest entry: the plugin
decrypts `file_hash` with the public key; copies the file from the store build's `public/` folder
when its SHA-256 matches; else copies it from its download cache (files it fetched for earlier
updates); else downloads `download_url`, decrypts it with `session_key`, unpacks `.br` and checks
the SHA-256. The plugin still requires a valid `url` in the reply, and never downloads it when a
manifest is present; the Worker points it at the manifest. A reply never carries an empty manifest:
the plugin would install an empty bundle.

The Worker keeps each manifest reply as text with placeholders and fills in one signed query for
all files of the app: building it per request from JSON costs more than Workers Free's 10 ms CPU
for a manifest of a thousand files. A files link opens any file of that app's file store until it
expires, nothing else.

## App configuration

```ts
CapacitorUpdater: {
  autoUpdate: true,                 // download in the background, apply on next launch/resume
  updateUrl: "https://ota.ricoslabs.com/updates",
  statsUrl: "https://ota.ricoslabs.com/stats",
  channelUrl: "https://ota.ricoslabs.com/channel_self",
  defaultChannel: "beta",           // production for store builds
  allowSetDefaultChannel: false,
  publicKey: "-----BEGIN RSA PUBLIC KEY-----…",
}
```

Create one key pair per app with `npx @capgo/cli key create` (RSA 2048, PKCS#1). Commit the public
half as `ota/public-key.pub`, not `.pem`: the machine-wide gitignore drops `*.pem`, so a `.pem`
file is silently left out of the commit. The private key goes into a GitHub
environment with a required reviewer and into a password manager as the backup; never into a
repository. Losing it means the next live update needs a store build with a new public key.

## Security model

- Bundles are encrypted and signed per app (encryption v2). The Worker, R2 or a stolen publish
  token cannot make a device run code: without the private key the device rejects the bundle.
- What a stolen publish token or Cloudflare access can do: withhold updates, or point a line at
  an older bundle that was signed for it. Keep the tokens in the app's release environment.
- Delta bundles: all versions of an app share one session key, and the signed hash covers a
  file's content, not its name. So the same attacker could also put together a manifest from
  files of different signed versions. Every file must still be one the private key signed. The
  session key never gave secrecy from anyone holding the app: the public key in the app opens it.
- The URL signing key and the publish tokens are generated by Terraform. They sit in the
  Worker's secret bindings and in the local, gitignored Terraform state of the hatchkit checkout.
- Desktop and Mac App Store builds never include the plugin.

## Limits

- Workers Free: 100,000 requests a day per account. Past that, update checks fail and apps keep
  their current bundle.
- Request bodies are capped at 100 MB on Free, so a full-zip upload must stay below that. Larger
  apps (Mesozoic Protocol) publish with `--delta`, where the cap applies to each file.
- Workers Free allows 10 ms of CPU per request. A delta reply costs a string replacement over its
  manifest, not a JSON parse. A manifest holds at most 10,000 files (Capgo's limit).
