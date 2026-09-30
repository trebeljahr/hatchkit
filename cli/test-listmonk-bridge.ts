import assert from "node:assert/strict";
import { createHmac, createSign, generateKeyPairSync } from "node:crypto";
import {
  legacyDecision,
  ttl,
  verifyToken,
} from "./src/templates/listmonk-isolated/bridge/policy.mjs";
import { verifySns } from "./src/templates/listmonk-isolated/bridge/sns.mjs";
const now = Date.now();
const secret = "fixture-only-secret";
function token(email: string, issued = now) {
  const p = Buffer.from(JSON.stringify({ e: email, x: issued + ttl })).toString("base64url");
  return `${p}.${createHmac("sha256", secret).update(p).digest("base64url")}`;
}
assert.equal(verifyToken(token("reader@example.com"), secret, now).email, "reader@example.com");
for (const bad of [
  token("reader@example.com", now - ttl - 1),
  token("reader@example.com", now + 100),
  token("FOREIGN@example.com"),
  "broken",
  token("reader@example.com") + "x",
])
  assert.throws(() => verifyToken(bad, secret, now));
const snapshot = {
  subscriber: { uuid: "source", email: "reader@example.com", status: "enabled" },
  memberships: [
    { list_id: 3, status: "unsubscribed", updated_at: new Date(now - 1000).toISOString() },
  ],
  events: [] as { kind: string }[],
};
assert.equal(legacyDecision(snapshot, null, {}, now, 3).unsubscribed.length, 0);
assert.equal(legacyDecision(snapshot, null, {}, now, 4).unsubscribed.length, 1);
assert.equal(
  legacyDecision(snapshot, null, { consents: { 4: new Date(now).toISOString() } }).unsubscribed
    .length,
  1,
);
assert.equal(
  legacyDecision(
    { ...snapshot, subscriber: null },
    { source_uuid: "source", email: "reader@example.com" },
    {},
  ).deleted,
  true,
);
assert.equal(
  legacyDecision({ ...snapshot, events: [{ kind: "deleted" }] }, null, {}, now, 3).blocked,
  true,
);
assert.equal(
  legacyDecision({ ...snapshot, events: [{ kind: "blocklisted" }] }, null, {}, now, 3).blocked,
  true,
);
assert.equal(
  legacyDecision(
    { ...snapshot, memberships: [{ list_id: 3, status: "unsubscribed", updated_at: null }] },
    null,
    {},
    now,
    3,
  ).unsubscribed.length,
  1,
);
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const topic = "arn:aws:sns:eu-west-1:123456789012:project-feedback";
const envelope: Record<string, string> = {
  Type: "Notification",
  Message: '{"eventType":"Complaint"}',
  MessageId: "fixture-message",
  Timestamp: new Date(now).toISOString(),
  TopicArn: topic,
  SignatureVersion: "2",
  SigningCertURL: "https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-fixture.pem",
};
const canonical = ["Message", "MessageId", "Timestamp", "TopicArn", "Type"]
  .map((k) => `${k}\n${envelope[k]}\n`)
  .join("");
envelope.Signature = createSign("RSA-SHA256").update(canonical).sign(privateKey, "base64");
let requests = 0;
const cert = async () => {
  requests++;
  return new Response(publicKey.export({ type: "spki", format: "pem" }));
};
await verifySns(envelope, topic, "eu-west-1", cert);
for (const patch of [
  { TopicArn: "foreign" },
  { Message: "changed" },
  { SigningCertURL: "http://169.254.169.254/key.pem" },
  {
    SigningCertURL:
      "https://sns.eu-west-1.amazonaws.com.evil.example/SimpleNotificationService-fixture.pem",
  },
])
  await assert.rejects(verifySns({ ...envelope, ...patch }, topic, "eu-west-1", cert));
assert.equal(requests, 2);
console.log(
  "PASS: legacy token verification, per-list consent, retained suppression/deletion, signed SNS validation and foreign certificate/topic refusal. SQL/send races require the Docker rehearsal.",
);

// Exercise public routing and authentication with a signed synthetic SNS envelope.
const { createServer } = await import("node:http");
const { bridgeHandler } = await import("./src/templates/listmonk-isolated/bridge/http.mjs");
const nativeFetch = globalThis.fetch;
let prepares = 0;
let feedbacks = 0;
const appPassword = "fixture-app-password-longer-than-32-characters";
const event = {
  eventType: "Complaint",
  mail: {
    source: "noreply@mail.example.com",
    sendingAccountId: "123456789012",
    tags: { "ses:configuration-set": ["fixture-set"] },
  },
};
const signed: Record<string, string> = { ...envelope, Message: JSON.stringify(event) };
signed.Signature = createSign("RSA-SHA256")
  .update(
    ["Message", "MessageId", "Timestamp", "TopicArn", "Type"]
      .map((k) => `${k}\n${signed[k]}\n`)
      .join(""),
  )
  .sign(privateKey, "base64");
const server = createServer(
  bridgeHandler(
    {
      appUser: "project-app",
      appPassword,
      topic,
      region: "eu-west-1",
      from: "noreply@mail.example.com",
      account: "123456789012",
      configurationSet: "fixture-set",
    },
    {
      prepare: async () => {
        prepares++;
      },
      feedback: async () => {
        feedbacks++;
      },
      health: async () => {},
    },
    () => {
      throw Error("Unexpected relay request");
    },
  ),
);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}`;
globalThis.fetch = cert as typeof fetch;
try {
  const post = (path: string, body: unknown, auth?: string) =>
    nativeFetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
      body: JSON.stringify(body),
    });
  assert.equal((await post("/prepare", { token: "x", role: "live" })).status, 401);
  assert.equal(prepares, 0);
  assert.equal(
    (
      await post(
        "/prepare",
        { token: "x", role: "live" },
        `Basic ${Buffer.from(`project-app:${appPassword}`).toString("base64")}`,
      )
    ).status,
    200,
  );
  assert.equal(prepares, 1);
  assert.equal((await post("/feedback", signed)).status, 200);
  assert.equal(feedbacks, 1);
  assert.equal((await post("/feedback", { ...signed, Message: "tampered" })).status, 503);
  assert.equal(feedbacks, 1);
  assert.equal((await post("/feedback", { ...signed, TopicArn: "foreign" })).status, 503);
  assert.equal(feedbacks, 1);
} finally {
  globalThis.fetch = nativeFetch;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
}
console.log(
  "PASS: public bridge routes require app authentication or a valid pinned SNS signature; tampered feedback never reaches reconciliation.",
);
