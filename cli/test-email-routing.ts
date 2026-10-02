/**
 * Cloudflare Email Routing — access preflight, carried-forward presets,
 * `runEmailSetup` record hygiene, the doctor row, and migrate-domain's
 * email-routing step.
 *
 * Found by the collection-of-beauty migration (beauty.trebeljahr.com →
 * collectionofbeauty.com, 2026-09-13): the new apex had no MX, so the
 * site's legal contact imprint@collectionofbeauty.com bounced, and
 * `hatchkit email status` died on a raw "10000: Authentication error"
 * because the DNS token lacked the Email Routing scopes. Locked down:
 *
 *   1. A scope-less token becomes an EmailRoutingScopeError naming the
 *      two permission groups — never a bare 10000.
 *   2. The migrate plan sets up routing on the new domain when the old
 *      side used it, the manifest records it, or the state can't be
 *      read; and stands down for a receiving zone or another provider's
 *      MX.
 *   3. `runEmailSetup` leaves exactly one SPF and one DMARC record, and
 *      keeps an existing DMARC when asked to be additive.
 *   4. `hatchkit doctor` turns the missing scope into a red row with the
 *      fix.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HATCHKIT_CONF_DIR = mkdtempSync(join(tmpdir(), "email-routing-conf-"));
process.env.HATCHKIT_KEYTAR_SERVICE = `hatchkit-test-${process.pid}`;

const { checkProjectEmailRoutingState } = await import("./src/doctor.js");
const { STATIC_FORWARD_PRESETS, buildForwardPresets, resolveCarriedForwarding } = await import(
  "./src/email/presets.js"
);
const {
  EMAIL_ROUTING_TOKEN_PERMISSIONS,
  EmailRoutingScopeError,
  assertEmailRoutingAccess,
  isCloudflareAuthError,
  probeEmailRouting,
  summarizeEmailRoutingProbe,
} = await import("./src/email/routing-access.js");
const { runEmailSetup } = await import("./src/email/setup.js");
const { parseEmailFlags, recordForwarding } = await import("./src/email/index.js");
const { readManifest } = await import("./src/scaffold/manifest.js");
const { MIGRATION_PROVIDERS, planDomainMigration, planEmailRouting, selectActions } = await import(
  "./src/migrate/plan.js"
);
const { executorFor } = await import("./src/migrate/steps.js");
type EmailRoutingReader = import("./src/email/routing-access.js").EmailRoutingReader;
type MigrationPlanInput = import("./src/migrate/plan.js").MigrationPlanInput;
type ProjectManifest = import("./src/scaffold/manifest.js").ProjectManifest;

const failures: string[] = [];

async function expect(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}: ${(err as Error).message}`);
    console.log(`  ✗ ${label}`);
  }
}

const AUTH_10000 = "Cloudflare GET /zones/z1/email/routing failed: 10000: Authentication error";

/** A reader whose answers are set per test. */
function fakeReader(opts: {
  zone?: string | null;
  routing?: { enabled: boolean } | Error | null;
  destinations?: Error;
  mx?: string[];
}): EmailRoutingReader {
  return {
    async resolveZoneForName(name: string) {
      const zone = opts.zone === undefined ? name : opts.zone;
      return zone
        ? { id: "z1", name: zone, name_servers: [], status: "active", account: { id: "acc1" } }
        : null;
    },
    async getEmailRouting() {
      if (opts.routing instanceof Error) throw opts.routing;
      return opts.routing === undefined ? null : (opts.routing as never);
    },
    async listEmailDestinations() {
      if (opts.destinations) throw opts.destinations;
      return [];
    },
    async findRecordsByName() {
      return (opts.mx ?? []).map((content, i) => ({
        id: `mx${i}`,
        type: "MX",
        name: "x",
        content,
      })) as never;
    },
  };
}

// ---------------------------------------------------------------------------

console.log("access preflight:");

await expect("email flags reject the obsolete SPF switch", () => {
  assert.equal(parseEmailFlags(["--no-resend-spf"]).noResendSpf, true);
  assert.throws(() => parseEmailFlags(["--no-listmonk-spf"]), /Unknown email flag/);
});

await expect("10000 / 9109 / 403 read as auth errors; 404 and timeouts do not", () => {
  assert.ok(isCloudflareAuthError(AUTH_10000));
  assert.ok(isCloudflareAuthError("failed: 9109: Unauthorized to access requested resource"));
  assert.ok(isCloudflareAuthError("Cloudflare GET /x failed: Forbidden"));
  assert.ok(!isCloudflareAuthError("Cloudflare GET /x failed: 1001: not found"));
  assert.ok(!isCloudflareAuthError("Cloudflare GET /x failed: The operation was aborted"));
});

await expect(
  "a 10000 on the zone endpoint is 'unauthorized', with the permissions named",
  async () => {
    const probe = await probeEmailRouting(
      fakeReader({ zone: "collectionofbeauty.com", routing: new Error(AUTH_10000) }),
      "collectionofbeauty.com",
    );
    assert.equal(probe.access, "unauthorized");
    if (probe.access !== "unauthorized") return;
    assert.ok(probe.error instanceof EmailRoutingScopeError);
    assert.match(
      probe.error.message,
      /lacks Email Routing permissions for collectionofbeauty\.com/,
    );
    assert.doesNotMatch(probe.error.message, /Cloudflare GET/, "the request path is noise here");
    const hint = probe.error.hint.join("\n");
    for (const perm of EMAIL_ROUTING_TOKEN_PERMISSIONS) assert.ok(hint.includes(perm), perm);
    assert.match(hint, /dash\.cloudflare\.com\/profile\/api-tokens/);
    assert.match(hint, /hatchkit config add dns/);
  },
);

await expect("the account-scoped destinations group is checked separately", async () => {
  const probe = await probeEmailRouting(
    fakeReader({
      routing: { enabled: true },
      destinations: new Error("failed: 9109: Unauthorized to access requested resource"),
    }),
    "example.com",
  );
  assert.equal(probe.access, "unauthorized");
});

await expect("non-auth failures propagate instead of posing as a scope problem", async () => {
  await assert.rejects(
    probeEmailRouting(fakeReader({ routing: new Error("failed: 500 Internal") }), "example.com"),
    /500 Internal/,
  );
});

await expect("assertEmailRoutingAccess throws the scope error itself", async () => {
  await assert.rejects(
    assertEmailRoutingAccess(fakeReader({ routing: new Error(AUTH_10000) }), "example.com"),
    (err) => err instanceof EmailRoutingScopeError && err.hint.length > 0,
  );
});

await expect("summary: receiving / not-receiving / foreign MX / no zone", async () => {
  const sum = async (opts: Parameters<typeof fakeReader>[0]) =>
    summarizeEmailRoutingProbe(await probeEmailRouting(fakeReader(opts), "example.com"));
  assert.equal(
    (await sum({ routing: { enabled: true }, mx: ["route1.mx.cloudflare.net"] })).state,
    "receiving",
  );
  const noMx = await sum({ routing: { enabled: true }, mx: [] });
  assert.deepEqual(noMx, { state: "not-receiving", zone: "example.com", enabled: true });
  assert.equal((await sum({ routing: { enabled: false } })).state, "not-receiving");
  const google = await sum({ routing: { enabled: false }, mx: ["aspmx.l.google.com."] });
  assert.deepEqual(google, {
    state: "foreign-mx",
    zone: "example.com",
    mxHosts: ["aspmx.l.google.com"],
  });
  assert.equal((await sum({ zone: null })).state, "no-zone");
});

// ---------------------------------------------------------------------------

console.log("\npresets:");

await expect("imprint@ and privacy@ are offered and ticked", () => {
  const imprint = STATIC_FORWARD_PRESETS.find((p) => p.localPart === "imprint");
  const privacy = STATIC_FORWARD_PRESETS.find((p) => p.localPart === "privacy");
  assert.equal(imprint?.defaultChecked, true);
  assert.equal(privacy?.defaultChecked, true);
});

await expect("a personal alias still lands right after hello@", () => {
  assert.deepEqual(
    buildForwardPresets("rico").map((p) => p.localPart),
    ["hello", "rico", "admin", "support", "hi", "imprint", "privacy"],
  );
});

await expect("carried forwarding: manifest beats old-domain rules beats defaults", () => {
  assert.deepEqual(
    resolveCarriedForwarding({
      recorded: { addresses: ["Hello", "hello", "imprint"], catchAll: false },
      oldDomainLocalParts: ["sales"],
    }),
    { addresses: ["hello", "imprint"], catchAll: false, source: "manifest" },
  );
  // Recorded-but-empty is a choice ("catch-all only"), not a gap.
  assert.deepEqual(resolveCarriedForwarding({ recorded: { addresses: [] } }), {
    addresses: [],
    catchAll: true,
    source: "manifest",
  });
  assert.deepEqual(resolveCarriedForwarding({ oldDomainLocalParts: ["sales", "hello"] }), {
    addresses: ["sales", "hello"],
    catchAll: true,
    source: "old-domain-rules",
  });
  const defaults = resolveCarriedForwarding({
    oldDomainLocalParts: null,
    personalLocalPart: "rico",
  });
  assert.equal(defaults.source, "defaults");
  assert.deepEqual(defaults.addresses, ["hello", "rico", "admin", "support", "imprint", "privacy"]);
  assert.equal(defaults.catchAll, true);
});

// ---------------------------------------------------------------------------

console.log("\nmigrate-domain plan:");

const COB_OLD = "beauty.trebeljahr.com";
const COB_NEW = "collectionofbeauty.com";
const COB = {
  version: 4,
  name: "collection-of-beauty",
  domain: COB_NEW,
  features: ["s3"],
  email: { transactional: "none", mailingList: "none" },
  ses: { identity: `mail.${COB_NEW}` },
} as unknown as ProjectManifest;
const ALL_CONFIGURED = Object.fromEntries(MIGRATION_PROVIDERS.map((p) => [p, true]));

function input(overrides: Partial<MigrationPlanInput> = {}): MigrationPlanInput {
  return {
    manifest: COB,
    newDomain: COB_NEW,
    oldDomain: COB_OLD,
    oldDomainSource: "--from",
    configured: ALL_CONFIGURED,
    includeCleanup: true,
    ...overrides,
  };
}

await expect(
  "collection-of-beauty as it is today: token can't read → planned, with the fix",
  () => {
    const [action] = planEmailRouting(
      input({
        emailRouting: {
          newDomain: { state: "unauthorized", zone: COB_NEW },
          oldDomain: { state: "unauthorized", zone: "trebeljahr.com" },
        },
      }),
    );
    assert.equal(action.id, "email-routing:setup");
    assert.equal(action.phase, "prepare", "adding MX to the new zone is additive");
    assert.equal(action.kind, "create");
    assert.match(action.summary, /@collectionofbeauty\.com/);
    const detail = (action.detail ?? []).join("\n");
    assert.match(detail, /Email Routing Rules → Edit/);
    assert.match(detail, /imprint@/, "the defaults it falls back to include imprint@");
  },
);

await expect("old zone routes mail, new apex has no MX → planned", () => {
  const [action] = planEmailRouting(
    input({
      emailRouting: {
        newDomain: { state: "not-receiving", zone: COB_NEW, enabled: false },
        oldDomain: { state: "not-receiving", zone: "trebeljahr.com", enabled: true },
      },
    }),
  );
  assert.equal(action.kind, "create");
  assert.match((action.detail ?? [])[0], /Email Routing is on for trebeljahr\.com/);
});

await expect("manifest-recorded forwarding is planned even when the old zone is quiet", () => {
  const recorded = {
    ...COB,
    integrations: {
      email: {
        domain: COB_OLD,
        configuredAt: "2026-01-01T00:00:00.000Z",
        destinationEmail: "me@example.com",
        addresses: ["hello", "imprint"],
        catchAll: false,
      },
    },
  } as ProjectManifest;
  const [action] = planEmailRouting(
    input({
      manifest: recorded,
      emailRouting: {
        newDomain: { state: "not-receiving", zone: COB_NEW, enabled: false },
        oldDomain: { state: "not-receiving", zone: "trebeljahr.com", enabled: false },
      },
    }),
  );
  assert.equal(action.kind, "create");
  const detail = (action.detail ?? []).join("\n");
  assert.match(detail, /me@example\.com/);
  assert.match(detail, /hello@, imprint@; catch-all off/);
});

await expect("recording an existing rule keeps its own forwarding destination", () => {
  const dir = mkdtempSync(join(tmpdir(), "email-forward-manifest-"));
  try {
    writeFileSync(join(dir, ".hatchkit.json"), JSON.stringify({
      ...COB,
      domain: COB_OLD,
      integrations: { email: {
        domain: COB_OLD,
        configuredAt: "2026-01-01T00:00:00.000Z",
        destinationEmail: "main@example.com",
        addresses: ["hello"],
      } },
    }));
    recordForwarding(dir, COB_OLD, "support", "support@example.org");
    const email = readManifest(dir)?.integrations?.email;
    assert.deepEqual(email?.addresses, ["hello", "support"]);
    assert.equal(email?.addressDestinations?.support, "support@example.org");
    assert.equal(email?.destinationEmail, "main@example.com");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await expect("already receiving on the new domain → no-op (idempotent re-run)", () => {
  const [action] = planEmailRouting(
    input({ emailRouting: { newDomain: { state: "receiving", zone: COB_NEW } } }),
  );
  assert.equal(action.kind, "noop");
});

await expect("another provider's MX on the new domain → no-op, never mixed in", () => {
  const [action] = planEmailRouting(
    input({
      emailRouting: {
        newDomain: { state: "foreign-mx", zone: COB_NEW, mxHosts: ["aspmx.l.google.com"] },
        oldDomain: { state: "receiving", zone: "trebeljahr.com" },
      },
    }),
  );
  assert.equal(action.kind, "noop");
  assert.match(action.summary, /aspmx\.l\.google\.com/);
});

await expect(
  "nothing to carry over (known state, no record) → no-op naming the manual command",
  () => {
    const [action] = planEmailRouting(
      input({
        emailRouting: {
          newDomain: { state: "not-receiving", zone: COB_NEW, enabled: false },
          oldDomain: { state: "not-receiving", zone: "trebeljahr.com", enabled: false },
        },
      }),
    );
    assert.equal(action.kind, "noop");
    assert.match(
      (action.detail ?? []).join("\n"),
      /hatchkit email setup --domain collectionofbeauty\.com/,
    );
  },
);

await expect("no DNS credential → manual row, not a silent drop", () => {
  const [action] = planEmailRouting(input({ configured: { ...ALL_CONFIGURED, dns: false } }));
  assert.equal(action.kind, "manual");
  assert.ok((action.detail ?? []).some((d) => d.includes("hatchkit config add dns")));
});

await expect(
  "the step is in the full plan, has an executor, and `--only email-routing` selects it",
  () => {
    const plan = planDomainMigration(input());
    const selected = selectActions(plan, { phase: "prepare", only: "email-routing" });
    assert.deepEqual(
      selected.map((a) => a.id),
      ["email-routing:setup"],
    );
    assert.doesNotThrow(() => executorFor("email-routing:setup"));
    assert.ok(MIGRATION_PROVIDERS.includes("email-routing"));
    assert.equal(selectActions(plan, { phase: "cleanup", only: "email-routing" }).length, 0);
  },
);

// ---------------------------------------------------------------------------

console.log("\nrunEmailSetup against a fake Cloudflare:");

interface Rec {
  id: string;
  type: string;
  name: string;
  content: string;
  priority?: number;
}

/** Just enough of the Cloudflare v4 API for `runEmailSetup`. */
function installFakeCloudflare(state: {
  records: Rec[];
  routingEnabled?: boolean;
  auth?: boolean;
}) {
  let seq = 0;
  const ok = (result: unknown) =>
    new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
      status: 200,
    });
  const fail = (code: number, message: string, status = 403) =>
    new Response(
      JSON.stringify({ success: false, errors: [{ code, message }], messages: [], result: null }),
      { status },
    );
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const path = u.pathname.replace("/client/v4", "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method === "GET" && path === "/zones") {
      const name = u.searchParams.get("name");
      return ok(
        name === "example.com"
          ? [{ id: "z1", name, name_servers: [], status: "active", account: { id: "acc1" } }]
          : [],
      );
    }
    if (path.includes("/email/routing") && state.auth === false) {
      return fail(10000, "Authentication error");
    }
    if (path === "/zones/z1/email/routing") return ok({ enabled: !!state.routingEnabled });
    if (path === "/zones/z1/email/routing/enable") {
      state.routingEnabled = true;
      return ok({ enabled: true });
    }
    if (path === "/zones/z1/email/routing/dns") return ok([]);
    if (path === "/accounts/acc1/email/routing/addresses") {
      return method === "GET" ? ok([]) : ok({ id: "d1", email: body.email, verified: "active" });
    }
    if (path === "/zones/z1/email/routing/rules") {
      return method === "GET" ? ok([]) : ok({ id: `rule${++seq}` });
    }
    if (path === "/zones/z1/email/routing/rules/catch_all") {
      return ok({ enabled: false, matchers: [{ type: "all" }], actions: [] });
    }
    if (path === "/zones/z1/dns_records") {
      if (method === "POST") {
        const rec = { id: `r${++seq}`, ...body };
        state.records.push(rec);
        return ok(rec);
      }
      const name = u.searchParams.get("name");
      const type = u.searchParams.get("type");
      const content = u.searchParams.get("content");
      return ok(
        state.records.filter(
          (r) =>
            r.name === name && (!type || r.type === type) && (!content || r.content === content),
        ),
      );
    }
    const byId = path.match(/^\/zones\/z1\/dns_records\/(.+)$/);
    if (byId && method === "DELETE") {
      state.records = state.records.filter((r) => r.id !== byId[1]);
      return ok({ id: byId[1] });
    }
    return fail(7003, `unhandled ${method} ${path}`, 404);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const setupOpts = {
  token: "t",
  domain: "example.com",
  destination: "me@example.org",
  addresses: ["imprint"],
  catchAll: true,
};

await expect("an existing SPF is merged into ONE record, not joined by a second", async () => {
  const state = {
    records: [
      {
        id: "old-spf",
        type: "TXT",
        name: "example.com",
        content: "v=spf1 ip4:192.0.2.1 a mx include:amazonses.com -all",
      },
    ] as Rec[],
  };
  const restore = installFakeCloudflare(state);
  try {
    await runEmailSetup(setupOpts);
  } finally {
    restore();
  }
  const spf = state.records.filter((r) => r.type === "TXT" && /^v=spf1/.test(r.content));
  assert.equal(spf.length, 1, `SPF rows: ${spf.map((r) => r.content).join(" | ")}`);
  assert.match(spf[0].content, /include:amazonses\.com/);
  assert.match(spf[0].content, /include:_spf\.mx\.cloudflare\.net/);
  assert.match(spf[0].content, /ip4:192\.0\.2\.1 a mx/);
  assert.match(spf[0].content, /-all$/);
  assert.equal(state.records.filter((r) => r.type === "MX").length, 3);
});

await expect("an existing DMARC is replaced in place — or kept, for additive callers", async () => {
  const existing = {
    id: "old-dmarc",
    type: "TXT",
    name: "_dmarc.example.com",
    content: "v=DMARC1; p=reject",
  };

  const replaced = { records: [{ ...existing }] as Rec[] };
  let restore = installFakeCloudflare(replaced);
  try {
    await runEmailSetup(setupOpts);
  } finally {
    restore();
  }
  const afterReplace = replaced.records.filter((r) => r.name === "_dmarc.example.com");
  assert.equal(afterReplace.length, 1, "two DMARC records make receivers ignore both");
  assert.match(afterReplace[0].content, /p=quarantine/);

  const kept = { records: [{ ...existing }] as Rec[] };
  restore = installFakeCloudflare(kept);
  try {
    await runEmailSetup({ ...setupOpts, preserveExistingDmarc: true });
  } finally {
    restore();
  }
  assert.deepEqual(
    kept.records.filter((r) => r.name === "_dmarc.example.com"),
    [existing],
  );
});

await expect(
  "a scope-less token fails with the permissions, before anything is written",
  async () => {
    const state = { records: [] as Rec[], auth: false };
    const restore = installFakeCloudflare(state);
    try {
      await assert.rejects(runEmailSetup(setupOpts), (err) => {
        assert.ok(err instanceof EmailRoutingScopeError);
        assert.match(err.hint.join("\n"), /Email Routing Addresses → Edit/);
        return true;
      });
    } finally {
      restore();
    }
    assert.equal(state.records.length, 0);
  },
);

// ---------------------------------------------------------------------------

console.log("\ndoctor:");

const projectDir = mkdtempSync(join(tmpdir(), "email-routing-project-"));
writeFileSync(join(projectDir, ".hatchkit.json"), "{}");

const doctorFor = (manifest: object, reader: EmailRoutingReader) =>
  checkProjectEmailRoutingState(projectDir, {
    readManifest: () => manifest as ProjectManifest,
    getDnsConfig: async () => ({ apiToken: "t" }) as never,
    makeClient: () => reader,
  });

await expect(
  "missing scopes → fail row carrying the permission hint, not a raw 10000",
  async () => {
    const [row] = await doctorFor(COB, fakeReader({ routing: new Error(AUTH_10000) }));
    assert.equal(row.status, "fail");
    assert.equal(row.name, "Email Routing (collectionofbeauty.com)");
    assert.match(row.detail ?? "", /lacks Email Routing permissions/);
    assert.ok((row.hint ?? []).some((h) => h.includes("Email Routing Rules → Edit")));
  },
);

await expect(
  "forwarding recorded for this domain but no MX → fail with the repair command",
  async () => {
    const manifest = {
      ...COB,
      integrations: { email: { domain: COB_NEW, configuredAt: "x" } },
    };
    const [row] = await doctorFor(manifest, fakeReader({ routing: { enabled: false } }));
    assert.equal(row.status, "fail");
    assert.ok((row.hint ?? []).some((h) => h.includes("hatchkit email setup --domain")));
  },
);

await expect("never set up and no MX → not-configured row that says mail bounces", async () => {
  const [row] = await doctorFor(COB, fakeReader({ routing: { enabled: false } }));
  assert.equal(row.status, "skip");
  assert.match(row.detail ?? "", /mail to @collectionofbeauty\.com bounces/);
});

await expect("receiving → ok", async () => {
  const [row] = await doctorFor(
    COB,
    fakeReader({ routing: { enabled: true }, mx: ["route2.mx.cloudflare.net"] }),
  );
  assert.equal(row.status, "ok");
});

rmSync(projectDir, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nAll email-routing tests passed.");
