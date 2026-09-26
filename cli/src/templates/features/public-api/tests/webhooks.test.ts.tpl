// The three webhook rules that fail QUIETLY when they break, asserted without
// a database, a clock or a network.
//
// "Quietly" is the criterion for what is in here. A broken retry schedule
// shows up as a support ticket months later; a signature computed over
// different bytes than were sent is rejected only by receivers that verify,
// which is to say only by the careful ones; and an SSRF range that stops
// matching is invisible until somebody uses it.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { retryDelayMs, WEBHOOK_MAX_ATTEMPTS } from "../services/webhooks/backoff.js";
import { projectWebhookEnvelope } from "../services/webhooks/projection.js";
import { isBlockedAddress } from "../services/webhooks/ssrf.js";
import { signWebhookBody } from "../services/webhooks/signature.js";
import type { WebhookEnvelope } from "../services/webhooks/types.js";

describe("the webhook signature", () => {
  it("signs `<timestamp>.<rawBody>`, so a replay cannot rewrite the header", () => {
    const expected = createHmac("sha256", "whsec_test")
      .update("1700000000.{\"a\":1}", "utf8")
      .digest("hex");
    assert.equal(signWebhookBody("whsec_test", 1_700_000_000, '{"a":1}'), expected);
  });

  it("changes when the timestamp does, with the body untouched", () => {
    const a = signWebhookBody("whsec_test", 1_700_000_000, '{"a":1}');
    const b = signWebhookBody("whsec_test", 1_700_000_001, '{"a":1}');
    assert.notEqual(a, b);
  });

  it("is over the exact string, not over a re-serialized object", () => {
    // The two bodies below carry the same data and differ only in key order —
    // which is precisely what a second serialization can produce. Different
    // signatures is the correct answer, and it is why `delivery.ts` serializes
    // once and hands the same variable to both the HMAC and the request.
    const a = signWebhookBody("whsec_test", 1, '{"a":1,"b":2}');
    const b = signWebhookBody("whsec_test", 1, '{"b":2,"a":1}');
    assert.notEqual(a, b);
  });
});

describe("the retry schedule", () => {
  it("makes the first attempt due immediately", () => {
    assert.equal(retryDelayMs(0), 0);
  });

  it("widens, and then gives up exactly once", () => {
    const delays: number[] = [];
    for (let made = 1; made < WEBHOOK_MAX_ATTEMPTS; made += 1) {
      const delay = retryDelayMs(made);
      assert.notEqual(delay, null, `attempt ${made} should still be retried`);
      delays.push(delay as number);
    }
    // Strictly increasing: a flat or shrinking step means a dead host is
    // hammered at a constant rate for the whole schedule.
    for (let i = 1; i < delays.length; i += 1) {
      assert.ok((delays[i] as number) > (delays[i - 1] as number));
    }
    // `null` is the ONLY terminal signal. A caller comparing against a
    // hard-coded 6 elsewhere is how the table and the give-up point drift.
    assert.equal(retryDelayMs(WEBHOOK_MAX_ATTEMPTS), null);
  });
});

describe("the SSRF range table", () => {
  it("blocks loopback, link-local and the cloud metadata address", () => {
    for (const address of ["127.0.0.1", "169.254.169.254", "10.0.0.1", "192.168.1.1", "::1"]) {
      assert.equal(isBlockedAddress(address), true, `${address} must be blocked`);
    }
  });

  it("blocks an IPv4 destination wrapped in an IPv6 spelling", () => {
    // WHATWG URL re-serializes `::ffff:169.254.169.254` to `::ffff:a9fe:a9fe`,
    // so a guard that matched the dotted spelling would never fire in
    // production. Both forms must be blocked.
    assert.equal(isBlockedAddress("::ffff:a9fe:a9fe"), true);
    assert.equal(isBlockedAddress("2002:a9fe:a9fe::"), true);
  });

  it("fails closed on anything it cannot parse", () => {
    assert.equal(isBlockedAddress("not-an-address"), true);
    assert.equal(isBlockedAddress(""), true);
  });

  it("allows ordinary public addresses", () => {
    assert.equal(isBlockedAddress("93.184.216.34"), false);
    assert.equal(isBlockedAddress("2606:2800:220:1:248:1893:25c8:1946"), false);
  });
});

describe("the send-time visibility projection", () => {
  const envelopeFor = (ownerId: string): WebhookEnvelope => ({
    id: "delivery-1",
    event: "item.created",
    tenantId: "tenant-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    data: {
      kind: "item",
      item: {
        id: "item-1",
        title: "t",
        status: "draft",
        ownerId,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    },
  });

  it("delivers the subscriber's own rows with no permission at all", () => {
    const projected = projectWebhookEnvelope(envelopeFor("alice"), {
      userId: "alice",
      permissions: [],
    });
    assert.notEqual(projected, null);
  });

  it("WITHHOLDS a colleague's row rather than stripping it", () => {
    // Withheld, not blanked: without `items:view-others` the existence of the
    // row is itself what the permission hides, and a blanked envelope would
    // still leak that something happened and when.
    const projected = projectWebhookEnvelope(envelopeFor("bob"), {
      userId: "alice",
      permissions: [],
    });
    assert.equal(projected, null);
  });

  it("delivers a colleague's row once the permission is held", () => {
    const projected = projectWebhookEnvelope(envelopeFor("bob"), {
      userId: "alice",
      permissions: ["items:view-others"],
    });
    assert.notEqual(projected, null);
  });

  it("asks the deletion payload, because the row is gone", () => {
    const deleted: WebhookEnvelope = {
      id: "delivery-2",
      event: "item.deleted",
      tenantId: "tenant-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      data: { kind: "item-deleted", itemId: "item-1", ownerId: "bob" },
    };
    assert.equal(
      projectWebhookEnvelope(deleted, { userId: "alice", permissions: [] }),
      null,
    );
    assert.notEqual(
      projectWebhookEnvelope(deleted, {
        userId: "alice",
        permissions: ["items:view-others"],
      }),
      null,
    );
  });
});
