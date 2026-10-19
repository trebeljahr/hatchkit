/**
 * Cloudflare Access in front of Coolify (src/deploy/coolify-access.ts,
 * src/utils/coolify-api.ts).
 *
 * Since 2026-10-19 Coolify's hostname is behind an Access application; the
 * properties pinned here:
 *   1. Every CoolifyApi call to a Coolify with a registered service token
 *      carries CF-Access-Client-Id/-Secret — and only to that origin.
 *   2. An Access sign-in page instead of Coolify is a clear error naming
 *      `hatchkit coolify access`, not "response is not JSON".
 *   3. The command finds the main application and the three bypasses by
 *      exact domain, so it never deletes the webhook or Sentinel bypass.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import { findCoolifyAccessApps, serviceTokenPolicy } from "./src/deploy/coolify-access.js";
import {
  CoolifyApi,
  accessHeaders,
  isAccessSignIn,
  registerCoolifyAccess,
} from "./src/utils/coolify-api.js";

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.log(`  ✗ ${name}\n    ${(err as Error).message.split("\n").join("\n    ")}`);
  }
}

async function main() {
  console.log("\ncoolify-access — finding the applications");

  const apps = [
    { id: "1", name: "Coolify dashboard", domain: "coolify.example.com" },
    { id: "2", name: "webhooks", domain: "coolify.example.com/webhooks/source/github/events" },
    { id: "3", name: "sentinel", domain: "coolify.example.com/api/v1/sentinel/push" },
    { id: "4", name: "api", domain: "Coolify.Example.com/api/v1" },
    { id: "5", name: "other", domain: "coolify.example.com.evil.test" },
  ];

  await check("main app and each bypass by exact domain, case-insensitive", () => {
    const f = findCoolifyAccessApps(apps, "coolify.example.com");
    assert.equal(f.main?.id, "1");
    assert.equal(f.webhookBypass?.id, "2");
    assert.equal(f.sentinelBypass?.id, "3");
    assert.equal(f.apiBypass?.id, "4");
  });

  await check("a lookalike domain is never taken for the main app", () => {
    assert.equal(findCoolifyAccessApps(apps.slice(4), "coolify.example.com").main, undefined);
  });

  await check("the Service Auth policy names the token and is not a bypass", () => {
    assert.deepEqual(serviceTokenPolicy("tok-1"), {
      name: "Service Auth: hatchkit CLI",
      decision: "non_identity",
      include: [{ service_token: { token_id: "tok-1" } }],
      precedence: 2,
    });
  });

  console.log("\ncoolify-access — headers on Coolify calls");

  await check("registered token goes to its own origin only", () => {
    registerCoolifyAccess("https://coolify.example.com/", {
      clientId: "id-1",
      clientSecret: "sec-1",
    });
    const h = accessHeaders("https://coolify.example.com", { Accept: "application/json" });
    assert.equal(h.get("CF-Access-Client-Id"), "id-1");
    assert.equal(h.get("CF-Access-Client-Secret"), "sec-1");
    assert.equal(h.get("Accept"), "application/json");
    assert.equal(
      accessHeaders("https://other.example.com", undefined).get("CF-Access-Client-Id"),
      null,
    );
    registerCoolifyAccess("https://coolify.example.com", null);
    assert.equal(
      accessHeaders("https://coolify.example.com", undefined).get("CF-Access-Client-Id"),
      null,
    );
  });

  await check("env fallback when nothing is registered", () => {
    process.env.HATCHKIT_COOLIFY_ACCESS_CLIENT_ID = "env-id";
    process.env.HATCHKIT_COOLIFY_ACCESS_CLIENT_SECRET = "env-sec";
    try {
      assert.equal(
        accessHeaders("https://coolify.example.com", undefined).get("CF-Access-Client-Id"),
        "env-id",
      );
    } finally {
      delete process.env.HATCHKIT_COOLIFY_ACCESS_CLIENT_ID;
      delete process.env.HATCHKIT_COOLIFY_ACCESS_CLIENT_SECRET;
    }
  });

  await check("isAccessSignIn tells the sign-in apart from Coolify", () => {
    assert.equal(
      isAccessSignIn({
        url: "https://team.cloudflareaccess.com/cdn-cgi/access/login/coolify.example.com",
      }),
      true,
    );
    assert.equal(
      isAccessSignIn({ url: "https://coolify.example.com/cdn-cgi/access/login/x" }),
      true,
    );
    assert.equal(isAccessSignIn({ url: "https://coolify.example.com/api/v1/version" }), false);
    assert.equal(isAccessSignIn({ url: "" }), false);
  });

  const realFetch = globalThis.fetch;
  const seen: Headers[] = [];
  let answerFrom = "https://coolify.example.com/api/v1/version";
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    seen.push(new Headers(init?.headers));
    const res = new Response(JSON.stringify({ version: "4.4.6" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    Object.defineProperty(res, "url", { value: answerFrom });
    return res;
  }) as typeof fetch;
  try {
    const api = new CoolifyApi({ url: "https://coolify.example.com", token: "root" });

    await check("CoolifyApi sends bearer and Access headers together", async () => {
      registerCoolifyAccess("https://coolify.example.com", {
        clientId: "id-2",
        clientSecret: "sec-2",
      });
      await api.listDatabases();
      const h = seen.at(-1) as Headers;
      assert.equal(h.get("Authorization"), "Bearer root");
      assert.equal(h.get("CF-Access-Client-Id"), "id-2");
      assert.equal(h.get("CF-Access-Client-Secret"), "sec-2");
      registerCoolifyAccess("https://coolify.example.com", null);
    });

    await check("an Access sign-in page is an error that names the fix", async () => {
      answerFrom = "https://team.cloudflareaccess.com/cdn-cgi/access/login/coolify.example.com";
      await assert.rejects(
        () => api.listDatabases(),
        /Cloudflare Access answered with its sign-in page.*hatchkit coolify access/s,
      );
    });
  } finally {
    globalThis.fetch = realFetch;
  }

  if (failures > 0) {
    console.log(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nall coolify-access checks passed");
}

main();
