/**
 * The shared Listmonk default sender and the global credential check.
 *
 *  - `checkListmonk` (doctor) authenticates the stored API user with
 *    `GET /api/profile`. A deleted API user answered "configured" before,
 *    because nothing called Listmonk.
 *  - It warns when `app.from_email` is unset or a project's
 *    `mail.<domain>` sender, and offers a `--fix` repair only when a
 *    neutral sender is configured. One Listmonk serves every project, and
 *    its own opt-in mail goes out under that one address.
 *  - `verifyProviderCredentials` (status) marks a rejected credential
 *    `verified: false` and puts the fix first in the suggestions.
 *  - `validateListmonkDefaultFrom` refuses a project's sender as the
 *    neutral default; `setListmonkDefaultFromEmail` stores it without
 *    touching the credential.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import {
  getListmonkDefaultFromEmail,
  getStore,
  setListmonkDefaultFromEmail,
  validateListmonkDefaultFrom,
} from "./src/config.js";
import { checkListmonk } from "./src/doctor.js";
import { collectStatus, verifyProviderCredentials } from "./src/status.js";

const failures: string[] = [];

async function expectAsync(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}: ${(err as Error).message}`);
    console.log(`  ✗ ${label}`);
  }
}

const auth = { url: "https://listmonk.test/", apiUser: "hatchkit", apiToken: "tok" };
const neutral = "Newsletter <noreply@trebeljahr.com>";
const chemistry = "chemistry-sketcher <noreply@mail.chemistry.trebeljahr.com>";

/** Stub a Listmonk whose profile answers `profileStatus` and whose
 *  settings hold `fromEmail`. Records every call. */
function stubListmonk(opts: {
  profileStatus?: number;
  settingsStatus?: number;
  fromEmail?: string;
}) {
  const calls: Array<{ method: string; path: string; auth?: string; body?: unknown }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = new URL(String(input)).pathname;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const raw = init?.body as string | undefined;
    calls.push({ method, path, auth: headers.Authorization, body: raw && JSON.parse(raw) });
    const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
    if (path === "/api/profile") {
      if (opts.profileStatus && opts.profileStatus !== 200) {
        return new Response('{"message":"invalid API credentials"}', {
          status: opts.profileStatus,
        });
      }
      return ok({ username: "hatchkit", type: "api", user_role: { name: "hatchkit" } });
    }
    if (path === "/api/settings") {
      if (opts.settingsStatus) return new Response("denied", { status: opts.settingsStatus });
      return ok({ "app.from_email": opts.fromEmail ?? "" });
    }
    if (method === "PUT" && path === "/api/settings/app.from_email") return ok(true);
    if (path === "/api/health") return ok(true);
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  return calls;
}

console.log("doctor checkListmonk:");

await expectAsync("a deleted API user fails with the re-create steps", async () => {
  const calls = stubListmonk({ profileStatus: 403 });
  const results = await checkListmonk({ auth, neutralFromEmail: neutral });
  assert.equal(results.length, 1, "no settings read once the credential is rejected");
  assert.equal(results[0].status, "fail");
  assert.match(results[0].detail ?? "", /HTTP 403/);
  assert.match((results[0].hint ?? []).join("\n"), /hatchkit config add listmonk/);
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    ["GET /api/profile"],
  );
  assert.equal(calls[0].auth, "token hatchkit:tok");
});

await expectAsync("a project's sender as the default warns and names its domain", async () => {
  stubListmonk({ fromEmail: chemistry });
  const [profile, sender] = await checkListmonk({ auth });
  assert.equal(profile.status, "ok");
  assert.match(profile.detail ?? "", /authenticated as hatchkit/);
  assert.equal(sender.status, "warn");
  assert.match(sender.detail ?? "", /chemistry\.trebeljahr\.com/);
  assert.match((sender.hint ?? []).join("\n"), /--default-from/);
  assert.equal(sender.repair, undefined, "nothing to write without a neutral sender");
});

await expectAsync("--fix writes the configured neutral sender, nothing else", async () => {
  const calls = stubListmonk({ fromEmail: chemistry });
  const [, sender] = await checkListmonk({ auth, neutralFromEmail: neutral });
  assert.equal(sender.status, "warn");
  assert.ok(sender.repair, "repair offered");
  const line = await sender.repair.run();
  assert.match(line, /Newsletter <noreply@trebeljahr\.com>/);
  const puts = calls.filter((c) => c.method === "PUT");
  assert.deepEqual(
    puts.map((c) => [c.path, c.body]),
    [["/api/settings/app.from_email", neutral]],
  );
});

await expectAsync("an unset or install-default sender warns", async () => {
  stubListmonk({ fromEmail: "listmonk <noreply@listmonk.yoursite.com>" });
  const [, sender] = await checkListmonk({ auth, neutralFromEmail: neutral });
  assert.equal(sender.status, "warn");
  assert.match(sender.detail ?? "", /install default/);
});

await expectAsync("the neutral sender, or any non-project sender, is ok", async () => {
  stubListmonk({ fromEmail: neutral });
  assert.equal((await checkListmonk({ auth, neutralFromEmail: neutral }))[1].status, "ok");
  stubListmonk({ fromEmail: "Ops <ops@example.com>" });
  assert.equal((await checkListmonk({ auth }))[1].status, "ok");
});

await expectAsync("an API user without Settings: All skips the sender check", async () => {
  stubListmonk({ settingsStatus: 403 });
  const [profile, sender] = await checkListmonk({ auth });
  assert.equal(profile.status, "ok");
  assert.equal(sender.status, "skip");
});

console.log("\nstatus verifyProviderCredentials:");

getStore().set("providers.listmonk", {
  status: "configured",
  url: "https://listmonk.test",
  apiUser: "hatchkit",
});

await expectAsync("status lists Listmonk from config alone", () => {
  const row = collectStatus().providers.find((p) => p.key === "listmonk");
  assert.equal(row?.configured, true);
  assert.equal(row?.verified, undefined);
});

await expectAsync("a rejected credential is marked broken, fix first", async () => {
  stubListmonk({ profileStatus: 401 });
  const s = await verifyProviderCredentials(collectStatus(), { listmonk: async () => auth });
  const row = s.providers.find((p) => p.key === "listmonk");
  assert.equal(row?.verified, false);
  assert.match(row?.problem ?? "", /HTTP 401/);
  assert.equal(s.suggestions[0].command, "hatchkit config add listmonk");
});

await expectAsync("a missing keychain token is marked broken without a request", async () => {
  const calls = stubListmonk({});
  const s = await verifyProviderCredentials(collectStatus(), { listmonk: async () => null });
  assert.equal(s.providers.find((p) => p.key === "listmonk")?.verified, false);
  assert.equal(calls.length, 0);
});

await expectAsync("a working credential is verified", async () => {
  stubListmonk({});
  const s = await verifyProviderCredentials(collectStatus(), { listmonk: async () => auth });
  assert.equal(s.providers.find((p) => p.key === "listmonk")?.verified, true);
  assert.notEqual(s.suggestions[0].command, "hatchkit config add listmonk");
});

console.log("\nconfig neutral default sender:");

await expectAsync("refuses a project's mail.<domain> sender and malformed input", () => {
  assert.equal(validateListmonkDefaultFrom(""), true);
  assert.equal(validateListmonkDefaultFrom(neutral), true);
  assert.equal(validateListmonkDefaultFrom("noreply@trebeljahr.com"), true);
  assert.match(String(validateListmonkDefaultFrom(chemistry)), /project's SES sender/);
  assert.match(String(validateListmonkDefaultFrom("not an address")), /Expected an address/);
});

await expectAsync("stores and clears the sender, keeping the credential", () => {
  setListmonkDefaultFromEmail(` ${neutral} `);
  assert.equal(getListmonkDefaultFromEmail(), neutral);
  assert.equal((getStore().get("providers.listmonk") as { apiUser: string }).apiUser, "hatchkit");
  assert.throws(() => setListmonkDefaultFromEmail(chemistry), /project's SES sender/);
  assert.equal(getListmonkDefaultFromEmail(), neutral);
  setListmonkDefaultFromEmail("");
  assert.equal(getListmonkDefaultFromEmail(), undefined);
});

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nAll Listmonk default-sender tests passed.");
