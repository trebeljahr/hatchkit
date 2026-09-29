/**
 * Tests for the per-project rotation additions in `cli/src/secrets/`:
 *
 *   1. key history: a committed `.env.keys` holding the CURRENT key
 *      refuses (even with --keys-rotated); a dry run reports it instead.
 *   2. key history: a committed key that was since rotated passes; an
 *      undecidable history refuses unless --keys-rotated.
 *   2b. key history edge cases: nested key path, empty key file, lost
 *      blob, unreadable history, no repo; no key material in a report.
 *   3. r2 + local-secrets happy path against HTTP mocks: same-scope
 *      mint, ListObjectsV2 with the NEW pair, old token deleted after
 *      verify, manifest tokenId moved, local secrets replaced, side
 *      effects reported, no value in the JSON audit.
 *   4. r2 verify failure: old token NOT deleted, rollback kept.
 *   5. r2 dry run: plan + side effects, no Cloudflare call.
 *   6. r2 is not detected for an `aws` project's AKIA key.
 *   7. push updates only keys a target already holds: Coolify bulk
 *      PATCH carries only existing keys; `gh secret set` gets the value
 *      on stdin, never in argv.
 *   8. a project holding SES/ListMonk copies lists them as shared
 *      credentials for `--global`.
 *
 * No real provider is contacted: Cloudflare and Coolify go through a
 * `fetch` override, S3 through a local HTTP server, `gh` through a fake
 * binary on PATH. Keychain writes go to a per-pid throwaway service.
 *
 * Run: pnpm test:secrets-rotate-providers
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HATCHKIT_KEYTAR_SERVICE = `hatchkit-test-secrets-providers-${process.pid}`;
process.env.HATCHKIT_CONF_DIR = mkdtempSync(join(tmpdir(), "secrets-providers-conf-"));

const { runSecretsRotate } = await import("./src/secrets/orchestrator.js");
const { loadRollback } = await import("./src/secrets/rollback-store.js");
const { inspectEnvKeysHistory } = await import("./src/secrets/key-history.js");
const { __setR2VerifyTimingForTesting } = await import("./src/secrets/adapters/r2.js");
const { pushToCoolify, pushToGithub } = await import("./src/secrets/push.js");
const { writeManifest, readManifest, MANIFEST_VERSION } = await import(
  "./src/scaffold/manifest.js"
);
const { writeProdEnv } = await import("./src/provision/write-env.js");
const { loadProjectEnv } = await import("./src/assets/env.js");
const { getStore } = await import("./src/config.js");
const { clearAllSecrets, setSecret, SECRET_KEYS } = await import("./src/utils/secrets.js");

__setR2VerifyTimingForTesting({ attempts: 2, delayMs: 10 });

const results: Record<string, boolean> = {};
function report(label: string, checks: [string, boolean][]): boolean {
  console.log(`\n── ${label} ─────────────────────────────`);
  let ok = true;
  for (const [n, c] of checks) {
    console.log(`  ${c ? "✓" : "✗"} ${n}`);
    if (!c) ok = false;
  }
  return ok;
}

const ACCT = "0123456789abcdef0123456789abcdef";
const OLD_ID = "a".repeat(32);
const NEW_ID = "b".repeat(32);
const NEW_TOKEN_VALUE = "new-token-value-never-printed";
const NEW_SECRET = createHash("sha256").update(NEW_TOKEN_VALUE).digest("hex");

function makeProject(
  name: string,
  env: Record<string, string>,
  extra: Record<string, unknown> = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), `secrets-prov-${name}-`));
  writeManifest(dir, {
    version: MANIFEST_VERSION,
    cliVersion: "0.0.0-test",
    scaffoldedAt: new Date().toISOString(),
    name,
    domain: `${name}.example.com`,
    features: [],
    mlServices: [],
    s3Provider: "existing",
    deployTarget: "existing",
    deploymentMode: "coolify",
    ports: { server: 3001, client: 3000 },
    ...extra,
  } as Parameters<typeof writeManifest>[1]);
  if (Object.keys(env).length > 0) {
    writeProdEnv(
      join(dir, ".env.production"),
      Object.entries(env).map(([key, value]) => ({ key, value })),
    );
  }
  return dir;
}

function prod(dir: string): Record<string, string> {
  return loadProjectEnv({ projectDir: dir, mode: "prod" });
}

function git(dir: string, cmd: string): void {
  execSync(`git ${cmd}`, { cwd: dir, stdio: "ignore" });
}

function gitInit(dir: string): void {
  git(dir, "init --quiet");
  git(dir, "config user.email t@t.t");
  git(dir, "config user.name test");
  git(dir, "config commit.gpgsign false");
  // Ignore the machine's global excludes file (it may list .env.keys).
  git(dir, "config core.excludesFile /dev/null");
}

async function captureStdout<T>(fn: () => Promise<T>): Promise<{ out: string; value: T }> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    chunks.push(String(chunk));
    return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  try {
    const value = await fn();
    return { out: chunks.join(""), value };
  } finally {
    process.stdout.write = original;
  }
}

// ---------------------------------------------------------------------------
// Fetch mock: Cloudflare + Coolify
// ---------------------------------------------------------------------------

interface FetchCall {
  method: string;
  url: string;
  body?: unknown;
}
const calls: FetchCall[] = [];
const realFetch = globalThis.fetch;
let cfTokenPolicyReadable = true;
let coolifyEnvKeys: string[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? "GET").toUpperCase();
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  if (url.startsWith("https://api.cloudflare.com/client/v4")) {
    calls.push({ method, url, body });
    const path = url.slice("https://api.cloudflare.com/client/v4".length);
    const ok = (result: unknown) => json({ success: true, errors: [], messages: [], result });
    if (method === "GET" && path.startsWith(`/accounts/${ACCT}/tokens/permission_groups`)) {
      return ok([
        { id: "grp-read", name: "Workers R2 Storage Bucket Item Read" },
        { id: "grp-write", name: "Workers R2 Storage Bucket Item Write" },
      ]);
    }
    if (method === "GET" && path === `/accounts/${ACCT}/tokens/${OLD_ID}`) {
      if (!cfTokenPolicyReadable) {
        return json({ success: false, errors: [{ code: 9109, message: "no" }] }, 403);
      }
      return ok({
        id: OLD_ID,
        status: "active",
        name: "hatchkit-r2proj",
        policies: [
          {
            effect: "allow",
            permission_groups: [
              { id: "grp-read", name: "Workers R2 Storage Bucket Item Read" },
              { id: "grp-write", name: "Workers R2 Storage Bucket Item Write" },
            ],
            resources: { [`com.cloudflare.edge.r2.bucket.${ACCT}_default_r2proj-assets`]: "*" },
          },
        ],
      });
    }
    if (method === "POST" && path === `/accounts/${ACCT}/tokens`) {
      return ok({ id: NEW_ID, value: NEW_TOKEN_VALUE });
    }
    if (method === "DELETE" && path.startsWith(`/accounts/${ACCT}/tokens/`)) {
      return ok({ id: path.split("/").pop() });
    }
    return json({ success: false, errors: [{ code: 404, message: `unmocked ${path}` }] }, 404);
  }
  if (url.startsWith("https://coolify.test/api/v1")) {
    calls.push({ method, url, body });
    const path = url.slice("https://coolify.test/api/v1".length);
    if (method === "GET" && path === "/applications")
      return json([{ uuid: "app-1", name: "pushproj" }]);
    if (method === "GET" && path === "/applications/app-1/envs") {
      return json(
        coolifyEnvKeys.map((key) => ({ key, value: "live-value-never-read", is_preview: false })),
      );
    }
    if (method === "PATCH" && path === "/applications/app-1/envs/bulk") return json({ ok: true });
    return json({ message: "not found" }, 404);
  }
  return realFetch(input as Request, init);
}) as typeof fetch;

// ---------------------------------------------------------------------------
// S3 mock: ListObjectsV2 answers 200 only for the NEW access key.
// ---------------------------------------------------------------------------

const s3Seen: string[] = [];
let s3AcceptNew = true;
const s3 = createServer((req: IncomingMessage, res: ServerResponse) => {
  const auth = String(req.headers.authorization ?? "");
  const keyId = /Credential=([^/]+)\//.exec(auth)?.[1] ?? "";
  s3Seen.push(`${req.method} ${req.url} ${keyId}`);
  if (keyId === NEW_ID && s3AcceptNew) {
    res.writeHead(200, { "content-type": "application/xml" });
    res.end(
      `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>r2proj-assets</Name><KeyCount>0</KeyCount><MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>`,
    );
    return;
  }
  res.writeHead(403, { "content-type": "application/xml" });
  res.end(
    `<?xml version="1.0" encoding="UTF-8"?><Error><Code>InvalidAccessKeyId</Code><Message>no</Message></Error>`,
  );
});
await new Promise<void>((resolve) => s3.listen(0, "127.0.0.1", resolve));
const S3_ENDPOINT = `http://127.0.0.1:${(s3.address() as AddressInfo).port}`;

getStore().set("providers.s3.r2", {
  status: "configured",
  endpoint: `https://${ACCT}.r2.cloudflarestorage.com`,
  region: "auto",
});
await setSecret(SECRET_KEYS.r2AdminToken, "cf-admin-token-test");

function r2Project(name: string): string {
  return makeProject(
    name,
    {
      R2_ENDPOINT: S3_ENDPOINT,
      R2_ACCESS_KEY_ID: OLD_ID,
      R2_SECRET_ACCESS_KEY: "c".repeat(64),
      R2_REGION: "auto",
      CRON_SECRET: "old-cron-secret-value",
      NEWSLETTER_TOKEN_SECRET: "old-newsletter-secret",
    },
    {
      s3Buckets: {
        assets: { name: "r2proj-assets", publicUrl: "https://assets.r2proj.example.com" },
        tokenId: OLD_ID,
        accountId: ACCT,
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Test 1 — the current key is in git history → REFUSE, dry run reports it.
// ---------------------------------------------------------------------------
{
  const dir = makeProject("leaky", { CRON_SECRET: "old" });
  gitInit(dir);
  git(dir, "add -f .env.keys .env.production .hatchkit.json");
  git(dir, "commit -q -m leak");
  git(dir, "rm -q --cached .env.keys");
  git(dir, "commit -q -m unleak");

  const history = await inspectEnvKeysHistory(dir);
  let refused: Error | undefined;
  try {
    await runSecretsRotate({ projectName: "leaky", projectDir: dir, noPush: true, json: true });
  } catch (err) {
    refused = err as Error;
  }
  let refusedWithFlag: Error | undefined;
  try {
    await runSecretsRotate({
      projectName: "leaky",
      projectDir: dir,
      noPush: true,
      json: true,
      keysRotated: true,
    });
  } catch (err) {
    refusedWithFlag = err as Error;
  }
  const { value: plan } = await captureStdout(() =>
    runSecretsRotate({
      projectName: "leaky",
      projectDir: dir,
      noPush: true,
      json: true,
      dryRun: true,
    }),
  );

  results.keyHistoryLeaked = report("Test 1: current key in git history refuses", [
    ["history status is 'leaked'", history.status === "leaked"],
    [
      "history names the commit and path",
      history.commits.length === 1 && history.paths[0] === ".env.keys",
    ],
    ["live run throws REFUSE", !!refused && /REFUSE/.test(refused.message)],
    [
      "refusal tells the user to run keys rotate",
      !!refused && /hatchkit keys rotate leaky/.test(refused.message),
    ],
    [
      "--keys-rotated does not override a proven leak",
      !!refusedWithFlag && /has not been rotated/.test(refusedWithFlag.message),
    ],
    [
      "dry run does not throw and reports blockedBy",
      typeof plan.blockedBy === "string" && /REFUSE/.test(plan.blockedBy),
    ],
    ["CRON_SECRET untouched", prod(dir).CRON_SECRET === "old"],
  ]);
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Test 2 — rotated since (superseded) passes; undecidable needs the flag.
// ---------------------------------------------------------------------------
{
  const dir = makeProject("rotated", { CRON_SECRET: "old" });
  gitInit(dir);
  git(dir, "add -f .env.keys");
  git(dir, "commit -q -m leak");
  git(dir, "rm -q --cached .env.keys");
  git(dir, "commit -q -m unleak");
  // New keypair: fresh .env.production + .env.keys.
  rmSync(join(dir, ".env.keys"));
  rmSync(join(dir, ".env.production"));
  writeProdEnv(join(dir, ".env.production"), [{ key: "CRON_SECRET", value: "old" }]);
  const superseded = await inspectEnvKeysHistory(dir);
  const audit = await runSecretsRotate({
    projectName: "rotated",
    projectDir: dir,
    only: ["local-secrets"],
    noPush: true,
    json: true,
  });

  // Undecidable: plaintext .env.production has no public key.
  const dir2 = mkdtempSync(join(tmpdir(), "secrets-prov-unknown-"));
  writeManifest(dir2, {
    version: MANIFEST_VERSION,
    cliVersion: "0.0.0-test",
    scaffoldedAt: new Date().toISOString(),
    name: "unknown",
    domain: "unknown.example.com",
    features: [],
    mlServices: [],
    s3Provider: "none",
    deployTarget: "existing",
    deploymentMode: "coolify",
    ports: { server: 3001, client: 3000 },
  });
  gitInit(dir2);
  writeFileSync(join(dir2, ".env.keys"), `DOTENV_PRIVATE_KEY_PRODUCTION="${"1".repeat(64)}"\n`);
  git(dir2, "add -f .env.keys");
  git(dir2, "commit -q -m leak");
  git(dir2, "rm -q --cached .env.keys");
  git(dir2, "commit -q -m unleak");
  rmSync(join(dir2, ".env.keys"));
  writeFileSync(join(dir2, ".env.production"), "CRON_SECRET=plain\n");
  const unknown = await inspectEnvKeysHistory(dir2);
  let refused = false;
  try {
    await runSecretsRotate({
      projectName: "unknown",
      projectDir: dir2,
      only: ["local-secrets"],
      noPush: true,
      json: true,
    });
  } catch (err) {
    refused =
      /REFUSE/.test((err as Error).message) && /--keys-rotated/.test((err as Error).message);
  }
  let passedWithFlag = true;
  try {
    await runSecretsRotate({
      projectName: "unknown",
      projectDir: dir2,
      only: ["local-secrets"],
      noPush: true,
      json: true,
      keysRotated: true,
      dryRun: true,
    });
  } catch {
    passedWithFlag = false;
  }

  results.keyHistoryRotated = report(
    "Test 2: rotated history passes, undecidable needs --keys-rotated",
    [
      ["history status is 'superseded'", superseded.status === "superseded"],
      ["rotation ran", audit.adapters[0]?.envKeysChanged.includes("CRON_SECRET") === true],
      [
        "CRON_SECRET replaced with 64 hex chars",
        /^[0-9a-f]{64}$/.test(prod(dir).CRON_SECRET ?? ""),
      ],
      ["undecidable history status is 'unknown'", unknown.status === "unknown"],
      ["undecidable refuses and names --keys-rotated", refused],
      ["--keys-rotated lets the undecidable case through", passedWithFlag],
    ],
  );
  rmSync(dir, { recursive: true, force: true });
  rmSync(dir2, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Test 2b — history edge cases: a nested key path, an empty committed key
// file, a blob git lost, a history git cannot read, no repo at all.
// ---------------------------------------------------------------------------
{
  const gitOut = (dir: string, cmd: string): string =>
    execSync(`git ${cmd}`, { cwd: dir, encoding: "utf-8" }).trim();
  // A partial clone or a broken repo lacks the object.
  const dropObject = (dir: string, oid: string): void =>
    rmSync(join(dir, ".git", "objects", oid.slice(0, 2), oid.slice(2)));

  const nested = makeProject("nested", { CRON_SECRET: "old" });
  gitInit(nested);
  mkdirSync(join(nested, "packages", "server"), { recursive: true });
  writeFileSync(
    join(nested, "packages", "server", ".env.keys"),
    readFileSync(join(nested, ".env.keys")),
  );
  git(nested, "add -f packages/server/.env.keys");
  git(nested, "commit -q -m nested");
  const nestedReport = await inspectEnvKeysHistory(nested);

  // An empty blob reads as "", which must not count as unreadable.
  const empty = makeProject("emptykeys", { CRON_SECRET: "old" });
  gitInit(empty);
  const emptyKeys = readFileSync(join(empty, ".env.keys"), "utf-8");
  writeFileSync(join(empty, ".env.keys"), "");
  git(empty, "add -f .env.keys");
  git(empty, "commit -q -m empty");
  writeFileSync(join(empty, ".env.keys"), emptyKeys);
  const emptyReport = await inspectEnvKeysHistory(empty);

  const lost = makeProject("lostblob", { CRON_SECRET: "old" });
  gitInit(lost);
  git(lost, "add -f .env.keys");
  git(lost, "commit -q -m leak");
  dropObject(lost, gitOut(lost, "rev-parse HEAD:.env.keys"));
  const lostReport = await inspectEnvKeysHistory(lost);

  const broken = makeProject("brokenlog", { CRON_SECRET: "old" });
  gitInit(broken);
  git(broken, "add -f .hatchkit.json");
  git(broken, "commit -q -m init");
  dropObject(broken, gitOut(broken, "rev-parse HEAD"));
  let brokenErr: Error | undefined;
  try {
    await inspectEnvKeysHistory(broken);
  } catch (err) {
    brokenErr = err as Error;
  }

  const plain = makeProject("plain", { CRON_SECRET: "old" });
  const plainReport = await inspectEnvKeysHistory(plain);

  const reports = JSON.stringify([nestedReport, emptyReport, lostReport, plainReport]);
  const keyMaterial = [nested, empty, lost, plain].flatMap((d) => [
    ...(readFileSync(join(d, ".env.keys"), "utf-8").match(/[0-9a-f]{64}/g) ?? []),
    ...(readFileSync(join(d, ".env.production"), "utf-8").match(/[0-9a-f]{66}/g) ?? []),
  ]);

  results.keyHistoryEdges = report("Test 2b: key history edge cases", [
    ["nested current key is 'leaked'", nestedReport.status === "leaked"],
    [
      "nested path is repo-relative",
      nestedReport.paths.join(",") === "packages/server/.env.keys",
    ],
    ["commit ids are 8 hex digits", /^[0-9a-f]{8}$/.test(nestedReport.commits[0] ?? "")],
    ["empty committed .env.keys is 'superseded'", emptyReport.status === "superseded"],
    ["lost blob is 'unknown'", lostReport.status === "unknown"],
    ["lost blob still names its commit", lostReport.commits.length === 1],
    [
      "unreadable history throws REFUSE, not 'clean'",
      !!brokenErr && /^REFUSE: git could not read/.test(brokenErr.message),
    ],
    ["no repo is 'not-a-repo'", plainReport.status === "not-a-repo"],
    ["fixtures hold key material to look for", keyMaterial.length >= 8],
    ["no report carries a private or public key", keyMaterial.every((k) => !reports.includes(k))],
  ]);
  for (const d of [nested, empty, lost, broken, plain]) rmSync(d, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Test 3 — r2 + local-secrets happy path.
// ---------------------------------------------------------------------------
{
  calls.length = 0;
  s3Seen.length = 0;
  const dir = r2Project("r2proj");
  const { out, value: audit } = await captureStdout(() =>
    runSecretsRotate({
      projectName: "r2proj",
      projectDir: dir,
      only: ["r2", "local-secrets"],
      noPush: true,
      json: true,
    }),
  );
  const env = prod(dir);
  const r2 = audit.adapters.find((a) => a.provider === "r2");
  const local = audit.adapters.find((a) => a.provider === "local-secrets");
  const post = calls.find((c) => c.method === "POST" && c.url.endsWith(`/accounts/${ACCT}/tokens`));
  const postBody = post?.body as
    | {
        name: string;
        policies: Array<{
          permission_groups: Array<{ id: string }>;
          resources: Record<string, string>;
        }>;
      }
    | undefined;
  const deleteIdx = calls.findIndex(
    (c) => c.method === "DELETE" && c.url.endsWith(`/tokens/${OLD_ID}`),
  );
  const manifest = readManifest(dir);

  results.r2Happy = report("Test 3: r2 + local-secrets rotation", [
    ["new token keeps the old name", postBody?.name === "hatchkit-r2proj"],
    [
      "new token scoped to the same bucket",
      JSON.stringify(Object.keys(postBody?.policies[0]?.resources ?? {})) ===
        JSON.stringify([`com.cloudflare.edge.r2.bucket.${ACCT}_default_r2proj-assets`]),
    ],
    [
      "new token keeps read + write",
      (postBody?.policies[0]?.permission_groups ?? [])
        .map((g) => g.id)
        .sort()
        .join(",") === "grp-read,grp-write",
    ],
    [
      "verify listed the bucket with the NEW key",
      s3Seen.some((l) => l.includes("/r2proj-assets") && l.endsWith(NEW_ID)),
    ],
    ["old token deleted", deleteIdx >= 0],
    ["R2_ACCESS_KEY_ID is the new token id", env.R2_ACCESS_KEY_ID === NEW_ID],
    ["R2_SECRET_ACCESS_KEY is sha256(new token value)", env.R2_SECRET_ACCESS_KEY === NEW_SECRET],
    ["manifest tokenId moved to the new token", manifest?.s3Buckets?.tokenId === NEW_ID],
    ["r2 verify ok + revoked", r2?.verificationResult === "ok" && r2?.oldRevoked === true],
    [
      "CRON_SECRET replaced",
      /^[0-9a-f]{64}$/.test(env.CRON_SECRET ?? "") && env.CRON_SECRET !== "old-cron-secret-value",
    ],
    ["NEWSLETTER_TOKEN_SECRET replaced", /^[0-9a-f]{64}$/.test(env.NEWSLETTER_TOKEN_SECRET ?? "")],
    ["local-secrets revoke is not-applicable", local?.oldRevoked === "not-applicable"],
    ["local-secrets verify skipped", local?.verificationResult === "skipped"],
    [
      "side effect names the newsletter links",
      (local?.sideEffects ?? []).some((e) => /NEWSLETTER_TOKEN_SECRET: .*unsubscribe/.test(e)),
    ],
    [
      "rollback blobs cleared",
      (await loadRollback("r2proj", "r2")) === null &&
        (await loadRollback("r2proj", "local-secrets")) === null,
    ],
    ["JSON audit holds no new secret", !out.includes(NEW_SECRET) && !out.includes(NEW_TOKEN_VALUE)],
    [
      "JSON audit holds no new local secret",
      !out.includes(env.CRON_SECRET) && !out.includes(env.NEWSLETTER_TOKEN_SECRET),
    ],
    [
      "next steps name the env file to commit",
      (audit.nextSteps ?? []).some((s) => s.includes(".env.production")),
    ],
  ]);
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Test 4 — r2 verify failure holds the old token.
// ---------------------------------------------------------------------------
{
  calls.length = 0;
  s3AcceptNew = false;
  cfTokenPolicyReadable = false; // exercises the manifest-scope fallback
  const dir = r2Project("r2fail");
  const audit = await runSecretsRotate({
    projectName: "r2fail",
    projectDir: dir,
    only: ["r2"],
    noPush: true,
    json: true,
  });
  s3AcceptNew = true;
  cfTokenPolicyReadable = true;
  const r2 = audit.adapters[0];
  const post = calls.find((c) => c.method === "POST");
  const rollback = await loadRollback("r2fail", "r2");
  results.r2VerifyFail = report("Test 4: r2 verify failure", [
    [
      "unreadable policy falls back to the manifest bucket",
      JSON.stringify(post?.body ?? "").includes(`${ACCT}_default_r2proj-assets`),
    ],
    [
      "fallback name is hatchkit-<project>",
      (post?.body as { name?: string })?.name === "hatchkit-r2fail",
    ],
    ["verify failed", r2?.verificationResult === "failed"],
    ["old token NOT deleted", !calls.some((c) => c.method === "DELETE")],
    ["rollback blob kept with the old id", rollback?.handle["tokenId:0"] === OLD_ID],
  ]);
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Test 5 — dry run: plan + side effects, no Cloudflare call.
// ---------------------------------------------------------------------------
{
  calls.length = 0;
  const dir = r2Project("r2dry");
  const audit = await runSecretsRotate({
    projectName: "r2dry",
    projectDir: dir,
    noPush: true,
    json: true,
    dryRun: true,
  });
  const r2 = audit.adapters.find((a) => a.provider === "r2");
  const local = audit.adapters.find((a) => a.provider === "local-secrets");
  results.r2DryRun = report("Test 5: dry run", [
    [
      "r2 plans both key names",
      r2?.envKeysChanged.join(",") === "R2_ACCESS_KEY_ID,R2_SECRET_ACCESS_KEY",
    ],
    [
      "local-secrets plans CRON + NEWSLETTER",
      local?.envKeysChanged.join(",") === "CRON_SECRET,NEWSLETTER_TOKEN_SECRET",
    ],
    ["side effects in the plan", (local?.sideEffects ?? []).length === 2],
    ["no Cloudflare call", calls.length === 0],
    ["env untouched", prod(dir).R2_ACCESS_KEY_ID === OLD_ID],
  ]);
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Test 6 — an AWS project's AKIA key is not an R2 token.
// ---------------------------------------------------------------------------
{
  const dir = makeProject(
    "awsproj",
    { AWS_ACCESS_KEY_ID: "AKIAEXAMPLEEXAMPLE12", AWS_SECRET_ACCESS_KEY: "x".repeat(40) },
    { s3Provider: "aws" },
  );
  const audit = await runSecretsRotate({
    projectName: "awsproj",
    projectDir: dir,
    noPush: true,
    json: true,
    dryRun: true,
  });
  results.r2NotAws = report("Test 6: r2 skips aws projects", [
    [
      "r2 not detected",
      audit.adapters.find((a) => a.provider === "r2")?.skipReason === "adapter-not-detected",
    ],
  ]);
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Test 7 — push touches only keys the target already holds.
// ---------------------------------------------------------------------------
{
  getStore().set("providers.coolify", { status: "configured", url: "https://coolify.test" });
  await setSecret(SECRET_KEYS.coolifyToken, "coolify-token-test");
  calls.length = 0;
  coolifyEnvKeys = ["KEEP_A", "OTHER"];
  const coolify = await pushToCoolify("pushproj", [
    { key: "KEEP_A", value: "new-a" },
    { key: "NEW_B", value: "new-b" },
  ]);
  const patch = calls.find((c) => c.method === "PATCH");
  const patchKeys = ((patch?.body as { data?: Array<{ key: string }> })?.data ?? []).map(
    (d) => d.key,
  );

  const binDir = mkdtempSync(join(tmpdir(), "fake-gh-"));
  const log = join(binDir, "log");
  writeFileSync(
    join(binDir, "gh"),
    `#!/bin/sh
if [ "$2" = "list" ]; then echo '[{"name":"KEEP_A"}]'; exit 0; fi
echo "ARGV $*" >> "${log}"
echo "STDIN $(cat)" >> "${log}"
exit 0
`,
  );
  chmodSync(join(binDir, "gh"), 0o755);
  const origPath = process.env.PATH;
  process.env.PATH = `${binDir}:${origPath ?? ""}`;
  let gh: Awaited<ReturnType<typeof pushToGithub>> | undefined;
  try {
    gh = await pushToGithub(
      [
        { key: "KEEP_A", value: "stdin-only-value" },
        { key: "NEW_B", value: "never-created" },
      ],
      { repoSlug: "owner/repo" },
    );
  } finally {
    process.env.PATH = origPath;
  }
  const ghLog = existsSync(log) ? readFileSync(log, "utf-8") : "";
  rmSync(binDir, { recursive: true, force: true });

  results.pushExistingOnly = report("Test 7: push updates only existing keys", [
    ["Coolify pushed only KEEP_A", coolify.pushed.join(",") === "KEEP_A"],
    ["Coolify PATCH body has only KEEP_A", patchKeys.join(",") === "KEEP_A"],
    ["gh pushed only KEEP_A", gh?.pushed.join(",") === "KEEP_A"],
    ["gh got the value on stdin", ghLog.includes("STDIN stdin-only-value")],
    [
      "gh argv never holds a value",
      !/ARGV .*stdin-only-value/.test(ghLog) && !ghLog.includes("never-created"),
    ],
  ]);
}

// ---------------------------------------------------------------------------
// Test 8 — shared credentials are listed, not rotated.
// ---------------------------------------------------------------------------
{
  const dir = makeProject("sharedproj", {
    SES_SMTP_USERNAME: "AKIAOLDOLDOLDOLDOLD1",
    SES_SMTP_PASSWORD: "old-password",
    LISTMONK_API_TOKEN: "old-token",
  });
  const audit = await runSecretsRotate({
    projectName: "sharedproj",
    projectDir: dir,
    noPush: true,
    json: true,
    dryRun: true,
  });
  results.sharedListed = report("Test 8: shared credentials listed for --global", [
    [
      "sharedCredentials = ses, listmonk",
      (audit.sharedCredentials ?? []).join(",") === "ses,listmonk",
    ],
  ]);
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
await clearAllSecrets();
globalThis.fetch = realFetch;
s3.close();
__setR2VerifyTimingForTesting(undefined);
if (existsSync(process.env.HATCHKIT_CONF_DIR!)) {
  rmSync(process.env.HATCHKIT_CONF_DIR!, { recursive: true, force: true });
}

console.log("\n=== SUMMARY ===");
let allOk = true;
for (const [name, ok] of Object.entries(results)) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) allOk = false;
}
console.log();
process.exit(allOk ? 0 : 1);
