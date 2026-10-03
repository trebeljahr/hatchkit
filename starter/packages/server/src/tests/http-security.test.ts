import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApp } from "../app.js";

test("auth and webhook responses receive security headers", async () => {
  const server = createApp().listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const auth = await fetch(`${origin}/api/auth/no-such-route`);
    const webhook = await fetch(`${origin}/api/stripe/webhook`, { method: "POST" });
    for (const response of [auth, webhook]) {
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
