/**
 * Deferrals — declining an optional step is a clean skip, not a crash.
 *
 * Covers the four behaviours the feature promises:
 *   1. Classification — what defers vs. what still aborts the run.
 *   2. Manifest bookkeeping — deferrals persist, dedupe, and clear once
 *      the step finally succeeds (so a resume isn't stale).
 *   3. runProvision end-to-end — one declined step, one unavailable
 *      step, and one provider blowing up mid-run all land in the same
 *      run, none of them abort it, and the surviving services still
 *      complete.
 *   4. Resume — re-running the deferred service clears its entry and
 *      leaves the others alone.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HATCHKIT_CONF_DIR = mkdtempSync(join(tmpdir(), "deferrals-conf-"));
process.env.HATCHKIT_KEYTAR_SERVICE = `hatchkit-test-deferrals-${process.pid}`;

// The credential gate defers automatically when there's no TTY rather
// than blocking on an invisible prompt. `pnpm test` from a terminal
// inherits a real TTY, so pin it off for the whole file — otherwise the
// integration run below would sit waiting for input forever.
Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

const {
  FatalProvisionError,
  STANDALONE_STEP_KEYS,
  StepDeferredError,
  classifyOptionalStepError,
  deferralForService,
  deferralForStripe,
  deferralKeyForService,
  followUpCommandForService,
  isFatalProvisionError,
  isStepDeferral,
  mergeDeferredSteps,
  persistDeferredSteps,
  readDeferredSteps,
  renderDeferralSummary,
  resolveDeferredSteps,
  withoutDeferredSteps,
} = await import("./src/provision/deferrals.js");
type DeferredStep = import("./src/provision/deferrals.js").DeferredStep;

const { MANIFEST_VERSION, readManifest, writeManifest } = await import(
  "./src/scaffold/manifest.js"
);

const tmpDirs: string[] = [process.env.HATCHKIT_CONF_DIR];
function tempProject(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  tmpDirs.push(dir);
  return dir;
}

function seedManifest(dir: string, name: string, extra: Record<string, unknown> = {}): void {
  writeManifest(dir, {
    version: MANIFEST_VERSION,
    cliVersion: "test",
    scaffoldedAt: "2026-01-01T00:00:00.000Z",
    name,
    domain: `${name}.example.com`,
    features: [],
    mlServices: [],
    s3Provider: "none",
    deployTarget: "existing",
    ports: { server: 3000, client: 5173 },
    ...extra,
  });
}

/* ── 1. Classification ─────────────────────────────────────────────── */

{
  const declined = classifyOptionalStepError(new StepDeferredError("said no"));
  assert.deepEqual(declined, { kind: "declined", reason: "said no" });

  const unavailable = classifyOptionalStepError(
    new StepDeferredError("no client surface", "unavailable"),
  );
  assert.deepEqual(unavailable, { kind: "unavailable", reason: "no client surface" });

  // A provider that 401s / times out mid-run is reported and skipped —
  // same downstream handling as a decline, so the run keeps going.
  const failed = classifyOptionalStepError(new Error("HTTP 401 bad token"));
  assert.deepEqual(failed, { kind: "failed", reason: "HTTP 401 bad token" });

  // Node's fetch reports transport failures as TypeError. That MUST be
  // deferrable — it's the canonical "provider unreachable" case.
  const netFail = classifyOptionalStepError(new TypeError("fetch failed"));
  assert.deepEqual(netFail, { kind: "failed", reason: "fetch failed" });

  // Genuinely fatal: keeps propagating (null = rethrow).
  assert.equal(classifyOptionalStepError(new FatalProvisionError("conflict")), null);
  const ctrlC = new Error("prompt closed");
  ctrlC.name = "ExitPromptError";
  assert.equal(classifyOptionalStepError(ctrlC), null);
  assert.equal(classifyOptionalStepError(new ReferenceError("x is not defined")), null);

  assert.equal(isStepDeferral(new StepDeferredError("x")), true);
  assert.equal(isStepDeferral(new Error("x")), false);
  assert.equal(isFatalProvisionError(new FatalProvisionError("x")), true);
  assert.equal(isFatalProvisionError(new Error("x")), false);
}

/* ── 2. Follow-up commands + collection helpers ────────────────────── */

{
  assert.equal(followUpCommandForService("glitchtip", "raptor"), "hatchkit add raptor glitchtip");
  assert.equal(
    followUpCommandForService("listmonk-ses", "raptor"),
    "hatchkit add raptor listmonk-ses",
  );
  assert.equal(deferralKeyForService("s3"), "service:s3");
  assert.equal(
    deferralForStripe({ project: "raptor", kind: "declined", reason: "no keys" }).command,
    "hatchkit add raptor stripe",
  );
  assert.equal(
    deferralForStripe({ project: "raptor", kind: "declined", reason: "no keys" }).key,
    STANDALONE_STEP_KEYS.stripe,
  );

  // "unavailable" carries no `hatchkit config add` hint — nothing is
  // missing credential-wise, the step just doesn't apply here.
  const unavailable = deferralForService({
    service: "plausible",
    project: "raptor",
    kind: "unavailable",
    reason: "backend surface",
    withoutSetupHint: true,
  });
  assert.equal(unavailable.hint, undefined);
  assert.deepEqual(
    deferralForService({
      service: "glitchtip",
      project: "raptor",
      kind: "declined",
      reason: "nope",
    }).hint,
    ["hatchkit config add glitchtip"],
  );

  const a: DeferredStep = {
    key: "service:glitchtip",
    label: "GlitchTip",
    kind: "declined",
    reason: "first",
    command: "cmd-a",
    deferredAt: "2026-01-01T00:00:00.000Z",
  };
  const b: DeferredStep = { ...a, reason: "second", deferredAt: "2026-02-01T00:00:00.000Z" };
  const c: DeferredStep = { ...a, key: "service:s3", reason: "other" };

  // Re-deferring the same step refreshes it in place instead of stacking.
  const merged = mergeDeferredSteps([a, c], [b]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].reason, "second");
  assert.equal(merged[1].key, "service:s3");

  assert.deepEqual(
    withoutDeferredSteps(merged, ["service:glitchtip"]).map((s) => s.key),
    ["service:s3"],
  );
}

/* ── 3. Manifest persistence ───────────────────────────────────────── */

{
  const dir = tempProject("deferrals-manifest");
  // No manifest yet: recording is a silent no-op, never a throw.
  assert.equal(
    persistDeferredSteps(dir, [
      deferralForService({ service: "s3", project: "p", kind: "declined", reason: "x" }),
    ]),
    null,
  );
  assert.deepEqual(readDeferredSteps(dir), []);
  assert.deepEqual(readDeferredSteps(undefined), []);

  seedManifest(dir, "raptor");
  const step = deferralForService({
    service: "s3",
    project: "raptor",
    kind: "declined",
    reason: "no R2 token to hand",
  });
  persistDeferredSteps(dir, [step]);
  const afterFirst = readDeferredSteps(dir);
  assert.equal(afterFirst.length, 1);
  assert.equal(afterFirst[0].command, "hatchkit add raptor s3");

  // Idempotent: writing the same deferral twice doesn't duplicate it.
  persistDeferredSteps(dir, [step]);
  assert.equal(readDeferredSteps(dir).length, 1);

  // A second, different step accumulates.
  persistDeferredSteps(dir, [
    deferralForService({
      service: "glitchtip",
      project: "raptor",
      kind: "failed",
      reason: "HTTP 500",
    }),
  ]);
  assert.equal(readDeferredSteps(dir).length, 2);

  // Completing a step clears exactly that entry.
  resolveDeferredSteps(dir, [deferralKeyForService("s3")]);
  const remaining = readDeferredSteps(dir);
  assert.deepEqual(
    remaining.map((s) => s.key),
    ["service:glitchtip"],
  );

  // Everything resolved → the field is dropped, not left as `[]`.
  resolveDeferredSteps(dir, [deferralKeyForService("glitchtip")]);
  assert.equal(readManifest(dir)?.deferred, undefined);

  // The manifest never carries a credential — only labels + commands.
  const serialized = JSON.stringify(readManifest(dir));
  assert.equal(serialized.includes("token"), false);
}

/* ── 4. Summary rendering ──────────────────────────────────────────── */

{
  const block = renderDeferralSummary({
    configured: ["GlitchTip (error tracking)"],
    deferred: [
      deferralForService({
        service: "s3",
        project: "raptor",
        kind: "declined",
        reason: "no R2 token to hand",
      }),
    ],
  });
  assert.match(block, /Configured \(1\)/);
  assert.match(block, /Deferred \(1\)/);
  assert.match(block, /hatchkit add raptor s3/);
  assert.match(block, /hatchkit config add s3/);
  assert.match(block, /Nothing was rolled back/);
  assert.equal(renderDeferralSummary({ configured: [], deferred: [] }), "");
}

/* ── 5. runProvision end-to-end ────────────────────────────────────── */

// Stub GlitchTip so the "resume" run can succeed without a real host.
const glitchtipHits: string[] = [];
const stub = createServer((req, res) => {
  glitchtipHits.push(`${req.method} ${req.url}`);
  if (req.url?.endsWith("/keys/")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([{ dsn: { public: "https://key@glitchtip.test/1" } }]));
    return;
  }
  res.writeHead(201, { "content-type": "application/json" });
  res.end("{}");
});
await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
const stubPort = (stub.address() as AddressInfo).port;

const { getStore } = await import("./src/config.js");
const { SECRET_KEYS, deleteSecret, setSecret } = await import("./src/utils/secrets.js");
const { runProvision } = await import("./src/provision/index.js");

const store = getStore();
// GlitchTip is configured but points at a dead port for the first run —
// that reproduces "provider errors mid-run" without any real network.
store.set("providers.glitchtip", {
  status: "configured",
  url: "http://127.0.0.1:1",
  organizationSlug: "acme",
  teamSlug: "core",
  lastVerified: "2026-01-01T00:00:00.000Z",
});
await setSecret(SECRET_KEYS.glitchtipToken, "test-token");
// Plausible is configured, so its credential gate passes — it defers on
// the surface check instead ("backend" has no client bundle).
store.set("providers.plausible", {
  status: "configured",
  url: "https://plausible.test",
  lastVerified: "2026-01-01T00:00:00.000Z",
});
await setSecret(SECRET_KEYS.plausibleApiKey, "test-key");
// OpenPanel is left unconfigured — no TTY, so its gate defers.

const projectDir = tempProject("deferrals-provision");
seedManifest(projectDir, "raptor", { surfaces: "backend" });

const firstRun = await runProvision({
  baseName: "raptor",
  services: ["glitchtip", "openpanel", "plausible"],
  domain: "raptor.example.com",
  surfaces: { mode: "backend", projectDir, serverEnvDir: projectDir },
  printSummary: false,
});

// Nothing threw, nothing completed, and every skip is accounted for.
assert.deepEqual(firstRun.configured, []);
assert.equal(firstRun.deferred.length, 3);
const byKey = new Map(firstRun.deferred.map((s) => [s.key, s]));
assert.equal(byKey.get("service:openpanel")?.kind, "declined");
assert.equal(byKey.get("service:plausible")?.kind, "unavailable");
assert.equal(byKey.get("service:glitchtip")?.kind, "failed");
assert.equal(byKey.get("service:glitchtip")?.command, "hatchkit add raptor glitchtip");

// Persisted for `hatchkit status` / a later resume.
assert.equal(readDeferredSteps(projectDir).length, 3);

/* ── 6. Resume clears only the step that succeeded ─────────────────── */

store.set("providers.glitchtip", {
  status: "configured",
  url: `http://127.0.0.1:${stubPort}`,
  organizationSlug: "acme",
  teamSlug: "core",
  lastVerified: "2026-01-01T00:00:00.000Z",
});

const resumeRun = await runProvision({
  baseName: "raptor",
  services: ["glitchtip"],
  domain: "raptor.example.com",
  surfaces: { mode: "backend", projectDir, serverEnvDir: projectDir },
  printSummary: false,
});

assert.deepEqual(resumeRun.configured, ["glitchtip"]);
assert.deepEqual(resumeRun.deferred, []);
assert.ok(
  glitchtipHits.some((h) => h.startsWith("POST")),
  "expected a GlitchTip create call",
);

const afterResume = readDeferredSteps(projectDir);
assert.deepEqual(
  afterResume.map((s) => s.key).sort(),
  ["service:openpanel", "service:plausible"],
  "resuming one step must not disturb the others",
);

/* ── 7. status surfaces the remainder ──────────────────────────────── */

{
  const { collectStatus } = await import("./src/status.js");
  const snapshot = collectStatus(projectDir);
  assert.equal(snapshot.project?.name, "raptor");
  assert.equal(snapshot.deferredSteps.length, 2);
  assert.ok(
    snapshot.suggestions.some((s) => s.command === "hatchkit add raptor openpanel"),
    "deferred follow-ups should appear in status suggestions",
  );
}

/* ── 8. doctor reports them without failing the run ────────────────── */

{
  const { checkProjectDeferredSteps } = await import("./src/doctor.js");
  const checks = checkProjectDeferredSteps(projectDir);
  assert.equal(checks.length, 2);
  assert.equal(checks[0].status, "deferred");
  assert.ok(checks[0].hint?.[0].includes("hatchkit add raptor"));
  assert.deepEqual(checkProjectDeferredSteps(tempProject("deferrals-empty")), []);
}

stub.close();
await deleteSecret(SECRET_KEYS.glitchtipToken).catch(() => {});
await deleteSecret(SECRET_KEYS.plausibleApiKey).catch(() => {});
// The successful resume run mirrored a dotenvx key into the (throwaway)
// keytar service — drop it so repeated local runs stay clean.
await deleteSecret(SECRET_KEYS.dotenvxPrivateKey("raptor")).catch(() => {});
for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });

console.log("✓ deferrals: classification, persistence, provisioning, resume, status, doctor");
