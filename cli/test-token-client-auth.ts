/**
 * `token-client-auth` — session identity, lifetime and devices.
 *
 * Three parts:
 *
 *  1. **The contract.** The four cases `docs/feature-authoring.md` asks of
 *     every feature — idempotency, dry run, user edits surviving, no
 *     unrendered tokens — plus what the registry says about this one.
 *
 *  2. **Composition.** `betterAuth({ … })` is shared ground: `workspaces`,
 *     `auth-account-security` and `extension` each add keys to it. This
 *     feature must merge into `session:` and `databaseHooks:` when they are
 *     already there and create them when they are not, in either order,
 *     without ever emitting a duplicate object key.
 *
 *  3. **The generated code, running.** The templates are data to this package
 *     — they import `@starter/shared`, which does not exist here — so they are
 *     rendered into a scratch package, their external import is pointed at the
 *     module rendered beside them, and they are imported and RUN. The
 *     load-bearing claims are behavioural ("the refresh reads the stamped
 *     client, not the request"); grepping the output would pin none of them.
 *
 * Run: pnpm --filter hatchkit test:token-client-auth
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// `all.js` for the registry-wide questions: importing it is what registers
// every feature, so `expandFeatureSelection` can see this one's prerequisite.
import { expandFeatureSelection, getFeature } from "./src/features/all.js";
import { FeatureLedger, applyFeatures } from "./src/features/contract.js";
import { findUnrenderedTokens, listFeatureTemplates } from "./src/features/templates.js";
import {
  EDITED,
  OWNED,
  TEMPLATE_DIR,
  render,
  rewriteAuthConfig,
  rewriteBarrel,
  rewriteCors,
  tokenClientAuthFeature,
} from "./src/features/token-client-auth/index.js";
import { resolveIdentifiers } from "./src/scaffold/identifiers.js";
import type { ProjectManifest } from "./src/scaffold/manifest.js";

const STARTER_ROOT = join(import.meta.dirname, "..", "starter");

/** The frozen identifiers a scaffolded project would carry. Everything this
 *  feature emits — the header, every client id — comes from here. */
const IDS = resolveIdentifiers({ name: "My App" });

let failed = 0;
let checks = 0;
function check(cond: unknown, msg: string): void {
  checks++;
  if (!cond) {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}
function section(name: string): void {
  console.log(`\n  ${name}`);
}

const scratchDirs: string[] = [];
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

/**
 * A project tree holding the real starter files this feature touches.
 *
 * Copied from `starter/` rather than written out here, so the anchors are
 * tested against the text the CLI will actually meet. A starter edit that
 * moves one breaks this test rather than a user's project.
 */
function seedProject(opts: { core?: boolean; client?: boolean } = {}): string {
  const root = scratch("tca-project-");
  const copy = (relative: string) => {
    const to = join(root, ...relative.split("/"));
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(STARTER_ROOT, ...relative.split("/")), to);
  };
  copy("packages/shared/src/index.ts");
  copy("packages/server/src/auth/auth.ts");
  copy("packages/server/src/app.ts");
  if (opts.core !== false) {
    copy("packages/core/src/index.ts");
    copy("packages/core/tsconfig.json");
  }
  if (opts.client !== false) copy("packages/client/src/app/layout.tsx");
  return root;
}

const MANIFEST = {
  name: "My App",
  features: ["token-client-auth"],
} as unknown as ProjectManifest;

async function apply(
  root: string,
  opts: { dryRun?: boolean; mode?: "create" | "update" } = {},
): Promise<{ ledger: FeatureLedger; logs: string[] }> {
  const ledger = new FeatureLedger(root, opts.dryRun ?? false);
  const logs: string[] = [];
  await applyFeatures(["token-client-auth"], {
    projectDir: root,
    manifestDir: root,
    manifest: MANIFEST,
    identifiers: IDS,
    mode: opts.mode ?? "create",
    ledger,
    log: (message) => logs.push(message),
  });
  return { ledger, logs };
}

const read = (root: string, relative: string): string =>
  readFileSync(join(root, ...relative.split("/")), "utf-8");

const ALL_PATHS = [...Object.values(OWNED), ...Object.values(EDITED)];

function snapshot(root: string, paths: readonly string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const rel of paths) {
    try {
      out[rel] = read(root, rel);
    } catch {
      out[rel] = null;
    }
  }
  return out;
}

/** How many times `key:` appears as a top-level key of the auth config. A
 *  duplicate object key is what two features both "inserting" produces. */
function topLevelKeyCount(source: string, key: string): number {
  return source.split(`\n    ${key}: {`).length - 1;
}

// ─────────────────────────────────────────────────────────────────────

section("registry — the feature is registered and states its prerequisite");

{
  const def = getFeature("token-client-auth");
  check(def === tokenClientAuthFeature, "the id resolves to this feature");
  check(def?.addableAfterScaffold === true, "`hatchkit update` can add it later");
  check(
    def?.requires?.includes("client-core") === true,
    "it requires client-core — `packages/core` is where the host-free sign-in helper belongs",
  );

  const { ordered, implied, errors } = expandFeatureSelection(["token-client-auth"]);
  check(errors.length === 0, "selecting it alone is a valid selection");
  check(implied.includes("client-core"), "…and pulls client-core in");
  check(
    ordered.indexOf("client-core") < ordered.indexOf("token-client-auth"),
    "…and orders the prerequisite first, so the apply may assume packages/core exists",
  );
}

section("templates — every shipped template renders completely");

{
  const templates = listFeatureTemplates(TEMPLATE_DIR);
  check(templates.length > 0, "the feature ships templates and they are found on disk");
  check(
    templates.every((name) => name.endsWith(".tmpl")),
    "…all under one suffix, so none is compiled by this package's own tsc",
  );
  for (const name of templates) {
    const leftover = findUnrenderedTokens(render(name.replace(/\.tmpl$/, ""), IDS));
    check(
      leftover.length === 0,
      `${name} renders with no leftover tokens${leftover.length ? ` (${leftover.join(", ")})` : ""}`,
    );
  }
}

section("templates — names come from the identifiers, never a local rule");

{
  const clientKind = render("shared/client-kind.ts", IDS);
  check(
    clientKind.includes(`export const CLIENT_HEADER = "${IDS.clientHeader}";`),
    "the client header is the project's frozen `clientHeader`",
  );
  check(IDS.clientHeader === "x-myapp-client", "…which for this project is x-myapp-client");
  for (const host of ["cli", "desktop", "mobile", "extension", "raycast", "mcp"] as const) {
    check(
      clientKind.includes(`"${IDS.clientIds[host]}"`),
      `the ${host} client id is the project's frozen one (${IDS.clientIds[host]})`,
    );
  }
  check(
    !clientKind.includes("SESSION_REVOKED_CLOSE_CODE"),
    "the socket close code is NOT redefined here — client-core owns it in sync-protocol.ts",
  );
  check(
    !clientKind.includes("isRandomExtensionOrigin"),
    "…nor the extension-origin shape check, which the extension feature owns",
  );
}

section("apply — a full project");

{
  const root = seedProject();
  const { ledger } = await apply(root);

  check(ledger.conflicts().length === 0, "nothing needed a hand");
  const written = ledger.summary().written;
  for (const path of Object.values(OWNED)) {
    check(written.includes(path), `wrote ${path}`);
  }
  for (const path of Object.values(EDITED)) {
    check(written.includes(path), `edited ${path}`);
  }

  const auth = read(root, EDITED.authConfig);
  check(
    auth.includes("expiresIn: TOKEN_CLIENT_SESSION_SECONDS"),
    "the global session window is the LONG one — the refresh trigger is computed against it",
  );
  check(auth.includes("updateAge: SESSION_UPDATE_AGE_SECONDS"), "updateAge is set");
  check(auth.includes("additionalFields: {"), "the session row gains a `client` field");
  check(auth.includes("input: false"), "`client` cannot be written by a request body");
  check(
    auth.includes("expiryForNewSession(context)"),
    "the create hook writes the per-client window",
  );
  check(
    auth.includes("expiryForSessionRefresh(update, context)"),
    "the UPDATE hook writes it too — the create hook alone is the trap",
  );
  check(topLevelKeyCount(auth, "session") === 1, "exactly one `session:` key");
  check(topLevelKeyCount(auth, "databaseHooks") === 1, "exactly one `databaseHooks:` key");

  const app = read(root, EDITED.serverApp);
  check(
    app.includes('exposedHeaders: ["set-auth-token"]'),
    "the session-token response header is exposed — a cross-origin client cannot read it otherwise",
  );

  const devices = read(root, OWNED.devicesPage);
  check(
    devices.includes('from "@starter/shared/client-kind"'),
    "the client component imports the shared SUBPATH — a value import of the barrel does not bundle",
  );

  check(
    read(root, EDITED.coreIndex).includes('export * from "./session-auth.js";'),
    "the client kit's barrel re-exports the sign-in helper",
  );
  check(
    /"lib":\s*\[[^\]]*"DOM"/.test(
      readFileSync(join(STARTER_ROOT, "packages", "core", "tsconfig.json"), "utf-8"),
    ),
    "the kit already compiles with the DOM lib, which the web-API sign-in helper needs",
  );

  // ── contract case 1: idempotency ──
  const before = snapshot(root, ALL_PATHS);
  const second = await apply(root);
  check(
    second.ledger.summary().written.length === 0,
    "re-applying writes nothing — `update` re-applies every selected feature on every run",
  );
  check(second.ledger.conflicts().length === 0, "…and raises no conflict");
  check(second.ledger.touched === false, "…and reports the run as untouched");
  check(
    JSON.stringify(before) === JSON.stringify(snapshot(root, ALL_PATHS)),
    "…and every file is byte-identical afterwards",
  );
}

section("apply — contract case 2: a dry run touches nothing");

{
  const root = seedProject();
  const before = snapshot(root, ALL_PATHS);
  const { ledger } = await apply(root, { dryRun: true });
  check(
    JSON.stringify(before) === JSON.stringify(snapshot(root, ALL_PATHS)),
    "the disk is byte-identical after a dry run, including files that do not exist yet",
  );
  check(ledger.summary().written.length === 0, "nothing is reported as written");
  check(
    ledger.summary()["would-write"].includes(OWNED.sharedClientKind),
    "…and the same work is reported as `would-write` instead",
  );
  check(ledger.touched === true, "a dry run still reports that the run WOULD change things");
}

section("apply — contract case 3: a user's edits survive");

{
  const root = seedProject();
  await apply(root);
  const barrelPath = join(root, ...EDITED.sharedIndex.split("/"));
  const mine = `${readFileSync(barrelPath, "utf-8")}export * from "./my-module.js";\n`;
  writeFileSync(barrelPath, mine);

  const { ledger } = await apply(root);
  check(
    readFileSync(barrelPath, "utf-8") === mine,
    "a line the user added to a file the feature edits is still there after a re-apply",
  );
  check(ledger.summary().written.length === 0, "…and the re-apply wrote nothing at all");
}

section("apply — no client kit, no server");

{
  const root = seedProject({ core: false });
  const { ledger } = await apply(root);
  check(
    ledger.conflicts().some((c) => c.file === OWNED.coreSessionAuth),
    "without packages/core the sign-in helper is reported, not written somewhere else",
  );
  check(
    ledger.summary().written.includes(OWNED.authSessionHooks),
    "…and the server half still lands",
  );
}

{
  const root = scratch("tca-static-");
  const { ledger, logs } = await apply(root);
  check(ledger.touched === false, "nothing is written where there is no auth config");
  check(
    logs.some((line) => line.includes("has no session to name")),
    "…and the reason is logged rather than thrown",
  );
}

// ─────────────────────────────────────────────────────────────────────

section("composition — merging into an auth config another feature wrote first");

{
  const pristine = readFileSync(
    join(STARTER_ROOT, "packages", "server", "src", "auth", "auth.ts"),
    "utf-8",
  );

  // What `workspaces` leaves behind: a `plugins:` key and a `databaseHooks:`
  // with a `user` hook in it. Inserting a second `databaseHooks:` here would
  // be a duplicate object key — TypeScript reports it, and at runtime the
  // first one is silently discarded.
  const withWorkspaces = pristine.replace(
    "\n    trustedOrigins: getTrustedOrigins(),\n",
    `\n    trustedOrigins: getTrustedOrigins(),

    plugins: [organization({ disableOrganizationDeletion: true })],

    databaseHooks: {
      user: {
        create: {
          after: bootstrapWorkspaceOnUserCreate,
        },
      },
    },
`,
  );
  check(withWorkspaces !== pristine, "the workspaces fixture differs from the starter file");

  const merged = rewriteAuthConfig(withWorkspaces);
  check(merged.outcome === "rewritten", "the feature applies on top of workspaces");
  const out = merged.next ?? "";
  check(topLevelKeyCount(out, "databaseHooks") === 1, "still exactly one `databaseHooks:` key");
  check(topLevelKeyCount(out, "session") === 1, "…and one `session:` key");
  check(
    out.includes("bootstrapWorkspaceOnUserCreate"),
    "workspaces' own user hook is still there",
  );
  check(
    out.includes("expiryForSessionRefresh(update, context)"),
    "…beside this feature's session hooks",
  );
  check(out.includes("plugins: [organization("), "and its plugins array is untouched");
  check(
    rewriteAuthConfig(out).outcome === "already-applied",
    "the merge recognises its own output",
  );
}

{
  // The reverse order: this feature first, then a `plugins:` key arrives.
  // Nothing here inserts `plugins:`, which is what makes that safe.
  const pristine = readFileSync(
    join(STARTER_ROOT, "packages", "server", "src", "auth", "auth.ts"),
    "utf-8",
  );
  const mine = rewriteAuthConfig(pristine).next ?? "";
  check(
    !mine.includes("plugins: ["),
    "this feature never writes a `plugins:` key — three other features already do, and a second one is a duplicate key",
  );
  check(topLevelKeyCount(mine, "session") === 1, "one `session:` key on the pristine file too");
  check(topLevelKeyCount(mine, "databaseHooks") === 1, "…and one `databaseHooks:`");
}

section("rewrites — a file that has moved on is reported, not guessed at");

{
  check(
    rewriteAuthConfig("export const nothing = 1;\n").outcome === "manual",
    "an auth.ts with no betterAuth({ … }) call is reported",
  );
  check(
    rewriteCors("export const nothing = 1;\n").outcome === "manual",
    "an app.ts with no cors({ … }) call is reported",
  );
  const app = readFileSync(join(STARTER_ROOT, "packages", "server", "src", "app.ts"), "utf-8");
  const once = rewriteCors(app);
  check(once.outcome === "rewritten", "the starter's CORS options are patched");
  check(
    rewriteCors(once.next ?? "").outcome === "already-applied",
    "…and, recognising its own output, patched only once",
  );

  check(
    rewriteBarrel('export * from "./types.js";\n', ["client-kind"]).outcome === "rewritten",
    "a barrel without the module is appended to",
  );
  const barrel = rewriteBarrel('export * from "./types.js";\n', ["client-kind"]);
  check(
    rewriteBarrel(barrel.next ?? "", ["client-kind"]).outcome === "already-applied",
    "…exactly once",
  );

}

// ─────────────────────────────────────────────────────────────────────
// The generated modules, actually running
// ─────────────────────────────────────────────────────────────────────

/**
 * Render this feature's runtime modules into one flat scratch package and
 * import them.
 *
 * Flat, and with `@starter/shared` rewritten to `./client-kind.js`, because
 * the only thing the generated server modules take from that package is what
 * `client-kind.ts` exports. Everything else about them — the branching, the
 * arithmetic, the error codes — is exactly what a project would run.
 */
async function loadGenerated(): Promise<Record<string, unknown>> {
  const dir = scratch("tca-generated-");
  writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');

  const modules: [string, string][] = [
    ["client-kind.ts", "shared/client-kind.ts"],
    ["session-auth.ts", "core/session-auth.ts"],
    ["session-lifetime.ts", "server/auth/session-lifetime.ts"],
    ["client-label.ts", "server/auth/client-label.ts"],
    ["session-hooks.ts", "server/auth/session-hooks.ts"],
  ];

  for (const [name, template] of modules) {
    const rendered = render(template, IDS).replaceAll('"@starter/shared"', '"./client-kind.js"');
    writeFileSync(join(dir, name), rendered);
  }

  const loaded: Record<string, unknown> = {};
  for (const [name] of modules) {
    Object.assign(loaded, await import(join(dir, name)));
  }
  return loaded;
}

const G = await loadGenerated();

// biome-ignore lint/suspicious/noExplicitAny: dynamically loaded templates.
const fn = (name: string): any => {
  const value = G[name];
  assert.ok(value, `generated export missing: ${name}`);
  return value;
};

section("generated — session lifetime is per client kind");

{
  const { isTokenClient, sessionExpiresInSeconds, sessionExpiresAt } = {
    isTokenClient: fn("isTokenClient"),
    sessionExpiresInSeconds: fn("sessionExpiresInSeconds"),
    sessionExpiresAt: fn("sessionExpiresAt"),
  };
  const long = fn("TOKEN_CLIENT_SESSION_SECONDS") as number;
  const short = fn("BROWSER_SESSION_SECONDS") as number;

  check(long === 60 * 60 * 24 * 30, "the stored-token window is thirty days");
  check(short === 60 * 60 * 24 * 7, "the browser window is seven days");
  check(long > short, "…and the long one really is longer");

  for (const kind of ["cli", "desktop", "mobile", "extension", "raycast", "mcp"]) {
    check(isTokenClient(kind) === true, `${kind} carries a stored token`);
    check(sessionExpiresInSeconds(kind) === long, `${kind} gets the long window`);
  }
  check(isTokenClient("web") === false, "a browser does not");
  check(sessionExpiresInSeconds("web") === short, "…and gets the short window");
  check(
    sessionExpiresInSeconds("unknown") === short,
    "an unlabelled client falls on the SHORT side — it loses convenience, never safety",
  );

  const now = 1_700_000_000_000;
  check(
    sessionExpiresAt("cli", now).getTime() === now + long * 1000,
    "sessionExpiresAt is now plus that client's window",
  );
}

section("generated — the refresh reads the STAMPED client, not the request");

{
  const clientKindForNewSession = fn("clientKindForNewSession");
  const clientKindForSessionRefresh = fn("clientKindForSessionRefresh");
  const expiryForNewSession = fn("expiryForNewSession");
  const expiryForSessionRefresh = fn("expiryForSessionRefresh");
  const long = fn("TOKEN_CLIENT_SESSION_SECONDS") as number;
  const short = fn("BROWSER_SESSION_SECONDS") as number;
  const now = 1_700_000_000_000;

  const headers = (value?: string): Headers => {
    const h = new Headers();
    if (value) h.set(IDS.clientHeader, value);
    return h;
  };

  check(
    clientKindForNewSession({ headers: headers("cli") }) === "cli",
    "a new session takes its kind from the client header",
  );
  check(
    clientKindForNewSession({ request: { headers: headers("mobile") } }) === "mobile",
    "…on the request too, for the endpoints that nest it there",
  );
  check(
    clientKindForNewSession({ headers: headers(), body: { client_id: IDS.clientIds.cli } }) === "cli",
    "the device flow sends no header — its client_id in the body is read instead",
  );
  check(
    clientKindForNewSession({
      headers: headers("extension"),
      body: { client_id: IDS.clientIds.cli },
    }) === "extension",
    "a request that does both is taken at its header's word",
  );
  check(
    clientKindForNewSession({ headers: headers("nonsense") }) === "unknown",
    "an unrecognised value is unknown, not accepted",
  );
  check(clientKindForNewSession(null) === "unknown", "a null context is unknown, not a throw");

  // The trap. A mobile session's own WebSocket re-check replays a handshake
  // that carries no client header at all — and a browser's handshake CANNOT
  // carry one. Deciding from the live request would demote the phone.
  const stamped = (client: string) => ({ context: { session: { session: { client } } } });
  check(
    clientKindForSessionRefresh({ ...stamped("mobile"), headers: headers() }) === "mobile",
    "a refresh with no header keeps the window stamped on the row",
  );
  check(
    clientKindForSessionRefresh({ ...stamped("mobile"), headers: headers("web") }) === "mobile",
    "…even when the refreshing request says otherwise",
  );
  check(
    clientKindForSessionRefresh({ ...stamped("web"), headers: headers("cli") }) === "web",
    "and a browser cannot promote itself to the long window later",
  );
  check(
    clientKindForSessionRefresh({ headers: headers("cli") }) === "cli",
    "with no stamped row at all, the header is the fallback",
  );
  check(
    clientKindForSessionRefresh({ headers: headers() }) === "unknown",
    "…falling to unknown, i.e. to the short window",
  );

  check(
    expiryForNewSession({ headers: headers("cli") }, now).getTime() === now + long * 1000,
    "a CLI sign-in is given the long window at creation",
  );
  check(
    expiryForNewSession({ headers: headers("web") }, now).getTime() === now + short * 1000,
    "a browser sign-in is given the short one",
  );

  check(
    expiryForSessionRefresh({ activeOrganizationId: "x" }, stamped("mobile"), now) === null,
    "an update that is NOT moving expiresAt is left alone — not every write is an extension",
  );
  const refreshed = expiryForSessionRefresh(
    { expiresAt: new Date(now) },
    { ...stamped("mobile"), headers: headers("web") },
    now,
  );
  check(
    refreshed?.getTime() === now + long * 1000,
    "a real refresh re-writes the stamped client's window — the create hook alone would not",
  );
}

section("generated — client labels");

{
  const describeClient = fn("describeClient");
  const normalizeClientKind = fn("normalizeClientKind");
  const clientKindFromHeaders = fn("clientKindFromHeaders");

  check(normalizeClientKind("CLI") === "cli", "the header value is case-insensitive");
  check(normalizeClientKind(IDS.clientIds.extension) === "extension", "a client id maps to its kind");
  check(normalizeClientKind(undefined) === "unknown", "a missing value is unknown");
  check(normalizeClientKind(42) === "unknown", "so is a non-string");
  check(clientKindFromHeaders(null) === "unknown", "and so are absent headers");

  check(describeClient("cli", null) === "Command line", "a CLI names itself");
  check(
    describeClient("cli", "Mozilla/5.0 (Macintosh; Intel Mac OS X)") === "Command line on macOS",
    "…with the platform when the user agent gives one",
  );
  check(
    describeClient("extension", "Mozilla/5.0 (Windows NT 10.0) Firefox/141.0") ===
      "Firefox extension on Windows",
    "an extension names the browser it is installed in — the same extension twice would not tell apart",
  );
  check(
    describeClient("web", "Mozilla/5.0 (Macintosh) AppleWebKit Chrome/140 Safari/537") ===
      "Chrome on macOS",
    "every Chromium UA also claims Safari — Chrome must win",
  );
  check(
    describeClient("web", "Mozilla/5.0 (Windows NT 10.0) Chrome/140 Safari/537 Edg/140") ===
      "Edge on Windows",
    "…and Edge must win over Chrome",
  );
  check(describeClient("unknown", null) === "Unknown client", "nothing to go on reads as unknown");
}

section("generated — the client sign-in helper");

{
  const signInWithPassword = fn("signInWithPassword");
  const startDeviceAuthorization = fn("startDeviceAuthorization");
  const requestDeviceToken = fn("requestDeviceToken");
  const pollForDeviceSession = fn("pollForDeviceSession");
  const AuthError = fn("AuthError");
  const SECOND_FACTOR_UNSUPPORTED = fn("SECOND_FACTOR_UNSUPPORTED") as string;

  type Call = { url: string; init: RequestInit };
  const makeFetch = (
    responses: { status?: number; headers?: Record<string, string>; body?: unknown }[],
  ) => {
    const calls: Call[] = [];
    let index = 0;
    const impl = async (url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init });
      const spec = responses[Math.min(index++, responses.length - 1)];
      return new Response(JSON.stringify(spec.body ?? {}), {
        status: spec.status ?? 200,
        headers: { "content-type": "application/json", ...(spec.headers ?? {}) },
      });
    };
    return { impl: impl as unknown as typeof fetch, calls };
  };

  const options = (fetchImpl: typeof fetch) => ({
    baseUrl: "https://api.example.com/",
    clientId: IDS.clientIds.cli,
    fetchImpl,
  });

  // password sign-in
  {
    const { impl, calls } = makeFetch([
      { headers: { "set-auth-token": "sess-abc" }, body: { user: { id: "u1", email: "a@b.c" } } },
    ]);
    const issued = await signInWithPassword(options(impl), {
      email: "a@b.c",
      password: "hunter2",
    });
    check(issued.token === "sess-abc", "the session token comes off the set-auth-token header");
    check(issued.userId === "u1" && issued.email === "a@b.c", "the account comes off the body");
    check(
      calls[0].url === "https://api.example.com/api/auth/sign-in/email",
      "a trailing slash on baseUrl does not become a doubled path",
    );
    check(
      (calls[0].init.headers as Record<string, string>)[IDS.clientHeader] === IDS.clientIds.cli,
      "the client names itself, so its session can be found in the devices list",
    );
  }

  // no bearer plugin on the server
  {
    const { impl } = makeFetch([{ body: { user: { id: "u1" } } }]);
    let code: string | null = null;
    try {
      await signInWithPassword(options(impl), { email: "a@b.c", password: "x" });
    } catch (error) {
      code = error instanceof AuthError ? error.code : String(error);
    }
    check(
      code === "NO_SESSION_TOKEN",
      "a cookie-only success is an ERROR here — the caller would be left holding no credential",
    );
  }

  // a second factor the client cannot show
  {
    const { impl } = makeFetch([{ body: { twoFactorRedirect: true } }]);
    let code: string | null = null;
    try {
      await signInWithPassword(options(impl), { email: "a@b.c", password: "x" });
    } catch (error) {
      code = error instanceof AuthError ? error.code : String(error);
    }
    check(
      code === SECOND_FACTOR_UNSUPPORTED,
      "a challenge this client has no cookie jar for is named, not reported as a missing token",
    );
  }

  // a refused sign-in carries the server's own code
  {
    const { impl } = makeFetch([
      { status: 403, body: { message: "Invalid origin", code: "INVALID_ORIGIN" } },
    ]);
    let code: string | null = null;
    try {
      await signInWithPassword(options(impl), { email: "a@b.c", password: "x" });
    } catch (error) {
      code = error instanceof AuthError ? error.code : String(error);
    }
    check(code === "INVALID_ORIGIN", "the server's refusal code survives to the caller");
  }

  // a proxy's HTML error page is not JSON
  {
    const impl = (async () =>
      new Response("<html>504</html>", {
        status: 504,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;
    let code: string | null = null;
    try {
      await signInWithPassword(options(impl), { email: "a@b.c", password: "x" });
    } catch (error) {
      code = error instanceof AuthError ? error.code : String(error);
    }
    check(code === "HTTP_504", "an unparseable body falls back to the status, not a parse throw");
  }

  // device authorization
  {
    const { impl, calls } = makeFetch([
      {
        body: {
          device_code: "dev-1",
          user_code: "ABCD-EFGH",
          verification_uri: "https://app.example.com/device",
          verification_uri_complete: "https://app.example.com/device?user_code=ABCD-EFGH",
          expires_in: 600,
          interval: 5,
        },
      },
    ]);
    const auth = await startDeviceAuthorization(options(impl));
    check(auth.deviceCode === "dev-1" && auth.userCode === "ABCD-EFGH", "the codes are parsed");
    check(auth.intervalSeconds === 5, "so is the server-mandated poll interval");
    check(
      JSON.parse(String(calls[0].init.body)).client_id === IDS.clientIds.cli,
      "the client_id goes in the body, where the allowlist checks it",
    );
  }

  {
    const { impl } = makeFetch([{ body: { user_code: "ABCD" } }]);
    let code: string | null = null;
    try {
      await startDeviceAuthorization(options(impl));
    } catch (error) {
      code = error instanceof AuthError ? error.code : String(error);
    }
    check(code === "PARSE_ERROR", "a response missing the device code is malformed, not empty");
  }

  // one exchange attempt — the shape a killable worker needs
  {
    const { impl } = makeFetch([{ status: 400, body: { error: "authorization_pending" } }]);
    const result = await requestDeviceToken(options(impl), "dev-1");
    check(result.status === "pending", "authorization_pending means ask again later");
  }
  {
    const { impl } = makeFetch([{ status: 400, body: { error: "slow_down" } }]);
    const result = await requestDeviceToken(options(impl), "dev-1");
    check(result.status === "slow-down", "slow_down means back off and ask again later");
  }
  {
    const { impl } = makeFetch([
      { body: { access_token: "sess-xyz", user: { id: "u9", email: "z@z.z" } } },
    ]);
    const result = await requestDeviceToken(options(impl), "dev-1");
    check(
      result.status === "approved" && result.session.token === "sess-xyz",
      "the device grant returns the token as access_token, with no set-auth-token header",
    );
  }
  {
    const { impl } = makeFetch([
      { status: 400, body: { error: "access_denied", error_description: "User said no" } },
    ]);
    let code: string | null = null;
    try {
      await requestDeviceToken(options(impl), "dev-1");
    } catch (error) {
      code = error instanceof AuthError ? error.code : String(error);
    }
    check(code === "access_denied", "anything else is terminal, carrying the RFC's own code");
  }
  {
    const { impl } = makeFetch([{ body: {} }]);
    let code: string | null = null;
    try {
      await requestDeviceToken(options(impl), "dev-1");
    } catch (error) {
      code = error instanceof AuthError ? error.code : String(error);
    }
    check(code === "NO_SESSION_TOKEN", "an approval with no token is an error, not a session");
  }

  // the polling loop
  {
    const { impl, calls } = makeFetch([
      { status: 400, body: { error: "authorization_pending" } },
      { status: 400, body: { error: "slow_down" } },
      { body: { access_token: "sess-final" } },
    ]);
    const slept: number[] = [];
    const session = await pollForDeviceSession(options(impl), "dev-1", {
      intervalSeconds: 5,
      sleepImpl: async (ms: number) => {
        slept.push(ms);
      },
    });
    check(session.token === "sess-final", "the loop returns the session once approved");
    check(calls.length === 3, "…after exactly as many exchanges as the server needed");
    check(slept[0] === 5000, "it waits the server's interval");
    check(slept[1] === 10_000, "…and adds five seconds on slow_down");
  }

  {
    const { impl } = makeFetch([{ status: 400, body: { error: "authorization_pending" } }]);
    const controller = new AbortController();
    controller.abort();
    let code: string | null = null;
    try {
      await pollForDeviceSession(options(impl), "dev-1", { signal: controller.signal });
    } catch (error) {
      code = error instanceof AuthError ? error.code : String(error);
    }
    check(code === "CANCELLED", "a cancelled wait stops rather than polling a dead flow");
  }

  {
    const { impl } = makeFetch([{ status: 400, body: { error: "authorization_pending" } }]);
    let code: string | null = null;
    try {
      await pollForDeviceSession(options(impl), "dev-1", {
        timeoutSeconds: -1,
        sleepImpl: async () => {},
      });
    } catch (error) {
      code = error instanceof AuthError ? error.code : String(error);
    }
    check(code === "expired_token", "a timed-out poll reports the RFC's expiry code");
  }
}

// ─────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────

for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n  ${failed} of ${checks} checks failed.\n`);
  process.exit(1);
}
console.log(`\n  ✓ token-client-auth — ${checks} checks passed.\n`);
