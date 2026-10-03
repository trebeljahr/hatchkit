import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RoomSocket, roomSocketUrl } from "./room-socket";

class FakeSocket {
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  send(data: string): void {
    this.sent.push(data);
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  snapshot(): void {
    this.onmessage?.({
      data: JSON.stringify({ type: "room-state", roomId: "pilot", members: [] }),
    });
  }
}

const oldApi = process.env.NEXT_PUBLIC_API_URL;
const oldWs = process.env.NEXT_PUBLIC_WS_URL;
const clients: RoomSocket[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(1);
  process.env.NEXT_PUBLIC_API_URL = "https://api.hatchkit-test.trebeljahr.com";
  delete process.env.NEXT_PUBLIC_WS_URL;
});
afterEach(() => {
  for (const client of clients.splice(0)) client.stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (oldApi === undefined) delete process.env.NEXT_PUBLIC_API_URL;
  else process.env.NEXT_PUBLIC_API_URL = oldApi;
  if (oldWs === undefined) delete process.env.NEXT_PUBLIC_WS_URL;
  else process.env.NEXT_PUBLIC_WS_URL = oldWs;
});

function fixture(resync: (signal: AbortSignal) => void | Promise<void> = vi.fn()) {
  const sockets: FakeSocket[] = [];
  const messages = vi.fn();
  const client = new RoomSocket("pilot", messages, resync, () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket as unknown as WebSocket;
  });
  clients.push(client);
  client.start();
  return { client, sockets, messages };
}

test("uses the separate API host for authenticated room upgrades", () => {
  expect(roomSocketUrl("room one")).toBe(
    "wss://api.hatchkit-test.trebeljahr.com/api/ws?roomId=room+one",
  );
});

test("same-origin rooms stay under the server's /api proxy route", () => {
  process.env.NEXT_PUBLIC_API_URL = "https://hatchkit-test.trebeljahr.com";
  expect(roomSocketUrl("pilot")).toBe("wss://hatchkit-test.trebeljahr.com/api/ws?roomId=pilot");
  process.env.NEXT_PUBLIC_WS_URL = "wss://hatchkit-test.trebeljahr.com";
  expect(roomSocketUrl("pilot")).toBe("wss://hatchkit-test.trebeljahr.com/api/ws?roomId=pilot");
});

test("waits for joined membership and durable resync before accepting actions", async () => {
  let finish!: () => void;
  const resync = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const { client, sockets } = fixture(resync);
  sockets[0].open();
  expect(sockets[0].sent).toEqual([]); // The URL auto-join must not be repeated.
  expect(resync).not.toHaveBeenCalled();
  expect(client.send({ type: "chat", text: "before join" })).toBe(false);
  sockets[0].snapshot();
  await vi.advanceTimersByTimeAsync(0);
  expect(resync).toHaveBeenCalledOnce();
  expect(client.send({ type: "chat", text: "during resync" })).toBe(false);
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(client.send({ type: "chat", text: "ready" })).toBe(true);
  sockets[0].snapshot();
  await vi.advanceTimersByTimeAsync(0);
  expect(resync).toHaveBeenCalledOnce(); // Presence heartbeats are not reconnects.
});

test("reconnects and refreshes again after replacement, then stop cancels retries", async () => {
  const resync = vi.fn();
  const { client, sockets, messages } = fixture(resync);
  sockets[0].open();
  sockets[0].snapshot();
  await vi.advanceTimersByTimeAsync(0);
  sockets[0].close();
  await vi.advanceTimersByTimeAsync(1000);
  expect(sockets).toHaveLength(2);
  expect(client.send({ type: "chat", text: "reconnecting" })).toBe(false);
  sockets[1].open();
  sockets[1].snapshot();
  await vi.advanceTimersByTimeAsync(0);
  expect(resync).toHaveBeenCalledTimes(2);
  expect(messages).toHaveBeenCalledTimes(2);
  client.stop();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(sockets).toHaveLength(2);
});

test("a failed constructor or a missing join snapshot cannot strand the client", async () => {
  const sockets: FakeSocket[] = [];
  let attempts = 0;
  const client = new RoomSocket("pilot", vi.fn(), vi.fn(), () => {
    if (++attempts === 1) throw new Error("transport unavailable");
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket as unknown as WebSocket;
  });
  clients.push(client);
  expect(() => client.start()).not.toThrow();
  await vi.advanceTimersByTimeAsync(1000);
  sockets[0].open();
  await vi.advanceTimersByTimeAsync(15_000);
  expect(sockets[0].readyState).toBe(3);
  await vi.advanceTimersByTimeAsync(2000);
  expect(sockets).toHaveLength(2);
});

test("failed state refresh retries rather than accepting actions on stale state", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const resync = vi
    .fn()
    .mockRejectedValueOnce(new Error("fetch interrupted"))
    .mockResolvedValue(undefined);
  const { client, sockets } = fixture(resync);
  sockets[0].open();
  sockets[0].snapshot();
  await vi.advanceTimersByTimeAsync(0);
  expect(client.send({ type: "chat", text: "stale" })).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  sockets[1].open();
  sockets[1].snapshot();
  await vi.advanceTimersByTimeAsync(0);
  expect(client.send({ type: "chat", text: "fresh" })).toBe(true);
});

test("late completion and close from an old socket cannot mark its replacement ready", async () => {
  let finish!: () => void;
  const resync = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const { client, sockets } = fixture(resync);
  sockets[0].open();
  sockets[0].snapshot();
  await vi.advanceTimersByTimeAsync(0);
  sockets[0].close();
  await vi.advanceTimersByTimeAsync(1000);
  sockets[1].open();
  finish();
  sockets[0].onclose?.();
  await vi.advanceTimersByTimeAsync(0);
  expect(client.send({ type: "chat", text: "replacement still joining" })).toBe(false);
  expect(sockets).toHaveLength(2);
});

test("newer live state waits for the older snapshot before it reaches the consumer", async () => {
  let state = "initial";
  let finish!: () => void;
  const resync = () =>
    new Promise<void>((resolve) => {
      finish = () => {
        state = "old snapshot";
        resolve();
      };
    });
  const { client, sockets, messages } = fixture(resync);
  messages.mockImplementation((message) => {
    if (message.type === "state-update") state = message.payload.value;
  });
  sockets[0].open();
  sockets[0].snapshot();
  await vi.advanceTimersByTimeAsync(0);
  for (const value of ["new state", "newest state"]) {
    sockets[0].onmessage?.({ data: JSON.stringify({ type: "state-update", payload: { value } }) });
  }
  expect(state).toBe("initial");
  expect(client.send({ type: "action", payload: {} })).toBe(false);
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(state).toBe("newest state");
  expect(client.send({ type: "action", payload: {} })).toBe(true);
});

test("replacing a connection aborts its obsolete snapshot fetch", async () => {
  let signal!: AbortSignal;
  const { sockets } = fixture((current) => {
    signal = current;
    return new Promise<void>(() => {});
  });
  sockets[0].open();
  sockets[0].snapshot();
  await vi.advanceTimersByTimeAsync(0);
  expect(signal.aborted).toBe(false);
  sockets[0].close();
  expect(signal.aborted).toBe(true);
});
