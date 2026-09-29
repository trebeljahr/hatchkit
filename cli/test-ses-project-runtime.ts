/** Pure runtime tests: no env loader, SDK client, network or keychain. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ProjectSesConfig,
  projectSesMessage,
  sendProjectSesEmail,
} from "../starter/packages/server/src/services/ses-email.js";
const source: ProjectSesConfig = {
  SES_PROJECT_ACCESS_KEY_ID: "mock-id",
  SES_PROJECT_SECRET_ACCESS_KEY: "mock-secret",
  SES_PROJECT_REGION: "eu-west-1",
  SES_PROJECT_IDENTITY_ARN: "arn:aws:ses:eu-west-1:123456789012:identity/mail.example.com",
  SES_PROJECT_TENANT: "project-a",
  SES_PROJECT_CONFIGURATION_SET: "project-a",
  SES_PROJECT_FROM_EMAIL: "noreply@mail.example.com",
  EMAIL_TEST_RECIPIENT: "dev@example.com",
  isProduction: false,
  isTest: true,
};
const email = {
  to: "dev@example.com",
  subject: "Verify account",
  text: "Plain body",
  html: "<p>Confirm</p>",
};
const message = projectSesMessage(email, source);
assert.equal(message.TenantName, source.SES_PROJECT_TENANT);
assert.equal(message.FromEmailAddressIdentityArn, source.SES_PROJECT_IDENTITY_ARN);
assert.deepEqual(message.Destination.ToAddresses, [email.to]);
assert.equal(message.Content.Simple.Body.Text.Data, "Plain body");
assert.equal(message.Content.Simple.Body.Html?.Data, "<p>Confirm</p>");
assert.throws(
  () => projectSesMessage({ ...email, to: "real@example.com" }, source),
  /Non-production/,
);
assert.throws(
  () => projectSesMessage(email, { ...source, EMAIL_TEST_RECIPIENT: "" }),
  /Non-production/,
);
for (const key of [
  "SES_PROJECT_ACCESS_KEY_ID",
  "SES_PROJECT_SECRET_ACCESS_KEY",
  "SES_PROJECT_IDENTITY_ARN",
  "SES_PROJECT_TENANT",
  "SES_PROJECT_REGION",
  "SES_PROJECT_FROM_EMAIL",
  "SES_PROJECT_CONFIGURATION_SET",
])
  assert.throws(() => projectSesMessage(email, { ...source, [key]: "" }), /incomplete/);
assert.throws(
  () =>
    projectSesMessage(email, {
      ...source,
      SES_PROJECT_FROM_EMAIL: "noreply@mail.foreign.com",
    }),
  /do not agree/,
);
assert.throws(
  () => projectSesMessage(email, { ...source, SES_PROJECT_REGION: "us-east-1" }),
  /do not agree/,
);
assert.throws(
  () => projectSesMessage({ ...email, subject: "Hello\r\nFrom: foreign@example.com" }, source),
  /Invalid/,
);
const prod = projectSesMessage(
  { ...email, to: "account-without-newsletter@example.com" },
  { ...source, isProduction: true },
);
assert.equal(prod.Destination.ToAddresses[0], "account-without-newsletter@example.com");
// If test mode accidentally imports/uses the SDK, fake credentials would try a
// network request and this fails. The function returns before importing it.
await sendProjectSesEmail(email, source);
const root = join(import.meta.dirname, "..");
for (const path of [
  "starter/packages/server/src/auth/auth.ts",
  "cli/src/scaffold/postgres-overlay.ts",
]) {
  const auth = readFileSync(join(root, path), "utf8");
  assert(auth.includes("isEmailConfigured()"), path);
  assert(!auth.includes("!env.LISTMONK_URL || !env.LISTMONK_TX_TEMPLATE_ID"), path);
}
const newsletter = readFileSync(
  join(root, "starter/packages/server/src/services/newsletter/listmonk.ts"),
  "utf8",
);
assert(newsletter.includes('process.env.EMAIL_TRANSPORT === "ses"'));
assert(newsletter.includes("subscriber_email: params.to.toLowerCase()"));
assert(
  newsletter.includes("from_email: process.env.LISTMONK_FROM || process.env.LISTMONK_FROM_EMAIL"),
);
console.log(
  "✓ direct SES payload, fail-closed config, arbitrary account recipient, dev allowlist, no test send, both auth databases and newsletter compatibility",
);

// Exercise the actual transport dispatch against a fixture env, including the
// newsletter path. Any accidental shared-relay fallback fails this test.
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { pathToFileURL } = await import("node:url");
const fixture = mkdtempSync(join(tmpdir(), "ses-runtime-"));
const realFetch = globalThis.fetch;
const oldTransport = process.env.EMAIL_TRANSPORT;
try {
  mkdirSync(join(fixture, "config"));
  mkdirSync(join(fixture, "services/newsletter"), { recursive: true });
  writeFileSync(join(fixture, "package.json"), '{"type":"module"}');
  const config = { ...source, EMAIL_TRANSPORT: "ses", LISTMONK_URL: "https://never-contact.test", LISTMONK_API_USER: "shared", LISTMONK_API_TOKEN: "mock-shared", LISTMONK_TX_TEMPLATE_ID: "1", LISTMONK_FROM: "Foreign <foreign@b.example.com>" };
  writeFileSync(join(fixture, "config/env.ts"), `export const env = ${JSON.stringify(config)};`);
  for (const name of ["email", "ses-email"]) writeFileSync(join(fixture, `services/${name}.ts`), readFileSync(join(root, `starter/packages/server/src/services/${name}.ts`), "utf8"));
  writeFileSync(join(fixture, "services/newsletter/listmonk.ts"), newsletter);
  globalThis.fetch = async () => { throw new Error("Unexpected shared Listmonk/network request"); };
  const actual = await import(pathToFileURL(join(fixture, "services/email.ts")).href);
  await actual.sendEmail(email);
  const actualEnv = (await import(pathToFileURL(join(fixture, "config/env.ts")).href)).env;
  actualEnv.SES_PROJECT_SECRET_ACCESS_KEY = "";
  await assert.rejects(actual.sendEmail(email), /incomplete/);
  actualEnv.SES_PROJECT_SECRET_ACCESS_KEY = source.SES_PROJECT_SECRET_ACCESS_KEY;
  process.env.EMAIL_TRANSPORT = "ses";
  const actualNewsletter = await import(pathToFileURL(join(fixture, "services/newsletter/listmonk.ts")).href);
  await actualNewsletter.sendTransactional({ to: email.to, subject: email.subject, html: email.html });
  writeFileSync(join(fixture, "email-delivery.ts"), readFileSync(join(root, "cli/src/templates/auth-account-security/server/email-delivery.ts.tpl"), "utf8"));
  const authTransport = await import(pathToFileURL(join(fixture, "email-delivery.ts")).href);
  assert.equal(authTransport.selectEmailTransport({ ...config, SMTP_HOST: "never-contact.test" }), "ses");
  assert.equal(authTransport.isEmailDeliveryConfigured(), true);
} finally {
  globalThis.fetch = realFetch;
  if (oldTransport === undefined) delete process.env.EMAIL_TRANSPORT;
  else process.env.EMAIL_TRANSPORT = oldTransport;
  rmSync(fixture, { recursive: true, force: true });
}
console.log("✓ actual account/newsletter dispatch never falls back to shared Listmonk; account-security detection honors SES ahead of SMTP");
