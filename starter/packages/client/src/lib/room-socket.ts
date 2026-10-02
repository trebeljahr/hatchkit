import type { ClientToServerMessage, ServerToClientMessage } from "@starter/shared";

type SocketFactory = (url: string) => WebSocket;

/** Browser cookies authenticate the upgrade on the API host. */
export function roomSocketUrl(roomId: string): string {
  const base = process.env.NEXT_PUBLIC_WS_URL || process.env.NEXT_PUBLIC_API_URL;
  if (!base) throw new Error("NEXT_PUBLIC_WS_URL or NEXT_PUBLIC_API_URL is required");
  const url = new URL("/ws", base);
  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  url.searchParams.set("roomId", roomId);
  return url.toString();
}

/** Rejoin after replacement; the caller must refetch durable state on every open. */
export class RoomSocket {
  private socket: WebSocket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private retries = 0;

  constructor(
    private readonly roomId: string,
    private readonly onMessage: (message: ServerToClientMessage) => void,
    private readonly onResync: () => void | Promise<void>,
    private readonly socketFactory: SocketFactory = (url) => new WebSocket(url),
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, "Client leaving");
  }

  /** No implicit queue: callers must persist and retry business actions by ID. */
  send(message: ClientToServerMessage): boolean {
    if (this.socket?.readyState !== 1) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  private connect(): void {
    const socket = this.socketFactory(roomSocketUrl(this.roomId));
    this.socket = socket;
    socket.onopen = () => {
      if (this.stopped || this.socket !== socket) return;
      this.retries = 0;
      socket.send(JSON.stringify({ type: "join-room", roomId: this.roomId }));
      try {
        void Promise.resolve(this.onResync()).catch((error: unknown) =>
          console.error("[ws] Room state refresh failed:", error),
        );
      } catch (error) {
        console.error("[ws] Room state refresh failed:", error);
      }
    };
    socket.onmessage = (event) => {
      if (this.stopped || this.socket !== socket) return;
      try {
        this.onMessage(JSON.parse(event.data as string) as ServerToClientMessage);
      } catch {
        // A malformed frame cannot break reconnect handling.
      }
    };
    socket.onclose = () => {
      if (this.stopped || this.socket !== socket) return;
      this.socket = null;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (!this.stopped) this.connect();
      }, Math.min(1000 * 2 ** this.retries++, 10_000));
    };
    socket.onerror = () => socket.close();
  }
}
