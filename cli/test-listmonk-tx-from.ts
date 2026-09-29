/**
 * listmonk-tx-from.ts: the newsletter confirmation-sender retrofit.
 *
 * Until 2026-09-29 the starter's newsletter client posted to Listmonk's
 * `/api/tx` without `from_email`, so Listmonk sent the double-opt-in
 * confirmation from its global `app.from_email` — on a shared instance,
 * another project's sender. `hatchkit update` patches the body of an
 * existing project; these tests pin that.
 *
 *  1. **The starter already sends `from_email`**, so a new project needs no
 *     retrofit and the transform leaves it alone.
 *  2. **The pre-fix shape is patched**, and the patched file is imported and
 *     run against a stubbed `fetch`: the body Listmonk would receive is what
 *     is asserted, not the text of the file. `subscriber_mode` never lands
 *     in it — the newsletter creates its subscriber first.
 *  3. **Idempotence.** `update` runs this on every invocation. A second pass
 *     must report nothing written.
 *  4. **Scope.** Only `/api/tx` bodies count. The campaign body in the same
 *     file always had a `from_email`, and must not stand in for the missing
 *     one.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { FeatureLedger } from "./src/features/contract.js";
import {
  NEWSLETTER_LISTMONK_REL_PATH,
  TX_FROM_PROPERTY,
  retrofitListmonkTxFrom,
  upgradeListmonkTxFromEmail,
} from "./src/scaffold/listmonk-tx-from.js";

const STARTER = join(import.meta.dirname, "..", "starter");

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

const STARTER_NEWSLETTER = readFileSync(join(STARTER, NEWSLETTER_LISTMONK_REL_PATH), "utf-8");

/** The starter's line, as it sits in the `/api/tx` body. */
const STARTER_FROM_LINE =
  /^[ \t]*from_email: process\.env\.LISTMONK_FROM \|\| process\.env\.LISTMONK_FROM_EMAIL,\n/m;

/** The newsletter client as it shipped before the fix: today's starter
 *  file without its `/api/tx` sender line. Everything else — the campaign
 *  body's own `from_email`, the header comment that names `/api/tx` — is
 *  left in, because the retrofit has to read past both. */
const PRE_FIX_NEWSLETTER = STARTER_NEWSLETTER.replace(STARTER_FROM_LINE, "");

const RECIPIENT_LINE = "      subscriber_email: params.to.toLowerCase(),";

function makeProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "listmonk-tx-from-"));
  for (const [rel, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), contents, "utf-8");
  }
  return dir;
}

/** Import `source` as the newsletter client and send one transactional
 *  email through it with `env` set, returning every request it made. */
async function sendThrough(
  source: string,
  env: Record<string, string | undefined>,
): Promise<Array<{ url: string; body: Record<string, unknown> }>> {
  const dir = makeProject({ [NEWSLETTER_LISTMONK_REL_PATH]: source });
  const vars: Record<string, string | undefined> = {
    LISTMONK_URL: "https://listmonk.test/",
    LISTMONK_API_USER: "api-user",
    LISTMONK_API_TOKEN: "api-token",
    LISTMONK_TX_TEMPLATE_ID: "5",
    LISTMONK_FROM: undefined,
    LISTMONK_FROM_EMAIL: undefined,
    ...env,
  };
  const saved = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
  const setEnv = (values: Record<string, string | undefined>) => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  setEnv(vars);
  try {
    const mod = await import(pathToFileURL(join(dir, NEWSLETTER_LISTMONK_REL_PATH)).href);
    await mod.sendTransactional({ to: "New@Example.com", subject: "Confirm", html: "<p>hi</p>" });
  } finally {
    globalThis.fetch = realFetch;
    setEnv(saved);
  }
  return sent;
}

// ── 1. The starter ────────────────────────────────────────────────────
console.log("\nstarter:");

await expect("the starter's newsletter already sends from_email on /api/tx", () => {
  assert.match(STARTER_NEWSLETTER, STARTER_FROM_LINE);
  assert.ok(
    STARTER_NEWSLETTER.includes(TX_FROM_PROPERTY),
    "the inserted line is the starter's line",
  );
  const result = upgradeListmonkTxFromEmail(STARTER_NEWSLETTER);
  assert.equal(result.outcome, "already");
  assert.equal(result.source, STARTER_NEWSLETTER);
});

// ── 2. The pre-fix shape ──────────────────────────────────────────────
console.log("\npre-fix newsletter/listmonk.ts:");

await expect("the pre-fix fixture is the starter minus its /api/tx sender", () => {
  assert.notEqual(PRE_FIX_NEWSLETTER, STARTER_NEWSLETTER);
  assert.ok(PRE_FIX_NEWSLETTER.includes(RECIPIENT_LINE));
});

await expect("from_email lands right after subscriber_email, same indent", () => {
  const result = upgradeListmonkTxFromEmail(PRE_FIX_NEWSLETTER);
  assert.equal(result.outcome, "patched");
  const lines = result.source.split("\n");
  const recipient = lines.indexOf(RECIPIENT_LINE);
  assert.notEqual(recipient, -1);
  assert.ok(lines[recipient + 1]?.startsWith("      // "), "the why-comment follows the recipient");
  assert.equal(lines[recipient + 3], `      ${TX_FROM_PROPERTY}`);
  assert.equal(lines.length, PRE_FIX_NEWSLETTER.split("\n").length + 3);
  assert.doesNotMatch(result.source, /subscriber_mode/);
});

await expect("the patched sender puts LISTMONK_FROM on the wire, in default mode", async () => {
  const patched = upgradeListmonkTxFromEmail(PRE_FIX_NEWSLETTER).source;
  const sent = await sendThrough(patched, { LISTMONK_FROM: "Starter <noreply@mail.example.com>" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.url, "https://listmonk.test/api/tx");
  assert.equal(sent[0]?.body.from_email, "Starter <noreply@mail.example.com>");
  assert.equal(sent[0]?.body.subscriber_email, "new@example.com");
  assert.equal(sent[0]?.body.template_id, 5);
  assert.equal("subscriber_mode" in (sent[0]?.body ?? {}), false);
});

await expect("the patched sender falls back to LISTMONK_FROM_EMAIL", async () => {
  const patched = upgradeListmonkTxFromEmail(PRE_FIX_NEWSLETTER).source;
  const sent = await sendThrough(patched, { LISTMONK_FROM_EMAIL: "noreply@mail.example.org" });
  assert.equal(sent[0]?.body.from_email, "noreply@mail.example.org");
});

await expect("the unpatched sender is what the retrofit fixes", async () => {
  const sent = await sendThrough(PRE_FIX_NEWSLETTER, {
    LISTMONK_FROM: "Starter <noreply@mail.example.com>",
  });
  assert.equal("from_email" in (sent[0]?.body ?? {}), false);
});

await expect("a sender somebody already chose is left alone", () => {
  const chosen = PRE_FIX_NEWSLETTER.replace(
    RECIPIENT_LINE,
    `${RECIPIENT_LINE}\n      from_email: "Newsletter <news@example.com>",`,
  );
  const result = upgradeListmonkTxFromEmail(chosen);
  assert.equal(result.outcome, "already");
  assert.equal(result.source, chosen);
});

await expect("a body with no recipient line is reported, not forced", () => {
  const dir = makeProject({
    [NEWSLETTER_LISTMONK_REL_PATH]: PRE_FIX_NEWSLETTER.replace(
      RECIPIENT_LINE,
      "      ...recipient(params.to),",
    ),
  });
  const before = readFileSync(join(dir, NEWSLETTER_LISTMONK_REL_PATH), "utf-8");
  const ledger = new FeatureLedger(dir, false);
  const result = retrofitListmonkTxFrom(ledger);
  assert.equal(result.outcome, "no-anchor");
  assert.equal(result.action, "conflict");
  assert.deepEqual(
    ledger.conflicts().map((entry) => entry.file),
    [NEWSLETTER_LISTMONK_REL_PATH],
  );
  assert.equal(readFileSync(join(dir, NEWSLETTER_LISTMONK_REL_PATH), "utf-8"), before);
});

// ── 3. Idempotence ────────────────────────────────────────────────────
console.log("\nidempotence:");

await expect("the transform is a fixed point", () => {
  const once = upgradeListmonkTxFromEmail(PRE_FIX_NEWSLETTER).source;
  const twice = upgradeListmonkTxFromEmail(once);
  assert.equal(twice.outcome, "already");
  assert.equal(twice.source, once);
});

await expect("a dry run reports the patch and writes nothing", () => {
  const dir = makeProject({ [NEWSLETTER_LISTMONK_REL_PATH]: PRE_FIX_NEWSLETTER });
  const result = retrofitListmonkTxFrom(new FeatureLedger(dir, true));
  assert.equal(result.outcome, "patched");
  assert.equal(result.action, "would-write");
  assert.equal(readFileSync(join(dir, NEWSLETTER_LISTMONK_REL_PATH), "utf-8"), PRE_FIX_NEWSLETTER);
});

await expect("a second update writes nothing", () => {
  const dir = makeProject({ [NEWSLETTER_LISTMONK_REL_PATH]: PRE_FIX_NEWSLETTER });
  const first = retrofitListmonkTxFrom(new FeatureLedger(dir, false));
  assert.equal(first.action, "written");
  const second = new FeatureLedger(dir, false);
  const again = retrofitListmonkTxFrom(second);
  assert.equal(again.outcome, "already");
  assert.equal(again.action, "unchanged");
  assert.deepEqual(second.summary().written, []);
});

// ── 4. Scope ──────────────────────────────────────────────────────────
console.log("\nscope:");

await expect("the campaign body's from_email does not count as the /api/tx one", () => {
  // Both files carry the campaign sender; only the starter carries the tx one.
  assert.match(PRE_FIX_NEWSLETTER, /^\s*from_email: fromEmail,$/m);
  assert.equal(upgradeListmonkTxFromEmail(PRE_FIX_NEWSLETTER).outcome, "patched");
});

await expect("a client with no /api/tx call has nothing to patch", () => {
  const noTx = [
    "/** Transactional sends go through `POST /api/tx` elsewhere. */",
    "export async function sendCampaign(fromEmail: string) {",
    '  await listmonkFetch("/api/campaigns", {',
    '    method: "POST",',
    "    body: JSON.stringify({",
    '      name: "digest",',
    "    }),",
    "  });",
    "}",
    "",
  ].join("\n");
  const dir = makeProject({ [NEWSLETTER_LISTMONK_REL_PATH]: noTx });
  const result = retrofitListmonkTxFrom(new FeatureLedger(dir, false));
  assert.equal(result.outcome, "no-tx");
  assert.equal(result.action, "unchanged");
  assert.equal(readFileSync(join(dir, NEWSLETTER_LISTMONK_REL_PATH), "utf-8"), noTx);
});

await expect("a project without the newsletter is absent, not an error", () => {
  const dir = makeProject({});
  const ledger = new FeatureLedger(dir, false);
  const result = retrofitListmonkTxFrom(ledger);
  assert.equal(result.outcome, "absent");
  assert.equal(ledger.touched, false);
});

// ── Result ────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("\nAll Listmonk tx-from tests passed.\n");
