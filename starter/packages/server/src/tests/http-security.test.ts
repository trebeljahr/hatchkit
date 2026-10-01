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

test("newsletter confirmation tokens do not appear in access logs", async () => {
  const previousSite = process.env.NEWSLETTER_SITE_URL;
  const previousSecret = process.env.NEWSLETTER_TOKEN_SECRET;
  process.env.NEWSLETTER_SITE_URL = "https://example.test";
  process.env.NEWSLETTER_TOKEN_SECRET = "test-secret";
  const logged: string[] = [];
  const server = createApp({ accessLogStream: { write: (line) => logged.push(line) } })
    .listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const response = await fetch(`${origin}/api/newsletter/confirm?token=sensitive-test-token`, {
      redirect: "manual",
    });
    assert.equal(response.status, 303);
    assert.deepEqual(logged, []);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousSite === undefined) delete process.env.NEWSLETTER_SITE_URL;
    else process.env.NEWSLETTER_SITE_URL = previousSite;
    if (previousSecret === undefined) delete process.env.NEWSLETTER_TOKEN_SECRET;
    else process.env.NEWSLETTER_TOKEN_SECRET = previousSecret;
  }
});
