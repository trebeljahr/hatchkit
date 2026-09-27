/*
 * A local stand-in for `/api/v1`, for the slow test tier.
 *
 * ── Why this is not the project's own server ────────────────────────
 *
 * The REST surface is an opt-in feature: a workspace that has not enabled it
 * has no `/api/v1` to start, so a suite that booted `@starter/server` would
 * fail on every checkout that did not happen to have the feature on — which
 * is a suite nobody keeps green. Point the same tests at the real thing by
 * exporting `MCP_IT_API_URL` and `MCP_IT_API_TOKEN`; they then skip this
 * server entirely and drive the binary against that deployment.
 *
 * ── Random port, throwaway directory ────────────────────────────────
 *
 * Port 0, so the kernel picks. A fixed port means another checkout's server
 * answers these requests and the suite passes against code that is not this
 * one — the failure is invisible, because passing is exactly what it looks
 * like. The state lives in a fresh `mkdtemp` directory for the same reason: a
 * shared one would let a previous run's records decide this run's assertions.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_BASE_PATH } from "../../config.js";

export type LocalApi = {
  origin: string;
  token: string;
  dataDir: string;
  stop(): Promise<void>;
};

type Item = { id: string; title: string; status: string; ownerId: string };

/** Start the stand-in. `scopes` is what its one token reports for `GET /me`. */
export async function startLocalApi(scopes: readonly string[]): Promise<LocalApi> {
  const dataDir = mkdtempSync(join(tmpdir(), "starter-mcp-it-"));
  const statePath = join(dataDir, "items.json");
  writeFileSync(
    statePath,
    JSON.stringify([{ id: "i1", title: "Seeded", status: "draft", ownerId: "usr_1" }]),
  );
  const token = "sk_integration_test";

  const readItems = (): Item[] => JSON.parse(readFileSync(statePath, "utf-8")) as Item[];
  const writeItems = (items: Item[]): void => writeFileSync(statePath, JSON.stringify(items));

  const problem = (status: number, slug: string, detail: string): [number, string, string] => [
    status,
    "application/problem+json",
    JSON.stringify({
      type: `https://example.invalid/problems/${slug}`,
      title: "Refused",
      status,
      detail,
      instance: "/api/v1",
    }),
  ];

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.startsWith(API_BASE_PATH)
      ? url.pathname.slice(API_BASE_PATH.length)
      : null;

    const send = ([status, type, body]: [number, string, string]): void => {
      res.writeHead(status, { "content-type": type });
      res.end(body);
    };
    const json = (status: number, body: unknown): void =>
      send([status, "application/json", JSON.stringify(body)]);

    if (path === null) {
      send(problem(404, "not-found", "No such route."));
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      send(problem(401, "invalid-token", "Provide a valid API token as `Authorization: Bearer`."));
      return;
    }

    if (req.method === "GET" && path === "/me") {
      json(200, {
        data: { tokenId: "tok_1", tenantId: "ten_1", userId: "usr_1", scopes, permissions: [] },
      });
      return;
    }
    if (req.method === "GET" && path.startsWith("/items?")) {
      json(200, { data: readItems(), nextCursor: null });
      return;
    }
    if (req.method === "GET" && path === "/items") {
      json(200, { data: readItems(), nextCursor: null });
      return;
    }
    const itemId = /^\/items\/([^/?]+)$/.exec(path)?.[1];
    if (req.method === "GET" && itemId !== undefined) {
      const found = readItems().find((item) => item.id === decodeURIComponent(itemId));
      if (!found) {
        send(problem(404, "not-found", "No such item."));
        return;
      }
      json(200, { data: found });
      return;
    }
    if (req.method === "DELETE" && itemId !== undefined) {
      const id = decodeURIComponent(itemId);
      writeItems(readItems().filter((item) => item.id !== id));
      json(200, { data: { success: true, id } });
      return;
    }
    send(problem(404, "not-found", `No handler for ${req.method} ${path}.`));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port was assigned");

  return {
    origin: `http://127.0.0.1:${address.port}`,
    token,
    dataDir,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          rmSync(dataDir, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}
