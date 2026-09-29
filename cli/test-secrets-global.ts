/**
 * Tests for `hatchkit secrets rotate --global <ses|listmonk>`
 * (`cli/src/secrets/global/`).
 *
 *   G1. SES dry run: consumer plan across local projects (env-name
 *       detection, value match, leaked-key skip, git-tracked dev skip),
 *       Coolify apps by key name, ListMonk SMTP settings. No mutation.
 *   G2. SES live: new IAM key, verify, keychain, fan-out, then the old
 *       key is deactivated and deleted AFTER every consumer; ListMonk
 *       SMTP swap keeps other relays and the from-address; no value in
 *       the JSON audit; next steps name the repos to commit.
 *   G3. SES without IAM rights, non-interactive: blocked, prints the
 *       self-rotation policy, mints nothing.
 *   G4. SES verify failure: the new key is deleted again, nothing else
 *       changes.
 *   G5. SES consumer failure holds the old key; --resume finishes.
 *   G6. SES with two keys already: blocked.
 *   L1. ListMonk live: replacement user, old user deleted, replacement
 *       renamed to the old name, LISTMONK_API_TOKEN fanned out, one user.
 *   L2. ListMonk without users:manage, non-interactive: blocked with the
 *       one-off admin instructions.
 *   L3. ListMonk refuses --revoke-old=never.
 *   S1. SMTP AUTH probe against a local server: authenticates, sends no
 *       MAIL FROM, reports the failing phase.
 *   I1. AWS IAM client against a local IAM query-API mock.
 *
 * Nothing reaches a real provider: IAM, SES probes and SMTP go through
 * the `__setSesRotationDepsForTesting` seam (plus local servers for S1
 * and I1), ListMonk and Coolify through a `fetch` override.
 *
 * Run: pnpm test:secrets-global
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { type AddressInfo, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HATCHKIT_KEYTAR_SERVICE = `hatchkit-test-secrets-global-${process.pid}`;
process.env.HATCHKIT_CONF_DIR = mkdtempSync(join(tmpdir(), "secrets-global-conf-"));

const { runGlobalRotate, GLOBAL_ROLLBACK_SCOPE } = await import(
  "./src/secrets/global/orchestrator.js"
);
const { __setSesRotationDepsForTesting, createAwsIamOps } = await import(
  "./src/secrets/global/ses.js"
);
const { checkSmtpAuth } = await import("./src/secrets/global/smtp-auth.js");
const { loadRollback } = await import("./src/secrets/rollback-store.js");
const { writeManifest, MANIFEST_VERSION } = await import("./src/scaffold/manifest.js");
const { writeProdEnv, writeDevEnv } = await import("./src/provision/write-env.js");
const { loadProjectEnv } = await import("./src/assets/env.js");
const { deriveSesSmtpPassword } = await import("./src/provision/ses.js");
const { getStore } = await import("./src/config.js");
const { clearAllSecrets, getSecret, setSecret, SECRET_KEYS } = await import(
  "./src/utils/secrets.js"
);

type IamOps = ReturnType<typeof createAwsIamOps>;

const results: Record<string, boolean> = {};
function report(label: string, checks: [string, boolean][]): boolean {
  console.log(`\n── ${label} ─────────────────────────────`);
  let ok = true;
  for (const [n, c] of checks) {
    console.log(`  ${c ? "✓" : "✗"} ${n}`);
    if (!c) ok = false;
  }
  return ok;
}

const REGION = "eu-west-1";
const OLD_KEY = "AKIAOLDOLDOLDOLD0001";
const OLD_SECRET = "old-iam-secret-OLDOLDOLDOLDOLDOLDOLDOLD";
const NEW_KEY = "AKIANEWNEWNEWNEWN002";
const NEW_SECRET = "new-iam-secret-NEWNEWNEWNEWNEWNEWNEWNEW";
const OLD_PW = deriveSesSmtpPassword(OLD_SECRET, REGION);
const NEW_PW = deriveSesSmtpPassword(NEW_SECRET, REGION);
const OLD_LM_TOKEN = "old-listmonk-token-0000000000000000";

/** Ordered log of every mutating fake-provider call. */
const events: string[] = [];

// ─── Fake IAM + SES probes ──────────────────────────────────────────

interface FakeKey {
  id: string;
  secret: string;
  status: string;
}
const iam = {
  keys: [] as FakeKey[],
  selfAllowed: true,
  smtpWorks: true,
  nextId: NEW_KEY,
  nextSecret: NEW_SECRET,
};

function resetIam(): void {
  iam.keys = [{ id: OLD_KEY, secret: OLD_SECRET, status: "Active" }];
  iam.selfAllowed = true;
  iam.smtpWorks = true;
}

function fakeIam(creds: { accessKeyId: string; secretAccessKey: string }): IamOps {
  const guard = () => {
    const signer = iam.keys.find(
      (k) => k.id === creds.accessKeyId && k.secret === creds.secretAccessKey,
    );
    if (!signer || signer.status !== "Active" || !iam.selfAllowed) {
      const err = new Error("User is not authorized to perform: iam:ListAccessKeys");
      (err as Error & { name: string }).name = "AccessDenied";
      throw err;
    }
  };
  return {
    async listKeys() {
      guard();
      return iam.keys.map((k) => ({ id: k.id, status: k.status, userName: "hatchkit-ses" }));
    },
    async createKey() {
      guard();
      iam.keys.push({ id: iam.nextId, secret: iam.nextSecret, status: "Active" });
      events.push(`iam:create ${iam.nextId}`);
      return { id: iam.nextId, secret: iam.nextSecret };
    },
    async setStatus(id, status) {
      guard();
      const k = iam.keys.find((x) => x.id === id);
      if (k) k.status = status;
      events.push(`iam:status ${id} ${status}`);
    },
    async deleteKey(id) {
      guard();
      const before = iam.keys.length;
      iam.keys = iam.keys.filter((k) => k.id !== id);
      events.push(`iam:delete ${id}`);
      return before === iam.keys.length ? "not-found" : "deleted";
    },
    async ownerOf() {
      return "hatchkit-ses";
    },
  };
}

// ─── fetch mock: Coolify + ListMonk ─────────────────────────────────

interface CoolifyApp {
  uuid: string;
  name: string;
  envs: Record<string, string>;
}
const coolify = { apps: [] as CoolifyApp[], failPatch: new Set<string>() };

interface LmUser {
  id: number;
  username: string;
  name: string;
  token: string;
  type: string;
  roleId: number;
  perms: string[];
}
const lm = {
  users: new Map<number, LmUser>(),
  nextId: 10,
  settings: {} as Record<string, unknown>,
};

const ADMIN_PERMS = ["subscribers:get", "lists:manage_all", "settings:get", "settings:manage"];

function resetWorld(opts: { lmUsersManage: boolean; maskedOtherRelay?: boolean }): void {
  events.length = 0;
  coolify.apps = [
    {
      uuid: "a1",
      name: "tracktime-server",
      envs: { LISTMONK_API_TOKEN: OLD_LM_TOKEN, NODE_ENV: "production" },
    },
    {
      uuid: "a2",
      name: "mailer",
      envs: { SES_SMTP_USERNAME: OLD_KEY, SES_SMTP_PASSWORD: OLD_PW, OTHER: "x" },
    },
    { uuid: "a3", name: "unrelated", envs: { FOO: "bar" } },
  ];
  coolify.failPatch.clear();
  lm.users = new Map([
    [
      2,
      {
        id: 2,
        username: "hatchkit",
        name: "hatchkit",
        token: OLD_LM_TOKEN,
        type: "api",
        roleId: 2,
        perms: opts.lmUsersManage ? [...ADMIN_PERMS, "users:get", "users:manage"] : ADMIN_PERMS,
      },
    ],
  ]);
  lm.nextId = 10;
  lm.settings = {
    "app.from_email": "Collection <noreply@mail.example.com>",
    smtp: [
      {
        uuid: "s1",
        name: "SES",
        enabled: true,
        host: `email-smtp.${REGION}.amazonaws.com`,
        port: 587,
        username: OLD_KEY,
        password: "••••••",
        max_conns: 7,
      },
      {
        uuid: "s2",
        name: "backup",
        enabled: false,
        host: "smtp.other.test",
        port: 587,
        username: "other-relay",
        // GET leaves `password` out when it is empty and masks it
        // otherwise; a masked one blocks the per-key SMTP write (G7).
        ...(opts.maskedOtherRelay ? { password: "••••••" } : {}),
        max_conns: 2,
      },
    ],
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? "GET").toUpperCase();
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  const headers = new Headers(init?.headers);

  if (url.startsWith("https://coolify.test/api/v1")) {
    const path = url.slice("https://coolify.test/api/v1".length);
    if (method === "GET" && path === "/applications") {
      return json(coolify.apps.map((a) => ({ uuid: a.uuid, name: a.name })));
    }
    const m = /^\/applications\/([^/]+)\/envs(\/bulk)?$/.exec(path);
    const app = m ? coolify.apps.find((a) => a.uuid === m[1]) : undefined;
    if (app && method === "GET" && !m?.[2]) {
      return json(
        Object.entries(app.envs).map(([key, value]) => ({ key, value, is_preview: false })),
      );
    }
    if (app && method === "PATCH" && m?.[2]) {
      if (coolify.failPatch.has(app.name)) return json({ message: "upstream 500" }, 500);
      for (const row of (body as { data: Array<{ key: string; value: string }> }).data)
        app.envs[row.key] = row.value;
      events.push(`coolify:patch ${app.name}`);
      return json({ ok: true });
    }
    return json({ message: "not found" }, 404);
  }

  if (url.startsWith("https://listmonk.test")) {
    const path = url.slice("https://listmonk.test".length);
    const auth = /^token ([^:]+):(.+)$/.exec(headers.get("authorization") ?? "");
    const caller = auth
      ? [...lm.users.values()].find((u) => u.username === auth[1] && u.token === auth[2])
      : undefined;
    if (path === "/api/health") return json({ data: true });
    if (!caller) return json({ message: "invalid token" }, 403);
    const canManage = caller.roleId === 1 || caller.perms.includes("users:manage");
    const profile = (u: LmUser) => ({
      id: u.id,
      username: u.username,
      name: u.name,
      type: u.type,
      status: "enabled",
      user_role: {
        id: u.roleId,
        name: u.roleId === 1 ? "Super Admin" : "Admin",
        permissions: u.perms,
      },
      list_role: null,
    });
    if (method === "GET" && path === "/api/profile") return json({ data: profile(caller) });
    if (method === "GET" && path === "/api/settings")
      return json({ data: structuredClone(lm.settings) });
    if (method === "PUT" && path === "/api/settings/smtp") {
      // Per-key PUT: Listmonk stores the value exactly as sent.
      lm.settings = { ...lm.settings, smtp: body };
      events.push("listmonk:put-settings");
      return json({ data: true });
    }
    if (path.startsWith("/api/users")) {
      if (!canManage) return json({ message: "permission denied: users:manage" }, 403);
      if (method === "POST" && path === "/api/users") {
        const b = body as { username: string; name: string; type: string; user_role_id: number };
        if ([...lm.users.values()].some((u) => u.username === b.username))
          return json({ message: "exists" }, 400);
        const id = lm.nextId++;
        const token = `new-listmonk-token-${id}-xxxxxxxxxxxxxxxx`;
        const role = [...lm.users.values()].find((u) => u.roleId === b.user_role_id);
        lm.users.set(id, {
          id,
          username: b.username,
          name: b.name,
          token,
          type: b.type,
          roleId: b.user_role_id,
          perms: role?.perms ?? [],
        });
        events.push(`listmonk:create ${b.username}`);
        return json({ data: { ...profile(lm.users.get(id)!), password: token } });
      }
      const idMatch = /^\/api\/users\/(\d+)$/.exec(path);
      const target = idMatch ? lm.users.get(Number(idMatch[1])) : undefined;
      if (method === "DELETE" && idMatch) {
        lm.users.delete(Number(idMatch[1]));
        events.push(`listmonk:delete ${idMatch[1]}`);
        return json({ data: true });
      }
      if (method === "PUT" && target) {
        const b = body as { username: string };
        target.username = b.username;
        events.push(`listmonk:rename ${target.id} ${b.username}`);
        return json({ data: profile(target) });
      }
    }
    return json({ message: "not found" }, 404);
  }
  return realFetch(input as Request, init);
}) as typeof fetch;

// ─── Config + keychain ──────────────────────────────────────────────

getStore().set("providers.ses", { status: "configured", region: REGION });
getStore().set("providers.coolify", { status: "configured", url: "https://coolify.test" });
getStore().set("providers.listmonk", {
  status: "configured",
  url: "https://listmonk.test",
  apiUser: "hatchkit",
});
await setSecret(SECRET_KEYS.coolifyToken, "coolify-token-test");

async function resetKeychain(): Promise<void> {
  await setSecret(SECRET_KEYS.sesAccessKeyId, OLD_KEY);
  await setSecret(SECRET_KEYS.sesSecretAccessKey, OLD_SECRET);
  await setSecret(SECRET_KEYS.listmonkApiToken, OLD_LM_TOKEN);
  getStore().set("providers.listmonk.apiUser", "hatchkit");
}

__setSesRotationDepsForTesting({
  iam: fakeIam,
  probe: async (auth) => {
    const k = iam.keys.find((x) => x.id === auth.accessKeyId && x.secret === auth.secretAccessKey);
    if (!k || k.status !== "Active") throw new Error("InvalidClientTokenId");
    return { identityCount: 1 };
  },
  smtpAuth: async (o) => {
    const k = iam.keys.find((x) => x.id === o.username);
    const ok =
      iam.smtpWorks &&
      !!k &&
      k.status === "Active" &&
      deriveSesSmtpPassword(k.secret, REGION) === o.password;
    return ok
      ? { ok: true }
      : { ok: false, phase: "auth", code: 535, detail: "server answered 535" };
  },
  timing: { attempts: 2, delayMs: 5 },
});

// ─── Local projects ─────────────────────────────────────────────────

function git(dir: string, cmd: string): void {
  execSync(`git ${cmd}`, { cwd: dir, stdio: "ignore" });
}

function project(
  root: string,
  name: string,
  opts: {
    prod?: Record<string, string>;
    dev?: Record<string, string>;
    email?: { transactional: string; mailingList: string };
    git?: "ignore-dev" | "track-dev" | "leak-keys";
  },
): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeManifest(dir, {
    version: MANIFEST_VERSION,
    cliVersion: "0.0.0-test",
    scaffoldedAt: new Date().toISOString(),
    name,
    domain: `${name}.example.com`,
    features: [],
    mlServices: [],
    s3Provider: "none",
    deployTarget: "existing",
    deploymentMode: "coolify",
    ports: { server: 3001, client: 3000 },
    ...(opts.email ? { email: opts.email } : {}),
  } as Parameters<typeof writeManifest>[1]);
  if (opts.prod)
    writeProdEnv(
      join(dir, ".env.production"),
      Object.entries(opts.prod).map(([key, value]) => ({ key, value })),
    );
  // `dev` is the shape `hatchkit add` left before 2026-09-29: the
  // credentials in `.env.development` itself. Written by hand because
  // writeDevEnv now refuses that file.
  if (opts.dev)
    writeFileSync(
      join(dir, ".env.development"),
      Object.entries(opts.dev)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    );
  if (opts.git) {
    git(dir, "init --quiet");
    git(dir, "config user.email t@t.t");
    git(dir, "config user.name test");
    git(dir, "config commit.gpgsign false");
    // Ignore the machine's global excludes file so only the fixture's own
    // .gitignore decides what git ignores.
    git(dir, "config core.excludesFile /dev/null");
    writeFileSync(
      join(dir, ".gitignore"),
      opts.git === "track-dev" ? ".env.keys\n" : ".env.keys\n.env.development\n",
    );
    git(dir, "add -f .gitignore .hatchkit.json .env.production");
    if (opts.git === "track-dev") git(dir, "add -f .env.development");
    if (opts.git === "leak-keys") git(dir, "add -f .env.keys");
    git(dir, "commit -q -m init");
  }
  return dir;
}

const SHARED = {
  SES_SMTP_USERNAME: OLD_KEY,
  SES_SMTP_PASSWORD: OLD_PW,
  LISTMONK_API_USER: "hatchkit",
  LISTMONK_API_TOKEN: OLD_LM_TOKEN,
};

function buildRoot(): { root: string; dirs: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), "secrets-global-root-"));
  const dirs = {
    cob: project(root, "cob", {
      prod: SHARED,
      dev: SHARED,
      email: { transactional: "none", mailingList: "none" },
      git: "ignore-dev",
    }),
    other: project(root, "other", {
      prod: { SES_SMTP_USERNAME: "AKIAOTHEROTHEROTHER9", SES_SMTP_PASSWORD: "other-pw" },
    }),
    leaked: project(root, "leaked", { prod: SHARED, git: "leak-keys" }),
    intent: project(root, "intent", {
      email: { transactional: "listmonk-ses", mailingList: "none" },
    }),
    devtracked: project(root, "devtracked", { prod: SHARED, dev: SHARED, git: "track-dev" }),
    nogit: project(root, "nogit", { prod: SHARED }),
  };
  // A nested manifest (a worktree copy) must not be discovered.
  project(join(root, "cob", ".claude", "worktrees"), "cob-copy", { prod: SHARED });
  return { root, dirs };
}

function prod(dir: string): Record<string, string> {
  return loadProjectEnv({ projectDir: dir, mode: "prod" });
}
/** Where rotated dev copies go. */
function dev(dir: string): string {
  return readFileSync(join(dir, ".env.development.local"), "utf-8");
}
/** The legacy dev file the fixtures start from. */
function devLegacy(dir: string): string {
  return readFileSync(join(dir, ".env.development"), "utf-8");
}

async function captureStdout<T>(fn: () => Promise<T>): Promise<{ out: string; value: T }> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    chunks.push(String(chunk));
    return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  try {
    return { out: chunks.join(""), value: await fn() };
  } finally {
    process.stdout.write = original;
  }
}

const base = { json: true, interactive: false, yes: true } as const;
const byName = (audit: { consumers: Array<{ name: string }> }, name: string) =>
  audit.consumers.find((c) => c.name === name) as
    | { name: string; status: string; reason?: string; files?: string[]; keys: string[] }
    | undefined;

// ---------------------------------------------------------------------------
// G1 — SES dry run
// ---------------------------------------------------------------------------
{
  resetIam();
  resetWorld({ lmUsersManage: false });
  await resetKeychain();
  const { root, dirs } = buildRoot();
  const audit = await runGlobalRotate({
    ...base,
    credential: "ses",
    dryRun: true,
    projectRoots: [root],
  });
  const cob = byName(audit, "cob");
  results.g1 = report("G1: SES dry run plan", [
    ["outcome planned", audit.outcome === "planned"],
    [
      "plan warns the revoke will be held for the leaked project",
      audit.notes.some((n) => /will be held for: leaked/.test(n)),
    ],
    [
      "cob planned for prod + dev (manifest says email none)",
      cob?.status === "planned" &&
        cob.files?.join(",") === ".env.production,.env.development.local",
    ],
    [
      "other holds a different credential",
      byName(audit, "other")?.status === "skipped" &&
        /different credential/.test(byName(audit, "other")?.reason ?? ""),
    ],
    [
      "leaked skipped, names keys rotate",
      byName(audit, "leaked")?.status === "skipped" &&
        /hatchkit keys rotate leaked/.test(byName(audit, "leaked")?.reason ?? ""),
    ],
    [
      "intent-only project listed as holding no copy",
      byName(audit, "intent")?.status === "unchanged",
    ],
    [
      "devtracked: prod + dev planned, dev to the gitignored .env.development.local",
      byName(audit, "devtracked")?.status === "planned" &&
        byName(audit, "devtracked")?.files?.join(",") === ".env.production,.env.development.local",
    ],
    ["nested worktree copy not discovered", !audit.consumers.some((c) => c.name === "cob-copy")],
    ["Coolify app mailer planned by key name", byName(audit, "mailer")?.status === "planned"],
    ["tracktime-server not an SES consumer", !byName(audit, "tracktime-server")],
    [
      "ListMonk SMTP settings planned",
      byName(audit, "ListMonk SMTP settings")?.status === "planned",
    ],
    ["no IAM mutation", events.length === 0],
    ["cob untouched", prod(dirs.cob).SES_SMTP_USERNAME === OLD_KEY],
  ]);
  rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// G2 — SES live
// ---------------------------------------------------------------------------
{
  resetIam();
  resetWorld({ lmUsersManage: false });
  await resetKeychain();
  const { root, dirs } = buildRoot();
  // `leaked` would hold the revoke (G2b covers that); --exclude drops it.
  const { out, value: audit } = await captureStdout(() =>
    runGlobalRotate({
      ...base,
      credential: "ses",
      projectRoots: [root],
      pushTargets: ["coolify"],
      exclude: ["leaked"],
    }),
  );
  const cobEnv = prod(dirs.cob);
  const smtp = lm.settings.smtp as Array<{
    uuid: string;
    username: string;
    password: string;
    max_conns: number;
  }>;
  const deleteIdx = events.indexOf(`iam:delete ${OLD_KEY}`);
  const lastFanOut = Math.max(
    events.indexOf("coolify:patch mailer"),
    events.indexOf("listmonk:put-settings"),
  );
  results.g2 = report("G2: SES live rotation", [
    ["outcome done", audit.outcome === "done"],
    ["verify ok, old revoked", audit.verificationResult === "ok" && audit.oldRevoked === true],
    [
      "keychain holds the new key",
      (await getSecret(SECRET_KEYS.sesAccessKeyId)) === NEW_KEY &&
        (await getSecret(SECRET_KEYS.sesSecretAccessKey)) === NEW_SECRET,
    ],
    [
      "cob prod: new username + derived password",
      cobEnv.SES_SMTP_USERNAME === NEW_KEY && cobEnv.SES_SMTP_PASSWORD === NEW_PW,
    ],
    ["cob prod: ListMonk values untouched", cobEnv.LISTMONK_API_TOKEN === OLD_LM_TOKEN],
    [
      "cob dev: new pair in .env.development.local, old password moved out of .env.development",
      dev(dirs.cob).includes(`SES_SMTP_USERNAME=${NEW_KEY}`) &&
        dev(dirs.cob).includes(`SES_SMTP_PASSWORD=${NEW_PW}`) &&
        !devLegacy(dirs.cob).includes(OLD_PW),
    ],
    ["other left alone", prod(dirs.other).SES_SMTP_USERNAME === "AKIAOTHEROTHEROTHER9"],
    [
      "excluded project left alone and not listed",
      prod(dirs.leaked).SES_SMTP_USERNAME === OLD_KEY && !byName(audit, "leaked"),
    ],
    [
      "devtracked: prod rewritten, dev copy in .env.development.local, none left in the tracked file",
      prod(dirs.devtracked).SES_SMTP_USERNAME === NEW_KEY &&
        dev(dirs.devtracked).includes(`SES_SMTP_PASSWORD=${NEW_PW}`) &&
        !devLegacy(dirs.devtracked).includes(OLD_PW) &&
        !devLegacy(dirs.devtracked).includes(NEW_PW),
    ],
    ["nogit rewritten", prod(dirs.nogit).SES_SMTP_USERNAME === NEW_KEY],
    [
      "Coolify mailer got the new pair",
      coolify.apps[1].envs.SES_SMTP_USERNAME === NEW_KEY &&
        coolify.apps[1].envs.SES_SMTP_PASSWORD === NEW_PW,
    ],
    ["Coolify tracktime-server untouched", !events.includes("coolify:patch tracktime-server")],
    [
      "ListMonk SES relay swapped",
      smtp[0].username === NEW_KEY && smtp[0].password === NEW_PW && smtp[0].max_conns === 7,
    ],
    [
      "ListMonk other relay untouched",
      smtp[1].username === "other-relay" &&
        smtp[1].password === undefined &&
        smtp[1].max_conns === 2,
    ],
    [
      "ListMonk from-address untouched",
      lm.settings["app.from_email"] === "Collection <noreply@mail.example.com>",
    ],
    [
      "old key deactivated before delete",
      events.indexOf(`iam:status ${OLD_KEY} Inactive`) >= 0 &&
        events.indexOf(`iam:status ${OLD_KEY} Inactive`) < deleteIdx,
    ],
    ["old key deleted after the fan-out", deleteIdx > lastFanOut && lastFanOut >= 0],
    ["IAM holds only the new key", iam.keys.map((k) => k.id).join(",") === NEW_KEY],
    ["rollback blob cleared", (await loadRollback(GLOBAL_ROLLBACK_SCOPE, "ses")) === null],
    [
      "JSON audit holds no secret",
      !out.includes(NEW_SECRET) &&
        !out.includes(NEW_PW) &&
        !out.includes(OLD_PW) &&
        !out.includes(OLD_SECRET),
    ],
    [
      "next steps: commit cob's .env.production only",
      audit.nextSteps.some((s) => s.includes(`git -C ${dirs.cob} add .env.production &&`)),
    ],
    [
      "next steps: redeploy mailer",
      audit.nextSteps.some((s) => s.includes("Redeploy Coolify app mailer")),
    ],
  ]);
  rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// G2b — the incident order: a project whose dotenvx key is in git history
// is skipped AND holds the revoke; after `keys rotate` (simulated: new
// keypair, re-encrypted file) `--resume` updates it and revokes.
// ---------------------------------------------------------------------------
{
  resetIam();
  resetWorld({ lmUsersManage: false });
  await resetKeychain();
  const { root, dirs } = buildRoot();
  const first = await runGlobalRotate({
    ...base,
    credential: "ses",
    projectRoots: [root],
    pushTargets: ["coolify"],
  });
  const heldForLeak =
    first.outcome === "partial" &&
    first.oldRevoked === "held" &&
    iam.keys.some((k) => k.id === OLD_KEY && k.status === "Active") &&
    prod(dirs.leaked).SES_SMTP_USERNAME === OLD_KEY &&
    prod(dirs.cob).SES_SMTP_USERNAME === NEW_KEY;

  // Simulate `hatchkit keys rotate leaked`: fresh keypair, same values.
  const leakedValues = prod(dirs.leaked);
  rmSync(join(dirs.leaked, ".env.keys"));
  rmSync(join(dirs.leaked, ".env.production"));
  writeProdEnv(
    join(dirs.leaked, ".env.production"),
    Object.entries(leakedValues)
      .filter(([k]) => !k.startsWith("DOTENV_"))
      .map(([key, value]) => ({ key, value })),
  );
  git(dirs.leaked, "add -f .env.production");
  git(dirs.leaked, "commit -q -m rekey");

  const second = await runGlobalRotate({
    ...base,
    credential: "ses",
    projectRoots: [root],
    pushTargets: ["coolify"],
    resume: true,
  });
  results.g2b = report("G2b: leaked project holds the revoke until --resume", [
    ["first run partial, old key still active, cob updated", heldForLeak],
    [
      "first run names the leaked project as the reason",
      first.notes.some((n) => /Old credential held for: leaked/.test(n)),
    ],
    ["resume done", second.outcome === "done"],
    ["leaked updated after its keypair rotated", prod(dirs.leaked).SES_SMTP_USERNAME === NEW_KEY],
    ["old key deleted on resume", iam.keys.map((k) => k.id).join(",") === NEW_KEY],
  ]);
  rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// G3 — no IAM rights, non-interactive → blocked with the policy
// ---------------------------------------------------------------------------
{
  resetIam();
  iam.selfAllowed = false;
  resetWorld({ lmUsersManage: false });
  await resetKeychain();
  const { root } = buildRoot();
  const audit = await runGlobalRotate({ ...base, credential: "ses", projectRoots: [root] });
  const steps = audit.nextSteps.join("\n");
  results.g3 = report("G3: SES without IAM rights", [
    ["outcome blocked", audit.outcome === "blocked"],
    [
      "prints the self-rotation policy",
      steps.includes('"iam:CreateAccessKey"') &&
        steps.includes("arn:aws:iam::*:user/${aws:username}"),
    ],
    ["offers the one-off admin key", /one-off admin access key/.test(steps)],
    ["nothing minted", !events.some((e) => e.startsWith("iam:create"))],
    ["keychain unchanged", (await getSecret(SECRET_KEYS.sesAccessKeyId)) === OLD_KEY],
  ]);
  rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// G4 — verify failure deletes the new key again
// ---------------------------------------------------------------------------
{
  resetIam();
  iam.smtpWorks = false;
  resetWorld({ lmUsersManage: false });
  await resetKeychain();
  const { root, dirs } = buildRoot();
  const audit = await runGlobalRotate({ ...base, credential: "ses", projectRoots: [root] });
  results.g4 = report("G4: SES verify failure", [
    ["outcome verify-failed", audit.outcome === "verify-failed"],
    [
      "new key deleted again",
      events.includes(`iam:delete ${NEW_KEY}`) && iam.keys.map((k) => k.id).join(",") === OLD_KEY,
    ],
    ["keychain unchanged", (await getSecret(SECRET_KEYS.sesAccessKeyId)) === OLD_KEY],
    [
      "no consumer written",
      prod(dirs.cob).SES_SMTP_USERNAME === OLD_KEY && !events.some((e) => e.startsWith("coolify:")),
    ],
    ["rollback blob cleared", (await loadRollback(GLOBAL_ROLLBACK_SCOPE, "ses")) === null],
  ]);
  rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// G5 — a failed consumer holds the old key; --resume finishes
// ---------------------------------------------------------------------------
{
  resetIam();
  resetWorld({ lmUsersManage: false });
  await resetKeychain();
  coolify.failPatch.add("mailer");
  const { root, dirs } = buildRoot();
  const first = await runGlobalRotate({
    ...base,
    credential: "ses",
    projectRoots: [root],
    pushTargets: ["coolify"],
    exclude: ["leaked"],
  });
  const blob = await loadRollback(GLOBAL_ROLLBACK_SCOPE, "ses");
  const heldOk =
    first.outcome === "partial" &&
    first.oldRevoked === "held" &&
    iam.keys.some((k) => k.id === OLD_KEY && k.status === "Active") &&
    blob?.handle["new.accessKeyId"] === NEW_KEY &&
    prod(dirs.cob).SES_SMTP_USERNAME === NEW_KEY &&
    first.nextSteps.some((s) => s.includes("--resume"));

  let freshRunRefused = false;
  try {
    await runGlobalRotate({ ...base, credential: "ses", projectRoots: [root] });
  } catch (err) {
    const msg = (err as Error).message;
    freshRunRefused = /not finished/.test(msg) && /--resume/.test(msg);
  }
  let noYesRefused = false;
  try {
    await runGlobalRotate({
      ...base,
      yes: false,
      credential: "ses",
      projectRoots: [root],
      resume: true,
    });
  } catch (err) {
    noYesRefused = /pass --yes/.test((err as Error).message);
  }

  coolify.failPatch.clear();
  const second = await runGlobalRotate({
    ...base,
    credential: "ses",
    projectRoots: [root],
    pushTargets: ["coolify"],
    exclude: ["leaked"],
    resume: true,
  });
  results.g5 = report("G5: consumer failure, then --resume", [
    ["first run partial, old key held + active, blob has new id", heldOk],
    ["a fresh run is refused while the interrupted one is pending", freshRunRefused],
    ["a live run without a terminal needs --yes", noYesRefused],
    ["resume outcome done", second.outcome === "done" && second.resumed],
    ["cob already on the new key → unchanged", byName(second, "cob")?.status === "unchanged"],
    [
      "mailer updated on resume",
      byName(second, "mailer")?.status === "updated" &&
        coolify.apps[1].envs.SES_SMTP_USERNAME === NEW_KEY,
    ],
    ["old key deleted on resume", iam.keys.map((k) => k.id).join(",") === NEW_KEY],
    ["only one key ever created", events.filter((e) => e.startsWith("iam:create")).length === 1],
    ["rollback blob cleared", (await loadRollback(GLOBAL_ROLLBACK_SCOPE, "ses")) === null],
  ]);
  rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// G6 — two keys already → blocked
// ---------------------------------------------------------------------------
{
  resetIam();
  iam.keys.push({ id: "AKIASTRAYSTRAYSTRAY3", secret: "s", status: "Inactive" });
  resetWorld({ lmUsersManage: false });
  await resetKeychain();
  const { root } = buildRoot();
  const audit = await runGlobalRotate({ ...base, credential: "ses", projectRoots: [root] });
  results.g6 = report("G6: SES with two keys already", [
    ["outcome blocked", audit.outcome === "blocked"],
    [
      "names the stray key masked to 4 chars",
      audit.nextSteps.some((s) => s.includes("AKIA…") && !s.includes("AKIASTRAY")),
    ],
    ["nothing minted", !events.some((e) => e.startsWith("iam:create"))],
  ]);
  rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// G7 — another SMTP server with a masked password blocks the ListMonk
// write; ListMonk still sends with the old key, so the revoke is held.
// ---------------------------------------------------------------------------
{
  resetIam();
  resetWorld({ lmUsersManage: false, maskedOtherRelay: true });
  await resetKeychain();
  const { root } = buildRoot();
  const audit = await runGlobalRotate({
    ...base,
    credential: "ses",
    projectRoots: [root],
    pushTargets: ["coolify"],
    exclude: ["leaked"],
  });
  const lmEntry = byName(audit, "ListMonk SMTP settings");
  const smtp = lm.settings.smtp as Array<{ username: string }>;
  results.g7 = report("G7: masked SMTP password blocks the ListMonk write", [
    [
      "ListMonk entry failed with the by-hand steps",
      lmEntry?.status === "failed" && /by hand|Settings → SMTP/.test(lmEntry?.reason ?? ""),
    ],
    [
      "nothing written to ListMonk",
      !events.includes("listmonk:put-settings") && smtp[0].username === OLD_KEY,
    ],
    ["old key held", audit.oldRevoked === "held" && iam.keys.some((k) => k.id === OLD_KEY)],
    ["outcome partial", audit.outcome === "partial"],
  ]);
  // Finish: the operator pastes the login by hand, then resumes.
  (lm.settings.smtp as Array<{ username: string }>)[0].username = NEW_KEY;
  const resumed = await runGlobalRotate({
    ...base,
    credential: "ses",
    projectRoots: [root],
    pushTargets: ["coolify"],
    exclude: ["leaked"],
    resume: true,
  });
  results.g7resume = report("G7: resume after the manual paste", [
    ["resume done", resumed.outcome === "done"],
    ["old key deleted", iam.keys.map((k) => k.id).join(",") === NEW_KEY],
  ]);
  rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// L1 — ListMonk live
// ---------------------------------------------------------------------------
{
  resetIam();
  resetWorld({ lmUsersManage: true });
  await resetKeychain();
  const { root, dirs } = buildRoot();
  const { out, value: audit } = await captureStdout(() =>
    runGlobalRotate({
      ...base,
      credential: "listmonk",
      projectRoots: [root],
      pushTargets: ["coolify"],
      exclude: ["leaked"],
    }),
  );
  const users = [...lm.users.values()];
  const newToken = await getSecret(SECRET_KEYS.listmonkApiToken);
  const cobEnv = prod(dirs.cob);
  results.l1 = report("L1: ListMonk live rotation", [
    ["outcome done", audit.outcome === "done"],
    [
      "exactly one user left, named hatchkit, new id",
      users.length === 1 && users[0].username === "hatchkit" && users[0].id === 10,
    ],
    ["replacement kept the role", users[0].roleId === 2],
    [
      "created with a temporary name first",
      events.some((e) => /^listmonk:create hatchkit-rotate-\d{12}$/.test(e)),
    ],
    [
      "old user deleted before the rename",
      events.indexOf("listmonk:delete 2") < events.indexOf("listmonk:rename 10 hatchkit"),
    ],
    ["keychain token is the new one", newToken === users[0].token && newToken !== OLD_LM_TOKEN],
    [
      "config apiUser back to hatchkit",
      getStore().get("providers.listmonk.apiUser") === "hatchkit",
    ],
    ["cob LISTMONK_API_TOKEN rotated", cobEnv.LISTMONK_API_TOKEN === newToken],
    ["cob LISTMONK_API_USER unchanged", cobEnv.LISTMONK_API_USER === "hatchkit"],
    ["cob SES values untouched", cobEnv.SES_SMTP_USERNAME === OLD_KEY],
    ["tracktime-server got the token", coolify.apps[0].envs.LISTMONK_API_TOKEN === newToken],
    [
      "old user deleted after the fan-out",
      events.indexOf("listmonk:delete 2") > events.indexOf("coolify:patch tracktime-server"),
    ],
    [
      "JSON audit holds no token",
      !!newToken && !out.includes(newToken) && !out.includes(OLD_LM_TOKEN),
    ],
  ]);
  rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// L2 — ListMonk without users:manage, non-interactive → blocked
// ---------------------------------------------------------------------------
{
  resetWorld({ lmUsersManage: false });
  await resetKeychain();
  const { root } = buildRoot();
  const audit = await runGlobalRotate({ ...base, credential: "listmonk", projectRoots: [root] });
  const steps = audit.nextSteps.join("\n");
  results.l2 = report("L2: ListMonk without users:manage", [
    ["outcome blocked", audit.outcome === "blocked"],
    [
      "tells the user to paste a one-off Super Admin API user",
      /Super Admin/.test(steps) && /never stored/.test(steps),
    ],
    ["warns against widening the role", /Do not add those to its role/.test(steps)],
    ["no user created", !events.some((e) => e.startsWith("listmonk:create"))],
  ]);
  rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// L3 — ListMonk refuses --revoke-old=never
// ---------------------------------------------------------------------------
{
  resetWorld({ lmUsersManage: true });
  await resetKeychain();
  const { root } = buildRoot();
  const audit = await runGlobalRotate({
    ...base,
    credential: "listmonk",
    projectRoots: [root],
    revokePolicy: "never",
  });
  results.l3 = report("L3: ListMonk refuses --revoke-old=never", [
    ["outcome blocked", audit.outcome === "blocked"],
    [
      "explains why",
      audit.nextSteps.some((s) => /--revoke-old=never cannot apply to ListMonk/.test(s)),
    ],
  ]);
  rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// S1 — SMTP AUTH probe
// ---------------------------------------------------------------------------
{
  const seen: string[] = [];
  const server = createTcpServer((sock) => {
    sock.on("error", () => undefined);
    sock.setEncoding("utf-8");
    sock.write("220 fake ESMTP\r\n");
    let buf = "";
    sock.on("data", (d: string) => {
      buf += d;
      let nl = buf.indexOf("\r\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        seen.push(line.split(" ")[0]);
        if (line.startsWith("EHLO")) sock.write("250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n");
        else if (line.startsWith("AUTH PLAIN ")) {
          const [, user, pass] = Buffer.from(line.slice(11), "base64")
            .toString("utf-8")
            .split("\u0000");
          sock.write(user === "good-user" && pass === "good-pass" ? "235 ok\r\n" : "535 bad\r\n");
        } else if (line === "QUIT") {
          sock.end("221 bye\r\n");
        } else sock.write("502 no\r\n");
        nl = buf.indexOf("\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const good = await checkSmtpAuth({
    host: "127.0.0.1",
    port,
    username: "good-user",
    password: "good-pass",
    tls: "none",
  });
  const bad = await checkSmtpAuth({
    host: "127.0.0.1",
    port,
    username: "good-user",
    password: "wrong",
    tls: "none",
  });
  server.close();
  results.s1 = report("S1: SMTP AUTH probe", [
    ["right pair authenticates", good.ok],
    ["wrong pair fails at auth with 535", !bad.ok && bad.phase === "auth" && bad.code === 535],
    [
      "no MAIL FROM ever sent",
      !seen.includes("MAIL") && !seen.includes("RCPT") && !seen.includes("DATA"),
    ],
    ["error detail holds no password", !bad.ok && !JSON.stringify(bad).includes("wrong")],
  ]);
}

// ---------------------------------------------------------------------------
// I1 — AWS IAM client against a local query-API mock
// ---------------------------------------------------------------------------
{
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      bodies.push(raw);
      const params = new URLSearchParams(raw);
      res.setHeader("content-type", "text/xml");
      if (params.get("Action") === "ListAccessKeys") {
        res.end(
          `<ListAccessKeysResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><ListAccessKeysResult><AccessKeyMetadata><member><UserName>hatchkit-ses</UserName><AccessKeyId>${OLD_KEY}</AccessKeyId><Status>Active</Status><CreateDate>2026-01-01T00:00:00Z</CreateDate></member></AccessKeyMetadata><IsTruncated>false</IsTruncated></ListAccessKeysResult><ResponseMetadata><RequestId>r1</RequestId></ResponseMetadata></ListAccessKeysResponse>`,
        );
      } else if (params.get("Action") === "CreateAccessKey") {
        res.statusCode = 403;
        res.end(
          `<ErrorResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><Error><Type>Sender</Type><Code>AccessDenied</Code><Message>User is not authorized to perform: iam:CreateAccessKey</Message></Error><RequestId>r2</RequestId></ErrorResponse>`,
        );
      } else {
        res.statusCode = 400;
        res.end("<ErrorResponse><Error><Code>InvalidAction</Code></Error></ErrorResponse>");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ops = createAwsIamOps({ accessKeyId: OLD_KEY, secretAccessKey: OLD_SECRET }, { endpoint });
  const keys = await ops.listKeys();
  let denied: { name?: string; message?: string } | undefined;
  try {
    await ops.createKey();
  } catch (err) {
    denied = err as { name?: string; message?: string };
  }
  server.close();
  const listParams = new URLSearchParams(bodies[0] ?? "");
  results.i1 = report("I1: AWS IAM client", [
    [
      "ListAccessKeys parsed",
      keys.length === 1 && keys[0].id === OLD_KEY && keys[0].userName === "hatchkit-ses",
    ],
    [
      "self mode sends no UserName",
      listParams.get("Action") === "ListAccessKeys" && !listParams.has("UserName"),
    ],
    [
      "AccessDenied surfaces by name",
      denied?.name === "AccessDenied" || /AccessDenied|not authorized/.test(denied?.message ?? ""),
    ],
  ]);
}

// ---------------------------------------------------------------------------
await clearAllSecrets();
__setSesRotationDepsForTesting(undefined);
globalThis.fetch = realFetch;
if (existsSync(process.env.HATCHKIT_CONF_DIR!))
  rmSync(process.env.HATCHKIT_CONF_DIR!, { recursive: true, force: true });

console.log("\n=== SUMMARY ===");
let allOk = true;
for (const [name, ok] of Object.entries(results)) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) allOk = false;
}
console.log();
process.exit(allOk ? 0 : 1);
