/**
 * listmonk-ses orchestrator: pure-output unit tests.
 *
 * Real `provisionListmonkSesForProject` reaches out to SES + Listmonk
 * + Cloudflare — covered by a manual end-to-end test, not this file.
 * What we lock down here are the deterministic outputs the orchestrator
 * produces from a fixed input:
 *
 *   1. `sesSendingSubdomain(domain)` — picks `mail.<domain>`. The
 *      subdomain is encoded in the env's SES_FROM_EMAIL, the DKIM
 *      records' parent, and the destroy-time identity name; drifting it
 *      silently breaks email send + leaves orphan SES identities.
 *
 *   2. `renderListmonkSesEnv` — the prod/dev env quartets. The only
 *      list difference is that prod carries the live list id as
 *      `LISTMONK_LIVE_LIST_ID` and dev does not carry it at all, which
 *      keeps a bug in dev from broadcasting to real subscribers. The
 *      name must match the starter: its docker-compose.yml passes only
 *      the names it lists into the server container, so a key it does
 *      not name reaches nothing in production. Everything else (SMTP
 *      host, username/password, region, from-email, API user/token,
 *      the test list id) is identical across surfaces.
 *
 *   3. `singleOptinLists` / `singleOptinHint` — the drift report for
 *      adopted lists that are still single opt-in. The hint's order is
 *      load-bearing: switching the list before the app stops adding
 *      `unconfirmed` members makes Listmonk send a second opt-in email.
 *
 *   4. The seeded tx template body and its repair. Listmonk parses a tx
 *      body with Go `html/template`, so a bare `{{ .Tx.Data.body }}`
 *      HTML-escapes the app's HTML and the email arrives as visible
 *      markup. The body must pipe through `Safe` (the helper Listmonk
 *      registers; `safeHTML` is not registered and fails to compile).
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_TX_TEMPLATE_BODY,
  escapedTxTemplateHint,
  renderListmonkSesEnv,
  repairEscapedTxTemplate,
  repairTxTemplateBody,
  sesSendingSubdomain,
  singleOptinHint,
  singleOptinLists,
  txBodyRendersEscaped,
} from "./src/provision/listmonk-ses.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const failures: string[] = [];

function expect(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}: ${(err as Error).message}`);
    console.log(`  ✗ ${label}`);
  }
}

console.log("sesSendingSubdomain:");

expect("prefixes 'mail.' to the project domain", () => {
  assert.equal(sesSendingSubdomain("playtiao.com"), "mail.playtiao.com");
});

expect("nested subdomains stack: mail.app.example.com from app.example.com", () => {
  assert.equal(sesSendingSubdomain("app.example.com"), "mail.app.example.com");
});

console.log("\nrenderListmonkSesEnv:");

const baseInput = {
  listmonkUrl: "https://newsletter.example.com",
  listmonkApiUser: "hatchkit",
  listmonkApiToken: "tok-abc",
  liveListId: 11,
  testListId: 22,
  txTemplateId: 33,
  campaignTemplateId: 44,
  listmonkFrom: "Playtiao <noreply@mail.playtiao.com>",
  smtpHost: "email-smtp.eu-west-1.amazonaws.com",
  smtpPort: 587,
  smtpUsername: "AKIAEXAMPLE",
  smtpPassword: "smtp-derived-secret",
  fromEmail: "noreply@mail.playtiao.com",
  region: "eu-west-1",
};

expect("prod env carries the LIVE list id as LISTMONK_LIVE_LIST_ID", () => {
  const env = renderListmonkSesEnv(baseInput);
  assert.ok(env.prod.includes("LISTMONK_LIVE_LIST_ID=11"));
});

expect("dev env carries no live list id (safe rehearsal)", () => {
  const env = renderListmonkSesEnv(baseInput);
  assert.ok(!env.dev.some((l) => l.startsWith("LISTMONK_LIVE_LIST_ID=")));
  assert.ok(!env.dev.some((l) => /_LIST_ID=11$/.test(l)), "live id 11 leaked into dev");
});

expect("neither surface writes the retired LISTMONK_LIST_ID name", () => {
  const env = renderListmonkSesEnv(baseInput);
  for (const lines of [env.prod, env.dev]) {
    assert.ok(!lines.some((l) => l.startsWith("LISTMONK_LIST_ID=")));
  }
});

expect("values other than the live list id are identical across prod and dev", () => {
  const env = renderListmonkSesEnv(baseInput);
  const filter = (lines: string[]) => lines.filter((l) => !l.startsWith("LISTMONK_LIVE_LIST_ID="));
  assert.deepEqual(filter(env.prod), filter(env.dev));
});

expect("every LISTMONK_* key in the prod env reaches the starter's server container", () => {
  const compose = readFileSync(join(HERE, "..", "starter", "docker-compose.yml"), "utf-8");
  const passed = new Set([...compose.matchAll(/^\s+(LISTMONK_[A-Z_]+):\s*\$\{\1[:}-]/gm)].map((m) => m[1]));
  const env = renderListmonkSesEnv(baseInput);
  for (const line of env.prod) {
    const key = line.slice(0, line.indexOf("="));
    if (key.startsWith("LISTMONK_")) {
      assert.ok(passed.has(key), `starter/docker-compose.yml never passes ${key} to the server`);
    }
  }
});

expect("emits every required key the runtime needs", () => {
  const env = renderListmonkSesEnv(baseInput);
  const required = [
    "LISTMONK_URL=",
    "LISTMONK_API_USER=",
    "LISTMONK_API_TOKEN=",
    "LISTMONK_TEST_LIST_ID=",
    "LISTMONK_TX_TEMPLATE_ID=",
    "LISTMONK_CAMPAIGN_TEMPLATE_ID=",
    "LISTMONK_FROM=",
    "SES_SMTP_HOST=",
    "SES_SMTP_PORT=",
    "SES_SMTP_USERNAME=",
    "SES_SMTP_PASSWORD=",
    "SES_FROM_EMAIL=",
    "SES_REGION=",
  ];
  for (const prefix of required) {
    assert.ok(
      env.prod.some((l) => l.startsWith(prefix)),
      `missing key ${prefix} in prod env`,
    );
    assert.ok(
      env.dev.some((l) => l.startsWith(prefix)),
      `missing key ${prefix} in dev env`,
    );
  }
});

expect("LISTMONK_TEST_LIST_ID stays pinned to the test list in BOTH surfaces", () => {
  const env = renderListmonkSesEnv(baseInput);
  assert.ok(env.prod.includes("LISTMONK_TEST_LIST_ID=22"));
  assert.ok(env.dev.includes("LISTMONK_TEST_LIST_ID=22"));
});

expect("template ids + LISTMONK_FROM are identical across prod and dev", () => {
  const env = renderListmonkSesEnv(baseInput);
  for (const line of [
    "LISTMONK_TX_TEMPLATE_ID=33",
    "LISTMONK_CAMPAIGN_TEMPLATE_ID=44",
    "LISTMONK_FROM=Playtiao <noreply@mail.playtiao.com>",
  ]) {
    assert.ok(env.prod.includes(line), `prod missing ${line}`);
    assert.ok(env.dev.includes(line), `dev missing ${line}`);
  }
});

expect("testRecipient lands in dev env ONLY (smoke scripts target dev only)", () => {
  const env = renderListmonkSesEnv({ ...baseInput, testRecipient: "rico@example.com" });
  assert.ok(env.dev.includes("LISTMONK_TEST_RECIPIENT=rico@example.com"));
  assert.ok(!env.prod.some((l) => l.startsWith("LISTMONK_TEST_RECIPIENT=")));
});

expect("omitted testRecipient leaves both surfaces without the key", () => {
  const env = renderListmonkSesEnv(baseInput);
  assert.ok(!env.dev.some((l) => l.startsWith("LISTMONK_TEST_RECIPIENT=")));
  assert.ok(!env.prod.some((l) => l.startsWith("LISTMONK_TEST_RECIPIENT=")));
});

console.log("\nsingleOptinLists / singleOptinHint:");

const live = { id: 5, name: "mood-magic", type: "private" as const, optin: "single" as const };
const test = { id: 6, name: "mood-magic-test", type: "private" as const, optin: "double" as const };

expect("reports only the lists that are not double opt-in", () => {
  assert.deepEqual(singleOptinLists([live, test]), [live]);
  assert.deepEqual(singleOptinLists([test]), []);
});

expect("hint names each list by id, and deploys the code before the switch", () => {
  const hint = singleOptinHint([live]).join("\n");
  assert.ok(hint.includes("mood-magic (id 5)"));
  const deploy = hint.indexOf("1. Deploy");
  const flip = hint.indexOf("2. Then Listmonk");
  assert.ok(deploy >= 0 && flip > deploy, "deploy step must come first");
});

console.log("\ntx template body:");

expect("the seeded body pipes .Tx.Data.body through Safe", () => {
  assert.ok(DEFAULT_TX_TEMPLATE_BODY.includes("{{ .Tx.Data.body | Safe }}"));
  assert.ok(!txBodyRendersEscaped(DEFAULT_TX_TEMPLATE_BODY));
});

expect("the seeded body never uses safeHTML (not registered for tx templates)", () => {
  assert.ok(!DEFAULT_TX_TEMPLATE_BODY.includes("safeHTML"));
});

// The body tracktime-tx, streaks-tx and chemistry-sketcher-tx were
// seeded with.
const escapedBody = `<!doctype html>
<html>
  <body>
    {{ .Tx.Data.body }}
  </body>
</html>
`;

expect("flags the bare body hatchkit used to seed", () => {
  assert.ok(txBodyRendersEscaped(escapedBody));
});

expect("repair pipes the bare body through Safe and keeps everything else", () => {
  assert.equal(repairTxTemplateBody(escapedBody), DEFAULT_TX_TEMPLATE_BODY);
});

expect("repair is idempotent", () => {
  const once = repairTxTemplateBody(escapedBody);
  assert.equal(repairTxTemplateBody(once), once);
});

expect("repair keeps trim markers and spacing", () => {
  assert.equal(repairTxTemplateBody("{{- .Tx.Data.body -}}"), "{{- .Tx.Data.body | Safe -}}");
  assert.equal(repairTxTemplateBody("{{.Tx.Data.body}}"), "{{.Tx.Data.body | Safe}}");
});

expect("repair fixes every bare occurrence", () => {
  const body = "{{ .Tx.Data.body }}<hr>{{ .Tx.Data.body }}";
  assert.equal(
    repairTxTemplateBody(body),
    "{{ .Tx.Data.body | Safe }}<hr>{{ .Tx.Data.body | Safe }}",
  );
});

expect("a hand-made template that already uses Safe is left alone", () => {
  const body = "<div>{{ .Tx.Data.body | Safe }}</div><p>{{ .Tx.Data.footer }}</p>";
  assert.ok(!txBodyRendersEscaped(body));
  assert.equal(repairTxTemplateBody(body), body);
});

expect("other .Tx.Data fields are not touched", () => {
  const body = "{{ .Tx.Data.bodyText }} {{ .Tx.Data.subject }}";
  assert.equal(repairTxTemplateBody(body), body);
});

expect("hint names the template by id and gives both fixes", () => {
  const hint = escapedTxTemplateHint({ id: 7, name: "tracktime-tx", type: "tx" }).join("\n");
  assert.ok(hint.includes("tracktime-tx (id 7)"));
  assert.ok(hint.includes("hatchkit doctor --fix"));
  assert.ok(hint.includes("{{ .Tx.Data.body | Safe }}"));
});

console.log("\nrepairEscapedTxTemplate:");

const auth = { url: "https://listmonk.test", apiUser: "hatchkit", apiToken: "tok" };
const realFetch = globalThis.fetch;

/** Stub fetch: GET returns `template`, PUT echoes its body back. */
function stubTemplateFetch(template: Record<string, unknown>) {
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, path: new URL(String(input)).pathname, body });
    const data = method === "PUT" ? { ...template, ...body } : template;
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof fetch;
  return calls;
}

async function expectAsync(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}: ${(err as Error).message}`);
    console.log(`  ✗ ${label}`);
  } finally {
    globalThis.fetch = realFetch;
  }
}

const liveTemplate = {
  id: 9,
  name: "streaks-tx",
  type: "tx",
  subject: "{{ .Tx.Data.subject }}",
  body: escapedBody,
};

await expectAsync("reads the template fresh, then PUTs the repaired body", async () => {
  const calls = stubTemplateFetch(liveTemplate);
  assert.equal(await repairEscapedTxTemplate(9, auth), "repaired");
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    ["GET /api/templates/9", "PUT /api/templates/9"],
  );
  assert.deepEqual(calls[1].body, {
    name: "streaks-tx",
    type: "tx",
    subject: "{{ .Tx.Data.subject }}",
    body: DEFAULT_TX_TEMPLATE_BODY,
  });
});

await expectAsync("does not write a template that is already safe", async () => {
  const calls = stubTemplateFetch({ ...liveTemplate, body: DEFAULT_TX_TEMPLATE_BODY });
  assert.equal(await repairEscapedTxTemplate(9, auth), "already-safe");
  assert.deepEqual(
    calls.map((c) => c.method),
    ["GET"],
  );
});

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nAll listmonk-ses orchestrator tests passed.");
