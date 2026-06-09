/*
 * cli/src/features/signing/google.ts — Android upload keystore
 * generation + Play API sanity check.
 *
 * Per-project work Hatchkit can fully automate:
 *   · `keytool -genkey -v -keystore <slug>.keystore -alias upload
 *      -keyalg RSA -keysize 2048 -validity 10000`
 *   · base64-encode the keystore → push as ANDROID_KEYSTORE_BASE64.
 *
 * Hatchkit refuses to regenerate the keystore once it exists locally —
 * Google's upload key is per-app and per-developer-account; regenerating
 * locks the dev out of pushing future versions until they file a key
 * reset through Play Console (slow, support-mediated).
 *
 * Play API "ping" is opt-in. The brief flags it as optional —
 * Hatchkit just parses the service account JSON and confirms scopes;
 * Google's Edits endpoint blocks API uploads until the user manually
 * approves the first release in Play Console.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { exec } from "../../utils/exec.js";
import { resolveUserPath } from "./render.js";
import type { OrgGoogle } from "./types.js";

export interface KeystoreGenInput {
  /** Directory to write the keystore into (typically
   *  `<projectDir>/.hatchkit/signing/`). */
  outputDir: string;
  /** Filename stem — typically the project kebab. Hatchkit appends
   *  `.keystore`. */
  fileStem: string;
  /** Subject DN (CN/O/L/ST/C). Defaults derived from {@link appName}. */
  appName: string;
  /** Alias to embed in the keystore. Always "upload" in the workflow
   *  template, kept configurable for tests. */
  alias?: string;
  /** Storepass + keypass — generated and returned. Hatchkit pushes
   *  these as GitHub secrets and never persists them on disk. */
  storePassword: string;
  keyPassword: string;
  /** Validity days. 10000 ≈ 27 years — Play's recommendation. */
  validityDays?: number;
}

export interface KeystoreGenResult {
  /** Absolute path to the .keystore file. */
  keystorePath: string;
  alias: string;
  /** base64-encoded keystore contents — feed to
   *  ANDROID_KEYSTORE_BASE64. */
  base64: string;
  storePassword: string;
  keyPassword: string;
}

/** Generate a new upload keystore via `keytool`. Refuses to overwrite
 *  an existing file at the target path — callers must clear it
 *  intentionally. */
export async function generateAndroidKeystore(input: KeystoreGenInput): Promise<KeystoreGenResult> {
  const alias = input.alias ?? "upload";
  const validity = input.validityDays ?? 10000;
  const keystorePath = join(input.outputDir, `${input.fileStem}.keystore`);
  if (existsSync(keystorePath)) {
    throw new Error(
      `Refusing to overwrite existing keystore at ${keystorePath} — regenerating would brick Play uploads.`,
    );
  }
  mkdirSync(dirname(keystorePath), { recursive: true });

  // -dname keeps keytool from prompting; values match Play's "Upload key" pattern.
  const cn = sanitizeDn(input.appName) || "Upload Key";
  const dname = `CN=${cn}, OU=Upload, O=${cn}, L=Unknown, ST=Unknown, C=US`;

  const res = await exec(
    "keytool",
    [
      "-genkey",
      "-v",
      "-keystore",
      keystorePath,
      "-alias",
      alias,
      "-keyalg",
      "RSA",
      "-keysize",
      "2048",
      "-validity",
      String(validity),
      "-storepass",
      input.storePassword,
      "-keypass",
      input.keyPassword,
      "-dname",
      dname,
    ],
    { silent: true },
  );
  if (res.exitCode !== 0) {
    throw new Error(`keytool failed (${res.exitCode}): ${res.stderr.trim() || res.stdout.trim()}`);
  }

  const buf = readFileSync(keystorePath);
  return {
    keystorePath,
    alias,
    base64: buf.toString("base64"),
    storePassword: input.storePassword,
    keyPassword: input.keyPassword,
  };
}

/** Sanitize DN component characters that confuse `keytool -dname`. */
function sanitizeDn(input: string): string {
  return input
    .replace(/[",=+<>#;\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Read + parse the Play service account JSON. Throws when missing or
 *  malformed. */
export function readPlayServiceAccount(google: OrgGoogle): {
  raw: string;
  parsed: { client_email?: string; private_key?: string; project_id?: string };
} {
  const path = resolveUserPath(google.serviceAccountJsonPath);
  if (!existsSync(path)) {
    throw new Error(`Play service account JSON not readable at ${path}.`);
  }
  const raw = readFileSync(path, "utf-8");
  try {
    const parsed = JSON.parse(raw) as {
      client_email?: string;
      private_key?: string;
      project_id?: string;
    };
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error(
        `Service account JSON is missing client_email or private_key. Re-download from Google Cloud Console.`,
      );
    }
    return { raw, parsed };
  } catch (err) {
    throw new Error(`Service account JSON parse failed: ${(err as Error).message}`);
  }
}

/** Write a copy of the local keystore reference into the project's
 *  `.hatchkit/signing/` dir. The actual keystore file LIVES in this
 *  directory — this helper just ensures the parent dir exists and
 *  writes a sentinel marker so `hatchkit destroy` knows the dir is
 *  Hatchkit-owned. */
export function ensureLocalSigningDir(projectDir: string): string {
  const dir = join(projectDir, ".hatchkit", "signing");
  mkdirSync(dir, { recursive: true });
  const sentinel = join(dir, ".gitignore");
  if (!existsSync(sentinel)) {
    writeFileSync(
      sentinel,
      `# Generated by hatchkit signing. Do NOT commit keystore + passwords.\n*.keystore\n*.jks\nkeystore.properties\nkeystore.passwords\n`,
      "utf-8",
    );
  }
  return dir;
}

/** Generate a strong random password suitable for keystore / key
 *  storage. Caller is responsible for handing it off to the keychain
 *  or GitHub secrets and immediately forgetting it. */
export function generateKeystorePassword(): string {
  // 24-byte cryptographic random → 32 chars base64url. Plenty of entropy
  // (>= 192 bits) for an offline keystore; Play caps practical use.
  const buf = new Uint8Array(24);
  // dynamic import via globalThis so this works in both Node 22 and tests.
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c) {
    throw new Error("No global crypto — Node 19+ required.");
  }
  c.getRandomValues(buf);
  return Buffer.from(buf).toString("base64url");
}
