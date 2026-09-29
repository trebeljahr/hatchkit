/**
 * listmonk-tx-mode.ts: the account-email recipient-mode retrofit.
 *
 * Until 2026-09-29 the starter posted verification, reset and invitation
 * mail to Listmonk's `/api/tx` without `subscriber_mode`. Listmonk's default
 * mode answers 400 for anybody who is not already a subscriber, which is
 * every one of those recipients, and the error is only logged. `hatchkit
 * update` patches the body of an existing project; these tests pin that.
 *
 *  1. **The starter already sends external mode**, so a new project needs
 *     no retrofit and the transform leaves it alone.
 *  2. **The pre-fix shape is patched**, and the patched file is imported and
 *     run against a stubbed `fetch`: the body Listmonk would receive is what
 *     is asserted, not the text of the file.
 *  3. **Idempotence.** `update` runs this on every invocation. A second pass
 *     must report nothing written.
 *  4. **Scope.** Only `services/email.ts` is touched. The newsletter sender
 *     creates its subscriber first and is correct as it is; a Resend-era
 *     email.ts has no `/api/tx` at all.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { FeatureLedger } from "./src/features/contract.js";
import {
  EMAIL_SERVICE_REL_PATH,
  retrofitListmonkTxMode,
  upgradeListmonkTxSubscriberMode,
} from "./src/scaffold/listmonk-tx-mode.js";

const STARTER = join(import.meta.dirname, "..", "starter");
const NEWSLETTER_REL_PATH = "packages/server/src/services/newsletter/listmonk.ts";

const failures: string[] = [];
function expect(label: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(
      () => {
        console.log(`  ✓ ${label}`);
      },
      (err: Error) => {
        failures.push(`${label}: ${err.message}`);
        console.log(`  ✗ ${label}`);
      },
    );
}

/** The starter's sender as it shipped before the fix, trimmed to what the
 *  retrofit reads: the `/api/tx` request with its inline body literal. */
const PRE_FIX_EMAIL_TS = [
  'import { env } from "../config/env.js";',
  "",
  "export async function sendEmail(params: { to: string; subject: string; text: string }) {",
  "  const body = `<pre>${params.text}</pre>`;",
  '  const baseUrl = env.LISTMONK_URL.replace(/\\/$/, "");',
  "  const fromEmail = env.LISTMONK_FROM || env.LISTMONK_FROM_EMAIL;",
  "",
  "  const response = await fetch(`${baseUrl}/api/tx`, {",
  '    method: "POST",',
  '    headers: { "Content-Type": "application/json" },',
  "    body: JSON.stringify({",
  "      subscriber_email: params.to,",
  "      template_id: Number(env.LISTMONK_TX_TEMPLATE_ID),",
  "      from_email: fromEmail,",
  "      data: { subject: params.subject, body },",
  '      content_type: "html",',
  "    }),",
  "  });",
  "",
  "  if (!response.ok) {",
  "    throw new Error(`Listmonk /api/tx error (${response.status})`);",
  "  }",
  "}",
  "",
].join("\n");

/** An email.ts from before Listmonk was the transport. */
const RESEND_EMAIL_TS = [
  "export async function sendEmail(params: { to: string }) {",
  '  await fetch("https://api.resend.com/emails", {',
  '    method: "POST",',
  "    body: JSON.stringify({ to: params.to }),",
  "  });",
  "}",
  "",
].join("\n");

function makeProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "listmonk-tx-mode-"));
  for (const [rel, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), contents, "utf-8");
  }
  return dir;
}

function copyFromStarter(dir: string, rel: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  cpSync(join(STARTER, rel), join(dir, rel));
}

// ── 1. The starter ────────────────────────────────────────────────────
console.log("\nstarter:");

await expect("the starter's account email already sends external mode", () => {
  const source = readFileSync(join(STARTER, EMAIL_SERVICE_REL_PATH), "utf-8");
  const result = upgradeListmonkTxSubscriberMode(source);
  assert.equal(result.outcome, "already");
  assert.equal(result.source, source);
  assert.match(source, /^\s*subscriber_mode: "external",$/m);
});

// ── 2. The pre-fix shape ──────────────────────────────────────────────
console.log("\npre-fix email.ts:");

await expect("subscriber_mode lands right after subscriber_email, same indent", () => {
  const result = upgradeListmonkTxSubscriberMode(PRE_FIX_EMAIL_TS);
  assert.equal(result.outcome, "patched");
  const lines = result.source.split("\n");
  const recipient = lines.indexOf("      subscriber_email: params.to,");
  assert.notEqual(recipient, -1);
  assert.ok(lines[recipient + 1]?.startsWith("      // "), "the why-comment follows the recipient");
  assert.equal(lines[recipient + 3], '      subscriber_mode: "external",');
  assert.equal(lines.length, PRE_FIX_EMAIL_TS.split("\n").length + 3);
});

await expect("the patched sender puts external mode on the wire", async () => {
  const dir = makeProject({
    [EMAIL_SERVICE_REL_PATH]: upgradeListmonkTxSubscriberMode(PRE_FIX_EMAIL_TS).source,
    "packages/server/src/config/env.ts": [
      "export const env = {",
      '  LISTMONK_URL: "https://listmonk.test/",',
      '  LISTMONK_FROM: "",',
      '  LISTMONK_FROM_EMAIL: "noreply@mail.example.com",',
      '  LISTMONK_TX_TEMPLATE_ID: "3",',
      "};",
      "",
    ].join("\n"),
  });
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const mod = await import(pathToFileURL(join(dir, EMAIL_SERVICE_REL_PATH)).href);
    await mod.sendEmail({ to: "new@example.com", subject: "Verify", text: "hi" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.url, "https://listmonk.test/api/tx");
  assert.equal(sent[0]?.body.subscriber_mode, "external");
  assert.equal(sent[0]?.body.subscriber_email, "new@example.com");
  assert.equal(sent[0]?.body.template_id, 3);
});

await expect("a mode somebody already chose is left alone", () => {
  const chosen = PRE_FIX_EMAIL_TS.replace(
    "      subscriber_email: params.to,",
    '      subscriber_email: params.to,\n      subscriber_mode: "default",',
  );
  const result = upgradeListmonkTxSubscriberMode(chosen);
  assert.equal(result.outcome, "already");
  assert.equal(result.source, chosen);
});

await expect("a body with no subscriber_email line is reported, not forced", () => {
  const dir = makeProject({
    [EMAIL_SERVICE_REL_PATH]: PRE_FIX_EMAIL_TS.replace(
      "      subscriber_email: params.to,",
      "      subscriber_id: 7,",
    ),
  });
  const before = readFileSync(join(dir, EMAIL_SERVICE_REL_PATH), "utf-8");
  const ledger = new FeatureLedger(dir, false);
  const result = retrofitListmonkTxMode(ledger);
  assert.equal(result.outcome, "no-anchor");
  assert.equal(result.action, "conflict");
  assert.deepEqual(
    ledger.conflicts().map((entry) => entry.file),
    [EMAIL_SERVICE_REL_PATH],
  );
  assert.equal(readFileSync(join(dir, EMAIL_SERVICE_REL_PATH), "utf-8"), before);
});

// ── 3. Idempotence ────────────────────────────────────────────────────
console.log("\nidempotence:");

await expect("the transform is a fixed point", () => {
  const once = upgradeListmonkTxSubscriberMode(PRE_FIX_EMAIL_TS).source;
  const twice = upgradeListmonkTxSubscriberMode(once);
  assert.equal(twice.outcome, "already");
  assert.equal(twice.source, once);
});

await expect("a dry run reports the patch and writes nothing", () => {
  const dir = makeProject({ [EMAIL_SERVICE_REL_PATH]: PRE_FIX_EMAIL_TS });
  const result = retrofitListmonkTxMode(new FeatureLedger(dir, true));
  assert.equal(result.outcome, "patched");
  assert.equal(result.action, "would-write");
  assert.equal(readFileSync(join(dir, EMAIL_SERVICE_REL_PATH), "utf-8"), PRE_FIX_EMAIL_TS);
});

await expect("a second update writes nothing", () => {
  const dir = makeProject({ [EMAIL_SERVICE_REL_PATH]: PRE_FIX_EMAIL_TS });
  const first = retrofitListmonkTxMode(new FeatureLedger(dir, false));
  assert.equal(first.action, "written");
  const second = new FeatureLedger(dir, false);
  const again = retrofitListmonkTxMode(second);
  assert.equal(again.outcome, "already");
  assert.equal(again.action, "unchanged");
  assert.deepEqual(second.summary().written, []);
});

// ── 4. Scope ──────────────────────────────────────────────────────────
console.log("\nscope:");

await expect("the newsletter sender is never touched", () => {
  const dir = makeProject({ [EMAIL_SERVICE_REL_PATH]: PRE_FIX_EMAIL_TS });
  copyFromStarter(dir, NEWSLETTER_REL_PATH);
  const newsletter = readFileSync(join(STARTER, NEWSLETTER_REL_PATH), "utf-8");
  // It posts to /api/tx with a subscriber_email and no mode, so the
  // transform alone would patch it. The retrofit must not reach it.
  assert.match(newsletter, /\/api\/tx/);
  assert.doesNotMatch(newsletter, /subscriber_mode/);
  const ledger = new FeatureLedger(dir, false);
  retrofitListmonkTxMode(ledger);
  assert.equal(readFileSync(join(dir, NEWSLETTER_REL_PATH), "utf-8"), newsletter);
  assert.deepEqual(
    ledger.entries.map((entry) => entry.file),
    [EMAIL_SERVICE_REL_PATH],
  );
});

await expect("a Resend-era email.ts is not Listmonk and stays as it is", () => {
  const dir = makeProject({ [EMAIL_SERVICE_REL_PATH]: RESEND_EMAIL_TS });
  const result = retrofitListmonkTxMode(new FeatureLedger(dir, false));
  assert.equal(result.outcome, "not-listmonk");
  assert.equal(result.action, "unchanged");
  assert.equal(readFileSync(join(dir, EMAIL_SERVICE_REL_PATH), "utf-8"), RESEND_EMAIL_TS);
});

await expect("a project without the file is absent, not an error", () => {
  const dir = makeProject({});
  const ledger = new FeatureLedger(dir, false);
  const result = retrofitListmonkTxMode(ledger);
  assert.equal(result.outcome, "absent");
  assert.equal(ledger.touched, false);
});

// ── Result ────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("\nAll Listmonk tx-mode tests passed.\n");
