/**
 * `hatchkit auth providers`: the GitHub App manifest exchange against a
 * fake GitHub, and the clipboard → .env.production path with a fake
 * clipboard, Trash and deployed app. No real provider, clipboard, browser
 * or Trash is touched.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { type IncomingMessage, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  type AuthProvidersDeps,
  type ProvidersPrompts,
  parseAuthProvidersArgs,
  probeSignIn,
  runAuthCommand,
} from "./src/auth-providers/command.js";
import { convertManifestCode, startManifestServer } from "./src/auth-providers/github-manifest.js";
import type { ProvidersIo } from "./src/auth-providers/io.js";
import {
  FIELDS,
  appleKeyEnvValue,
  checkAppleKey,
  checkSignInUrl,
  chosenProviders,
  defaultGithubAppName,
  githubAppManifest,
  parseProviderList,
} from "./src/auth-providers/plan.js";
import { resolveEnvFile } from "./src/deploy/env-resolve.js";

const DOMAIN = "app.example.com";
let failures = 0;
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${label}\n${(err as Error).stack}`);
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────

const GOOGLE_ID = "123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com";
const GOOGLE_SECRET = `GOCSPX-${"A1b2C3d4E5f6G7h8I9j0K1l2m3n4"}`;
const APPLE_TEAM = "ABCDE12345";
const APPLE_SERVICES = "com.example.app.signin";
const APPLE_KEY_ID = "KEY1234567";
// Joined at runtime: an 18-digit literal next to "discord" trips gitleaks' discord-client-id rule.
const DISCORD_ID = ["112233445", "566778899"].join("");
const DISCORD_SECRET = "abcdEFGHijklMNOPqrstUVWXyz012345";
const GITHUB_ID = "Iv23liAbCdEfGh123456";
const GITHUB_SECRET = randomBytes(20).toString("hex");
const GITHUB_PEM = "-----BEGIN RSA PRIVATE KEY-----\nfake-app-key\n-----END RSA PRIVATE KEY-----";
const APPLE_PEM = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const RSA_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

function makeProject(options: string[]): { dir: string; envPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "auth-providers-"));
  writeFileSync(
    join(dir, ".hatchkit.json"),
    JSON.stringify({
      version: 5,
      name: "demo",
      domain: DOMAIN,
      surfaces: "split",
      deploymentMode: "coolify",
      features: ["auth-account-security"],
      authSecurity: { options },
    }),
  );
  mkdirSync(join(dir, "packages/server"), { recursive: true });
  const envPath = join(dir, "packages/server/.env.production");
  writeFileSync(envPath, "NODE_ENV=production\nGITHUB_CLIENT_ID=\n");
  return { dir, envPath };
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

/** A fake github.com + api.github.com on one port. The App form answers
 *  like GitHub after the operator confirms: a redirect to the manifest's
 *  redirect_url with a code and the state. */
async function fakeGithub(): Promise<{
  base: string;
  manifests: Array<Record<string, unknown>>;
  conversions: string[];
  close(): void;
}> {
  const manifests: Array<Record<string, unknown>> = [];
  const conversions: string[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    if (req.method === "POST" && url.pathname === "/settings/apps/new") {
      const form = new URLSearchParams(await readBody(req));
      const manifest = JSON.parse(form.get("manifest") ?? "{}") as Record<string, unknown>;
      manifests.push(manifest);
      const back = new URL(String(manifest.redirect_url));
      back.searchParams.set("code", "code-123");
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      res.writeHead(302, { location: back.toString() });
      res.end();
      return;
    }
    const conv = /^\/app-manifests\/([^/]+)\/conversions$/.exec(url.pathname);
    if (req.method === "POST" && conv) {
      conversions.push(conv[1]);
      assert.equal(req.headers.authorization, undefined, "the conversion needs no credential");
      if (conv[1] !== "code-123") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "Not Found" }));
        return;
      }
      res.writeHead(201, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: 1,
          slug: "demo-sign-in",
          name: "demo sign-in",
          owner: { login: "example-owner" },
          html_url: "https://github.com/apps/demo-sign-in",
          client_id: GITHUB_ID,
          client_secret: GITHUB_SECRET,
          webhook_secret: "whsec-fake",
          pem: GITHUB_PEM,
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    manifests,
    conversions,
    close: () => server.close(),
  };
}

function htmlUnescape(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Do what the browser does with the local start page: submit its form
 *  to GitHub, then follow GitHub's redirect back to the local server. */
async function browse(startUrl: string): Promise<{ status: number; text: string }> {
  const page = await (await fetch(startUrl)).text();
  const action = htmlUnescape(/action="([^"]+)"/.exec(page)?.[1] ?? "");
  const manifest = htmlUnescape(/name="manifest" value="([^"]+)"/.exec(page)?.[1] ?? "");
  const posted = await fetch(action, {
    method: "POST",
    body: new URLSearchParams({ manifest }),
    redirect: "manual",
  });
  const location = posted.headers.get("location");
  assert.ok(location, "GitHub redirects back");
  const back = await fetch(location);
  return { status: back.status, text: await back.text() };
}

/** A deployed app's `/api/auth/sign-in/social`, like better-auth answers
 *  it: 404 PROVIDER_NOT_FOUND until the credentials are deployed, else the
 *  provider's authorization URL. */
function fakeDeployed(
  clientIds: Partial<Record<string, string>>,
  calls: string[] = [],
): typeof fetch {
  const hosts: Record<string, string> = {
    google: "https://accounts.google.com/o/oauth2/v2/auth",
    apple: "https://appleid.apple.com/auth/authorize",
    github: "https://github.com/login/oauth/authorize",
    discord: "https://discord.com/api/oauth2/authorize",
  };
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(`https://${DOMAIN}/`)) return fetch(input, init);
    assert.equal(url, `https://${DOMAIN}/api/auth/sign-in/social`);
    assert.equal(init?.method, "POST");
    const body = JSON.parse(String(init?.body)) as { provider: string; disableRedirect?: boolean };
    assert.equal(body.disableRedirect, true);
    calls.push(body.provider);
    const clientId = clientIds[body.provider];
    if (!clientId) {
      return new Response(
        JSON.stringify({ code: "PROVIDER_NOT_FOUND", message: "Provider not found" }),
        {
          status: 404,
          headers: { "content-type": "application/json" },
        },
      );
    }
    const auth = new URL(hosts[body.provider]);
    auth.searchParams.set("client_id", clientId);
    auth.searchParams.set("redirect_uri", `https://${DOMAIN}/api/auth/callback/${body.provider}`);
    auth.searchParams.set("state", "s");
    return new Response(JSON.stringify({ url: auth.toString(), redirect: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

type Action = { copy: string } | "enter" | "skip";

interface Harness {
  deps: AuthProvidersDeps;
  logs: string[];
  trashed: string[];
  syncs: string[];
  clipboard: { value: string; reads: number; clears: number };
  pendingActions(): number;
}

function harness(opts: {
  actions: Action[];
  confirms?: boolean[];
  texts?: string[];
  downloadsDir: string;
  fetch: typeof fetch;
  github?: { webBase: string; apiBase: string };
  interactive?: boolean;
}): Harness {
  const logs: string[] = [];
  const trashed: string[] = [];
  const syncs: string[] = [];
  const clipboard = { value: "", reads: 0, clears: 0 };
  const actions = [...opts.actions];
  const confirms = [...(opts.confirms ?? [])];
  const texts = [...(opts.texts ?? [])];
  const trashDir = mkdtempSync(join(tmpdir(), "auth-providers-trash-"));
  const prompts: ProvidersPrompts = {
    async enter(message) {
      logs.push(`? ${message}`);
      const next = actions.shift();
      assert.ok(next !== undefined, `no scripted answer for: ${message}`);
      if (next === "skip") return "s";
      if (next !== "enter") clipboard.value = next.copy;
      return "";
    },
    async confirm(message, def) {
      logs.push(`? ${message}`);
      return confirms.length > 0 ? (confirms.shift() as boolean) : def;
    },
    async text(message) {
      logs.push(`? ${message}`);
      const next = texts.shift();
      assert.ok(next !== undefined, `no scripted text for: ${message}`);
      return next;
    },
    async secret() {
      throw new Error("the fake has a clipboard");
    },
    log: (line) => logs.push(line),
  };
  const io: ProvidersIo = {
    async readClipboard() {
      clipboard.reads++;
      return clipboard.value;
    },
    async clearClipboard() {
      clipboard.clears++;
      clipboard.value = "";
    },
    async openBrowser(url) {
      const back = await browse(url);
      assert.equal(back.status, 200);
    },
    async trash(path) {
      trashed.push(path);
      renameSync(path, join(trashDir, basename(path)));
      return "the Trash";
    },
    downloadsDir: opts.downloadsDir,
  };
  return {
    deps: {
      io,
      prompts,
      interactive: opts.interactive ?? true,
      fetch: opts.fetch,
      ...(opts.github ? { github: { ...opts.github, timeoutMs: 10_000 } } : {}),
      async runSync(dir) {
        syncs.push(dir);
        return 0;
      },
    },
    logs,
    trashed,
    syncs,
    clipboard,
    pendingActions: () => actions.length,
  };
}

// ── Pure checks ───────────────────────────────────────────────────────

await check("provider lists parse, unknown names are refused", () => {
  assert.deepEqual(parseProviderList(["github,google", "apple"]), {
    providers: ["google", "apple", "github"],
  });
  assert.ok("error" in parseProviderList(["gitlab"]));
  assert.deepEqual(chosenProviders(["two-factor", "discord-oauth", "google-oauth"]), [
    "google",
    "discord",
  ]);
});

await check("argument parsing", () => {
  const parsed = parseAuthProvidersArgs([
    "apps/web",
    "--provider=github",
    "--dry-run",
    "--github-org",
    "acme",
  ]);
  assert.ok(!("error" in parsed));
  assert.equal(parsed.dir, "apps/web");
  assert.deepEqual(parsed.providers, ["github"]);
  assert.equal(parsed.githubOrg, "acme");
  assert.ok("error" in parseAuthProvidersArgs(["--dry-run", "--verify"]));
  assert.ok("error" in parseAuthProvidersArgs(["--bogus"]));
  assert.ok("error" in parseAuthProvidersArgs(["--github-app-name", "x".repeat(35)]));
});

await check("value shapes", () => {
  assert.equal(FIELDS.GOOGLE_CLIENT_ID.check(GOOGLE_ID), null);
  assert.notEqual(FIELDS.GOOGLE_CLIENT_ID.check("123.apps.example.com"), null);
  assert.equal(FIELDS.GOOGLE_CLIENT_SECRET.check(GOOGLE_SECRET), null);
  assert.notEqual(FIELDS.GOOGLE_CLIENT_SECRET.check(GOOGLE_ID), null);
  assert.equal(FIELDS.APPLE_TEAM_ID.check(APPLE_TEAM), null);
  assert.notEqual(FIELDS.APPLE_KEY_ID.check("abc"), null);
  assert.equal(FIELDS.APPLE_CLIENT_ID.check(APPLE_SERVICES), null);
  assert.equal(FIELDS.GITHUB_CLIENT_ID.check(GITHUB_ID), null);
  assert.equal(FIELDS.GITHUB_CLIENT_ID.check("Iv1.0123456789abcdef"), null);
  assert.equal(FIELDS.GITHUB_CLIENT_SECRET.check(GITHUB_SECRET), null);
  assert.equal(FIELDS.DISCORD_CLIENT_ID.check(DISCORD_ID), null);
  assert.equal(FIELDS.DISCORD_CLIENT_SECRET.check(DISCORD_SECRET), null);
});

await check("the Apple key must be ES256; it is stored on one line", () => {
  const oneLine = appleKeyEnvValue(APPLE_PEM);
  assert.ok(!oneLine.includes("\n"));
  assert.ok(oneLine.includes("\\n"));
  assert.equal(checkAppleKey(oneLine), null);
  assert.match(checkAppleKey(appleKeyEnvValue(RSA_PEM)) ?? "", /P-256/);
  assert.match(checkAppleKey("not a key") ?? "", /PEM/);
});

await check("the GitHub App manifest is sign-in only", () => {
  const m = githubAppManifest({
    name: defaultGithubAppName("a-project-with-a-very-long-slug-indeed"),
    domain: DOMAIN,
    redirectUrl: "http://127.0.0.1:1/created",
  });
  assert.ok(m.name.length <= 34);
  assert.equal(m.public, true);
  assert.deepEqual(m.default_permissions, { email_addresses: "read" });
  assert.deepEqual(m.callback_urls, [`https://${DOMAIN}/api/auth/callback/github`]);
  assert.equal(m.hook_attributes.active, false);
  assert.deepEqual(m.default_events, []);
  assert.equal(m.url, `https://${DOMAIN}`);
});

await check("a sign-in URL is checked for host, client_id and redirect_uri", () => {
  const good = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${GOOGLE_ID}&redirect_uri=${encodeURIComponent(`https://${DOMAIN}/api/auth/callback/google`)}`;
  assert.equal(
    checkSignInUrl({ provider: "google", url: good, domain: DOMAIN, expectedClientId: GOOGLE_ID })
      .ok,
    true,
  );
  const other = checkSignInUrl({
    provider: "google",
    url: good,
    domain: DOMAIN,
    expectedClientId: "x",
  });
  assert.equal(other.ok, false);
  assert.match(other.problems.join(), /client_id/);
  const wrongHost = checkSignInUrl({
    provider: "google",
    url: good.replace("app.example.com", "localhost:3000"),
    domain: DOMAIN,
  });
  assert.match(wrongHost.problems.join(), /redirect_uri/);
});

// ── GitHub manifest exchange ──────────────────────────────────────────

const gh = await fakeGithub();

await check("manifest flow: local page → GitHub form → code → conversion", async () => {
  const server = await startManifestServer({
    domain: DOMAIN,
    name: "demo sign-in",
    webBase: gh.base,
  });
  try {
    const back = await browse(server.startUrl);
    assert.equal(back.status, 200);
    const code = await server.code;
    assert.equal(code, "code-123");
    const posted = gh.manifests.at(-1) ?? {};
    assert.equal(posted.redirect_url, server.redirectUrl);
    assert.equal(posted.public, true);
    const creds = await convertManifestCode({ code, apiBase: gh.base });
    assert.equal(creds.clientId, GITHUB_ID);
    assert.equal(creds.clientSecret, GITHUB_SECRET);
    assert.equal(creds.slug, "demo-sign-in");
    assert.equal(creds.owner, "example-owner");
    assert.equal("pem" in creds, false, "the App's private key is dropped");
  } finally {
    await server.close();
  }
});

await check("manifest flow: a wrong state is refused, an expired code explained", async () => {
  const server = await startManifestServer({
    domain: DOMAIN,
    name: "demo sign-in",
    webBase: gh.base,
  });
  try {
    const res = await fetch(`${server.redirectUrl}?code=code-123&state=forged`);
    assert.equal(res.status, 400);
    await assert.rejects(server.code, /different state/);
  } finally {
    await server.close();
  }
  await assert.rejects(convertManifestCode({ code: "stale", apiBase: gh.base }), /about an hour/);
});

await check("manifest flow: an organization's form", async () => {
  const server = await startManifestServer({
    domain: DOMAIN,
    name: "demo sign-in",
    org: "acme",
    webBase: gh.base,
  });
  try {
    const page = await (await fetch(server.startUrl)).text();
    assert.match(page, /\/organizations\/acme\/settings\/apps\/new\?state=/);
  } finally {
    await server.close();
  }
});

// ── Clipboard → .env.production, end to end ───────────────────────────

await check(
  "every provider: values stored, clipboard emptied, key trashed, redirect checked",
  async () => {
    const { dir, envPath } = makeProject([
      "two-factor",
      "google-oauth",
      "apple-oauth",
      "github-oauth",
      "discord-oauth",
    ]);
    const downloads = mkdtempSync(join(tmpdir(), "auth-providers-downloads-"));
    const keyFile = join(downloads, `AuthKey_${APPLE_KEY_ID}.p8`);
    writeFileSync(keyFile, APPLE_PEM);
    const probed: string[] = [];
    const h = harness({
      downloadsDir: downloads,
      github: { webBase: gh.base, apiBase: gh.base },
      fetch: fakeDeployed(
        { google: GOOGLE_ID, apple: APPLE_SERVICES, github: GITHUB_ID, discord: DISCORD_ID },
        probed,
      ),
      actions: [
        // Google: four steps to do, then the web client's two values.
        "enter",
        "enter",
        "enter",
        "enter",
        { copy: GOOGLE_ID },
        // Secret: nothing copied → empty; the ID again → stale; a wrong
        // shape → refused (confirm false); then the real one.
        "enter",
        { copy: GOOGLE_ID },
        { copy: "not-a-google-secret" },
        { copy: GOOGLE_SECRET },
        // Apple: Team ID, App ID step, Services ID, Key ID, the .p8, relay.
        { copy: APPLE_TEAM },
        "enter",
        { copy: APPLE_SERVICES },
        { copy: APPLE_KEY_ID },
        "enter",
        "enter",
        // Discord.
        { copy: DISCORD_ID },
        { copy: DISCORD_SECRET },
      ],
      // "store anyway?" no; GitHub: open; sync: yes.
      confirms: [false, true, true],
    });
    const result = await runAuthCommand(["providers", dir], h.deps);
    assert.equal(result.exitCode, 0, h.logs.join("\n"));
    assert.equal(h.pendingActions(), 0);
    assert.deepEqual(result.stored.sort(), [
      "APPLE_CLIENT_ID",
      "APPLE_KEY_ID",
      "APPLE_PRIVATE_KEY",
      "APPLE_TEAM_ID",
      "DISCORD_CLIENT_ID",
      "DISCORD_CLIENT_SECRET",
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
    ]);

    const raw = readFileSync(envPath, "utf-8");
    for (const [key, value] of [
      ["GOOGLE_CLIENT_ID", GOOGLE_ID],
      ["APPLE_TEAM_ID", APPLE_TEAM],
      ["APPLE_CLIENT_ID", APPLE_SERVICES],
      ["APPLE_KEY_ID", APPLE_KEY_ID],
      ["GITHUB_CLIENT_ID", GITHUB_ID],
      ["DISCORD_CLIENT_ID", DISCORD_ID],
    ]) {
      assert.ok(
        raw.includes(`${key}=${value}`) || raw.includes(`${key}="${value}"`),
        `${key} is plain`,
      );
    }
    for (const key of [
      "GOOGLE_CLIENT_SECRET",
      "APPLE_PRIVATE_KEY",
      "GITHUB_CLIENT_SECRET",
      "DISCORD_CLIENT_SECRET",
    ]) {
      assert.match(raw, new RegExp(`^${key}="?encrypted:`, "m"), `${key} is encrypted`);
    }
    for (const secret of [GOOGLE_SECRET, GITHUB_SECRET, DISCORD_SECRET, "BEGIN PRIVATE KEY"]) {
      assert.ok(!raw.includes(secret), "no secret in plain text");
    }
    assert.equal(
      (raw.match(/^GITHUB_CLIENT_ID=/gm) ?? []).length,
      1,
      "the empty placeholder was replaced",
    );
    assert.ok(
      !raw.includes("whsec-fake") && !raw.includes("fake-app-key"),
      "App key and webhook secret dropped",
    );

    const decrypted = (await resolveEnvFile(envPath, dir)).values;
    assert.equal(decrypted.GOOGLE_CLIENT_SECRET, GOOGLE_SECRET);
    assert.equal(decrypted.GITHUB_CLIENT_SECRET, GITHUB_SECRET);
    assert.equal(decrypted.DISCORD_CLIENT_SECRET, DISCORD_SECRET);
    assert.equal(decrypted.APPLE_PRIVATE_KEY, appleKeyEnvValue(APPLE_PEM));
    assert.equal(checkAppleKey(decrypted.APPLE_PRIVATE_KEY), null);

    assert.deepEqual(h.trashed, [keyFile]);
    assert.equal(existsSync(keyFile), false, "the .p8 left Downloads");
    assert.equal(h.clipboard.value, "", "the clipboard ends empty");
    assert.equal(h.clipboard.clears, h.clipboard.reads, "every read is followed by a clear");

    const shown = h.logs.join("\n");
    for (const secret of [GOOGLE_SECRET, GITHUB_SECRET, DISCORD_SECRET, GOOGLE_ID, DISCORD_ID]) {
      assert.ok(!shown.includes(secret), "no clipboard value is echoed");
    }
    assert.match(shown, /clipboard is empty/);
    assert.match(shown, /still holds a value read earlier/);
    assert.match(shown, /does not look right/);

    assert.equal(gh.manifests.at(-1)?.name, "demo sign-in");
    assert.deepEqual(h.syncs, [dir]);
    assert.deepEqual(probed, ["google", "apple", "github", "discord"]);
    assert.ok(result.checks.every((c) => c.ok));
  },
);

await check("a skipped provider writes nothing; a set one is left alone", async () => {
  const { dir, envPath } = makeProject(["google-oauth", "discord-oauth"]);
  writeFileSync(
    envPath,
    `NODE_ENV=production\nGOOGLE_CLIENT_ID=${GOOGLE_ID}\nGOOGLE_CLIENT_SECRET=set\n`,
  );
  const before = readFileSync(envPath, "utf-8");
  const h = harness({
    downloadsDir: tmpdir(),
    fetch: fakeDeployed({}),
    actions: [{ copy: DISCORD_ID }, "skip"],
  });
  const result = await runAuthCommand(["providers", dir], h.deps);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.stored, []);
  assert.deepEqual(result.skipped, ["discord"]);
  assert.equal(readFileSync(envPath, "utf-8"), before);
  assert.match(h.logs.join("\n"), /Already set/);
  assert.deepEqual(h.syncs, [], "nothing stored, no sync offered");
});

await check("--dry-run --json plans every chosen provider and touches nothing", async () => {
  const { dir, envPath } = makeProject([
    "google-oauth",
    "apple-oauth",
    "github-oauth",
    "discord-oauth",
  ]);
  const before = readFileSync(envPath, "utf-8");
  const h = harness({
    downloadsDir: tmpdir(),
    fetch: fakeDeployed({}),
    actions: [],
    interactive: false,
  });
  const result = await runAuthCommand(["providers", dir, "--dry-run", "--json"], h.deps);
  assert.equal(result.exitCode, 0);
  const plan = JSON.parse(h.logs.join("\n")) as {
    envFile: string;
    providers: Array<{
      provider: string;
      method: string;
      githubManifest?: { manifest: { public: boolean } };
    }>;
  };
  assert.equal(plan.envFile, "packages/server/.env.production");
  assert.deepEqual(
    plan.providers.map((p) => p.provider),
    ["google", "apple", "github", "discord"],
  );
  assert.equal(plan.providers[2].method, "github-app-manifest");
  assert.equal(plan.providers[2].githubManifest?.manifest.public, true);
  assert.equal(readFileSync(envPath, "utf-8"), before);
  assert.equal(h.clipboard.reads, 0);

  const text = harness({
    downloadsDir: tmpdir(),
    fetch: fakeDeployed({}),
    actions: [],
    interactive: false,
  });
  await runAuthCommand(["providers", dir, "--dry-run", "--github-oauth-app"], text.deps);
  const shown = text.logs.join("\n");
  assert.match(shown, /console\.cloud\.google\.com\/auth\/branding/);
  assert.match(shown, /Leave the logo empty/);
  assert.match(shown, /Publish app/);
  assert.match(shown, /github\.com\/settings\/applications\/new/);
  assert.match(shown, /https:\/\/app\.example\.com\/api\/auth\/callback\/apple/);
});

await check("--verify reports a provider the server does not know yet", async () => {
  const { dir, envPath } = makeProject(["google-oauth", "github-oauth"]);
  writeFileSync(envPath, `GOOGLE_CLIENT_ID=${GOOGLE_ID}\nGITHUB_CLIENT_ID=${GITHUB_ID}\n`);
  const h = harness({
    downloadsDir: tmpdir(),
    fetch: fakeDeployed({ google: GOOGLE_ID }),
    actions: [],
    interactive: false,
  });
  const result = await runAuthCommand(["providers", dir, "--verify"], h.deps);
  assert.equal(result.exitCode, 1);
  assert.equal(result.checks[0].ok, true);
  assert.equal(result.checks[1].notLive, true);
  const stale = await probeSignIn({
    provider: "google",
    domain: DOMAIN,
    expectedClientId: "999-other.apps.googleusercontent.com",
    fetch: fakeDeployed({ google: GOOGLE_ID }),
  });
  assert.equal(stale.ok, false);
});

await check("refusals: no terminal, no button for the provider", async () => {
  const { dir } = makeProject(["google-oauth"]);
  const quiet = harness({
    downloadsDir: tmpdir(),
    fetch: fakeDeployed({}),
    actions: [],
    interactive: false,
  });
  const origError = console.error;
  const errors: string[] = [];
  console.error = (line: string) => errors.push(line);
  try {
    assert.equal((await runAuthCommand(["providers", dir], quiet.deps)).exitCode, 1);
    assert.equal(
      (await runAuthCommand(["providers", dir, "--provider", "github"], quiet.deps)).exitCode,
      1,
    );
  } finally {
    console.error = origError;
  }
  assert.match(errors.join("\n"), /needs a terminal/);
  assert.match(errors.join("\n"), /--auth-options github-oauth/);
});

gh.close();
if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nauth providers: all checks passed");
