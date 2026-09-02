/**
 * Coolify's per-build PATCH allow-list, and what `updateApplication`
 * does when a field falls outside it.
 *
 * The bug these encode, reproduced 2026-09-02 against Coolify
 * 4.0.0-beta.469 while syncing a `split` project:
 *
 *   ✖ Coolify: PATCH failed: … 422 Unprocessable Entity —
 *     {"message":"Validation failed.",
 *      "errors":{"is_stripprefix_enabled":["This field is not allowed."]}}
 *
 * One rejected field failed the WHOLE request, so `docker_compose_domains`
 * never landed and BOTH apps of the project ended up with no domain —
 * under a summary that read "✓ Synced 2 app(s) to manifest state."
 *
 * Two independent defences, both asserted here:
 *   1. `split` has no strip-prefix opinion at all (test-routing.ts), so
 *      the field is never in the body to begin with.
 *   2. Where the field IS wanted, a rejection drops it and retries —
 *      the domains matter more than the toggle. An ESSENTIAL field
 *      still throws, because dropping it would report success for a
 *      call that changed nothing the caller asked for.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import {
  CoolifyApi,
  describeCoolifyPatchLimit,
  parseRejectedFields,
} from "./src/utils/coolify-api.js";

const failures: string[] = [];

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`  ✗ ${label}: ${(err as Error).message}`);
  }
}

/** The exact error string `CoolifyApi.request` builds for a 422 whose
 *  body names `fields` as not allowed. Written out in full rather than
 *  hand-shortened so the parser is tested against the real shape. */
function rejection(...fields: string[]): string {
  const errors = Object.fromEntries(fields.map((f) => [f, ["This field is not allowed."]]));
  return (
    "Coolify API PATCH /applications/abc failed: 422 Unprocessable Entity — " +
    JSON.stringify({ message: "Validation failed.", errors })
  );
}

/** Stand in for `fetch` so no test touches a real Coolify. Returns 422
 *  with a not-allowed body for as long as the request still carries a
 *  field in `rejects`, then 200. Records every body it saw. */
function fakeCoolify(rejects: string[]): {
  fetch: typeof fetch;
  bodies: Array<Record<string, unknown>>;
} {
  const bodies: Array<Record<string, unknown>> = [];
  const impl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    bodies.push(body);
    const offending = rejects.filter((f) => f in body);
    if (offending.length > 0) {
      const errors = Object.fromEntries(offending.map((f) => [f, ["This field is not allowed."]]));
      return new Response(JSON.stringify({ message: "Validation failed.", errors }), {
        status: 422,
        statusText: "Unprocessable Entity",
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch: impl as unknown as typeof fetch, bodies };
}

async function withFakeFetch<T>(
  fake: { fetch: typeof fetch },
  fn: (api: CoolifyApi) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fake.fetch;
  try {
    return await fn(new CoolifyApi({ url: "https://coolify.example", token: "t" }));
  } finally {
    globalThis.fetch = original;
  }
}

// ---------------------------------------------------------------------------
// Parsing Coolify's 422
// ---------------------------------------------------------------------------

await check("parses the rejected field out of a real 422 body", () => {
  assert.deepEqual(parseRejectedFields(rejection("is_stripprefix_enabled")), [
    "is_stripprefix_enabled",
  ]);
});

await check("parses several rejected fields at once", () => {
  assert.deepEqual(parseRejectedFields(rejection("docker_compose_raw", "source_id")), [
    "docker_compose_raw",
    "source_id",
  ]);
});

await check("ignores validation errors that are not field rejections", () => {
  const msg =
    "Coolify API PATCH /applications/abc failed: 422 Unprocessable Entity — " +
    JSON.stringify({
      message: "Validation failed.",
      errors: { domains: ["The domains field must be a valid URL."] },
    });
  assert.deepEqual(parseRejectedFields(msg), [], "a bad value is not a forbidden field");
});

await check("returns [] rather than throwing on an error with no JSON body", () => {
  assert.deepEqual(parseRejectedFields("Coolify API PATCH failed: 500 Internal Server Error"), []);
  assert.deepEqual(parseRejectedFields(""), []);
});

await check("falls back to a regex when the 422 body is truncated", () => {
  // Real transport truncation: the JSON tail won't parse, but the field
  // name is still the actionable part of the message.
  const truncated =
    'Coolify API PATCH /applications/abc failed: 422 — {"message":"Validation failed.",' +
    '"errors":{"is_stripprefix_enabled":["This field is not allowed."';
  assert.deepEqual(parseRejectedFields(truncated), ["is_stripprefix_enabled"]);
});

// ---------------------------------------------------------------------------
// The known limits, as user-facing text
// ---------------------------------------------------------------------------

await check("the compose-domains limit says an undeployed app can't be given a domain", () => {
  for (const field of ["docker_compose_raw", "docker_compose_domains"]) {
    const text = describeCoolifyPatchLimit(field);
    assert.ok(text, `${field} must be explained`);
    assert.match(text, /never deployed/i, "the precondition is what the user needs to know");
    assert.match(text, /hatchkit sync/, "and the way forward");
  }
});

await check("source_id / source_type are explained rather than surfaced raw", () => {
  assert.ok(describeCoolifyPatchLimit("source_id"));
  assert.ok(describeCoolifyPatchLimit("source_type"));
});

await check("an unknown field has no invented explanation", () => {
  assert.equal(describeCoolifyPatchLimit("some_future_field"), undefined);
});

// ---------------------------------------------------------------------------
// Drop-and-retry
// ---------------------------------------------------------------------------

await check("a rejected is_stripprefix_enabled is dropped and the domains still land", async () => {
  const fake = fakeCoolify(["is_stripprefix_enabled"]);
  const result = await withFakeFetch(fake, (api) =>
    api.updateApplication("abc", {
      dockerComposeDomains: [{ name: "client", domain: "https://x.com" }],
      isStripprefixEnabled: true,
    }),
  );
  assert.deepEqual(result.droppedFields, ["is_stripprefix_enabled"]);
  assert.equal(fake.bodies.length, 2, "one rejected attempt, one retry");
  assert.ok("is_stripprefix_enabled" in fake.bodies[0]);
  assert.ok(!("is_stripprefix_enabled" in fake.bodies[1]), "the retry drops it");
  assert.deepEqual(
    fake.bodies[1].docker_compose_domains,
    [{ name: "client", domain: "https://x.com" }],
    "the domains — the whole point of the call — survive",
  );
});

await check("nothing is dropped when Coolify accepts the request", async () => {
  const fake = fakeCoolify([]);
  const result = await withFakeFetch(fake, (api) =>
    api.updateApplication("abc", {
      dockerComposeDomains: [{ name: "client", domain: "https://x.com" }],
      isStripprefixEnabled: false,
    }),
  );
  assert.deepEqual(result.droppedFields, []);
  assert.equal(fake.bodies.length, 1, "no speculative retry on a healthy build");
  assert.equal(fake.bodies[0].is_stripprefix_enabled, false);
});

await check("a rejected ESSENTIAL field throws instead of reporting a hollow success", async () => {
  const fake = fakeCoolify(["docker_compose_domains"]);
  await assert.rejects(
    () =>
      withFakeFetch(fake, (api) =>
        api.updateApplication("abc", {
          dockerComposeDomains: [{ name: "client", domain: "https://x.com" }],
        }),
      ),
    /This field is not allowed/,
  );
  assert.equal(fake.bodies.length, 1, "an essential field is never dropped, so never retried");
});

await check(
  "dropping the only field short-circuits instead of PATCHing an empty body",
  async () => {
    const fake = fakeCoolify(["is_stripprefix_enabled"]);
    const result = await withFakeFetch(fake, (api) =>
      api.updateApplication("abc", { isStripprefixEnabled: true }),
    );
    assert.deepEqual(result.droppedFields, ["is_stripprefix_enabled"]);
    assert.equal(fake.bodies.length, 1, "nothing left to ask for — don't ask");
  },
);

await check("a 422 that names no field is not retried", async () => {
  let calls = 0;
  const impl = async (): Promise<Response> => {
    calls++;
    return new Response(JSON.stringify({ message: "Validation failed.", errors: {} }), {
      status: 422,
      statusText: "Unprocessable Entity",
    });
  };
  await assert.rejects(() =>
    withFakeFetch({ fetch: impl as unknown as typeof fetch }, (api) =>
      api.updateApplication("abc", { isStripprefixEnabled: true }),
    ),
  );
  assert.equal(calls, 1, "no field named → nothing to drop → no retry loop");
});

await check("retries are bounded even if Coolify keeps rejecting", async () => {
  // A build that answers 422 naming a droppable field no matter what
  // the body holds must not spin.
  let calls = 0;
  const impl = async (): Promise<Response> => {
    calls++;
    return new Response(
      JSON.stringify({
        message: "Validation failed.",
        errors: { is_stripprefix_enabled: ["This field is not allowed."] },
      }),
      { status: 422, statusText: "Unprocessable Entity" },
    );
  };
  await assert.rejects(() =>
    withFakeFetch({ fetch: impl as unknown as typeof fetch }, (api) =>
      api.updateApplication("abc", {
        dockerComposeDomains: [{ name: "client", domain: "https://x.com" }],
        isStripprefixEnabled: true,
      }),
    ),
  );
  assert.ok(calls <= 3, `bounded retries, got ${calls} calls`);
});

await check("an empty field set is a no-op, not a PATCH", async () => {
  const fake = fakeCoolify([]);
  const result = await withFakeFetch(fake, (api) => api.updateApplication("abc", {}));
  assert.deepEqual(result.droppedFields, []);
  assert.equal(fake.bodies.length, 0);
});

if (failures.length > 0) {
  console.log("\nCoolify PATCH-limit test failures:");
  for (const f of failures) console.log(f);
  process.exit(1);
}

console.log("\nAll Coolify PATCH-limit cases passed.");
