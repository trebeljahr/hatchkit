"use client";

import { useAuth } from "@/hooks/use-auth";
import { RoomSocket } from "@/lib/room-socket";
import { getTRPCClient } from "@/lib/trpc";
// Pilot-only diagnostic page. Copy into the generated client's
// src/app/rolling-proof/page.tsx after scaffolding; never ship as starter UI.
// Requires websocket + client-core. Sign in through the normal /login page
// using a dedicated synthetic account before opening this route.
import { useCallback, useEffect, useRef, useState } from "react";

const PREFIX = "[rolling-proof]";
const ROOM = "rolling-proof";
type ProofItem = { id: string; title: string; status: string };
type Member = { userId: string; displayName: string };

export default function RollingBrowserProof() {
  const { user, isLoading } = useAuth();
  const [api] = useState(getTRPCClient);
  const socket = useRef<RoomSocket | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const readSequence = useRef(0);
  const [status, setStatus] = useState("stopped");
  const [resyncs, setResyncs] = useState(0);
  const [reads, setReads] = useState(0);
  const [members, setMembers] = useState<Member[]>([]);
  const [messages, setMessages] = useState<string[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [items, setItems] = useState<ProofItem[]>([]);
  const [label, setLabel] = useState("synthetic checkpoint");
  const [chat, setChat] = useState("synthetic room message");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const readItems = useCallback(
    async (signal?: AbortSignal) => {
      const sequence = ++readSequence.current;
      const snapshot = await api.items.list.query({ limit: 100 }, { signal });
      if (signal?.aborted || sequence !== readSequence.current) return;
      setItems(snapshot.items.filter((item) => item.title.startsWith(PREFIX)));
      setReads((count) => count + 1);
    },
    [api],
  );

  const leave = useCallback(() => {
    generation.current += 1;
    lifetime.current?.abort();
    lifetime.current = null;
    socket.current?.stop();
    socket.current = null;
    setStatus("stopped");
    setMembers([]);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: account changes must retire the previous account's socket and snapshot.
  useEffect(() => {
    setItems([]);
    return leave;
  }, [user?.id, leave]);

  function join() {
    if (!user) return;
    leave();
    setError("");
    const current = generation.current;
    const controller = new AbortController();
    lifetime.current = controller;
    const active = () => generation.current === current && !controller.signal.aborted;
    const log = (event: string) => {
      if (active()) setEvents((previous) => [...previous, event].slice(-20));
    };
    let transportSequence = 0;
    setStatus("connecting");
    const client = new RoomSocket(
      ROOM,
      (message) => {
        if (!active()) return;
        if (message.type === "room-state") setMembers(message.members);
        if (message.type === "chat") {
          setMessages((previous) =>
            [...previous, `${message.displayName}: ${message.text}`].slice(-20),
          );
        }
        if (message.type === "state-update" && message.payload.fixture === "rolling-proof") {
          void readItems(controller.signal).catch((caught: unknown) => {
            if (active()) setError(String(caught));
          });
        }
        if (message.type === "error") setError(message.message);
      },
      async (signal) => {
        if (!active()) return;
        setStatus("refreshing snapshot");
        await readItems(signal);
        if (!active() || signal.aborted) return;
        setResyncs((count) => count + 1);
        setStatus("ready");
        log("authoritative snapshot complete");
      },
      (url) => {
        // Native browser WebSocket supplies the API-host cookie. Instrumentation
        // uses listeners so the production helper keeps its own handlers.
        const transport = new WebSocket(url);
        const sequence = ++transportSequence;
        transport.addEventListener("open", () => {
          if (active() && sequence === transportSequence) setStatus("waiting for room snapshot");
          log("WebSocket opened");
        });
        transport.addEventListener("close", (event) => {
          if (active() && sequence === transportSequence) setStatus("reconnecting");
          log(`WebSocket closed ${event.code}`);
        });
        return transport;
      },
    );
    socket.current = client;
    client.start();
  }

  async function write(kind: "create" | "update") {
    if (!user || busy || status !== "ready") return;
    if (kind === "update" && !items[0]) return;
    setBusy(true);
    setError("");
    try {
      const title = `${PREFIX} ${label.trim() || "synthetic checkpoint"}`;
      // One request, no automatic retry. An uncertain response must be resolved
      // by refreshing the list before the operator chooses another write.
      const saved =
        kind === "create"
          ? await api.items.create.mutate({
              title,
              description: "Synthetic rolling browser proof only.",
            })
          : await api.items.update.mutate({ id: items[0].id, title });
      await readItems(lifetime.current?.signal);
      if (
        !socket.current?.send({
          type: "action",
          payload: { fixture: "rolling-proof", itemId: saved.id },
        })
      ) {
        setError(
          "Saved successfully; room notification was unavailable. Refresh the peer snapshot.",
        );
      }
    } catch (caught) {
      setError(`${String(caught)} — do not retry the write automatically; refresh first.`);
    } finally {
      setBusy(false);
    }
  }

  if (isLoading) return <main>Checking the real browser session…</main>;
  if (!user)
    return (
      <main data-testid="proof-signed-out">
        <a href="/login">Sign in with the synthetic test account</a>
      </main>
    );

  return (
    <main style={{ maxWidth: 900, margin: "2rem auto", padding: "1rem", fontFamily: "monospace" }}>
      <h1>Rolling browser proof</h1>
      <p>
        Use synthetic test accounts and data only. HTTP snapshots and writes use the normal
        authenticated API.
      </p>
      <p data-testid="proof-user">
        Signed in as {user.name} ({user.id})
      </p>
      <p>
        Status: <strong data-testid="proof-status">{status}</strong>
      </p>
      <p>
        Reconnect snapshots: <span data-testid="proof-resync-count">{resyncs}</span>; completed
        reads: <span data-testid="proof-read-count">{reads}</span>
      </p>
      {error && (
        <p role="alert" data-testid="proof-error">
          {error}
        </p>
      )}
      <div>
        <button type="button" onClick={join} data-testid="proof-join">
          Join room
        </button>{" "}
        <button type="button" onClick={leave} data-testid="proof-leave">
          Leave room
        </button>{" "}
        <button
          type="button"
          onClick={() =>
            void readItems(lifetime.current?.signal).catch((caught: unknown) =>
              setError(String(caught)),
            )
          }
          data-testid="proof-refresh"
        >
          Refresh snapshot
        </button>
      </div>
      <h2>Membership</h2>
      <ul data-testid="proof-members">
        {members.map((member) => (
          <li key={member.userId}>
            {member.displayName} ({member.userId})
          </li>
        ))}
      </ul>
      <h2>Chat</h2>
      <label>
        Message{" "}
        <input
          value={chat}
          onChange={(event) => setChat(event.target.value)}
          maxLength={200}
          data-testid="proof-chat-input"
        />
      </label>{" "}
      <button
        type="button"
        disabled={status !== "ready"}
        onClick={() => {
          setError(
            socket.current?.send({ type: "chat", text: chat })
              ? ""
              : "Room is not ready; message was not sent.",
          );
        }}
        data-testid="proof-chat-send"
      >
        Send chat
      </button>
      <ol data-testid="proof-messages">
        {messages.map((message, index) => (
          <li key={`${index}:${message}`}>{message}</li>
        ))}
      </ol>
      <h2>Durable synthetic items</h2>
      <label>
        Checkpoint{" "}
        <input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          maxLength={160}
          data-testid="proof-item-label"
        />
      </label>{" "}
      <button
        type="button"
        disabled={busy || status !== "ready"}
        onClick={() => void write("create")}
        data-testid="proof-create"
      >
        Create synthetic item
      </button>{" "}
      <button
        type="button"
        disabled={busy || status !== "ready" || !items[0]}
        onClick={() => void write("update")}
        data-testid="proof-update"
      >
        Update newest synthetic item
      </button>
      <ul data-testid="proof-items">
        {items.map((item) => (
          <li key={item.id} data-testid={`proof-item-${item.id}`}>
            {item.id}: {item.title} ({item.status})
          </li>
        ))}
      </ul>
      <h2>Transport events</h2>
      <ol data-testid="proof-events">
        {events.map((event, index) => (
          <li key={`${index}:${event}`}>{event}</li>
        ))}
      </ol>
    </main>
  );
}
