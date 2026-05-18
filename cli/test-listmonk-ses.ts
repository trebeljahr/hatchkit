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
 *      difference between prod and dev is which list id lands in
 *      `LISTMONK_LIST_ID` (live for prod, test for dev — same pattern
 *      Resend's audience split uses). Everything else (SMTP host,
 *      username/password, region, from-email, API user/token) is
 *      identical across surfaces.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import {
  renderListmonkSesEnv,
  sesSendingSubdomain,
} from "./src/provision/listmonk-ses.js";

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

expect("prod env routes broadcasts to the LIVE list id", () => {
  const env = renderListmonkSesEnv(baseInput);
  assert.ok(env.prod.includes("LISTMONK_LIST_ID=11"));
  assert.ok(!env.prod.includes("LISTMONK_LIST_ID=22"));
});

expect("dev env routes broadcasts to the TEST list id (safe rehearsal)", () => {
  const env = renderListmonkSesEnv(baseInput);
  assert.ok(env.dev.includes("LISTMONK_LIST_ID=22"));
  assert.ok(!env.dev.includes("LISTMONK_LIST_ID=11"));
});

expect("non-list values are identical across prod and dev", () => {
  const env = renderListmonkSesEnv(baseInput);
  const filter = (lines: string[]) => lines.filter((l) => !l.startsWith("LISTMONK_LIST_ID="));
  assert.deepEqual(filter(env.prod), filter(env.dev));
});

expect("emits every required key the runtime needs", () => {
  const env = renderListmonkSesEnv(baseInput);
  const required = [
    "LISTMONK_URL=",
    "LISTMONK_API_USER=",
    "LISTMONK_API_TOKEN=",
    "LISTMONK_LIST_ID=",
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

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nAll listmonk-ses orchestrator tests passed.");
