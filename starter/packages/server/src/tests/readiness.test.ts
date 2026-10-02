import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

process.env.FRONTEND_URL = "https://hatchkit-test.trebeljahr.com";
process.env.REDIS_URL = "redis://127.0.0.1:1";

const { createApp } = await import("../app.js");

test("split API refuses readiness before Mongo and Redis are connected", async () => {
  const server = createApp().listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const response = await fetch(`${base}/api/health`, {
      headers: { Origin: "https://hatchkit-test.trebeljahr.com" },
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://hatchkit-test.trebeljahr.com");
    const body = (await response.json()) as { status: string; db: boolean; redis: boolean };
    assert.equal(body.status, "degraded");
    assert.equal(body.db, false);
    assert.equal(body.redis, false);
  } finally {
    server.close();
  }
});
