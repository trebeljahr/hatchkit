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
 *      refused call and the one permission group it needs — never a bare
 *      10000. The zone's routing settings need Zone Settings, not Email
 *      Routing Rules (measured 2026-10-19).
 *   2. The migrate plan sets up routing on the new domain when the old
 *      side used it, the manifest records it, or the state can't be
 *      read; and stands down for a receiving zone or another provider's
 *      MX.
 *   3. `runEmailSetup` leaves exactly one SPF and one DMARC record, and
 *      keeps an existing DMARC when asked to be additive.
 *   4. `hatchkit doctor` turns the missing scope into a red row with the
 *      fix.
 *   5. A verified destination reads as verified. Cloudflare answers
 *      `verified` with a timestamp, never "active" (2026-10-19:
 *      `email status` showed the verified inbox as pending and `email
 *      forward` refused with "No rule created").
 *   6. A hostname below the zone is registered with Email Routing
 *      (`POST …/email/routing/dns { name }`) before its records, so
 *      Cloudflare receives for it; the run ledger's undo stops it again
 *      and refuses anything that would switch off the whole zone.
 *   7. The DMARC rua (dmarc@<host>) has a rule wherever no catch-all
 *      receives it. Cloudflare's catch-all is apex-only, so on
 *      broadcastdock/mood-magic/streaks.trebeljahr.com every aggregate
 *      report bounced (2026-10-19).
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
const { parseEmailFlags, recordEmailSetup, recordForwarding } = await import(
  "./src/email/index.js"
);
const { isEmailDestinationVerified } = await import("./src/utils/cloudflare-api.js");
const { RunLedger } = await import("./src/utils/run-ledger.js");
const { isStrictlyBelow, runRollback } = await import("./src/deploy/rollback.js");
const { getStore } = await import("./src/config.js");
const { SECRET_KEYS, setSecret } = await import("./src/utils/secrets.js");
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
  "a 10000 on the zone settings is 'unauthorized', naming the call and Zone Settings",
  async () => {
    const probe = await probeEmailRouting(
      fakeReader({ zone: "collectionofbeauty.com", routing: new Error(AUTH_10000) }),
      "collectionofbeauty.com",
    );
    assert.equal(probe.access, "unauthorized");
    if (probe.access !== "unauthorized") return;
    assert.ok(probe.error instanceof EmailRoutingScopeError);
    assert.equal(probe.error.call, "settings");
    assert.match(
      probe.error.message,
      /lacks Zone → Zone Settings → Read for collectionofbeauty\.com: GET \/zones\/\{zone\}\/email\/routing answered 10000/,
    );
    assert.doesNotMatch(probe.error.message, /Cloudflare GET/, "the client's prefix is noise here");
    const hint = probe.error.hint.join("\n");
    assert.match(hint, /add: Zone → Zone Settings → Read/);
    assert.match(hint, /GET \/zones\/\{zone\}\/email\/routing/);
    assert.doesNotMatch(
      hint,
      /Email Routing Rules|Email Routing Addresses/,
      "not the groups it has",
    );
    assert.match(hint, /dash\.cloudflare\.com\/profile\/api-tokens/);
    assert.match(hint, /hatchkit config add cloudflare/);
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
  if (probe.access !== "unauthorized") return;
  assert.equal(probe.error.call, "destinations");
  const hint = probe.error.hint.join("\n");
  assert.match(hint, /add: Account → Email Routing Addresses → Edit/);
  assert.doesNotMatch(hint, /Zone Settings/);
});

await expect("without a known call, the hint lists every group setup needs", () => {
  const hint = new EmailRoutingScopeError("example.com", AUTH_10000).hint.join("\n");
  for (const perm of EMAIL_ROUTING_TOKEN_PERMISSIONS) assert.ok(hint.includes(perm), perm);
  assert.ok(hint.includes("Zone → Zone Settings → Edit"));
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
    writeFileSync(
      join(dir, ".hatchkit.json"),
      JSON.stringify({
        ...COB,
        domain: COB_OLD,
        integrations: {
          email: {
            domain: COB_OLD,
            configuredAt: "2026-01-01T00:00:00.000Z",
            destinationEmail: "main@example.com",
            addresses: ["hello"],
          },
        },
      }),
    );
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
  meta?: { email_routing?: boolean; read_only?: boolean };
}

interface FakeCloudflareState {
  records: Rec[];
  routingEnabled?: boolean;
  auth?: boolean;
  /** Hostnames registered with Email Routing below the zone. */
  subdomains?: Array<{ name: string; enabled: boolean; status: string }>;
  /** What `GET …/email/routing/dns` recommends; [] → the setup's constants. */
  recommended?: Rec[];
  /** Every request, in order. */
  calls?: Array<{ method: string; path: string; body?: Record<string, unknown> }>;
  /** Email Routing destinations on the account. */
  destinations?: Array<{ id: string; email: string; verified: string | null }>;
  /** Forwarding rules on the zone; when absent, the list reads empty and
   *  POSTs are not kept. */
  rules?: Array<{ id: string; matchers: unknown[]; actions: unknown[] }>;
}

/** Cloudflare's own MX records for a registered name: locked, stored
 *  without the trailing dot its recommendation list shows. */
const lockedMx = (name: string, at = 0): Rec[] =>
  [57, 29, 12].map((priority, i) => ({
    id: `locked-${name}-${at + i}`,
    type: "MX",
    name,
    content: `route${i + 1}.mx.cloudflare.net`,
    priority,
    meta: { email_routing: true, read_only: true },
  }));

/** Just enough of the Cloudflare v4 API for `runEmailSetup`. */
function installFakeCloudflare(state: FakeCloudflareState) {
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
    state.calls?.push({ method, path, body });
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
    if (path === "/zones/z1/email/routing") {
      return ok({ enabled: !!state.routingEnabled, subdomains: state.subdomains ?? [] });
    }
    if (path === "/zones/z1/email/routing/enable") {
      state.routingEnabled = true;
      return ok({ enabled: true });
    }
    if (path === "/zones/z1/email/routing/dns" && method === "GET") {
      return ok(state.recommended ?? []);
    }
    if (path === "/zones/z1/email/routing/dns" && method === "POST") {
      // Like Cloudflare: register the name, write + lock its MX, add SPF.
      state.subdomains = [
        ...(state.subdomains ?? []).filter((s) => s.name !== body.name),
        { name: body.name, enabled: true, status: "ready" },
      ];
      state.records.push(...lockedMx(body.name, ++seq * 10), {
        id: `r${++seq}`,
        type: "TXT",
        name: body.name,
        content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"',
      });
      return ok({ name: body.name });
    }
    if (path === "/zones/z1/email/routing/dns" && method === "DELETE") {
      if (!body?.name) return fail(1000, "would disable the whole zone", 400);
      if (!state.subdomains?.some((s) => s.name === body.name)) return fail(1001, "nope", 404);
      state.subdomains = state.subdomains.filter((s) => s.name !== body.name);
      state.records = state.records.filter((r) => !(r.name === body.name && r.meta?.read_only));
      return ok({ name: body.name });
    }
    if (path === "/accounts/acc1/email/routing/addresses") {
      const known = state.destinations ?? [];
      if (method === "GET") return ok(known);
      // Like Cloudflare: a POST for a known address succeeds with the old record.
      const old = known.find((d) => d.email === body.email);
      if (old) return ok(old);
      const created = { id: `d${++seq}`, email: body.email, verified: null };
      state.destinations = [...known, created];
      return ok(created);
    }
    if (path === "/zones/z1/email/routing/rules") {
      if (method === "GET") return ok(state.rules ?? []);
      const rule = { id: `rule${++seq}`, ...body };
      state.rules?.push(rule);
      return ok(rule);
    }
    if (path === "/zones/z1/email/routing/rules/catch_all") {
      return ok({ enabled: false, matchers: [{ type: "all" }], actions: [] });
    }
    if (path === "/zones/z1/dns_records") {
      if (method === "POST") {
        const same = state.records.find(
          (r) =>
            r.name === body.name &&
            r.type === body.type &&
            r.content === body.content &&
            r.priority === body.priority,
        );
        if (same) return fail(81058, "An identical record already exists.", 400);
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
    if (byId && method !== "GET" && state.records.find((r) => r.id === byId[1])?.meta?.read_only) {
      return fail(1004, "This record is managed by Email Routing and is read-only.", 400);
    }
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
        assert.match(err.hint.join("\n"), /Zone → Zone Settings → Read/);
        return true;
      });
    } finally {
      restore();
    }
    assert.equal(state.records.length, 0);
  },
);

await expect("a destination verified at a timestamp is verified; null and pending are not", () => {
  assert.equal(isEmailDestinationVerified("2026-04-10T09:23:18.086829Z"), true);
  assert.equal(isEmailDestinationVerified("active"), true);
  assert.equal(isEmailDestinationVerified(null), false);
  assert.equal(isEmailDestinationVerified(undefined), false);
  assert.equal(isEmailDestinationVerified(""), false);
  assert.equal(isEmailDestinationVerified("pending"), false);
});

const subOpts = { ...setupOpts, domain: "mail.example.com", addresses: ["privacy", "imprint"] };

await expect(
  "a hostname below the zone is registered with Email Routing before its records",
  async () => {
    const state: FakeCloudflareState = {
      records: [],
      routingEnabled: true,
      subdomains: [],
      recommended: [57, 29, 12].map((priority, i) => ({
        id: "",
        type: "MX",
        name: "example.com",
        content: `route${i + 1}.mx.cloudflare.net.`,
        priority,
      })),
      calls: [],
    };
    const restore = installFakeCloudflare(state);
    let result: Awaited<ReturnType<typeof runEmailSetup>>;
    try {
      result = await runEmailSetup(subOpts);
    } finally {
      restore();
    }
    const calls = state.calls ?? [];
    const register = calls.findIndex(
      (c) => c.method === "POST" && c.path === "/zones/z1/email/routing/dns",
    );
    assert.ok(register >= 0, "no POST /email/routing/dns");
    assert.deepEqual(calls[register].body, { name: "mail.example.com" });
    const firstWrite = calls.findIndex(
      (c) => c.method !== "GET" && c.path.startsWith("/zones/z1/dns_records"),
    );
    assert.ok(firstWrite > register, "records were written before the registration");
    assert.deepEqual(result.subdomain, {
      name: "mail.example.com",
      registeredThisRun: true,
      status: "ready",
    });
    // Cloudflare's locked MX and its quoted SPF stay as they are.
    const mx = state.records.filter((r) => r.name === "mail.example.com" && r.type === "MX");
    assert.equal(mx.length, 3);
    assert.ok(mx.every((r) => r.meta?.read_only));
    assert.ok(result.dnsRecords.filter((r) => r.type === "MX").every((r) => !r.created));
    const spf = state.records.filter((r) => r.name === "mail.example.com" && r.type === "TXT");
    assert.deepEqual(
      spf.map((r) => r.content),
      ['"v=spf1 include:_spf.mx.cloudflare.net ~all"'],
    );
    assert.equal(
      state.records.filter((r) => r.name === "_dmarc.mail.example.com").length,
      1,
      "DMARC",
    );
    assert.deepEqual(
      result.rules.map((r) => [r.address, r.created]),
      [
        ["privacy@mail.example.com", true],
        ["imprint@mail.example.com", true],
        ["dmarc@mail.example.com", true],
      ],
    );
  },
);

await expect(
  "DMARC reports get a rule where no catch-all receives them, and only there",
  async () => {
    const dmarcRules = (state: FakeCloudflareState) =>
      (state.calls ?? []).filter(
        (c) =>
          c.method === "POST" &&
          c.path === "/zones/z1/email/routing/rules" &&
          JSON.stringify(c.body?.matchers).includes("dmarc@"),
      );
    const run = async (state: FakeCloudflareState, opts: Parameters<typeof runEmailSetup>[0]) => {
      const restore = installFakeCloudflare(state);
      try {
        return await runEmailSetup(opts);
      } finally {
        restore();
      }
    };

    // Below the zone the catch-all never applies (Cloudflare runs it on
    // the apex only), so dmarc@<host> needs its own rule — and keeps it
    // on a re-run without a second one.
    const sub: FakeCloudflareState = { records: [], routingEnabled: true, rules: [], calls: [] };
    const first = await run(sub, subOpts);
    assert.match(
      sub.records.find((r) => r.name === "_dmarc.mail.example.com")?.content ?? "",
      /rua=mailto:dmarc@mail\.example\.com;/,
    );
    assert.deepEqual(
      first.rules.find((r) => r.address === "dmarc@mail.example.com")?.created,
      true,
      "the ledger needs created: true to undo it",
    );
    assert.deepEqual(dmarcRules(sub)[0]?.body?.actions, [
      { type: "forward", value: ["me@example.org"] },
    ]);
    const again = await run(sub, subOpts);
    assert.equal(dmarcRules(sub).length, 1);
    assert.ok(!again.rules.some((r) => r.address === "dmarc@mail.example.com"));

    // A rule already on the address forwards where someone chose.
    const chosen: FakeCloudflareState = {
      records: [],
      routingEnabled: true,
      calls: [],
      rules: [
        {
          id: "mine",
          matchers: [{ type: "literal", field: "to", value: "dmarc@mail.example.com" }],
          actions: [{ type: "forward", value: ["reports@example.org"] }],
        },
      ],
    };
    const kept = await run(chosen, subOpts);
    assert.equal(dmarcRules(chosen).length, 0);
    assert.ok(!(chosen.calls ?? []).some((c) => c.path.endsWith("/rules/mine")));
    assert.ok(!kept.rules.some((r) => r.address === "dmarc@mail.example.com"));

    // Asked for by name: one rule, not two.
    const named: FakeCloudflareState = { records: [], routingEnabled: true, rules: [], calls: [] };
    await run(named, { ...subOpts, addresses: ["dmarc", "privacy"] });
    assert.equal(dmarcRules(named).length, 1);

    // A report inbox off the host is the caller's to route.
    const offHost: FakeCloudflareState = { records: [], routingEnabled: true, rules: [], calls: [] };
    await run(offHost, { ...subOpts, dmarcRua: "dmarc@example.org" });
    assert.equal(dmarcRules(offHost).length, 0);

    // On the apex the catch-all receives it, when there is one.
    const apex: FakeCloudflareState = { records: [], routingEnabled: true, rules: [], calls: [] };
    await run(apex, setupOpts);
    assert.equal(dmarcRules(apex).length, 0);
    const apexNoCatchAll: FakeCloudflareState = {
      records: [],
      routingEnabled: true,
      rules: [],
      calls: [],
    };
    await run(apexNoCatchAll, { ...setupOpts, catchAll: false });
    assert.equal(dmarcRules(apexNoCatchAll).length, 1, "the fake's catch-all is disabled");
  },
);

await expect("an already registered hostname is not registered again", async () => {
  const state: FakeCloudflareState = {
    records: [
      ...lockedMx("mail.example.com"),
      {
        id: "cf-spf",
        type: "TXT",
        name: "mail.example.com",
        content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"',
      },
    ],
    routingEnabled: true,
    subdomains: [{ name: "mail.example.com", enabled: true, status: "ready" }],
    calls: [],
  };
  const restore = installFakeCloudflare(state);
  let result: Awaited<ReturnType<typeof runEmailSetup>>;
  try {
    result = await runEmailSetup(subOpts);
  } finally {
    restore();
  }
  assert.ok(!(state.calls ?? []).some((c) => c.method === "POST" && c.path.endsWith("/dns")));
  assert.deepEqual(result.subdomain, {
    name: "mail.example.com",
    registeredThisRun: false,
    status: "ready",
  });
  assert.ok(
    result.dnsRecords
      .filter((r) => r.type !== "TXT" || r.name === "mail.example.com")
      .every((r) => !r.created && !r.updated),
  );
});

await expect("a destination already on the account is never reported as created", async () => {
  const verified = { id: "d-old", email: "me@example.org", verified: "2026-04-10T09:23:18Z" };
  const state: FakeCloudflareState = {
    records: [],
    routingEnabled: true,
    destinations: [verified],
  };
  const restore = installFakeCloudflare(state);
  let result: Awaited<ReturnType<typeof runEmailSetup>>;
  try {
    result = await runEmailSetup(setupOpts);
  } finally {
    restore();
  }
  // createdThisRun puts it in the run ledger, and destroy would revoke it.
  assert.equal(result.destination.createdThisRun, false);
  assert.equal(result.destination.record.id, "d-old");
  assert.equal(isEmailDestinationVerified(result.destination.verified), true);

  const fresh: FakeCloudflareState = { records: [], routingEnabled: true };
  const restoreFresh = installFakeCloudflare(fresh);
  try {
    result = await runEmailSetup(setupOpts);
  } finally {
    restoreFresh();
  }
  assert.equal(result.destination.createdThisRun, true);
  assert.equal(isEmailDestinationVerified(result.destination.verified), false);
});

await expect("the zone apex is never registered as a subdomain", async () => {
  const state: FakeCloudflareState = { records: [], routingEnabled: true, calls: [] };
  const restore = installFakeCloudflare(state);
  let result: Awaited<ReturnType<typeof runEmailSetup>>;
  try {
    result = await runEmailSetup(setupOpts);
  } finally {
    restore();
  }
  assert.ok(
    !(state.calls ?? []).some(
      (c) => c.path === "/zones/z1/email/routing/dns" && c.method !== "GET",
    ),
  );
  assert.equal(result.subdomain, undefined);
});

await expect("re-running on CF's trailing-dot MX leaves the records alone", async () => {
  const recommended = [57, 29, 12].map((priority, i) => ({
    id: "",
    type: "MX",
    name: "example.com",
    content: `route${i + 1}.mx.cloudflare.net.`,
    priority,
  }));
  const state: FakeCloudflareState = { records: [], routingEnabled: true, recommended };
  const restore = installFakeCloudflare(state);
  let second: Awaited<ReturnType<typeof runEmailSetup>>;
  try {
    await runEmailSetup(setupOpts);
    second = await runEmailSetup(setupOpts);
  } finally {
    restore();
  }
  assert.equal(state.records.filter((r) => r.type === "MX").length, 3);
  assert.ok(second.dnsRecords.every((r) => !r.created && !r.updated));
});

await expect(
  "destroy stops routing for the registered hostname, and never for the apex",
  async () => {
    assert.equal(isStrictlyBelow("mail.example.com", "example.com"), true);
    assert.equal(isStrictlyBelow("Mail.Example.com.", "example.com"), true);
    assert.equal(isStrictlyBelow("example.com", "example.com"), false);
    assert.equal(isStrictlyBelow("badexample.com", "example.com"), false);
    assert.equal(isStrictlyBelow("example.com", ""), false);

    getStore().set("providers.dns", { status: "configured", provider: "cloudflare" });
    await setSecret(SECRET_KEYS.cloudflareOperatorToken, "t");
    const state: FakeCloudflareState = {
      records: lockedMx("mail.example.com"),
      routingEnabled: true,
      subdomains: [{ name: "mail.example.com", enabled: true, status: "ready" }],
      calls: [],
    };
    const ledger = RunLedger.start("email-subdomain-undo");
    ledger.record({
      kind: "cloudflareEmailRoutingSubdomain",
      zoneId: "z1",
      zoneName: "example.com",
      name: "example.com",
    });
    ledger.record({
      kind: "cloudflareEmailRoutingSubdomain",
      zoneId: "z1",
      zoneName: "example.com",
      name: "mail.example.com",
    });
    const restore = installFakeCloudflare(state);
    try {
      await runRollback(ledger, { yes: true });
    } finally {
      restore();
    }
    const deletes = (state.calls ?? []).filter(
      (c) => c.method === "DELETE" && c.path === "/zones/z1/email/routing/dns",
    );
    assert.deepEqual(
      deletes.map((c) => c.body),
      [{ name: "mail.example.com" }],
    );
    assert.deepEqual(state.subdomains, []);
    assert.equal(state.records.length, 0, "Cloudflare's locked MX go with the name");
    // The refused apex step stays in the ledger for a human to look at.
    assert.deepEqual(
      RunLedger.load("email-subdomain-undo")?.steps.map((s) => (s as { name?: string }).name),
      ["example.com"],
    );
  },
);

await expect("email setup records its forwarding in the project manifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "email-setup-manifest-"));
  try {
    writeFileSync(
      join(dir, ".hatchkit.json"),
      JSON.stringify({
        ...COB,
        name: "app",
        domain: "app.example.com",
        integrations: {
          email: {
            domain: "app.example.com",
            configuredAt: "x",
            destinationEmail: "me@example.org",
            addresses: ["support"],
            addressDestinations: { support: "help@example.org" },
          },
        },
      }),
    );
    const result = {
      domain: "app.example.com",
      rules: [
        { address: "privacy@app.example.com", id: "1", created: true, updated: false },
        { address: "support@app.example.com", id: "2", created: false, updated: false },
      ],
      destination: { record: { id: "d1", email: "me@example.org" } },
    } as never;
    recordEmailSetup(dir, result);
    const email = readManifest(dir)?.integrations?.email;
    assert.deepEqual(email?.addresses, ["support", "privacy"]);
    assert.deepEqual(email?.addressDestinations, { support: "help@example.org" });
    assert.equal(email?.catchAll, false);

    // Another domain's setup leaves the manifest alone.
    recordEmailSetup(dir, { ...(result as object), domain: "other.example.com" } as never);
    assert.equal(readManifest(dir)?.integrations?.email?.domain, "app.example.com");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
    assert.match(row.detail ?? "", /lacks Zone → Zone Settings → Read/);
    assert.match(row.detail ?? "", /GET \/zones\/\{zone\}\/email\/routing answered/);
    assert.ok((row.hint ?? []).some((h) => h.includes("add: Zone → Zone Settings → Read")));
    assert.ok(!(row.hint ?? []).some((h) => h.includes("Email Routing Rules")));
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
