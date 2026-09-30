import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runListmonkIsolationPlan } from "./src/provision/listmonk-isolation-plan.js";
// The deployed relay is plain JavaScript, tested here without loading its AWS SDK entrypoint.
const { relayConfig, messageForProject, authenticated, createRelayHandler } = await import(
  "./src/templates/listmonk-isolated/relay/message.mjs"
);
const config = relayConfig({
  SES_PROJECT_REGION: "eu-west-1",
  SES_PROJECT_IDENTITY_ARN: "arn:aws:ses:eu-west-1:123456789012:identity/mail.sample.example.com",
  SES_PROJECT_TENANT: "sample-tenant",
  SES_PROJECT_CONFIGURATION_SET: "sample-config",
  SES_PROJECT_FROM_EMAIL: "noreply@mail.sample.example.com",
  SES_PROJECT_ACCESS_KEY_ID: "fixture-key",
  SES_PROJECT_SECRET_ACCESS_KEY: "fixture-secret",
  RELAY_USER: "sample",
  RELAY_PASSWORD: "p".repeat(32),
  LISTMONK_PUBLIC_URL: "https://news.sample.example.com",
  EMAIL_TEST_RECIPIENT: "test@example.com",
});
const auth = `Basic ${Buffer.from(`sample:${"p".repeat(32)}`).toString("base64")}`;
const subUuid = "11111111-1111-4111-8111-111111111111";
const campaignUuid = "22222222-2222-4222-8222-222222222222";
const payload = {
  from_email: config.from,
  subject: "A newsletter",
  body: "<p>hello</p>",
  content_type: "html",
  recipients: [{ email: "test@example.com", status: "enabled", uuid: subUuid }],
  campaign: { from_email: config.from, uuid: campaignUuid, headers: [] },
};
const message = messageForProject(payload, config);
assert.equal(message.TenantName, config.tenant);
assert.equal(
  message.Content.Simple.Headers[0].Value,
  `<${config.publicUrl}/subscription/${campaignUuid}/${subUuid}>`,
);
assert(authenticated(auth, config));
assert(!authenticated("Basic foreign", config));
assert(
  !authenticated(auth, {
    ...config,
    password: "other-project-secret".repeat(2),
  }),
);
for (const hostile of [
  { ...payload, from_email: "noreply@mail.foreign.example.com" },
  { ...payload, recipients: [...payload.recipients, ...payload.recipients] },
  {
    ...payload,
    recipients: [{ ...payload.recipients[0], email: "someone-else@example.com" }],
  },
  {
    ...payload,
    recipients: [{ ...payload.recipients[0], status: "blocklisted" }],
  },
  { ...payload, subject: "subject\r\nBcc: foreign@example.com" },
  { ...payload, attachments: [{ content: "abc" }] },
  {
    ...payload,
    campaign: {
      ...payload.campaign,
      headers: [{ From: "foreign@example.com" }],
    },
  },
  { ...payload, campaign: { ...payload.campaign, uuid: "../../foreign" } },
])
  assert.throws(() => messageForProject(hostile, config));
// External account mail has no stored subscriber status or UUID in Listmonk v6.2.
assert(
  messageForProject(
    {
      ...payload,
      campaign: null,
      recipients: [{ email: "test@example.com", status: "" }],
    },
    config,
  ),
);
const override = messageForProject(
  {
    ...payload,
    TenantName: "foreign",
    credentials: { accessKeyId: "foreign" },
  },
  config,
);
assert.equal(override.TenantName, config.tenant);
let sends = 0;
const server = createServer(
  createRelayHandler(config, async () => {
    sends++;
  }),
);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/send`;
  const request = (data: unknown, authorization = auth) =>
    fetch(url, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });
  assert.equal((await request(payload, "Basic wrong-project")).status, 401);
  assert.equal((await request({ ...payload, from_email: "foreign@example.com" })).status, 400);
  assert.equal(sends, 0);
  assert.equal((await request(payload)).status, 200);
  assert.equal(sends, 1);
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
const dir = mkdtempSync(join(tmpdir(), "listmonk-isolated-"));
const log = console.log;
console.log = () => {};
try {
  writeFileSync(
    join(dir, ".hatchkit.json"),
    JSON.stringify({
      version: 5,
      name: "sample",
      domain: "sample.example.com",
    }),
  );
  const output = join(dir, "staging");
  const args = [
    dir,
    "--account",
    "123456789012",
    "--region",
    "eu-west-1",
    "--url",
    "https://news.sample.example.com",
    "--output",
    output,
  ];
  await runListmonkIsolationPlan([...args, "--dry-run"]);
  assert(!existsSync(output));
  await runListmonkIsolationPlan(args);
  const compose = readFileSync(join(output, "compose.yml"), "utf8");
  assert(!compose.includes("__PROJECT"));
  assert(compose.includes("internal: true"));
  assert(compose.includes("arn:aws:ses:eu-west-1:123456789012:identity/mail.sample.example.com"));
  assert(existsSync(join(output, "relay/package-lock.json")));
  assert(existsSync(join(output, "MIGRATION.md")));
  assert(existsSync(join(output, "export-memberships.sql")));
  assert(existsSync(join(output, "prepare-transfer.mjs")));
  assert(existsSync(join(output, "transfer-review.example.json")));
  assert(!existsSync(join(output, "secrets")));
  await assert.rejects(runListmonkIsolationPlan(args), /already exists/);
  assert.equal(
    JSON.parse(readFileSync(join(output, "plan.json"), "utf8")).status,
    "staging-only; not deployed or verified",
  );
} finally {
  console.log = log;
  rmSync(dir, { recursive: true, force: true });
}
console.log(
  "Listmonk isolation: dedicated staging bundle, no overwrite, relay A/B auth and sender checks pass",
);
