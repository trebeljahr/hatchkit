/**
 * Unit tests for `hatchkit secrets rotate` — the rotation orchestrator
 * in `cli/src/secrets/`.
 *
 * Coverage (12 tests):
 *   1. happy path: detect → envKeys → captureOld → createNew →
 *      env write (asserted via on-disk side effect) → verify → revoke,
 *      audit reports oldRevoked === true and verificationResult 'ok'.
 *   2. --revoke=never: revoke is NOT called; audit reports
 *      oldRevoked: 'held' + skipReason 'revoke-held'.
 *   3. --revoke=immediate: revoke called BEFORE verify.
 *   4. --dry-run: no mutation methods called (captureOld/createNew/
 *      verify/revoke); rollback-store untouched.
 *   5. .env.keys tracked by git: orchestrator throws (real git init in
 *      tmp dir + git add — no monkey-patch).
 *   6. plaintext .env.production: warnIfNotEncrypted logs a yellow
 *      warning to stderr but the rotation proceeds to verify+revoke.
 *   7. audit redaction: redactValues replaces credential-shaped
 *      strings, the JSON output never contains the actual new value.
 *   8. verify failure: revoke NOT called; rollback blob preserved in
 *      keychain; audit reports verificationResult 'failed' +
 *      oldRevoked 'held' + skipReason 'verify-failed'.
 *   9. multi-adapter partial failure: adapter A's verify ok → fully
 *      revoked + rollback cleared; adapter B's verify fails →
 *      rollback preserved + revoke not called.
 *  10. captureOld empty → auto-downgrade after-verify to never (no
 *      revoke on adapter); audit reports skipReason 'revoke-held'.
 *  11. pushToGithub: `gh secret set` non-zero exit redacts secret-shaped
 *      stderr before throwing (fake `gh` on PATH).
 *  12. push() throws → orchestrator catches, env stays written, revoke
 *      force-held, rollback preserved, audit reports skipReason
 *      'push-failed' with redacted `pushError`.
 *
 * Scoping: every test registers a fresh fake adapter (with a unique
 * name per test, since `registry.register()` throws on duplicates) and
 * passes `only: [adapter.name]` to `runSecretsRotate`, so concrete
 * adapters (openpanel/glitchtip) in the registry are filtered out.
 *
 * Push targets: most tests pass `noPush: true`, so Coolify + GitHub
 * are never touched. The happy-path test uses `noPush: true` too —
 * exercising real Coolify/GH push is out of scope (covered by the
 * push.ts module-level tests separately).
 *
 * Keychain: HATCHKIT_KEYTAR_SERVICE is set to a per-pid throwaway
 * service so test rollback blobs don't pollute the user's real
 * keychain. clearAllSecrets() at the end sweeps everything we wrote.
 *
 * Run: pnpm test:secrets-rotate
 */
import { execSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HATCHKIT_KEYTAR_SERVICE = `hatchkit-test-secrets-rotate-${process.pid}`;
process.env.HATCHKIT_CONF_DIR = mkdtempSync(join(tmpdir(), "secrets-rotate-conf-"));

const { runSecretsRotate } = await import("./src/secrets/orchestrator.js");
const { register } = await import("./src/secrets/registry.js");
const { loadRollback, rollbackAccount } = await import("./src/secrets/rollback-store.js");
const { redactValues, redactErrorMessage } = await import("./src/secrets/audit.js");
const { writeManifest, MANIFEST_VERSION } = await import("./src/scaffold/manifest.js");
const { clearAllSecrets, getSecret } = await import("./src/utils/secrets.js");

import type {
  EnvKeySpec,
  NewCred,
  OldCred,
  ProviderRotator,
  RotationContext,
  VerifyOutcome,
} from "./src/secrets/types.js";

type CallEvent =
  | { phase: "detect" }
  | { phase: "envKeys" }
  | { phase: "captureOld" }
  | { phase: "createNew" }
  | { phase: "verify"; fresh: NewCred }
  | { phase: "revoke"; old: OldCred };

interface FakeAdapterOptions {
  name?: string;
  label?: string;
  detect?: (ctx: RotationContext) => boolean;
  envKeys?: ReadonlyArray<EnvKeySpec>;
  captureOldValues?: Record<string, string>;
  captureOldHandle?: Record<string, string>;
  newValues?: Record<string, string>;
  newHandle?: Record<string, string>;
  verifyResult?: VerifyOutcome;
  verifyHook?: (ctx: RotationContext, fresh: NewCred) => Promise<VerifyOutcome>;
  revokeHook?: (ctx: RotationContext, old: OldCred) => Promise<void>;
}

interface FakeAdapter extends ProviderRotator {
  calls: CallEvent[];
  callOrder(): string[];
}

/** Build + register a recordable adapter. Each test gets a unique name
 *  so re-registration doesn't collide. */
function makeFakeAdapter(opts: FakeAdapterOptions = {}): FakeAdapter {
  const calls: CallEvent[] = [];
  const name = opts.name ?? `fake-${Math.random().toString(36).slice(2, 10)}`;
  const envKeys: ReadonlyArray<EnvKeySpec> = opts.envKeys ?? [
    { name: "FAKE_SECRET", scope: "production", secret: true },
  ];
  const adapter: FakeAdapter = {
    name,
    label: opts.label ?? `Fake (${name})`,
    calls,
    callOrder() {
      return calls.map((c) => c.phase);
    },
    detect(ctx) {
      calls.push({ phase: "detect" });
      return opts.detect ? opts.detect(ctx) : true;
    },
    envKeys(_ctx) {
      calls.push({ phase: "envKeys" });
      return envKeys;
    },
    async captureOld(_ctx) {
      calls.push({ phase: "captureOld" });
      return {
        values: opts.captureOldValues ?? { FAKE_SECRET: "OLD-VALUE-DO-NOT-LEAK" },
        handle: opts.captureOldHandle ?? { id: "old-handle-id" },
      };
    },
    async createNew(_ctx) {
      calls.push({ phase: "createNew" });
      return {
        values: opts.newValues ?? { FAKE_SECRET: "NEW-VALUE-AAAA-BBBB-CCCC-DDDD" },
        handle: opts.newHandle ?? { id: "new-handle-id" },
      };
    },
    async verify(ctx, fresh) {
      calls.push({ phase: "verify", fresh });
      if (opts.verifyHook) return opts.verifyHook(ctx, fresh);
      return opts.verifyResult ?? "ok";
    },
    async revoke(ctx, old) {
      calls.push({ phase: "revoke", old });
      if (opts.revokeHook) await opts.revokeHook(ctx, old);
    },
  };
  register(adapter);
  return adapter;
}

/** Project skeleton: tmp dir with a v3 manifest. No .env.* files —
 *  the orchestrator's first call to setProdPairs will mint a keypair
 *  on disk via dotenvx. */
function makeProject(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "secrets-rotate-proj-"));
  writeManifest(dir, {
    version: MANIFEST_VERSION,
    cliVersion: "0.0.0-test",
    scaffoldedAt: new Date().toISOString(),
    name,
    domain: `${name}.example.com`,
    features: [],
    mlServices: [],
    s3Provider: "none",
    deployTarget: "existing",
    deploymentMode: "coolify",
    ports: { server: 3001, client: 3000 },
  });
  return dir;
}

function readProdEnvText(projectDir: string): string {
  const p = join(projectDir, ".env.production");
  return existsSync(p) ? readFileSync(p, "utf-8") : "";
}

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

// ---------------------------------------------------------------------------
// Test 1 — happy path: full pipeline runs in the expected order, env file
// is written between createNew and verify (asserted via the verify hook
// reading .env.production), revoke is called after verify, audit is clean.
// ---------------------------------------------------------------------------
{
  const projectName = "fake-happy";
  const dir = makeProject(projectName);
  let envObservedDuringVerify = "";
  const fake = makeFakeAdapter({
    name: "fake-happy-adapter",
    verifyHook: async (ctx, _fresh) => {
      envObservedDuringVerify = readProdEnvText(ctx.projectDir);
      return "ok";
    },
  });

  const audit = await runSecretsRotate({
    projectName,
    projectDir: dir,
    only: [fake.name],
    noPush: true,
    json: true,
  });

  const order = fake.callOrder();
  // detect (×1), envKeys (×2 — once in dry-run check, once at top of
  // rotateOneAdapter), captureOld, createNew, verify, revoke.
  const phaseSeq = order.join("→");
  const expected = "detect→envKeys→envKeys→captureOld→createNew→verify→revoke";
  const a = audit.adapters[0];

  // After full success, the rollback blob is cleared.
  const rollback = await loadRollback(projectName, fake.name);

  results.happyPath = report("Test 1: happy path call order + audit shape", [
    [`call order = ${expected}`, phaseSeq === expected],
    ["audit has exactly one adapter entry", audit.adapters.length === 1],
    ["entry.provider matches adapter name", a?.provider === fake.name],
    ["entry.envKeysChanged === ['FAKE_SECRET']", a?.envKeysChanged.join(",") === "FAKE_SECRET"],
    ["entry.verificationResult === 'ok'", a?.verificationResult === "ok"],
    ["entry.oldRevoked === true", a?.oldRevoked === true],
    ["entry.skipReason undefined", a?.skipReason === undefined],
    ["audit.dryRun === false", audit.dryRun === false],
    [
      ".env.production written before verify (observed during verify hook)",
      envObservedDuringVerify.includes("FAKE_SECRET"),
    ],
    ["rollback blob cleared after full success", rollback === null],
  ]);
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Test 2 — --revoke=never: revoke is NOT called. Rollback blob is
// preserved (cleared only on revoke success). Audit reports
// oldRevoked: 'held' + skipReason 'revoke-held'.
// ---------------------------------------------------------------------------
{
  const projectName = "fake-no-revoke";
  const dir = makeProject(projectName);
  const fake = makeFakeAdapter({ name: "fake-no-revoke-adapter" });

  const audit = await runSecretsRotate({
    projectName,
    projectDir: dir,
    only: [fake.name],
    noPush: true,
    revokePolicy: "never",
  });

  const order = fake.callOrder();
  const a = audit.adapters[0];
  const rollback = await loadRollback(projectName, fake.name);

  results.revokeNever = report("Test 2: --revoke=never holds the old credential", [
    ["revoke NOT in call order", !order.includes("revoke")],
    ["verify still called", order.includes("verify")],
    ["entry.verificationResult === 'ok'", a?.verificationResult === "ok"],
    ["entry.oldRevoked === 'held'", a?.oldRevoked === "held"],
    ["entry.skipReason === 'revoke-held'", a?.skipReason === "revoke-held"],
    ["rollback blob preserved in keychain", rollback !== null],
    [
      "rollback.values carries the OLD value",
      rollback?.values.FAKE_SECRET === "OLD-VALUE-DO-NOT-LEAK",
    ],
  ]);
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Test 3 — --revoke=immediate: revoke is called BEFORE verify (the
// emergency flip for racing a leak).
// ---------------------------------------------------------------------------
{
  const projectName = "fake-immediate";
  const dir = makeProject(projectName);
  const fake = makeFakeAdapter({ name: "fake-immediate-adapter" });

  const audit = await runSecretsRotate({
    projectName,
    projectDir: dir,
    only: [fake.name],
    noPush: true,
    revokePolicy: "immediate",
  });

  const order = fake.callOrder();
  const revokeIdx = order.indexOf("revoke");
  const verifyIdx = order.indexOf("verify");
  const a = audit.adapters[0];

  results.revokeImmediate = report("Test 3: --revoke=immediate revokes before verify", [
    ["revoke present in call order", revokeIdx >= 0],
    ["verify present in call order", verifyIdx >= 0],
    ["revoke index < verify index", revokeIdx >= 0 && verifyIdx >= 0 && revokeIdx < verifyIdx],
    ["entry.oldRevoked === true", a?.oldRevoked === true],
    ["entry.verificationResult === 'ok'", a?.verificationResult === "ok"],
  ]);
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Test 4 — --dry-run: no captureOld/createNew/verify/revoke called.
// envKeys + detect are still called (orchestrator needs the names to
// populate the audit). rollback-store is untouched.
// ---------------------------------------------------------------------------
{
  const projectName = "fake-dry";
  const dir = makeProject(projectName);
  const fake = makeFakeAdapter({ name: "fake-dry-adapter" });

  const audit = await runSecretsRotate({
    projectName,
    projectDir: dir,
    only: [fake.name],
    noPush: true,
    dryRun: true,
  });

  const order = fake.callOrder();
  const a = audit.adapters[0];
  const rollbackAcct = rollbackAccount(projectName, fake.name);
  const rollbackRaw = await getSecret(rollbackAcct);

  results.dryRun = report("Test 4: --dry-run does no mutation", [
    ["detect called", order.includes("detect")],
    ["envKeys called", order.includes("envKeys")],
    ["captureOld NOT called", !order.includes("captureOld")],
    ["createNew NOT called", !order.includes("createNew")],
    ["verify NOT called", !order.includes("verify")],
    ["revoke NOT called", !order.includes("revoke")],
    ["audit.dryRun === true", audit.dryRun === true],
    [
      "entry.envKeysChanged === ['FAKE_SECRET'] (plan)",
      a?.envKeysChanged.join(",") === "FAKE_SECRET",
    ],
    ["entry.verificationResult === 'skipped'", a?.verificationResult === "skipped"],
    ["entry.oldRevoked === 'held'", a?.oldRevoked === "held"],
    ["rollback-store untouched (no keychain entry written)", rollbackRaw === null],
    [
      ".env.production NOT created (no writes in dry-run)",
      !existsSync(join(dir, ".env.production")),
    ],
  ]);
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Test 5 — .env.keys is git-tracked → orchestrator throws REFUSE.
// We `git init` inside the tmp dir, write a .env.keys, `git add` it,
// then run the rotation. assertEnvKeysNotTracked must throw before any
// adapter call. Real git, no mocking.
// ---------------------------------------------------------------------------
{
  const projectName = "fake-tracked";
  const dir = makeProject(projectName);

  // Real git repo so `git ls-files --error-unmatch .env.keys` matches.
  execSync("git init --quiet", { cwd: dir });
  execSync(`git config user.email t@t.t`, { cwd: dir });
  execSync(`git config user.name test`, { cwd: dir });
  writeFileSync(join(dir, ".env.keys"), `DOTENV_PRIVATE_KEY_PRODUCTION="${"a".repeat(64)}"\n`);
  execSync("git add .env.keys", { cwd: dir });
  execSync(`git commit -m seed --quiet --allow-empty-message`, { cwd: dir });

  const fake = makeFakeAdapter({ name: "fake-tracked-adapter" });

  let caught: Error | undefined;
  try {
    await runSecretsRotate({
      projectName,
      projectDir: dir,
      only: [fake.name],
      noPush: true,
    });
  } catch (err) {
    caught = err as Error;
  }

  results.envKeysTracked = report("Test 5: .env.keys tracked → REFUSE", [
    ["orchestrator threw", !!caught],
    ["error message mentions REFUSE", !!caught && /REFUSE/.test(caught.message)],
    [
      "error message mentions git tracking + recovery hint",
      !!caught && /tracked by git/.test(caught.message) && /git rm --cached/.test(caught.message),
    ],
    [
      "adapter.detect not called (guard fired before adapter loop)",
      !fake.calls.some((c) => c.phase === "detect"),
    ],
  ]);
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Test 6 — plaintext .env.production: warnIfNotEncrypted logs a yellow
// chalk warning but the rotation proceeds (it does NOT throw).
// Capture stderr to assert the warning text.
// ---------------------------------------------------------------------------
{
  const projectName = "fake-plaintext";
  const dir = makeProject(projectName);
  // Pre-create a plaintext .env.production without DOTENV_PUBLIC_KEY_PRODUCTION.
  writeFileSync(join(dir, ".env.production"), "EXISTING_VAR=hello\n");
  const fake = makeFakeAdapter({ name: "fake-plaintext-adapter" });

  const stderrCaptured: string[] = [];
  const originalErr = console.error;
  console.error = (...args: unknown[]) => {
    stderrCaptured.push(args.map((a) => String(a)).join(" "));
  };

  let threw = false;
  try {
    await runSecretsRotate({
      projectName,
      projectDir: dir,
      only: [fake.name],
      noPush: true,
    });
  } catch {
    threw = true;
  } finally {
    console.error = originalErr;
  }

  const joinedStderr = stderrCaptured.join("\n");
  const order = fake.callOrder();

  results.plaintextWarn = report("Test 6: plaintext .env.production warns, continues", [
    ["orchestrator did NOT throw", !threw],
    ["warning printed to stderr", /not dotenvx-encrypted/i.test(joinedStderr)],
    ["createNew still called (rotation proceeded)", order.includes("createNew")],
    ["verify still called", order.includes("verify")],
    ["revoke still called", order.includes("revoke")],
  ]);
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Test 7 — audit redaction. Two layers:
//   (a) redactValues unit test: hex/base64/sk_/whsec_/DSN values redacted.
//   (b) end-to-end: JSON output of a real rotation never contains the
//       new credential value. The audit shape doesn't carry values
//       anyway, but redactValues belt-and-braces guards against future
//       drift — we capture stdout and grep for the value.
// ---------------------------------------------------------------------------
{
  // (a) unit: redactValues handles known credential shapes.
  const sample = {
    safe_name: "FAKE_SECRET",
    SOMETHING_SECRET: "looks-secret",
    SOMETHING_TOKEN: "looks-token",
    SOMETHING_KEY: "looks-key",
    SOMETHING_PASSWORD: "looks-password",
    SOMETHING_DSN: "https://abc:def@sentry.io/12345",
    plain: "hello",
    long_hex: "a".repeat(40),
    stripe_secret: "sk_test_abcdefghijklmnop12345",
    webhook_secret: "whsec_qwertyuiopasdfghjkl1234567",
    base64ish: "AbCdEfGhIjKlMnOpQrStUvWx1234",
    dsn_value: "https://abc:def@example.com/path",
    nested: { GH_TOKEN: "should-also-be-redacted", inner: "plain" },
    list: ["plain1", "sk_test_xxxxxxxxxxxxxxxxxxxxxxx"],
  };
  const redacted = redactValues(sample) as Record<string, unknown>;
  const nested = redacted.nested as { GH_TOKEN: string; inner: string };
  const list = redacted.list as string[];

  // (b) end-to-end: assert the rotation's NDJSON output never contains
  // the new value string. Capture stdout via process.stdout.write hook.
  const projectName = "fake-redact";
  const dir = makeProject(projectName);
  const NEW_VAL = "NEW-SECRET-VALUE-MUST-NOT-LEAK-1234567890";
  const fake = makeFakeAdapter({
    name: "fake-redact-adapter",
    newValues: { FAKE_SECRET: NEW_VAL },
    captureOldValues: { FAKE_SECRET: "OLD-NEVER-LEAK-VALUE" },
  });

  const stdoutCaptured: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  type WriteFn = typeof process.stdout.write;
  const captureWrite: WriteFn = ((chunk: unknown, ...rest: unknown[]) => {
    if (typeof chunk === "string") stdoutCaptured.push(chunk);
    else if (Buffer.isBuffer(chunk)) stdoutCaptured.push(chunk.toString("utf-8"));
    return (originalWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as WriteFn;
  process.stdout.write = captureWrite;
  try {
    await runSecretsRotate({
      projectName,
      projectDir: dir,
      only: [fake.name],
      noPush: true,
      json: true,
    });
  } finally {
    process.stdout.write = originalWrite;
  }
  const joined = stdoutCaptured.join("");

  // redactErrorMessage strips hex/stripe-style/dsn substrings out of
  // error text.
  const errIn = `boom https://user:pass@host/x and sk_test_${"a".repeat(20)} plus ${"f".repeat(40)}`;
  const errOut = redactErrorMessage(errIn);

  results.auditRedaction = report("Test 7: audit + error redaction", [
    ["plain value untouched", redacted.plain === "hello"],
    ["safe_name lowercase not redacted (it's just a string)", redacted.safe_name === "FAKE_SECRET"],
    ["*_SECRET key triggers redaction", redacted.SOMETHING_SECRET === "[REDACTED]"],
    ["*_TOKEN key triggers redaction", redacted.SOMETHING_TOKEN === "[REDACTED]"],
    ["*_KEY key triggers redaction", redacted.SOMETHING_KEY === "[REDACTED]"],
    ["*_PASSWORD key triggers redaction", redacted.SOMETHING_PASSWORD === "[REDACTED]"],
    ["*_DSN key triggers redaction", redacted.SOMETHING_DSN === "[REDACTED]"],
    ["long hex value redacted", redacted.long_hex === "[REDACTED]"],
    ["sk_ prefixed value redacted", redacted.stripe_secret === "[REDACTED]"],
    ["whsec_ prefixed value redacted", redacted.webhook_secret === "[REDACTED]"],
    ["base64-ish value redacted", redacted.base64ish === "[REDACTED]"],
    ["DSN-shaped url redacted", redacted.dsn_value === "[REDACTED]"],
    ["nested object: *_TOKEN key redacted", nested.GH_TOKEN === "[REDACTED]"],
    ["nested object: plain string preserved", nested.inner === "plain"],
    ["array: plain string preserved", list[0] === "plain1"],
    ["array: secret-shaped string redacted", list[1] === "[REDACTED]"],
    ["redactErrorMessage strips hex run", !/[0-9a-f]{32,}/.test(errOut)],
    ["redactErrorMessage strips sk_ token", !/sk_/.test(errOut)],
    ["redactErrorMessage rewrites basic-auth url", /https:\/\/\[REDACTED\]@host/.test(errOut)],
    ["end-to-end JSON output does NOT contain the new credential value", !joined.includes(NEW_VAL)],
    [
      "end-to-end JSON output does NOT contain the old credential value",
      !joined.includes("OLD-NEVER-LEAK-VALUE"),
    ],
    ["end-to-end JSON output contains the env-key NAME", joined.includes("FAKE_SECRET")],
    ["end-to-end JSON output contains the provider name", joined.includes(fake.name)],
  ]);
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Test 8 — verify failure: revoke NOT called, rollback blob preserved,
// audit reports verificationResult 'failed' + oldRevoked 'held' +
// skipReason 'verify-failed'.
// ---------------------------------------------------------------------------
{
  const projectName = "fake-verify-fail";
  const dir = makeProject(projectName);
  const fake = makeFakeAdapter({
    name: "fake-verify-fail-adapter",
    verifyResult: "failed",
  });

  const audit = await runSecretsRotate({
    projectName,
    projectDir: dir,
    only: [fake.name],
    noPush: true,
  });

  const order = fake.callOrder();
  const a = audit.adapters[0];
  const rollback = await loadRollback(projectName, fake.name);

  results.verifyFail = report("Test 8: verify failure preserves rollback, holds revoke", [
    ["createNew called", order.includes("createNew")],
    ["verify called", order.includes("verify")],
    ["revoke NOT called", !order.includes("revoke")],
    ["entry.verificationResult === 'failed'", a?.verificationResult === "failed"],
    ["entry.oldRevoked === 'held'", a?.oldRevoked === "held"],
    ["entry.skipReason === 'verify-failed'", a?.skipReason === "verify-failed"],
    ["rollback blob preserved", rollback !== null],
    [
      "rollback.values has OLD credential",
      rollback?.values.FAKE_SECRET === "OLD-VALUE-DO-NOT-LEAK",
    ],
    ["rollback.handle preserved", rollback?.handle.id === "old-handle-id"],
  ]);
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Test 9 — multiple adapters, partial failure. A succeeds, B fails verify.
// A: revoke called, rollback cleared.
// B: revoke NOT called, rollback preserved.
// Both audit entries appear in the result.
// ---------------------------------------------------------------------------
{
  const projectName = "fake-partial";
  const dir = makeProject(projectName);
  const aAdapter = makeFakeAdapter({
    name: "fake-partial-a",
    envKeys: [{ name: "ADAPTER_A_SECRET", scope: "production", secret: true }],
    newValues: { ADAPTER_A_SECRET: "a-new-value" },
    captureOldValues: { ADAPTER_A_SECRET: "a-old-value" },
    captureOldHandle: { id: "a-handle" },
    verifyResult: "ok",
  });
  const bAdapter = makeFakeAdapter({
    name: "fake-partial-b",
    envKeys: [{ name: "ADAPTER_B_SECRET", scope: "production", secret: true }],
    newValues: { ADAPTER_B_SECRET: "b-new-value" },
    captureOldValues: { ADAPTER_B_SECRET: "b-old-value" },
    captureOldHandle: { id: "b-handle" },
    verifyResult: "failed",
  });

  const audit = await runSecretsRotate({
    projectName,
    projectDir: dir,
    only: [aAdapter.name, bAdapter.name],
    noPush: true,
  });

  const aEntry = audit.adapters.find((e) => e.provider === aAdapter.name);
  const bEntry = audit.adapters.find((e) => e.provider === bAdapter.name);
  const aRollback = await loadRollback(projectName, aAdapter.name);
  const bRollback = await loadRollback(projectName, bAdapter.name);

  const aOrder = aAdapter.callOrder();
  const bOrder = bAdapter.callOrder();

  results.partialFailure = report("Test 9: multi-adapter partial failure", [
    ["audit has 2 entries", audit.adapters.length === 2],
    ["adapter A entry present", !!aEntry],
    ["adapter B entry present", !!bEntry],
    ["A: verify ok", aEntry?.verificationResult === "ok"],
    ["A: oldRevoked true", aEntry?.oldRevoked === true],
    ["A: revoke called", aOrder.includes("revoke")],
    ["A: rollback cleared", aRollback === null],
    ["A: env key in audit", aEntry?.envKeysChanged.join(",") === "ADAPTER_A_SECRET"],
    ["B: verify failed", bEntry?.verificationResult === "failed"],
    ["B: oldRevoked 'held'", bEntry?.oldRevoked === "held"],
    ["B: skipReason verify-failed", bEntry?.skipReason === "verify-failed"],
    ["B: revoke NOT called", !bOrder.includes("revoke")],
    ["B: rollback preserved", bRollback !== null],
    ["B: rollback.values has OLD credential", bRollback?.values.ADAPTER_B_SECRET === "b-old-value"],
  ]);
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Test 10 — captureOld returns empty (adapter can't recover old creds).
// Orchestrator auto-downgrades after-verify → never for THAT adapter:
// revoke not called, audit reports skipReason 'revoke-held'.
// ---------------------------------------------------------------------------
{
  const projectName = "fake-empty-capture";
  const dir = makeProject(projectName);
  const fake = makeFakeAdapter({
    name: "fake-empty-capture-adapter",
    captureOldValues: {},
    captureOldHandle: {},
  });

  const audit = await runSecretsRotate({
    projectName,
    projectDir: dir,
    only: [fake.name],
    noPush: true,
    // explicit after-verify; orchestrator should downgrade to 'never'
    // because captureOld returned empty.
    revokePolicy: "after-verify",
  });

  const order = fake.callOrder();
  const a = audit.adapters[0];

  results.emptyCaptureDowngrade = report(
    "Test 10: empty captureOld auto-downgrades revoke policy",
    [
      ["createNew called", order.includes("createNew")],
      ["verify called", order.includes("verify")],
      ["revoke NOT called (downgraded)", !order.includes("revoke")],
      ["entry.verificationResult === 'ok'", a?.verificationResult === "ok"],
      ["entry.oldRevoked === 'held'", a?.oldRevoked === "held"],
      ["entry.skipReason === 'revoke-held'", a?.skipReason === "revoke-held"],
    ],
  );
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Test 11 — push.ts: `gh secret set` failure redacts secret-shaped stderr
// before throwing. Defense-in-depth — today `gh` doesn't echo `--body` argv,
// but a future release might on auth failure, and the throw message bubbles
// to the user / orchestrator audit. Uses a fake `gh` on PATH so the real
// binary isn't required for the test to run.
// ---------------------------------------------------------------------------
{
  const { pushToGithub } = await import("./src/secrets/push.js");

  const fakeBinDir = mkdtempSync(join(tmpdir(), "fake-gh-bin-"));
  const ghPath = join(fakeBinDir, "gh");
  // Fake gh: exits non-zero with stderr that contains both a sk_ token
  // and a long hex run — exactly the shapes redactErrorMessage strips.
  writeFileSync(
    ghPath,
    `#!/bin/sh
echo "auth failed: token sk_test_abcdefghijklmnopqrst (${"f".repeat(40)})" 1>&2
exit 1
`,
  );
  chmodSync(ghPath, 0o755);

  const origPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${origPath ?? ""}`;

  let thrown: Error | null = null;
  try {
    await pushToGithub([{ key: "FAKE_SECRET", value: "new-value-do-not-leak" }], {
      repoSlug: "owner/repo",
    });
  } catch (err) {
    thrown = err as Error;
  } finally {
    process.env.PATH = origPath;
    rmSync(fakeBinDir, { recursive: true, force: true });
  }

  const msg = thrown?.message ?? "";
  results.pushGhRedact = report(
    "Test 11: pushToGithub redacts secret-shaped stderr on gh failure",
    [
      ["throws Error", thrown instanceof Error],
      ["message mentions key name", msg.includes("FAKE_SECRET")],
      ["message mentions exit code", msg.includes("exited 1")],
      ["message does NOT contain sk_ token", !/sk_test_/.test(msg)],
      ["message does NOT contain long hex run", !/[0-9a-f]{32,}/.test(msg)],
      ["message contains [REDACTED]", msg.includes("[REDACTED]")],
    ],
  );
}

// ---------------------------------------------------------------------------
// Test 12 — push() throws: env file is written locally, verify still runs,
// revoke is force-skipped (deploy targets still hold OLD cred), rollback
// blob preserved, audit reports skipReason 'push-failed' with a redacted
// pushError. Uses the __setPushImplForTesting seam in push.ts so we never
// touch real Coolify/GH credentials.
// ---------------------------------------------------------------------------
{
  const projectName = "fake-push-fail";
  const dir = makeProject(projectName);
  const fake = makeFakeAdapter({ name: "fake-push-fail-adapter" });

  const { __setPushImplForTesting } = await import("./src/secrets/push.js");
  __setPushImplForTesting(async () => {
    // Include a hex run so we can assert it's redacted in pushError.
    throw new Error(`coolify 503: upstream connect error ${"a".repeat(40)}`);
  });

  const stderrCaptured: string[] = [];
  const originalErr = console.error;
  console.error = (...args: unknown[]) => {
    stderrCaptured.push(args.map((a) => String(a)).join(" "));
  };

  let threw = false;
  let audit;
  try {
    audit = await runSecretsRotate({
      projectName,
      projectDir: dir,
      only: [fake.name],
      // Don't set noPush — we want the push() call to happen and throw.
      pushTargets: ["coolify"],
      revokePolicy: "after-verify",
    });
  } catch {
    threw = true;
  } finally {
    console.error = originalErr;
    __setPushImplForTesting(undefined);
  }

  const order = fake.callOrder();
  const a = audit?.adapters[0];
  const rollback = await loadRollback(projectName, fake.name);
  const joinedStderr = stderrCaptured.join("\n");

  results.pushFailed = report(
    "Test 12: push() throws — orchestrator continues, revoke held, rollback preserved",
    [
      ["orchestrator did NOT throw", !threw],
      ["captureOld called", order.includes("captureOld")],
      ["createNew called", order.includes("createNew")],
      ["verify still called (against local newCred, not deploy targets)", order.includes("verify")],
      [
        "revoke NOT called (force-held — OLD cred still live in deploy targets)",
        !order.includes("revoke"),
      ],
      ["entry.verificationResult === 'ok'", a?.verificationResult === "ok"],
      ["entry.oldRevoked === 'held'", a?.oldRevoked === "held"],
      ["entry.skipReason === 'push-failed'", a?.skipReason === "push-failed"],
      [
        "entry.pushError is a non-empty redacted string",
        typeof a?.pushError === "string" && a.pushError.length > 0,
      ],
      [
        "entry.pushError has long hex run redacted (defence-in-depth)",
        typeof a?.pushError === "string" && !/[0-9a-f]{32,}/.test(a.pushError),
      ],
      [
        "entry.deployTargetsUpdated is empty (no targets succeeded)",
        a?.deployTargetsUpdated.length === 0,
      ],
      [
        ".env.production WAS written locally (in-disk new value is good)",
        readProdEnvText(dir).includes("FAKE_SECRET"),
      ],
      ["rollback blob preserved (OLD cred recoverable via secrets rollback)", rollback !== null],
      [
        "rollback.values carries the OLD value",
        rollback?.values.FAKE_SECRET === "OLD-VALUE-DO-NOT-LEAK",
      ],
      ["stderr line printed about push failure", /push failed/i.test(joinedStderr)],
    ],
  );
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Cleanup + summary
// ---------------------------------------------------------------------------
await clearAllSecrets();
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
