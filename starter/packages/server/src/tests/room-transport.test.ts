import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { Redis } from "ioredis";
import type { WebSocket } from "ws";
import type { ServerToClientMessage } from "@starter/shared";
import { RoomManager } from "../ws/rooms.js";

// Presence expiry and wire delivery are tested against real Redis by the CLI
// runtime harness. This transport double injects a failed PUBLISH acknowledgment
// without disconnecting healthy peers, which a full Redis restart cannot do.
class Transport extends EventEmitter {
  status = "ready";
  channel: string | null = null;
  failPublish = false;
  constructor(
    private readonly bus: Set<Transport>,
    private readonly presence: Map<string, Set<string>>,
  ) {
    super();
    bus.add(this);
  }
  duplicate(): Transport {
    const client = new Transport(this.bus, this.presence);
    client.status = "wait";
    return client;
  }
  async connect(): Promise<void> {
    this.status = "ready";
    this.emit("ready");
  }
  async subscribe(channel: string): Promise<void> {
    this.channel = channel;
  }
  async eval(
    _script: string,
    _keys: number,
    key: string,
    operation: string,
    _lease: number,
    ...values: string[]
  ): Promise<string[]> {
    const entries = this.presence.get(key) ?? new Set<string>();
    for (const value of values) {
      if (operation === "remove") entries.delete(value);
      else entries.add(value);
    }
    this.presence.set(key, entries);
    return [...entries];
  }
  async publish(channel: string, data: string): Promise<number> {
    if (this.failPublish) {
      this.failPublish = false;
      throw new Error("injected publish failure");
    }
    if (this.status !== "ready") throw new Error("publisher unavailable");
    for (const peer of this.bus) {
      if (peer.status === "ready" && peer.channel === channel) peer.emit("message", channel, data);
    }
    return this.bus.size;
  }
  disconnect(): void {
    this.status = "end";
    this.channel = null;
    this.bus.delete(this);
    this.emit("close");
  }
  asRedis(): Redis {
    return this as unknown as Redis;
  }
}

class Socket {
  readyState = 1;
  messages: ServerToClientMessage[] = [];
  closeCodes: number[] = [];
  send(raw: string): void {
    this.messages.push(JSON.parse(raw));
  }
  close(code: number): void {
    this.readyState = 3;
    this.closeCodes.push(code);
  }
  asWebSocket(): WebSocket {
    return this as unknown as WebSocket;
  }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function pair() {
  const bus = new Set<Transport>();
  const presence = new Map<string, Set<string>>();
  const publisherA = new Transport(bus, presence);
  const publisherB = new Transport(bus, presence);
  const a = new RoomManager({ heartbeatMs: 20, presenceLeaseMs: 100 });
  const b = new RoomManager({ heartbeatMs: 20, presenceLeaseMs: 100 });
  await a.connectPubSub(publisherA.asRedis());
  await b.connectPubSub(publisherB.asRedis());
  const local = new Socket();
  const remote = new Socket();
  await a.join("shared", "alice", "Alice", local.asWebSocket());
  await b.join("shared", "bob", "Bob", remote.asWebSocket());
  await flush();
  return {
    a,
    b,
    publisherA,
    publisherB,
    local,
    remote,
    close: async () => {
      await a.disconnectPubSub();
      await b.disconnectPubSub();
      publisherA.disconnect();
      publisherB.disconnect();
    },
  };
}

test("failed publish rejects local success and forces peer snapshots after transport recovery", async () => {
  const p = await pair();
  try {
    p.publisherA.failPublish = true;
    await assert.rejects(
      p.a.handleMessage(p.local.asWebSocket(), { type: "action", payload: { revision: 2 } }),
      /injected publish failure/,
    );
    assert.equal(p.local.messages.filter((message) => message.type === "state-update").length, 0);
    assert.equal(p.remote.messages.filter((message) => message.type === "state-update").length, 0);
    assert.ok(p.local.closeCodes.includes(1012));
    assert.equal(
      p.remote.closeCodes.length,
      0,
      "a healthy peer cannot yet know this publisher missed a frame",
    );
    p.publisherA.emit("ready");
    await flush();
    assert.ok(p.remote.closeCodes.includes(1012), "recovery must tell peers to refetch too");
  } finally {
    await p.close();
  }
});

test("existing room sockets cannot publish while their configured Redis transport is unavailable", async () => {
  const p = await pair();
  try {
    p.publisherA.status = "reconnecting";
    p.publisherA.emit("close");
    assert.ok(p.local.closeCodes.includes(1012));
    await p.a.handleMessage(p.local.asWebSocket(), {
      type: "chat",
      text: "must not look delivered",
    });
    assert.equal(p.local.messages.filter((message) => message.type === "chat").length, 0);
    assert.equal(p.remote.messages.filter((message) => message.type === "chat").length, 0);
    await assert.rejects(
      p.a.broadcast("shared", { type: "state-update", payload: { revision: 3 } }),
      /transport is unavailable/,
    );
    p.publisherA.status = "ready";
  } finally {
    await p.close();
  }
});
