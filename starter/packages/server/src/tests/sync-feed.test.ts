import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { Redis } from "ioredis";
import type { SyncMessage } from "@starter/shared";
import { SyncFeed } from "../sync/feed.js";

// A controllable transport double exercises failed acknowledgments and unusual
// event ordering. cli/test-rolling-runtime.ts also covers real Redis processes.
class Transport extends EventEmitter {
  status = "ready";
  channel: string | null = null;
  child: Transport | null = null;
  failSubscribe = false;
  constructor(private readonly bus: Set<Transport>) {
    super();
    bus.add(this);
  }
  duplicate(): Transport {
    this.child = new Transport(this.bus);
    this.child.status = "wait";
    return this.child;
  }
  async connect(): Promise<void> {
    this.status = "ready";
    this.emit("ready");
  }
  async subscribe(channel: string): Promise<void> {
    if (this.failSubscribe) {
      this.failSubscribe = false;
      throw new Error("temporary subscription refusal");
    }
    this.channel = channel;
  }
  async publish(channel: string, data: string): Promise<number> {
    if (this.status !== "ready") throw new Error("publisher disconnected");
    for (const peer of this.bus) {
      if (peer.status === "ready" && peer.channel === channel) peer.emit("message", channel, data);
    }
    return this.bus.size;
  }
  disconnect(): void {
    this.status = "end";
    this.channel = null;
    this.emit("close");
    this.bus.delete(this);
  }
  lose(): void {
    this.status = "reconnecting";
    this.channel = null;
    this.emit("close");
  }
  asRedis(): Redis {
    return this as unknown as Redis;
  }
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function pair() {
  const bus = new Set<Transport>();
  const a = new SyncFeed();
  const b = new SyncFeed();
  const publisherA = new Transport(bus);
  const publisherB = new Transport(bus);
  await a.connectPubSub(publisherA.asRedis());
  await b.connectPubSub(publisherB.asRedis());
  return {
    a,
    b,
    publisherA,
    publisherB,
    close: async () => {
      await a.disconnectPubSub();
      await b.disconnectPubSub();
      publisherA.disconnect();
      publisherB.disconnect();
    },
  };
}

test("sync crosses replicas without local subscribers, isolates users, and suppresses its own echo", async () => {
  const p = await pair();
  try {
    const remote: SyncMessage[] = [];
    const local: SyncMessage[] = [];
    const other: SyncMessage[] = [];
    p.b.subscribe({ userId: "alice", send: (message) => remote.push(message) });
    p.b.subscribe({ userId: "bob", send: (message) => other.push(message) });
    p.a.publish(
      "alice",
      { kind: "items.changed", id: "first" },
      { originId: "origin", tenantId: "tenant" },
    );
    await flush();
    assert.equal(remote.length, 1, "the publisher needs no local listeners");
    assert.equal(remote[0].originId, "origin");
    assert.equal(remote[0].tenantId, "tenant");
    assert.equal(other.length, 0);
    p.a.subscribe({ userId: "alice", send: (message) => local.push(message) });
    p.a.publish("alice", { kind: "profile.changed" });
    await flush();
    assert.equal(local.length, 1, "Redis's echo must not duplicate local delivery");
    assert.equal(remote.length, 2);
  } finally {
    await p.close();
  }
});

test("a publisher-only gap makes both replicas refetch and restores subsequent delivery", async () => {
  const p = await pair();
  try {
    let localResyncs = 0;
    let remoteResyncs = 0;
    let deliveries = 0;
    p.a.subscribe({
      userId: "alice",
      send: () => {},
      resync: () => {
        localResyncs += 1;
      },
    });
    p.b.subscribe({
      userId: "alice",
      send: () => {
        deliveries += 1;
      },
      resync: () => {
        remoteResyncs += 1;
      },
    });
    p.publisherA.lose();
    assert.ok(localResyncs > 0);
    await p.publisherA.connect();
    await flush();
    assert.ok(remoteResyncs > 0, "peers must learn that the publisher missed invalidations");
    p.a.publish("alice", { kind: "items.changed" });
    await flush();
    assert.equal(deliveries, 1);
  } finally {
    await p.close();
  }
});

test("a failed resubscribe acknowledgment retries without permanently disconnecting", async (context) => {
  const p = await pair();
  const originalError = console.error;
  console.error = () => {};
  context.after(() => {
    console.error = originalError;
  });
  try {
    let resyncs = 0;
    let deliveries = 0;
    p.b.subscribe({
      userId: "alice",
      send: () => {
        deliveries += 1;
      },
      resync: () => {
        resyncs += 1;
      },
    });
    const subscriber = p.publisherB.child!;
    subscriber.lose();
    subscriber.failSubscribe = true;
    await subscriber.connect();
    await flush();
    assert.ok(resyncs > 0);
    assert.equal(
      subscriber.status,
      "ready",
      "a failed command must preserve the reconnectable transport",
    );
    await new Promise((resolve) => setTimeout(resolve, 1100));
    p.a.publish("alice", { kind: "profile.changed" });
    await flush();
    assert.equal(deliveries, 1, "delivery resumes after the next subscription acknowledgment");
  } finally {
    await p.close();
  }
});
