import { afterEach, expect, test, vi } from "vitest";
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
  send(data: string): void { this.sent.push(data); }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
}

afterEach(() => vi.useRealTimers());

test("uses the separate API host for WebSocket upgrades", () => {
  process.env.NEXT_PUBLIC_API_URL = "https://api.hatchkit-test.trebeljahr.com";
  delete process.env.NEXT_PUBLIC_WS_URL;
  expect(roomSocketUrl("room one")).toBe("wss://api.hatchkit-test.trebeljahr.com/ws?roomId=room+one");
});

test("rejoins and requests a fresh snapshot after server replacement", async () => {
  vi.useFakeTimers();
  process.env.NEXT_PUBLIC_API_URL = "https://api.hatchkit-test.trebeljahr.com";
  delete process.env.NEXT_PUBLIC_WS_URL;
  const sockets: FakeSocket[] = [];
  const resync = vi.fn();
  const messages = vi.fn();
  const client = new RoomSocket("pilot", messages, resync, () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket as unknown as WebSocket;
  });
  client.start();
  expect(client.send({ type: "chat", text: "before open" })).toBe(false);
  sockets[0].open();
  expect(JSON.parse(sockets[0].sent[0])).toEqual({ type: "join-room", roomId: "pilot" });
  expect(resync).toHaveBeenCalledTimes(1);
  sockets[0].close();
  await vi.advanceTimersByTimeAsync(1000);
  expect(sockets).toHaveLength(2);
  sockets[1].open();
  expect(JSON.parse(sockets[1].sent[0])).toEqual({ type: "join-room", roomId: "pilot" });
  expect(resync).toHaveBeenCalledTimes(2);
  sockets[1].onmessage?.({ data: JSON.stringify({ type: "room-state", roomId: "pilot", members: [] }) });
  expect(messages).toHaveBeenCalledOnce();
  client.stop();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(sockets).toHaveLength(2);
});
