/** Runs only inside the owned synthetic Docker rehearsal. Never load real env files. */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { ttl } from "/app/bridge/policy.mjs";
import { NewsletterBridge } from "/app/bridge/store.mjs";
const fixture = JSON.parse(readFileSync("/fixture.json", "utf8"));
const source = new pg.Pool({ connectionString: fixture.source, max: 3 });
const sourceAdmin = new pg.Pool({ connectionString: fixture.sourceAdmin, max: 3 });
const target = new pg.Pool({ connectionString: fixture.target, max: 4 });
const secret = "synthetic-confirmation-secret";
const bridge = new NewsletterBridge(source, target, fixture.scope, secret);
const token = (email, issued = Date.now()) => {
  const p = Buffer.from(JSON.stringify({ e: email, x: issued + ttl })).toString("base64url");
  return `${p}.${createHmac("sha256", secret).update(p).digest("base64url")}`;
};
const q = async (sql, args = []) => (await target.query(sql, args)).rows;
let release;
try {
  await bridge.verify();
  await sourceAdmin.query(
    `ALTER TABLE subscribers DISABLE TRIGGER ${bridge.scope.sourceSchema}_subscriber`,
  );
  await assert.rejects(bridge.prepare(token("reader21@example.com"), "live", true));
  await sourceAdmin.query(
    `ALTER TABLE subscribers ENABLE TRIGGER ${bridge.scope.sourceSchema}_subscriber`,
  );
  await target.query("ALTER TABLE subscribers DISABLE TRIGGER hk_bridge_subscriber");
  await assert.rejects(bridge.verify());
  await target.query("ALTER TABLE subscribers ENABLE TRIGGER hk_bridge_subscriber");
  await assert.rejects(source.query("SELECT * FROM public.subscribers"));
  await assert.rejects(bridge.prepare(token("reader23@example.com"), "live", true));
  const old = token("excluded-orphan@example.com", Date.now() - 10000);
  await bridge.prepare(old, "live");
  assert.equal(
    (
      await q(
        "SELECT count(*)::int AS n FROM subscriber_lists sl JOIN subscribers s ON s.id=sl.subscriber_id WHERE s.email='excluded-orphan@example.com'",
      )
    )[0].n,
    0,
  );
  await bridge.prepare(old, "live", true);
  assert.equal(
    (
      await q(
        "SELECT sl.status FROM subscriber_lists sl JOIN subscribers s ON s.id=sl.subscriber_id WHERE s.email='excluded-orphan@example.com' AND sl.list_id=13",
      )
    )[0].status,
    "confirmed",
  );
  await assert.rejects(
    bridge.prepare(token("absent-old@example.com", Date.now() - 10000), "live", true),
  );
  // Re-confirming live must not clear the test list's distinct unsubscribe.
  await bridge.prepare(token("reader21@example.com"), "live", true);
  assert.equal(
    (
      await q(
        "SELECT sl.status FROM subscriber_lists sl JOIN subscribers s ON s.id=sl.subscriber_id WHERE s.email='reader21@example.com' AND sl.list_id=14",
      )
    )[0].status,
    "unsubscribed",
  );
  // A native destination unsubscribe is retained even if an API later resets the membership.
  await target.query(
    "UPDATE subscriber_lists SET status='unsubscribed',updated_at=now() WHERE subscriber_id=(SELECT id FROM subscribers WHERE email='excluded-orphan@example.com')",
  );
  await target.query(
    "UPDATE subscriber_lists SET status='confirmed' WHERE subscriber_id=(SELECT id FROM subscribers WHERE email='excluded-orphan@example.com')",
  );
  await assert.rejects(bridge.prepare(old, "live", true));
  await new Promise((r) => setTimeout(r, 10));
  await bridge.prepare(token("excluded-orphan@example.com"), "live", true);
  // Force a native source unsubscribe to race an SES send. It cannot commit before receipt handling.
  await sourceAdmin.query(
    "INSERT INTO subscriber_lists(subscriber_id,list_id,status) VALUES(25,3,'confirmed')",
  );
  let entered;
  const started = new Promise((r) => {
    entered = r;
  });
  const resume = new Promise((r) => {
    release = r;
  });
  const email = "excluded-orphan@example.com";
  const message = { Destination: { ToAddresses: [email] } };
  const sending = bridge.deliver(message, { campaign: null }, async () => {
    entered();
    await resume;
    return { MessageId: "fixture-ses-receipt" };
  });
  await Promise.race([
    started,
    sending.then(() => {
      throw Error("Send ended before callback");
    }),
  ]);
  let unsubscribeDone = false;
  const unsubscribe = sourceAdmin
    .query(
      "UPDATE subscriber_lists SET status='unsubscribed',updated_at=now() WHERE subscriber_id=25 AND list_id=3",
    )
    .then(() => {
      unsubscribeDone = true;
    });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(unsubscribeDone, false);
  release();
  await sending;
  await unsubscribe;
  let calls = 0;
  await assert.rejects(
    bridge.deliver(message, { campaign: null }, async () => {
      calls++;
      return { MessageId: "must-not-send" };
    }),
  );
  assert.equal(calls, 0);
  await bridge.reconcile();
  assert.equal(
    (
      await q(
        "SELECT sl.status FROM subscriber_lists sl JOIN subscribers s ON s.id=sl.subscriber_id WHERE s.email=$1 AND sl.list_id=13",
        [email],
      )
    )[0].status,
    "unsubscribed",
  );
  const complaint = {
    eventType: "Complaint",
    mail: { messageId: "fixture-ses-receipt" },
    complaint: { complainedRecipients: [{ emailAddress: email }] },
  };
  await bridge.feedback({ MessageId: "sns-fixture" }, complaint, "fixture-digest");
  await bridge.feedback({ MessageId: "sns-fixture" }, complaint, "fixture-digest");
  assert.equal(
    (await q("SELECT status FROM subscribers WHERE email=$1", [email]))[0].status,
    "blocklisted",
  );
  await assert.rejects(
    bridge.feedback(
      { MessageId: "sns-foreign" },
      { ...complaint, mail: { messageId: "foreign" } },
      "other",
    ),
  );
  await assert.rejects(bridge.prepare(token(email), "live", true));
  // Ambiguous SES acceptance holds retries until an operator reviews the attempt.
  await bridge.prepare(token("ambiguous@example.com"), "live", true);
  let ambiguousCalls = 0;
  const ambiguousMessage = { Destination: { ToAddresses: ["ambiguous@example.com"] } };
  await assert.rejects(
    bridge.deliver(ambiguousMessage, { campaign: null }, async () => {
      ambiguousCalls++;
      throw Error("synthetic transport timeout");
    }),
  );
  await assert.rejects(
    bridge.deliver(ambiguousMessage, { campaign: null }, async () => {
      ambiguousCalls++;
      return { MessageId: "retry-must-not-send" };
    }),
  );
  assert.equal(ambiguousCalls, 1);
  // Source deletion survives retries and a fresh bridge process.
  await sourceAdmin.query(
    "INSERT INTO subscribers(id,uuid,email,name,status) VALUES(36,gen_random_uuid(),'delete@example.com','fixture','enabled')",
  );
  await bridge.prepare(token("delete@example.com"), "live", true);
  await sourceAdmin.query("DELETE FROM subscribers WHERE id=36");
  await new NewsletterBridge(source, target, fixture.scope, secret).reconcile();
  await assert.rejects(bridge.prepare(token("delete@example.com"), "live", true));
  assert.equal(
    (
      await q(
        "SELECT deleted FROM hatchkit_newsletter_bridge.evidence WHERE email='delete@example.com'",
      )
    )[0].deleted,
    true,
  );
  await bridge.prepare(token("rename@example.com"), "live", true);
  await target.query(
    "UPDATE subscribers SET email='renamed@example.com' WHERE email='rename@example.com'",
  );
  await assert.rejects(bridge.prepare(token("renamed@example.com"), "live", true));
  console.log(
    "PASS: real PostgreSQL legacy orphan confirmation, per-list consent, native unsubscribe serialization, durable deletion, restricted source role, duplicate/foreign feedback and suppression. SES send function was fake.",
  );
} finally {
  release?.();
  await Promise.all([source.end(), sourceAdmin.end(), target.end()]);
}
