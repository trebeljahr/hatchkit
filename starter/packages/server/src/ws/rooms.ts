import type { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { setRoomSubscriber } from "../db/redis.js";
import type { RoomMember, ClientToServerMessage, ServerToClientMessage } from "@starter/shared";

interface MemberInfo {
  member: RoomMember;
  presence: string;
}

interface Room {
  members: Map<WebSocket, MemberInfo>;
}

// Redis time makes leases independent of clock differences between containers.
// One sorted-set entry per connection means a reconnect's old close cannot erase
// its replacement. Expired connections are removed on every read and heartbeat.
const PRESENCE = `
local clock = redis.call('TIME')
local now = clock[1] * 1000 + math.floor(clock[2] / 1000)
local lease = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
for i = 3, #ARGV do
  if ARGV[1] == 'remove' then
    redis.call('ZREM', KEYS[1], ARGV[i])
  else
    redis.call('ZADD', KEYS[1], now + lease, ARGV[i])
  end
end
if #ARGV > 2 then redis.call('PEXPIRE', KEYS[1], lease * 2) end
return redis.call('ZRANGE', KEYS[1], 0, -1)
`;

/** Shared, leased presence and event fanout. Business state belongs in the DB. */
export class RoomManager {
  private rooms = new Map<string, Room>();
  private socketToRoom = new Map<WebSocket, string>();
  private readonly instanceId = randomUUID();
  private publisher: Redis | null = null;
  private subscriber: Redis | null = null;
  private readonly channel = "hatchkit:room-events";
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly presenceLeaseMs: number;
  private readonly heartbeatMs: number;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private restore: Promise<void> | null = null;
  private ready = false;
  private everReady = false;
  private needsPeerResync = false;
  private closing = false;
  private generation = 0;

  constructor(options: { presenceLeaseMs?: number; heartbeatMs?: number } = {}) {
    this.presenceLeaseMs = options.presenceLeaseMs ?? 30_000;
    this.heartbeatMs = options.heartbeatMs ?? 10_000;
    if (this.heartbeatMs <= 0 || this.presenceLeaseMs <= this.heartbeatMs * 2) {
      throw new Error("Room presence lease must exceed two heartbeat intervals");
    }
  }

  async connectPubSub(redis: Redis): Promise<void> {
    if (this.publisher) throw new Error("Room pub/sub is already connected");
    const subscriber = redis.duplicate({ lazyConnect: true });
    this.publisher = redis;
    this.subscriber = subscriber;
    this.closing = false;
    setRoomSubscriber(subscriber, false);
    const unavailable = () => this.markUnavailable();
    const restore = () => {
      void this.restoreSubscriptions().catch((error: unknown) => {
        this.markUnavailable();
        console.error("[ws] Redis room restore failed:", error);
      });
    };
    for (const client of [redis, subscriber]) {
      client.on("close", unavailable);
      client.on("ready", restore);
    }
    this.removeConnectionListeners = () => {
      for (const client of [redis, subscriber]) {
        client.off("close", unavailable);
        client.off("ready", restore);
      }
    };
    subscriber.on("error", (error: unknown) =>
      console.error("[ws] Redis subscriber error:", error),
    );
    subscriber.on("message", (_channel, payload) => {
      try {
        const event = JSON.parse(payload) as {
          origin: string;
          roomId: string;
          presence?: boolean;
          resync?: boolean;
          message?: ServerToClientMessage;
        };
        if (event.origin === this.instanceId) return;
        if (event.resync === true) {
          this.requestResync();
          return;
        }
        if (typeof event.roomId !== "string") return;
        if (event.presence) {
          void this.refreshRoom(event.roomId).catch((error: unknown) =>
            console.error("[ws] Redis room refresh failed:", error),
          );
        } else if (event.message) {
          this.deliver(event.roomId, event.message);
        }
      } catch {
        // Malformed transport data cannot break the room listener.
      }
    });
    await subscriber.connect();
    await this.restoreSubscriptions();
    this.heartbeat = setInterval(() => {
      const update = this.ready ? this.refreshPresence() : this.restoreSubscriptions();
      void update.catch((error: unknown) => {
        unavailable();
        console.error("[ws] Redis presence heartbeat failed:", error);
      });
    }, this.heartbeatMs);
    this.heartbeat.unref();
  }

  private removeConnectionListeners: (() => void) | null = null;

  private requestResync(): void {
    for (const socket of this.socketToRoom.keys()) {
      if (socket.readyState === 1) socket.close(1012, "Room transport reset");
    }
  }

  private markUnavailable(): void {
    if (this.closing) return;
    this.ready = false;
    this.generation += 1;
    this.needsPeerResync = this.everReady || this.needsPeerResync;
    setRoomSubscriber(this.subscriber, false);
    this.requestResync();
  }

  private canWrite(): boolean {
    return (
      !this.closing &&
      (!this.publisher ||
        (this.ready && this.publisher.status === "ready" && this.subscriber?.status === "ready"))
    );
  }

  private async restoreSubscriptions(): Promise<void> {
    if (this.restore) return this.restore;
    const subscriber = this.subscriber;
    if (
      this.closing ||
      this.ready ||
      this.publisher?.status !== "ready" ||
      subscriber?.status !== "ready"
    )
      return;
    const generation = this.generation;
    this.restore = (async () => {
      await subscriber.subscribe(this.channel);
      await this.refreshPresence();
      if (
        this.closing ||
        generation !== this.generation ||
        subscriber.status !== "ready" ||
        this.publisher?.status !== "ready"
      )
        return;
      if (this.needsPeerResync) {
        // Other replicas cannot observe this publisher's failed writes. Their
        // clients must refetch too once Redis can carry notifications again.
        await this.publisher.publish(
          this.channel,
          JSON.stringify({ origin: this.instanceId, resync: true }),
        );
      }
      if (
        this.closing ||
        generation !== this.generation ||
        subscriber.status !== "ready" ||
        this.publisher?.status !== "ready"
      )
        return;
      this.needsPeerResync = false;
      this.ready = true;
      setRoomSubscriber(subscriber, true);
      if (this.everReady) {
        // Pub/sub has no replay. Reconnecting makes every client refetch durable
        // state, including changes made while this subscriber was unavailable.
        this.requestResync();
      }
      this.everReady = true;
    })().finally(() => {
      this.restore = null;
    });
    return this.restore;
  }

  async disconnectPubSub(): Promise<void> {
    this.closing = true;
    this.ready = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.removeConnectionListeners?.();
    this.removeConnectionListeners = null;
    await this.restore?.catch(() => undefined);
    await Promise.all([...this.queues.values()].map((pending) => pending.catch(() => undefined)));
    const subscriber = this.subscriber;
    // Graceful exit removes this instance immediately. A crash is handled by
    // the leases; never delete a whole room another instance still occupies.
    if (this.publisher?.status === "ready") {
      for (const [roomId, room] of this.rooms) {
        await this.presence(
          roomId,
          "remove",
          [...room.members.values()].map((info) => info.presence),
        );
        await this.publishPresence(roomId);
      }
    }
    this.subscriber = null;
    this.publisher = null;
    setRoomSubscriber(null);
    subscriber?.disconnect();
  }

  async join(
    roomId: string,
    userId: string,
    displayName: string,
    socket: WebSocket,
  ): Promise<void> {
    if (!this.canWrite()) {
      socket.close(1012, "Room temporarily unavailable");
      return;
    }
    if (socket.readyState !== 1) return;
    if (this.socketToRoom.get(socket) === roomId) {
      await this.enqueue(roomId, async () => {
        this.send(socket, { type: "room-state", roomId, members: await this.presence(roomId) });
      });
      return;
    }
    await this.leave(socket);
    if (this.closing || socket.readyState !== 1) return;
    await this.enqueue(roomId, async () => {
      if (socket.readyState !== 1) return;
      let room = this.rooms.get(roomId);
      if (!room) {
        room = { members: new Map() };
        this.rooms.set(roomId, room);
      }
      const member: RoomMember = { userId, displayName, joinedAt: new Date().toISOString() };
      const info = { member, presence: JSON.stringify({ connectionId: randomUUID(), member }) };
      room.members.set(socket, info);
      this.socketToRoom.set(socket, roomId);
      const members = await this.presence(roomId, "add", [info.presence]);
      await this.broadcast(roomId, { type: "member-joined", member }, socket);
      this.deliver(roomId, { type: "room-state", roomId, members });
      await this.publishPresence(roomId);
    });
  }

  async leave(socket: WebSocket): Promise<void> {
    const roomId = this.socketToRoom.get(socket);
    if (!roomId) return;
    await this.enqueue(roomId, async () => {
      const room = this.rooms.get(roomId);
      const info = room?.members.get(socket);
      if (!room || !info) return;
      room.members.delete(socket);
      this.socketToRoom.delete(socket);
      if (room.members.size === 0) this.rooms.delete(roomId);
      const members = await this.presence(roomId, "remove", [info.presence]);
      // Other sockets belonging to this user may still be on another replica.
      if (!members.some((member) => member.userId === info.member.userId)) {
        await this.broadcast(roomId, { type: "member-left", userId: info.member.userId });
      }
      this.deliver(roomId, { type: "room-state", roomId, members });
      await this.publishPresence(roomId);
    });
  }

  async handleMessage(socket: WebSocket, message: ClientToServerMessage): Promise<void> {
    const roomId = this.socketToRoom.get(socket);
    if (message.type === "leave-room") return this.leave(socket);
    if (message.type === "join-room") return;
    if (socket.readyState !== 1) return;
    if (!this.canWrite()) {
      socket.close(1012, "Room temporarily unavailable");
      return;
    }
    if (!roomId) {
      this.send(socket, {
        type: "error",
        code: "NOT_IN_ROOM",
        message: "You must join a room first",
      });
      return;
    }
    const member = this.rooms.get(roomId)?.members.get(socket)?.member;
    if (message.type === "chat" && member) {
      await this.broadcast(roomId, {
        type: "chat",
        userId: member.userId,
        displayName: member.displayName,
        text: message.text,
      });
    } else if (message.type === "action") {
      // Applications must persist business actions with idempotency IDs before
      // broadcasting them. Pub/sub carries notifications, not durable history.
      await this.broadcast(roomId, { type: "state-update", payload: message.payload });
    }
  }

  async broadcast(
    roomId: string,
    message: ServerToClientMessage,
    exclude?: WebSocket,
  ): Promise<void> {
    if ((message.type === "chat" || message.type === "state-update") && !this.canWrite()) {
      throw new Error("Room transport is unavailable; retry the durable action by ID after resync");
    }
    if (this.publisher) {
      try {
        await this.publisher.publish(
          this.channel,
          JSON.stringify({ origin: this.instanceId, roomId, message }),
        );
      } catch (error) {
        this.markUnavailable();
        throw error;
      }
    }
    this.deliver(roomId, message, exclude);
  }

  private async publishPresence(roomId: string): Promise<void> {
    if (!this.publisher) return;
    try {
      await this.publisher.publish(
        this.channel,
        JSON.stringify({ origin: this.instanceId, roomId, presence: true }),
      );
    } catch (error) {
      this.markUnavailable();
      throw error;
    }
  }

  private deliver(roomId: string, message: ServerToClientMessage, exclude?: WebSocket): void {
    for (const socket of this.rooms.get(roomId)?.members.keys() ?? []) {
      if (socket !== exclude) this.send(socket, message);
    }
  }

  send(socket: WebSocket, message: ServerToClientMessage): void {
    if (socket.readyState === 1) {
      try {
        socket.send(JSON.stringify(message));
      } catch {
        /* A dead peer cannot interrupt other listeners. */
      }
    }
  }

  private enqueue<T>(roomId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(roomId) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(work);
    this.queues.set(roomId, pending);
    void pending
      .finally(() => {
        if (this.queues.get(roomId) === pending) this.queues.delete(roomId);
      })
      .catch(() => undefined);
    return pending;
  }

  private async presence(
    roomId: string,
    operation = "read",
    values: string[] = [],
  ): Promise<RoomMember[]> {
    if (!this.publisher) return this.localMembers(roomId);
    let entries: string[];
    try {
      entries = (await this.publisher.eval(
        PRESENCE,
        1,
        `hatchkit:room-presence:${roomId}`,
        operation,
        this.presenceLeaseMs,
        ...values,
      )) as string[];
    } catch (error) {
      this.markUnavailable();
      throw error;
    }
    const members = new Map<string, RoomMember>();
    for (const entry of entries) {
      const { member } = JSON.parse(entry) as { member: RoomMember };
      const previous = members.get(member.userId);
      if (!previous || member.joinedAt < previous.joinedAt) members.set(member.userId, member);
    }
    return [...members.values()].sort((a, b) => a.userId.localeCompare(b.userId));
  }

  private localMembers(roomId: string): RoomMember[] {
    const members = new Map<string, RoomMember>();
    for (const { member } of this.rooms.get(roomId)?.members.values() ?? [])
      members.set(member.userId, member);
    return [...members.values()];
  }

  private refreshRoom(roomId: string): Promise<void> {
    return this.enqueue(roomId, async () => {
      if (!this.rooms.has(roomId)) return;
      this.deliver(roomId, { type: "room-state", roomId, members: await this.presence(roomId) });
    });
  }

  private async refreshPresence(): Promise<void> {
    for (const roomId of this.rooms.keys()) {
      await this.enqueue(roomId, async () => {
        const room = this.rooms.get(roomId);
        if (!room) return;
        const members = await this.presence(
          roomId,
          "add",
          [...room.members.values()].map((info) => info.presence),
        );
        this.deliver(roomId, { type: "room-state", roomId, members });
      });
    }
  }

  getMembers(roomId: string): Promise<RoomMember[]> {
    return this.enqueue(roomId, () => this.presence(roomId));
  }

  getRoomCount(): number {
    return this.rooms.size;
  }
  getConnectionCount(): number {
    return this.socketToRoom.size;
  }
}
