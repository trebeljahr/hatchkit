import assert from "node:assert/strict";
import { Agent, createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { closeHttpServer } from "../shutdown.js";

test("shutdown keeps dependencies available until an accepted HTTP request completes", async () => {
  let completeRequest!: () => void;
  let requestStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    requestStarted = resolve;
  });
  let dependenciesConnected = true;
  const server = createServer((_request, response) => {
    completeRequest = () => {
      assert.equal(dependenciesConnected, true, "DB must remain available for the active request");
      response.end("committed");
    };
    requestStarted();
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  let client: ReturnType<typeof request> | undefined;
  try {
    const result = new Promise<string>((resolve, reject) => {
      client = request(`http://127.0.0.1:${port}`, { agent: false }, (response) => {
        let body = "";
        response.on("data", (part) => {
          body += part;
        });
        response.on("end", () => resolve(body));
        response.on("error", reject);
      });
      client.on("error", reject);
      client.end();
    });
    await started;
    let closed = false;
    const shutdown = closeHttpServer(server).then(() => {
      dependenciesConnected = false;
      closed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closed, false, "shutdown must await the accepted request");
    completeRequest();
    assert.equal(await result, "committed");
    await shutdown;
    assert.equal(closed, true);
    assert.equal(dependenciesConnected, false);
  } finally {
    client?.destroy();
    server.closeAllConnections();
    server.close();
  }
});

test("an active keep-alive socket cannot hold shutdown open when its client reuses it", async () => {
  let finish!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const server = createServer((req, res) => {
    if (req.url === "/slow") {
      finish = () => res.end("finished");
      markStarted();
    } else res.end("health");
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const read = (path: string) =>
    new Promise<string>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port, path, agent }, (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve(body));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end();
    });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const longRequest = read("/slow");
    await started;
    // Queue behind the active request on the same TCP connection. This models
    // the proxy's pool reusing a socket after the listener has stopped.
    const queued = read("/health").catch(() => "connection retired");
    const closed = closeHttpServer(server);
    finish();
    assert.equal(await longRequest, "finished");
    await Promise.race([
      closed,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error("keep-alive reuse held shutdown open")), 1000);
      }),
    ]);
    await queued;
  } finally {
    if (deadline) clearTimeout(deadline);
    agent.destroy();
    server.closeAllConnections();
    server.close();
  }
});
