/** Two real relay HTTP servers; fake SES only. This does not test Listmonk auth/DBs. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  createRelayHandler,
  relayConfig,
} from "./src/templates/listmonk-isolated/relay/message.mjs";

const make = (project: string) =>
  relayConfig({
    SES_PROJECT_REGION: "eu-west-1",
    SES_PROJECT_IDENTITY_ARN: `arn:aws:ses:eu-west-1:123456789012:identity/mail.${project}.example.com`,
    SES_PROJECT_TENANT: project,
    SES_PROJECT_REPLY_TO: `hi@${project}.example.com`,
    SES_PROJECT_CONFIGURATION_SET: project,
    SES_PROJECT_FROM_EMAIL: `noreply@mail.${project}.example.com`,
    SES_PROJECT_ACCESS_KEY_ID: `fixture-${project}`,
    SES_PROJECT_SECRET_ACCESS_KEY: `fixture-secret-${project}`,
    RELAY_USER: project,
    RELAY_PASSWORD: project.repeat(32),
    LISTMONK_PUBLIC_URL: `https://news.${project}.example.com`,
    EMAIL_TEST_RECIPIENT: "inbox@example.com",
  });
const configs = [make("alpha"), make("bravo")];
const sent: unknown[][] = [[], []];
const servers = configs.map((config, i) =>
  createServer(
    createRelayHandler(config, async (message: unknown) => {
      sent[i].push(message);
    }),
  ),
);
const auth = (i: number) =>
  `Basic ${Buffer.from(`${configs[i].user}:${configs[i].password}`).toString("base64")}`;
const subscriber = "11111111-1111-4111-8111-111111111111";
const campaign = "22222222-2222-4222-8222-222222222222";
const payload = (i: number) => ({
  from_email: configs[i].from,
  subject: "fixture",
  body: "<p>fixture</p>",
  content_type: "html",
  recipients: [{ email: "inbox@example.com", status: "enabled", uuid: subscriber }],
  campaign: { from_email: configs[i].from, uuid: campaign, headers: [] },
});
try {
  for (const server of servers)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const send = (destination: number, credentials: number, body: unknown) =>
    fetch(`http://127.0.0.1:${(servers[destination].address() as { port: number }).port}/send`, {
      method: "POST",
      headers: { authorization: auth(credentials), "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  for (const own of [0, 1]) {
    const foreign = 1 - own;
    assert.equal((await send(foreign, own, payload(foreign))).status, 401);
    assert.equal((await send(own, own, payload(foreign))).status, 400);
    assert.equal(
      (await send(own, own, { ...payload(own), campaign: payload(foreign).campaign })).status,
      400,
    );
    assert.equal(sent[own].length, 0);
    // Scope fields supplied by an attacker never select the SES tenant, key or recipient.
    assert.equal(
      (
        await send(own, own, {
          ...payload(own),
          TenantName: configs[foreign].tenant,
          ReplyToAddresses: ["foreign@example.com"],
          ConfigurationSetName: configs[foreign].configurationSet,
          FromEmailAddressIdentityArn: configs[foreign].identity,
          Destination: { ToAddresses: ["foreign@example.com"] },
          credentials: { accessKeyId: configs[foreign].accessKeyId },
        })
      ).status,
      200,
    );
    const result = sent[own][0] as {
      TenantName: string;
      ReplyToAddresses: string[];
      ConfigurationSetName: string;
      FromEmailAddressIdentityArn: string;
      FromEmailAddress: string;
      Destination: { ToAddresses: string[] };
      credentials?: unknown;
      Content: { Simple: { Headers: Array<{ Value: string }> } };
    };
    assert.equal(result.TenantName, configs[own].tenant);
    assert.equal(result.ConfigurationSetName, configs[own].configurationSet);
    assert.equal(result.FromEmailAddressIdentityArn, configs[own].identity);
    assert.equal(result.FromEmailAddress, configs[own].from);
    assert.deepEqual(result.Destination, { ToAddresses: ["inbox@example.com"] });
    assert.equal(result.credentials, undefined);
    assert.deepEqual(result.ReplyToAddresses, [configs[own].replyTo]);
    assert.equal(
      result.Content.Simple.Headers[0].Value,
      `<${configs[own].publicUrl}/subscription/${campaign}/${subscriber}>`,
    );
    assert.equal(
      (
        await send(own, own, {
          ...payload(own),
          recipients: [{ ...payload(own).recipients[0], status: "blocklisted" }],
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await send(own, own, {
          ...payload(own),
          recipients: [{ ...payload(own).recipients[0], email: "foreign@example.com" }],
        })
      ).status,
      400,
    );
    assert.equal(sent[own].length, 1);
  }
} finally {
  for (const server of servers) {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
console.log(
  "PASS: two relay servers reject foreign auth/senders; SES scope and staging recipient stay pinned. Listmonk/database enforcement remains a separate test.",
);
