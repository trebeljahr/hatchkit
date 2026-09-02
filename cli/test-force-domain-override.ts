/**
 * Contract for Coolify's `force_domain_override`.
 *
 * `hatchkit sync --force` exists to take a domain that Coolify reports
 * as claimed by another resource. Verified against Coolify
 * 4.0.0-beta.469, the server's behaviour is NOT uniform:
 *
 *   · PATCH /applications/{uuid}          → honoured.
 *   · POST create, flat `domains`         → honoured
 *     (`validateDataApplications` runs before the field is stripped).
 *   · POST create, `docker_compose_domains` → IGNORED. Upstream calls
 *     `removeUnnecessaryFieldsFromRequest`, which unsets
 *     `force_domain_override` (bootstrap/helpers/api.php), BEFORE the
 *     compose-domain conflict check reads it — so the request 409s
 *     with an error telling you to pass the flag it just discarded.
 *
 * Every hatchkit app is `dockercompose`, so the create path always
 * lands in the ignored case. We still SEND the flag — the field is in
 * Coolify's create `$allowedFields` and the plumbing should be right
 * the day upstream reorders those two lines — but we must never tell a
 * user that `--force` rescues a create. These tests pin both halves:
 * the flag goes on the wire, and the guidance doesn't lie about it.
 *
 * Run: `pnpm test`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CoolifyApi } from "./src/utils/coolify-api.js";

const failures: string[] = [];
async function expect(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}: ${(err as Error).message}`);
    console.log(`  ✗ ${label}: ${(err as Error).message}`);
  }
}

console.log("\n  test-force-domain-override\n");

function makeFetchStub() {
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
  const stub = async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: url.toString(),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body as string) : {},
    });
    return new Response('{"uuid":"x","name":"y"}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { stub, calls };
}

async function withStub(
  fn: (api: CoolifyApi) => Promise<void>,
): Promise<Array<{ url: string; method: string; body: Record<string, unknown> }>> {
  const { stub, calls } = makeFetchStub();
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub as unknown as typeof fetch;
  try {
    await fn(new CoolifyApi({ url: "https://coolify.example", token: "t" }));
  } finally {
    globalThis.fetch = realFetch;
  }
  return calls;
}

const baseCreate = {
  projectUuid: "p",
  serverUuid: "s",
  gitRepository: "https://github.com/owner/repo",
  name: "myapp",
  buildPack: "dockercompose" as const,
  dockerComposeDomains: [{ name: "client", domain: "https://myapp.example" }],
};

// ---------------------------------------------------------------------------
// buildAppCreateBody — the flag is emitted, and only when asked for.
// ---------------------------------------------------------------------------

await expect("create body: forceDomainOverride:true → force_domain_override: true", async () => {
  const calls = await withStub((api) =>
    api
      .createApplicationFromPublicRepo({ ...baseCreate, forceDomainOverride: true })
      .then(() => undefined),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://coolify.example/api/v1/applications/public");
  assert.equal(calls[0].body.force_domain_override, true);
});

await expect("create body: forceDomainOverride omitted → key absent entirely", async () => {
  const calls = await withStub((api) =>
    api.createApplicationFromPublicRepo(baseCreate).then(() => undefined),
  );
  assert.equal(
    "force_domain_override" in calls[0].body,
    false,
    "must omit the key rather than send false — Coolify's $allowedFields sees a present key",
  );
});

await expect("create body: forceDomainOverride:false → key absent", async () => {
  const calls = await withStub((api) =>
    api
      .createApplicationFromPublicRepo({ ...baseCreate, forceDomainOverride: false })
      .then(() => undefined),
  );
  assert.equal("force_domain_override" in calls[0].body, false);
});

await expect("create body: flag rides the private-github-app endpoint too", async () => {
  const calls = await withStub((api) =>
    api
      .createApplicationFromPrivateGithubApp({
        ...baseCreate,
        githubAppUuid: "gh-1",
        forceDomainOverride: true,
      })
      .then(() => undefined),
  );
  assert.equal(calls[0].url, "https://coolify.example/api/v1/applications/private-github-app");
  assert.equal(calls[0].body.force_domain_override, true);
  assert.equal(calls[0].body.github_app_uuid, "gh-1");
});

await expect("create body: flag is orthogonal to docker_compose_domains", async () => {
  const calls = await withStub((api) =>
    api
      .createApplicationFromPublicRepo({ ...baseCreate, forceDomainOverride: true })
      .then(() => undefined),
  );
  const body = calls[0].body;
  assert.equal(body.force_domain_override, true);
  assert.deepEqual(body.docker_compose_domains, [
    { name: "client", domain: "https://myapp.example" },
  ]);
  assert.equal("domains" in body, false, "compose apps must not carry the flat domains field");
});

// ---------------------------------------------------------------------------
// updateApplication — the path Coolify actually honours.
// ---------------------------------------------------------------------------

await expect("update body: forceDomainOverride:true → force_domain_override: true", async () => {
  const calls = await withStub((api) =>
    api
      .updateApplication("uuid-1", {
        dockerComposeDomains: [{ name: "client", domain: "https://myapp.example" }],
        forceDomainOverride: true,
      })
      .then(() => undefined),
  );
  assert.equal(calls[0].method, "PATCH");
  assert.equal(calls[0].body.force_domain_override, true);
});

await expect("update body: omitted → key absent", async () => {
  const calls = await withStub((api) =>
    api.updateApplication("uuid-1", { portsExposes: "3000" }).then(() => undefined),
  );
  assert.equal("force_domain_override" in calls[0].body, false);
});

// ---------------------------------------------------------------------------
// Static audit: sync threads --force to both paths, and its guidance
// never claims --force clears a create-time 409. The second half is the
// regression that actually cost debugging time.
// ---------------------------------------------------------------------------

const syncSrc = readFileSync(join(process.cwd(), "src/deploy/sync.ts"), "utf-8");

await expect("sync: --force reaches the reconcile PATCH", () => {
  assert.ok(
    /opts\.force\s*\?\s*\{\s*forceDomainOverride:\s*true\s*\}/.test(syncSrc),
    "sync's updateApplication PATCH must pass forceDomainOverride when opts.force is set",
  );
});

await expect("sync: --force reaches the create path", () => {
  assert.ok(
    /forceDomainOverride:\s*args\.force/.test(syncSrc),
    "createMissingApps must pass forceDomainOverride into provisionRoutedApp",
  );
  assert.ok(
    /createMissingApps\(\{[\s\S]{0,400}?force:\s*opts\.force/.test(syncSrc),
    "runSync must pass opts.force into createMissingApps",
  );
});

await expect("sync: the create-time 409 branch does not recommend --force", () => {
  const start = syncSrc.indexOf("errors.push(`create: ");
  assert.ok(start >= 0, "couldn't find the create error path");
  // Scan the enclosing catch block: from the preceding `catch (err)` to
  // the push itself.
  const catchStart = syncSrc.lastIndexOf("} catch (err) {", start);
  const block = syncSrc.slice(catchStart, start);
  assert.ok(
    /409|conflict/i.test(block),
    "the create catch must recognise a 409 and explain it, not surface the raw message alone",
  );
  assert.ok(
    !/re-run with `--force`|Re-run with `--force`/.test(block),
    "the create-time 409 branch must NOT tell the user to re-run with --force",
  );
  assert.ok(
    /not something `--force` can push through|`--force` cannot help/.test(block),
    "the create-time 409 branch must say --force cannot clear it",
  );
});

await expect("sync: the split pre-warning splits create vs update advice", () => {
  const start = syncSrc.indexOf("legacyDomainHolder =");
  assert.ok(start >= 0, "couldn't find the legacy-domain-holder warning");
  const block = syncSrc.slice(start, start + 2200);
  assert.ok(
    /if \(missing\.length > 0\)/.test(block),
    "the warning must branch on whether the clashing app still has to be created",
  );
  assert.ok(
    /`--force` cannot help here/.test(block),
    "the create branch must say --force cannot help",
  );
  assert.ok(
    /re-run with `--force` to take the domain over/.test(block),
    "the update branch keeps the --force advice, which is correct there",
  );
});

await expect("sync: PATCH 409 guidance still recommends --force", () => {
  assert.ok(
    /Coolify reports this domain as claimed by another resource\. Re-run with `--force`/.test(
      syncSrc,
    ),
    "the PATCH 409 path is the one case where --force is the right advice",
  );
});

console.log("");
if (failures.length > 0) {
  console.error(`  ${failures.length} test(s) failed:`);
  for (const f of failures) console.error(`    · ${f}`);
  process.exit(1);
} else {
  console.log("  all tests passed");
}
