/**
 * hatchkit's ONE Cloudflare operator token (`cloudflare:operator`).
 *
 * Locked down, in the order they'd break:
 *
 *   1. Resolution — the operator slot wins for every use; before it
 *      exists each use falls back to its old slot, and the caller learns
 *      which slot answered.
 *   2. Setup — `ensureCloudflare` saves only a token whose every grant
 *      probe passed, never one the user declined to replace, and clears
 *      the old slots after a save.
 *   3. The probe set — every grant in CLOUDFLARE_OPERATOR_GRANTS has a
 *      probe with the same label, so doctor and setup never disagree.
 *   4. Terraform — gets a one-zone DNS token minted per run, never the
 *      operator token, and the minted token is revoked afterwards.
 *   5. Doctor — one row for the operator; a warn row while only old
 *      slots answer.
 *
 * Fixture keychain only (scripts/test.mjs). No network: Cloudflare is
 * a fake or a stubbed fetch.
 */
import assert from "node:assert/strict";

const config = await import("./src/config.js");
const { getStore } = config;
const {
  CLOUDFLARE_OPERATOR_GRANTS,
  ensureCloudflare,
  getCloudflareProvisioner,
  getDnsConfig,
  verifyCloudflareOperatorToken,
} = config;
const { SECRET_KEYS, deleteSecret, getCloudflareToken, getSecret, setSecret } = await import(
  "./src/utils/secrets.js"
);
const { CloudflareApi } = await import("./src/utils/cloudflare-api.js");
const {
  terraformCloudflareToken,
  withTerraformCloudflareToken,
  zoneResource,
  TERRAFORM_TOKEN_GROUPS,
} = await import("./src/deploy/terraform-token.js");
const { checkCloudflareOperator } = await import("./src/doctor.js");

const ACCOUNT = "a".repeat(32);
const OTHER_ACCOUNT = "b".repeat(32);
const store = getStore();
const SLOTS = [
  SECRET_KEYS.cloudflareOperatorToken,
  SECRET_KEYS.dnsCloudflareToken,
  SECRET_KEYS.cloudflareProvisionerToken,
  SECRET_KEYS.r2AdminToken,
];

async function reset(): Promise<void> {
  for (const slot of SLOTS) await deleteSecret(slot);
  for (const key of [
    "providers.cloudflare",
    "providers.cloudflareWorkers",
    "providers.dns",
    "providers.s3.r2",
  ]) {
    store.delete(key as never);
  }
}

const failures: string[] = [];
async function test(label: string, fn: () => Promise<void>): Promise<void> {
  await reset();
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}: ${(err as Error).stack ?? err}`);
    console.log(`  ✗ ${label}: ${(err as Error).message}`);
  }
}

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
};

/** Grant label without its "(why)" column — the probe's label. */
const grantLabel = (g: string) => g.replace(/\s+\(.*\)$/, "");

console.log("1. resolution:");

await test("the operator slot answers every use", async () => {
  await setSecret(SECRET_KEYS.cloudflareOperatorToken, "op");
  await setSecret(SECRET_KEYS.dnsCloudflareToken, "dns");
  await setSecret(SECRET_KEYS.cloudflareProvisionerToken, "prov");
  await setSecret(SECRET_KEYS.r2AdminToken, "r2");
  for (const use of ["dns", "r2", "provisioner"] as const) {
    assert.deepEqual(await getCloudflareToken(use), {
      token: "op",
      source: SECRET_KEYS.cloudflareOperatorToken,
    });
  }
});

await test("without the operator, each use falls back to its old slot", async () => {
  await setSecret(SECRET_KEYS.dnsCloudflareToken, "dns");
  await setSecret(SECRET_KEYS.r2AdminToken, "r2");
  assert.equal((await getCloudflareToken("dns"))?.source, SECRET_KEYS.dnsCloudflareToken);
  assert.equal((await getCloudflareToken("r2"))?.source, SECRET_KEYS.r2AdminToken);
  // Provisioner keeps its documented R2 fallback.
  assert.equal((await getCloudflareToken("provisioner"))?.source, SECRET_KEYS.r2AdminToken);
  await setSecret(SECRET_KEYS.cloudflareProvisionerToken, "prov");
  assert.equal(
    (await getCloudflareToken("provisioner"))?.source,
    SECRET_KEYS.cloudflareProvisionerToken,
  );
  // DNS never borrows the R2 token or the other way round.
  await deleteSecret(SECRET_KEYS.dnsCloudflareToken);
  assert.equal(await getCloudflareToken("dns"), null);
});

await test("provisioner and DNS config report the operator slot and its account", async () => {
  await setSecret(SECRET_KEYS.cloudflareOperatorToken, "op");
  store.set("providers.cloudflare", { status: "configured", accountId: ACCOUNT });
  store.set("providers.dns", { status: "configured", provider: "cloudflare" });
  const prov = await getCloudflareProvisioner();
  assert.equal(prov?.token, "op");
  assert.equal(prov?.accountId, ACCOUNT);
  assert.equal(prov?.source, SECRET_KEYS.cloudflareOperatorToken);
  const dns = await getDnsConfig();
  assert.equal(dns?.apiToken, "op");
  assert.equal(dns?.apiTokenSource, SECRET_KEYS.cloudflareOperatorToken);
});

await test("a legacy R2 provisioner still refuses another account's metadata", async () => {
  await setSecret(SECRET_KEYS.r2AdminToken, "r2");
  store.set("providers.s3.r2", {
    status: "configured",
    endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
  });
  store.set("providers.cloudflareWorkers", { status: "configured", accountId: OTHER_ACCOUNT });
  assert.equal(await getCloudflareProvisioner(), null);
});

console.log("2. setup:");

await test("a token with a missing grant is not saved when the user stops", async () => {
  await setSecret(SECRET_KEYS.dnsCloudflareToken, "dns-old");
  await assert.rejects(
    quiet(() =>
      ensureCloudflare(
        { force: true },
        {
          promptAccountId: async () => ACCOUNT,
          promptToken: async () => "weak",
          verify: async () => ({ ok: false, detail: "Token lacks Zone → DNS → Edit." }),
          confirmRetry: async () => false,
          lookupWorkersSubdomain: async () => null,
        },
      ),
    ),
    /not saved: Token lacks Zone → DNS → Edit/,
  );
  assert.equal(await getSecret(SECRET_KEYS.cloudflareOperatorToken), null);
  assert.equal(await getSecret(SECRET_KEYS.dnsCloudflareToken), "dns-old");
  assert.equal(store.get("providers.cloudflare" as never), undefined);
});

await test("a re-paste that passes is saved and replaces the old slots", async () => {
  await setSecret(SECRET_KEYS.dnsCloudflareToken, "dns-old");
  await setSecret(SECRET_KEYS.cloudflareProvisionerToken, "prov-old");
  await setSecret(SECRET_KEYS.r2AdminToken, "r2-old");
  const pasted = ["weak", "strong"];
  const verified: string[] = [];
  const result = await quiet(() =>
    ensureCloudflare(
      { force: true },
      {
        promptAccountId: async () => ` ${ACCOUNT} `,
        promptToken: async () => pasted.shift() ?? "",
        verify: async (token, accountId) => {
          verified.push(`${token}@${accountId}`);
          return token === "strong"
            ? { ok: true, detail: "10/10" }
            : { ok: false, detail: "Token lacks Zone → Zone Settings → Edit." };
        },
        confirmRetry: async () => true,
        lookupWorkersSubdomain: async () => "rico",
      },
    ),
  );
  assert.deepEqual(verified, [`weak@${ACCOUNT}`, `strong@${ACCOUNT}`]);
  assert.deepEqual(result, {
    token: "strong",
    accountId: ACCOUNT,
    source: SECRET_KEYS.cloudflareOperatorToken,
  });
  assert.equal(await getSecret(SECRET_KEYS.cloudflareOperatorToken), "strong");
  for (const slot of [
    SECRET_KEYS.dnsCloudflareToken,
    SECRET_KEYS.cloudflareProvisionerToken,
    SECRET_KEYS.r2AdminToken,
  ]) {
    assert.equal(await getSecret(slot), null, `${slot} should be cleared`);
  }
  const meta = store.get("providers.cloudflare" as never) as { accountId: string; status: string };
  assert.equal(meta.accountId, ACCOUNT);
  assert.equal(meta.status, "configured");
  // DNS is Cloudflare-only, so the operator token configures it.
  assert.equal((await getDnsConfig())?.apiTokenSource, SECRET_KEYS.cloudflareOperatorToken);
  assert.equal((await getCloudflareProvisioner())?.workersSubdomain, "rico");
});

await test("without force, a stored operator token is returned without prompting", async () => {
  await setSecret(SECRET_KEYS.cloudflareOperatorToken, "op");
  store.set("providers.cloudflare", { status: "configured", accountId: ACCOUNT });
  const result = await ensureCloudflare(
    {},
    {
      promptToken: async () => {
        throw new Error("prompted");
      },
    },
  );
  assert.equal(result.token, "op");
});

console.log("3. probe set:");

await test("every operator grant has a probe with its label, and nothing else", async () => {
  const realFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    paths.push(new URL(typeof input === "string" ? input : input.toString()).pathname);
    return new Response(JSON.stringify({ success: true, errors: [], messages: [], result: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  try {
    const api = new CloudflareApi({ token: "t", accountId: ACCOUNT });
    const probes = await api.probeOperatorPermissions({ accountId: ACCOUNT, zoneId: "zone" });
    const labels = probes.map((p) => p.permission.replace(" (read preflight)", ""));
    const grants = CLOUDFLARE_OPERATOR_GRANTS.map(grantLabel).filter(
      // Zone Read is proven by the zone listing that picks the probe zone.
      (g) => g !== "Zone → Zone → Read",
    );
    assert.deepEqual([...labels].sort(), [...grants].sort());
    assert.ok(probes.every((p) => p.ok));
    assert.ok(paths.includes("/client/v4/zones/zone/email/routing"), "Zone Settings probe");
    assert.ok(paths.includes(`/client/v4/accounts/${ACCOUNT}/r2/buckets`), "R2 probe");
  } finally {
    globalThis.fetch = realFetch;
  }
});

const fakeProbeApi = (opts: { zones?: Array<{ id: string; name: string }>; deny?: string[] }) => ({
  verifyToken: async () => "active",
  listZones: async () =>
    (opts.zones ?? [{ id: "z1", name: "example.com" }]).map((z) => ({
      ...z,
      name_servers: [],
      status: "active",
    })),
  probeOperatorPermissions: async () =>
    CLOUDFLARE_OPERATOR_GRANTS.map(grantLabel)
      .filter((g) => g !== "Zone → Zone → Read")
      .map((permission) => ({ permission, ok: !(opts.deny ?? []).includes(permission) })),
});

await test("verify names each missing grant and the zone it probed", async () => {
  const verdict = await verifyCloudflareOperatorToken(
    "t",
    ACCOUNT,
    fakeProbeApi({ deny: ["Zone → DNS → Edit", "Zone → Zone Settings → Edit"] }),
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.detail, /Zone → DNS → Edit, Zone → Zone Settings → Edit/);
  assert.match(verdict.detail, /example\.com/);
});

await test("verify fails a token that lists no zone (no Zone Read)", async () => {
  const verdict = await verifyCloudflareOperatorToken("t", ACCOUNT, fakeProbeApi({ zones: [] }));
  assert.equal(verdict.ok, false);
  assert.match(verdict.detail, /Zone → Zone → Read/);
});

await test("verify passes when every probe passes", async () => {
  const verdict = await verifyCloudflareOperatorToken("t", ACCOUNT, fakeProbeApi({}));
  assert.equal(verdict.ok, true);
});

console.log("4. terraform token:");

const ZONE = { id: "f".repeat(32), name: "example.com", name_servers: [], status: "active" };

function fakeMintApi(opts: { readback?: unknown[]; failCreate?: boolean } = {}) {
  const calls: { create?: Record<string, unknown>; deleted: string[] } = { deleted: [] };
  const api = {
    permissionGroupIds: async (_a: string, names: readonly string[]) => names.map((n) => `id:${n}`),
    createAccountToken: async (params: Record<string, unknown>) => {
      if (opts.failCreate) throw new Error("HTTP 403 (code 9109)");
      calls.create = params;
      return { id: "tok1", value: "minted-value" };
    },
    getAccountToken: async () => ({
      id: "tok1",
      status: "active",
      name: "x",
      policies: (opts.readback as never) ?? [
        {
          effect: "allow",
          permission_groups: TERRAFORM_TOKEN_GROUPS.map((name) => ({ id: `id:${name}`, name })),
          resources: { [zoneResource(ZONE.id)]: "*" },
        },
      ],
    }),
    deleteAccountToken: async (_a: string, id: string) => {
      calls.deleted.push(id);
      return "deleted" as const;
    },
  };
  return { api, calls };
}

await test("the operator token is swapped for a minted one-zone DNS token", async () => {
  const { api, calls } = fakeMintApi();
  const tf = await terraformCloudflareToken({
    token: "op",
    source: SECRET_KEYS.cloudflareOperatorToken,
    zone: { ...ZONE, account: { id: ACCOUNT } },
    api: api as never,
    now: () => new Date("2026-10-19T10:00:00.000Z"),
  });
  assert.equal(tf.value, "minted-value");
  assert.equal(tf.minted, true);
  assert.equal(calls.create?.accountId, ACCOUNT);
  assert.equal(calls.create?.expiresOn, "2026-10-19T11:00:00Z");
  assert.deepEqual(calls.create?.policies, [
    {
      effect: "allow",
      permission_groups: [{ id: "id:Zone Read" }, { id: "id:DNS Write" }],
      resources: { [`com.cloudflare.api.account.zone.${ZONE.id}`]: "*" },
    },
  ]);
  assert.match(String(calls.create?.name), /^hatchkit-terraform-example\.com-20261019T100000Z$/);
  assert.deepEqual(calls.deleted, []);
  await tf.revoke();
  assert.deepEqual(calls.deleted, ["tok1"]);
});

await test("a minted token broader than one zone is revoked and the run stops", async () => {
  const { api, calls } = fakeMintApi({
    readback: [
      {
        effect: "allow",
        permission_groups: [{ id: "x", name: "DNS Write" }],
        resources: { "com.cloudflare.api.account.zone.*": "*" },
      },
    ],
  });
  await assert.rejects(
    quiet(() =>
      terraformCloudflareToken({
        token: "op",
        source: SECRET_KEYS.cloudflareOperatorToken,
        zone: ZONE,
        accountId: ACCOUNT,
        api: api as never,
      }),
    ),
    /not Zone Read \+ DNS Write on this zone alone/,
  );
  assert.deepEqual(calls.deleted, ["tok1"]);
});

await test("a failed mint stops the run instead of passing the operator token", async () => {
  const { api } = fakeMintApi({ failCreate: true });
  await assert.rejects(
    terraformCloudflareToken({
      token: "op",
      source: SECRET_KEYS.cloudflareOperatorToken,
      zone: ZONE,
      accountId: ACCOUNT,
      api: api as never,
    }),
    /Account API Tokens → Edit[\s\S]*does not hand its own Cloudflare token to Terraform/,
  );
});

await test("a legacy DNS-only token is passed through unchanged", async () => {
  const { api, calls } = fakeMintApi();
  const tf = await terraformCloudflareToken({
    token: "dns-old",
    source: SECRET_KEYS.dnsCloudflareToken,
    zone: ZONE,
    api: api as never,
  });
  assert.equal(tf.value, "dns-old");
  assert.equal(tf.minted, false);
  assert.equal(calls.create, undefined);
});

await test("a run gets the minted value, never the operator, and is revoked after", async () => {
  const { api, calls } = fakeMintApi();
  const seen: string[] = [];
  const result = await withTerraformCloudflareToken(
    {
      token: "op",
      source: SECRET_KEYS.cloudflareOperatorToken,
      zone: ZONE,
      accountId: ACCOUNT,
      label: "mesozoic-protocol",
      api: api as never,
      now: () => new Date("2026-10-19T10:00:00.000Z"),
    },
    async (tfToken) => {
      seen.push(tfToken);
      assert.deepEqual(calls.deleted, [], "still alive while Terraform runs");
      return "applied";
    },
  );
  assert.equal(result, "applied");
  assert.deepEqual(seen, ["minted-value"]);
  assert.equal(calls.create?.name, "hatchkit-terraform-mesozoic-protocol-20261019T100000Z");
  assert.deepEqual(calls.deleted, ["tok1"]);
});

await test("a failed Terraform run still revokes its token", async () => {
  const { api, calls } = fakeMintApi();
  await assert.rejects(
    withTerraformCloudflareToken(
      {
        token: "op",
        source: SECRET_KEYS.cloudflareOperatorToken,
        zone: ZONE,
        accountId: ACCOUNT,
        api: api as never,
      },
      async () => {
        throw new Error("Terraform apply failed");
      },
    ),
    /Terraform apply failed/,
  );
  assert.deepEqual(calls.deleted, ["tok1"]);
});

await test("a failed mint never runs Terraform", async () => {
  const { api } = fakeMintApi({ failCreate: true });
  let ran = false;
  await assert.rejects(
    withTerraformCloudflareToken(
      {
        token: "op",
        source: SECRET_KEYS.cloudflareOperatorToken,
        zone: ZONE,
        accountId: ACCOUNT,
        api: api as never,
      },
      async () => {
        ran = true;
      },
    ),
    /Could not mint/,
  );
  assert.equal(ran, false);
});

console.log("5. doctor:");

await test("doctor skips when no Cloudflare token is stored", async () => {
  assert.equal((await checkCloudflareOperator()).status, "skip");
});

await test("doctor warns and names the old slots while only they answer", async () => {
  await setSecret(SECRET_KEYS.dnsCloudflareToken, "dns-old");
  await setSecret(SECRET_KEYS.r2AdminToken, "r2-old");
  const row = await checkCloudflareOperator();
  assert.equal(row.status, "warn");
  assert.match(row.detail ?? "", /dns:cloudflare:token, s3:r2:admin-token/);
  assert.ok(row.hint?.some((l) => l.includes("hatchkit config add cloudflare")));
});

const fakeDoctorApi = (deny: string[] = []) =>
  ({
    verifyToken: async () => "active",
    resolveZoneForName: async () => null,
    listZones: async () => [{ id: "z1", name: "example.com", name_servers: [], status: "active" }],
    probeOperatorPermissions: async () =>
      CLOUDFLARE_OPERATOR_GRANTS.map(grantLabel)
        .filter((g) => g !== "Zone → Zone → Read")
        .map((permission) =>
          deny.includes(permission)
            ? { permission, ok: false, reason: "denied", detail: "HTTP 403 (code 10000)" }
            : { permission, ok: true },
        ),
  }) as never;

await test("doctor passes the operator and says which slot answered", async () => {
  await setSecret(SECRET_KEYS.cloudflareOperatorToken, "op");
  store.set("providers.cloudflare", { status: "configured", accountId: ACCOUNT });
  const row = await checkCloudflareOperator({ makeApi: () => fakeDoctorApi() });
  assert.equal(row.status, "ok", row.detail);
  assert.match(row.detail ?? "", /9\/9 read probes passed/);
  assert.match(row.detail ?? "", /from cloudflare:operator/);
});

await test("doctor names a missing operator grant and lists every grant to fix it", async () => {
  await setSecret(SECRET_KEYS.cloudflareOperatorToken, "op");
  store.set("providers.cloudflare", { status: "configured", accountId: ACCOUNT });
  const row = await checkCloudflareOperator({
    makeApi: () => fakeDoctorApi(["Zone → Zone Settings → Edit"]),
  });
  assert.equal(row.status, "fail");
  assert.match(row.detail ?? "", /missing permissions \(zone example\.com.*Zone Settings/);
  for (const grant of CLOUDFLARE_OPERATOR_GRANTS) {
    assert.ok(
      row.hint?.some((l) => l.includes(grant)),
      `hint lists ${grant}`,
    );
  }
});

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):\n${failures.join("\n\n")}`);
  process.exit(1);
}
console.log("\nAll Cloudflare operator token tests passed.");
