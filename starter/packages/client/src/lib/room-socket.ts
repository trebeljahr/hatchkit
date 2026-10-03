import type { ClientToServerMessage, ServerToClientMessage } from "@starter/shared";

type SocketFactory = (url: string) => WebSocket;

/** Browser cookies authenticate the upgrade on the API host. */
export function roomSocketUrl(roomId: string): string {
  const base = process.env.NEXT_PUBLIC_WS_URL || process.env.NEXT_PUBLIC_API_URL;
  if (!base) throw new Error("NEXT_PUBLIC_WS_URL or NEXT_PUBLIC_API_URL is required");
  // /api is the server route in both split-host and same-origin deployments.
  const url = new URL("/api/ws", base);
  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  url.searchParams.set("roomId", roomId);
  return url.toString();
}

/** Rejoin after replacement and refetch durable state before allowing writes. */
export class RoomSocket {
  private socket: WebSocket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private retries = 0;
  private ready = false;
  private resyncController: AbortController | null = null;

  constructor(
    private readonly roomId: string,
    private readonly onMessage: (message: ServerToClientMessage) => void,
    // Fetches should pass this signal to fetch() so an obsolete connection's
    // request cannot commit its snapshot after a newer connection has started.
    private readonly onResync: (signal: AbortSignal) => void | Promise<void>,
    private readonly socketFactory: SocketFactory = (url) => new WebSocket(url),
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ready = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.clearHandshake();
    this.resyncController?.abort();
    this.resyncController = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, "Client leaving");
  }

  /** No implicit queue: callers must persist and retry business actions by ID. */
  send(message: ClientToServerMessage): boolean {
    if (!this.ready || this.socket?.readyState !== 1) return false;
    try {
      this.socket.send(JSON.stringify(message));
      return true;
    } catch {
      this.replace(this.socket);
      return false;
    }
  }

  private clearHandshake(): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
  }

  private retry(): void {
    if (this.stopped || this.retryTimer) return;
    const delay = Math.min(1000 * 2 ** this.retries++, 10_000) * (0.5 + Math.random() * 0.5);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped) this.connect();
    }, delay);
  }

  private replace(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.ready = false;
    this.clearHandshake();
    this.resyncController?.abort();
    this.resyncController = null;
    try {
      socket.close();
    } catch {
      /* A failed handshake may already be closed. */
    }
    this.retry();
  }

  private connect(): void {
    let socket: WebSocket;
    try {
      socket = this.socketFactory(roomSocketUrl(this.roomId));
    } catch {
      this.retry();
      return;
    }
    this.socket = socket;
    this.ready = false;
    let syncing = false;
    const controller = new AbortController();
    this.resyncController = controller;
    const buffered: ServerToClientMessage[] = [];
    const deliver = (message: ServerToClientMessage) => {
      try {
        this.onMessage(message);
      } catch {
        /* One consumer cannot break reconnect handling. */
      }
    };
    // Covers TCP/auth hangs as well as an open socket that never joined. Waiting
    // only for onclose leaves sleeping browsers permanently disconnected.
    this.handshakeTimer = setTimeout(() => this.replace(socket), 15_000);
    socket.onopen = () => {
      // roomId in the upgrade URL already joins on the authenticated server.
      // Sending a second join produced leave/join churn on every reconnect.
    };
    socket.onmessage = (event) => {
      if (this.stopped || this.socket !== socket) return;
      let message: ServerToClientMessage;
      try {
        message = JSON.parse(event.data as string) as ServerToClientMessage;
      } catch {
        return;
      }
      if (!message || typeof message.type !== "string") return;
      if (this.ready) {
        deliver(message);
        return;
      }
      // A slow HTTP snapshot must commit before newer live frames. Otherwise a
      // pushed update can be overwritten by the snapshot it raced with.
      buffered.push(message);
      if (buffered.length > 1000) {
        buffered.length = 0;
        this.replace(socket);
        return;
      }
      if (!syncing && message.type === "room-state" && message.roomId === this.roomId) {
        syncing = true;
        void Promise.resolve()
          .then(() => {
            if (!controller.signal.aborted) return this.onResync(controller.signal);
          })
          .then(() => {
            if (this.stopped || this.socket !== socket) return;
            this.clearHandshake();
            for (const frame of buffered.splice(0)) {
              if (this.stopped || this.socket !== socket) return;
              deliver(frame);
            }
            this.retries = 0;
            this.ready = true;
          })
          .catch((error: unknown) => {
            if (this.stopped || this.socket !== socket) return;
            console.error("[ws] Room state refresh failed:", error);
            this.replace(socket);
          });
      }
    };
    socket.onclose = () => this.replace(socket);
    socket.onerror = () => this.replace(socket);
  }
}
