/**
 * Listmonk client smoke tests — pure helpers only.
 *
 *  - `listmonkAuthHeader` follows the Listmonk docs verbatim:
 *      Authorization: token <api_user>:<token>
 *    Format is parsed server-side by string match, so any drift here
 *    silently breaks every API call. Worth a golden test.
 *
 *  - `normalizeListmonkUrl` strips trailing slashes so that
 *    `${base}/api/lists` always renders one separator, regardless of
 *    whether the user pasted `https://newsletter.example.com` or
 *    `https://newsletter.example.com/`.
 *
 *  - `createListmonkList` defaults to `optin: double`. On a single list
 *    Listmonk sends campaigns to every member not `unsubscribed`,
 *    `unconfirmed` included.
 *
 *  - `findListmonkSubscriberByEmail` uses an anchored, quoted `search`,
 *    not `query` (which needs the `subscribers:sql_query` permission).
 *
 *  - `applySesSmtpToListmonk` writes through the per-key
 *    `PUT /api/settings/<key>` only, never sends a masked secret back,
 *    and sets the shared `app.from_email` only when it is unset. One
 *    Listmonk serves every project, so any other sender is another
 *    project's.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import {
  type ListmonkSmtpEntry,
  applySesSmtpToListmonk,
  createListmonkList,
  findListmonkSubscriberByEmail,
  listmonkAuthHeader,
  listmonkEmailSearch,
  listmonkFromEmailUnset,
  normalizeListmonkUrl,
} from "./src/provision/listmonk.js";

const failures: string[] = [];

function expect(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}: ${(err as Error).message}`);
    console.log(`  ✗ ${label}`);
  }
}

console.log("listmonkAuthHeader:");

expect("formats as `token <user>:<token>` per Listmonk docs", () => {
  assert.equal(
    listmonkAuthHeader({ apiUser: "hatchkit", apiToken: "abc123" }),
    "token hatchkit:abc123",
  );
});

expect("does not URL-encode or otherwise transform the inputs", () => {
  assert.equal(
    listmonkAuthHeader({ apiUser: "user with spaces", apiToken: "tok+ /=" }),
    "token user with spaces:tok+ /=",
  );
});

console.log("\nnormalizeListmonkUrl:");

expect("strips a single trailing slash", () => {
  assert.equal(
    normalizeListmonkUrl("https://newsletter.example.com/"),
    "https://newsletter.example.com",
  );
});

expect("strips multiple trailing slashes", () => {
  assert.equal(
    normalizeListmonkUrl("https://newsletter.example.com///"),
    "https://newsletter.example.com",
  );
});

expect("leaves a slashless URL untouched", () => {
  assert.equal(
    normalizeListmonkUrl("https://newsletter.example.com"),
    "https://newsletter.example.com",
  );
});

expect("trims surrounding whitespace", () => {
  assert.equal(
    normalizeListmonkUrl("  https://newsletter.example.com/  "),
    "https://newsletter.example.com",
  );
});

const auth = { url: "https://listmonk.test", apiUser: "hatchkit", apiToken: "tok" };
const realFetch = globalThis.fetch;

/** Stub fetch with one canned `data` payload; returns the recorded calls. */
function stubFetch(data: unknown): Array<{ url: URL; init?: RequestInit }> {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init });
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof fetch;
  return calls;
}

async function expectAsync(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}: ${(err as Error).message}`);
    console.log(`  ✗ ${label}`);
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("\ncreateListmonkList:");

await expectAsync("creates lists double opt-in unless told otherwise", async () => {
  const calls = stubFetch({ id: 7, name: "demo", type: "private", optin: "double" });
  await createListmonkList("demo", { auth });
  assert.equal(calls[0].url.pathname, "/api/lists");
  assert.equal(JSON.parse(calls[0].init?.body as string).optin, "double");
});

console.log("\nfindListmonkSubscriberByEmail:");

expect("anchors the search and quotes regex characters", () => {
  const search = listmonkEmailSearch("Reader+Test@Example.com");
  assert.equal(search, "^reader\\+test@example\\.com$");
  // Same semantics as Postgres `~*` for this pattern.
  assert.ok(new RegExp(search, "i").test("reader+test@example.com"));
  assert.ok(!new RegExp(search, "i").test("readerrtest@example.com"));
  assert.ok(!new RegExp(search, "i").test("xreader+test@example.com"));
});

await expectAsync("uses search, not the sql_query-gated query param", async () => {
  const calls = stubFetch({ results: [], total: 0 });
  await findListmonkSubscriberByEmail("a+b@example.com", auth);
  assert.equal(calls[0].url.pathname, "/api/subscribers");
  assert.equal(calls[0].url.searchParams.get("search"), "^a\\+b@example\\.com$");
  assert.equal(calls[0].url.searchParams.get("query"), null);
});

await expectAsync("keeps only the exact email when the name column also matches", async () => {
  stubFetch({
    results: [
      { id: 1, email: "other@example.com", name: "a@example.com", status: "enabled" },
      { id: 2, email: "A@Example.com", name: "A", status: "enabled" },
    ],
    total: 2,
  });
  const found = await findListmonkSubscriberByEmail("a@example.com", auth);
  assert.equal(found?.id, 2);
});

console.log("\napplySesSmtpToListmonk:");

/** Stub a Listmonk that serves `settings` on GET /api/settings, answers
 *  every per-key PUT with `putData` (or `putStatus`), and is healthy. */
function stubSettingsFetch(
  settings: Record<string, unknown>,
  opts: { putData?: unknown; putStatus?: number } = {},
) {
  const calls: Array<{ method: string; path: string; body?: unknown; raw?: string }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = new URL(String(input)).pathname;
    const raw = init?.body as string | undefined;
    calls.push({ method, path, raw, body: raw ? JSON.parse(raw) : undefined });
    const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
    if (path === "/api/health") return ok(true);
    if (method === "GET" && path === "/api/settings") return ok(structuredClone(settings));
    if (method === "PUT" && path.startsWith("/api/settings/")) {
      if (opts.putStatus) return new Response("Not Found", { status: opts.putStatus });
      return ok(opts.putData ?? true);
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  return calls;
}

const mask = (secret: string) => "•".repeat(secret.length);
const route = (calls: Array<{ method: string; path: string }>) =>
  calls.map((c) => `${c.method} ${c.path}`);

const ses = {
  host: "email-smtp.eu-west-1.amazonaws.com",
  port: 587,
  username: "AKIANEWKEY",
  password: "BNewDerivedSmtpPasswordForEuWest1xxxxxxxxxx",
  fromEmail: "noreply@mail.tracktime.app",
  fromName: "tracktime",
};
const fast = { reloadDelayMs: 0 };

function sesEntry(overrides: Partial<ListmonkSmtpEntry> = {}): ListmonkSmtpEntry {
  return {
    name: "email-ses",
    uuid: "uuid-ses",
    enabled: true,
    host: ses.host,
    hello_hostname: "listmonk.test",
    port: 587,
    auth_protocol: "login",
    username: "AKIAOLDKEY",
    password: mask("AOldDerivedSmtpPasswordForEuWest1xxxxxxxxxxx"),
    email_headers: [],
    max_conns: 25,
    max_msg_retries: 2,
    idle_timeout: "15s",
    wait_timeout: "5s",
    tls_type: "STARTTLS",
    tls_skip_verify: false,
    ...overrides,
  };
}

/** The shared instance: another project's sender, one SES relay, and
 *  secrets outside SMTP that GET masks too. */
function sharedSettings(smtp: ListmonkSmtpEntry[] = [sesEntry()]): Record<string, unknown> {
  return {
    "app.from_email": "Collection of Beauty <noreply@mail.collection-of-beauty.com>",
    "app.root_url": "https://listmonk.test",
    "upload.s3.aws_secret_access_key": mask("s3-secret"),
    "security.oidc": { enabled: false, client_secret: mask("oidc-secret") },
    smtp,
  };
}

await expectAsync("rotated key: writes only the smtp key, through the per-key PUT", async () => {
  const calls = stubSettingsFetch(sharedSettings());
  const result = await applySesSmtpToListmonk(ses, auth, fast);
  assert.deepEqual(route(calls), [
    "GET /api/settings",
    "PUT /api/settings/smtp",
    "GET /api/health",
  ]);
  assert.equal(result.written, true);
  assert.equal(result.reason, undefined);
});

await expectAsync("never sends a masked secret back", async () => {
  const calls = stubSettingsFetch(sharedSettings());
  await applySesSmtpToListmonk(ses, auth, fast);
  for (const c of calls) {
    assert.ok(!c.raw?.includes("•"), `${c.method} ${c.path} sent a masked value`);
  }
});

await expectAsync(
  "keeps the SES entry's name, uuid and tuning; swaps the credentials",
  async () => {
    const calls = stubSettingsFetch(sharedSettings());
    await applySesSmtpToListmonk(ses, auth, fast);
    const [entry, ...rest] = calls[1].body as ListmonkSmtpEntry[];
    assert.equal(rest.length, 0);
    assert.equal(entry.name, "email-ses");
    assert.equal(entry.uuid, "uuid-ses");
    assert.equal(entry.max_conns, 25);
    assert.equal(entry.username, ses.username);
    assert.equal(entry.password, ses.password);
    assert.equal(entry.enabled, true);
  },
);

await expectAsync("leaves another project's default sender alone", async () => {
  const calls = stubSettingsFetch(sharedSettings());
  const result = await applySesSmtpToListmonk(ses, auth, fast);
  assert.ok(!calls.some((c) => c.path === "/api/settings/app.from_email"));
  assert.deepEqual(result.fromEmail, {
    value: "Collection of Beauty <noreply@mail.collection-of-beauty.com>",
    written: false,
  });
});

await expectAsync(
  "same key: a masked password of the right length is in place, no write",
  async () => {
    const calls = stubSettingsFetch(
      sharedSettings([sesEntry({ username: ses.username, password: mask(ses.password) })]),
    );
    const result = await applySesSmtpToListmonk(ses, auth, fast);
    assert.deepEqual(route(calls), ["GET /api/settings"]);
    assert.equal(result.written, false);
    assert.equal(result.reason, "already in place");
  },
);

await expectAsync("same key but a wrong-length password is rewritten", async () => {
  const calls = stubSettingsFetch(
    sharedSettings([sesEntry({ username: ses.username, password: mask("short") })]),
  );
  const result = await applySesSmtpToListmonk(ses, auth, fast);
  assert.equal(result.written, true);
  assert.ok(calls.some((c) => c.path === "/api/settings/smtp"));
});

await expectAsync(
  "fresh install: drops the samples and sets the unset default sender",
  async () => {
    const sample = {
      enabled: true,
      host: "smtp.yoursite.com",
      port: 25,
      auth_protocol: "cram",
      username: "username",
      password: mask("password"),
    };
    const gmail = {
      enabled: false,
      host: "smtp.gmail.com",
      port: 465,
      auth_protocol: "login",
      username: "username@gmail.com",
      password: mask("password"),
    };
    const calls = stubSettingsFetch({
      "app.from_email": "listmonk <noreply@listmonk.yoursite.com>",
      smtp: [sample, gmail],
    });
    const result = await applySesSmtpToListmonk(ses, auth, fast);
    assert.deepEqual(route(calls), [
      "GET /api/settings",
      "PUT /api/settings/smtp",
      "GET /api/health",
      "PUT /api/settings/app.from_email",
      "GET /api/health",
    ]);
    const smtp = calls[1].body as ListmonkSmtpEntry[];
    assert.equal(smtp.length, 1);
    assert.equal(smtp[0].name, "email-ses");
    assert.ok(smtp[0].uuid, "the per-key PUT assigns no uuid, so hatchkit must");
    assert.equal(smtp[0].host, ses.host);
    assert.equal(smtp[0].password, ses.password);
    assert.equal(calls[3].body, "tracktime <noreply@mail.tracktime.app>");
    assert.deepEqual(result.fromEmail, {
      value: "tracktime <noreply@mail.tracktime.app>",
      written: true,
    });
  },
);

await expectAsync("a blank default sender is set even when SMTP is already in place", async () => {
  const settings = sharedSettings([
    sesEntry({ username: ses.username, password: mask(ses.password) }),
  ]);
  settings["app.from_email"] = "  ";
  const calls = stubSettingsFetch(settings);
  const result = await applySesSmtpToListmonk(ses, auth, fast);
  assert.deepEqual(route(calls), [
    "GET /api/settings",
    "PUT /api/settings/app.from_email",
    "GET /api/health",
  ]);
  assert.equal(result.reason, "already in place");
  assert.equal(result.fromEmail?.written, true);
});

await expectAsync("another server with a masked password blocks the write", async () => {
  const postmark = sesEntry({
    name: "email-postmark",
    uuid: "uuid-postmark",
    host: "smtp.postmarkapp.com",
    username: "pm-token",
    password: mask("pm-secret"),
  });
  const calls = stubSettingsFetch(sharedSettings([sesEntry(), postmark]));
  const result = await applySesSmtpToListmonk(ses, auth, fast);
  assert.deepEqual(route(calls), ["GET /api/settings"]);
  assert.equal(result.written, false);
  assert.match(result.reason ?? "", /email-postmark/);
  assert.match(result.reason ?? "", /Settings → SMTP by hand/);
});

await expectAsync("another server without a password is kept as it was", async () => {
  const mailpit = sesEntry({
    name: "email-mailpit",
    uuid: "uuid-mailpit",
    enabled: false,
    host: "mailpit",
    port: 1025,
    auth_protocol: "none",
    username: "",
    password: undefined,
  });
  const calls = stubSettingsFetch(sharedSettings([mailpit, sesEntry()]));
  await applySesSmtpToListmonk(ses, auth, fast);
  const smtp = calls[1].body as ListmonkSmtpEntry[];
  assert.deepEqual(
    smtp.map((e) => e.name),
    ["email-mailpit", "email-ses"],
  );
  assert.deepEqual(smtp[0], JSON.parse(JSON.stringify(mailpit)));
});

await expectAsync(
  "a running campaign: reports needsRestart and skips the reload wait",
  async () => {
    const calls = stubSettingsFetch(sharedSettings(), { putData: { needs_restart: true } });
    const result = await applySesSmtpToListmonk(ses, auth, fast);
    assert.equal(result.needsRestart, true);
    assert.ok(!calls.some((c) => c.path === "/api/health"));
  },
);

await expectAsync("a Listmonk without the per-key endpoint gets the manual fallback", async () => {
  stubSettingsFetch(sharedSettings(), { putStatus: 404 });
  await assert.rejects(
    applySesSmtpToListmonk(ses, auth, fast),
    /needs v6\+\)\. Paste the SES SMTP credentials into Settings → SMTP by hand/,
  );
});

expect("listmonkFromEmailUnset: blank or the install default, nothing else", () => {
  assert.ok(listmonkFromEmailUnset(undefined));
  assert.ok(listmonkFromEmailUnset(""));
  assert.ok(listmonkFromEmailUnset("listmonk <noreply@listmonk.yoursite.com>"));
  assert.ok(!listmonkFromEmailUnset("Streaks <noreply@mail.streaks.app>"));
  assert.ok(!listmonkFromEmailUnset("noreply@mail.tracktime.app"));
});

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nAll listmonk client tests passed.");
