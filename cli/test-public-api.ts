/**
 * `public-api` feature writer tests.
 *
 * The feature writes ~35 files into somebody's scaffolded project and patches
 * five of their own. Two classes of failure are worth a test here, and they
 * are different:
 *
 *   1. WRITER behaviour — does the first run land the files and the patches,
 *      is the second run a complete no-op, and does a project with no server
 *      package decline cleanly rather than half-apply.
 *   2. TEMPLATE invariants — the properties of the generated code that fail
 *      QUIETLY in production. A body serialized twice is rejected only by
 *      receivers that verify signatures; an SSRF check moved back to create
 *      time still passes every test that does not look for it; a 5xx detail
 *      that leaks a driver message looks fine until somebody runs with
 *      NODE_ENV unset. None of those break a build, so they are asserted as
 *      static properties of the shipped templates.
 *
 * Run: pnpm --filter hatchkit test:public-api
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { hasMarkedBlocks, stripMarkedBlocks } from "./src/features/client-core/markers.js";
import { ITEMS_ROUTER_NOTE, applyPublicApi } from "./src/features/public-api/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const STARTER_SERVER = join(here, "..", "starter", "packages", "server");
const TEMPLATES = join(here, "src", "templates", "features", "public-api");

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (!cond) {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

/** Read a shipped template, tokens and all. */
function template(rel: string): string {
  return readFileSync(join(TEMPLATES, rel), "utf-8");
}

/**
 * A minimal but REAL scaffolded project.
 *
 * The four files the feature patches are copied verbatim out of `starter/`
 * rather than stubbed: the patches are literal-anchor, so a hand-written
 * approximation would pass while the real file's anchors had already moved.
 */
function makeProject(root: string, options: { clientCore?: boolean } = {}): string {
  const server = join(root, "packages", "server");
  mkdirSync(join(server, "src", "trpc", "routers"), { recursive: true });
  mkdirSync(join(server, "src", "config"), { recursive: true });
  mkdirSync(join(root, "packages", "shared"), { recursive: true });

  for (const rel of [
    "src/app.ts",
    "src/index.ts",
    "src/config/env.ts",
    "src/trpc/router.ts",
    "src/trpc/routers/items.ts",
  ]) {
    cpSync(join(STARTER_SERVER, rel), join(server, rel));
  }
  // `hatchkit create` strips the `// ── client-core ──` blocks when that
  // feature is not selected, so a scaffolded router has two legitimate
  // shapes. Reproduced here with the scaffold's own strip rather than a
  // hand-written approximation — a fixture of "what a stripped file looks
  // like" is the second implementation the marker convention exists to avoid.
  if (options.clientCore === false) {
    const router = join(server, "src/trpc/routers/items.ts");
    writeFileSync(router, stripMarkedBlocks(readFileSync(router, "utf-8")));
  } else {
    // client-core also ships the sync feed the bridge soft-couples to.
    mkdirSync(join(server, "src", "sync"), { recursive: true });
    cpSync(join(STARTER_SERVER, "src/sync/feed.ts"), join(server, "src/sync/feed.ts"));
  }
  cpSync(join(STARTER_SERVER, "package.json"), join(server, "package.json"));
  writeFileSync(
    join(root, "packages", "shared", "package.json"),
    `${JSON.stringify({ name: "@starter/shared", version: "0.1.0" }, null, 2)}\n`,
  );
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "demo", private: true, scripts: { build: "true" } }, null, 2)}\n`,
  );
  writeFileSync(join(server, ".env.example"), "MONGODB_URI=\n");
  return server;
}

const root = mkdtempSync(join(tmpdir(), "public-api-"));

/** The feature reports every path from the REPO ROOT, so a conflict line
 *  names a file the user can actually open. The server package sits at
 *  `packages/server`, so a server-relative path gains that prefix in the
 *  report while staying server-relative on disk. */
const srv = (rel: string) => `packages/server/${rel}`;
try {
  // ── 1. first run ───────────────────────────────────────────────────
  const server = makeProject(root);
  const first = applyPublicApi({ projectDir: root, projectName: "Demo" });

  assert(first.skipped === undefined, `first run not skipped (got ${String(first.skipped)})`);

  for (const rel of [
    "src/api/v1/index.ts",
    "src/api/v1/auth.ts",
    "src/api/v1/routes-table.ts",
    "src/api/v1/openapi.ts",
    "src/api/v1/emit-openapi.ts",
    "src/api/v1/problem.ts",
    "src/api/v1/envelope.ts",
    "src/api/v1/query.ts",
    "src/api/v1/rate-limit.ts",
    "src/api/v1/routes/meta.ts",
    "src/api/v1/routes/items.ts",
    "src/api/v1/routes/webhooks.ts",
    "src/auth/api-token.ts",
    "src/auth/api-permissions.ts",
    "src/models/ApiToken.ts",
    "src/models/ApiMember.ts",
    "src/models/WebhookSubscription.ts",
    "src/models/WebhookDelivery.ts",
    "src/services/tenancy.ts",
    "src/services/items/index.ts",
    "src/services/items/events.ts",
    "src/services/api-tokens/index.ts",
    "src/services/webhooks/signature.ts",
    "src/services/webhooks/ssrf.ts",
    "src/services/webhooks/projection.ts",
    "src/services/webhooks/delivery.ts",
    "src/services/webhooks/sweeper.ts",
    "src/trpc/routers/api-tokens.ts",
    "src/tests/openapi-document.test.ts",
  ]) {
    assert(first.written.includes(srv(rel)), `first run wrote ${rel}`);
    assert(existsSync(join(server, rel)), `${rel} exists on disk`);
  }
  for (const rel of [
    "docs/public-api.md",
    "docs-site/static/openapi.json",
    "docs-site/docs/api/reference.md",
  ]) {
    assert(first.written.includes(rel), `first run wrote ${rel}`);
    assert(existsSync(join(root, rel)), `${rel} exists at the repo root`);
  }

  // ── 2. the app.ts mount lands in the right place ───────────────────
  const app = readFileSync(join(server, "src/app.ts"), "utf-8");
  assert(first.patched.includes(srv("src/app.ts")), "app.ts reported as patched");
  assert(
    app.includes('import { registerApiV1Routes } from "./api/v1/index.js";'),
    "app.ts imports the v1 mount",
  );
  const atJson = app.indexOf("app.use(express.json(");
  const atTrpc = app.indexOf('app.use("/api/trpc", trpcMiddleware);');
  const atV1 = app.indexOf("registerApiV1Routes(app);");
  const atHealth = app.indexOf('app.get("/api/health"');
  const atNotFound = app.indexOf("app.use(notFoundHandler)");
  assert(
    atJson > 0 && atTrpc > 0 && atV1 > 0 && atHealth > 0 && atNotFound > 0,
    "app.ts landmarks found",
  );
  // Ordering is the whole point of the patch: a body the handlers can read,
  // tRPC keeping first claim on its prefix, and the 404 handler last.
  assert(atV1 > atJson, "v1 is mounted after express.json()");
  assert(atV1 > atTrpc, "v1 is mounted after the tRPC middleware");
  assert(atV1 < atHealth, "v1 is mounted before the health endpoint");
  assert(atV1 < atNotFound, "v1 is mounted before notFoundHandler");
  // A second express.raw() would fight the Stripe mount for a body this
  // server never reads — the signed bytes are ones it serializes itself.
  assert(
    (app.match(/express\.raw\(/g) ?? []).length === 1,
    "app.ts still has exactly one express.raw() (Stripe's)",
  );

  // ── 3. the other patches ───────────────────────────────────────────
  const index = readFileSync(join(server, "src/index.ts"), "utf-8");
  assert(index.includes("startWebhookSweeper();"), "index.ts starts the sweeper");
  assert(index.includes("stopWebhookSweeper();"), "index.ts stops the sweeper on shutdown");
  assert(
    index.indexOf("startWebhookSweeper();") < index.indexOf("server.listen(env.PORT"),
    "the sweeper starts before the server listens",
  );

  const trpcRouter = readFileSync(join(server, "src/trpc/router.ts"), "utf-8");
  assert(trpcRouter.includes("apiTokens: apiTokensRouter,"), "trpc router registers apiTokens");

  const envConfig = readFileSync(join(server, "src/config/env.ts"), "utf-8");
  assert(
    envConfig.includes('getOptional("API_RATE_LIMIT_PER_MINUTE", "600")'),
    "env.ts gains API_RATE_LIMIT_PER_MINUTE with a 600 default",
  );
  assert(
    envConfig.includes(
      'WEBHOOK_ALLOW_PRIVATE_TARGETS: getOptional("WEBHOOK_ALLOW_PRIVATE_TARGETS") === "true"',
    ),
    "env.ts gains WEBHOOK_ALLOW_PRIVATE_TARGETS",
  );
  assert(
    envConfig.indexOf("API_RATE_LIMIT_PER_MINUTE") < envConfig.indexOf("  isProduction:"),
    "the new keys are inside the env object literal",
  );

  const envExample = readFileSync(join(server, ".env.example"), "utf-8");
  assert(envExample.includes("API_RATE_LIMIT_PER_MINUTE=600"), ".env.example documents the limit");

  const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as {
    scripts?: Record<string, string>;
  };
  assert(
    (rootPkg.scripts?.["openapi:emit"] ?? "").includes("emit-openapi.ts"),
    "root package.json gains openapi:emit",
  );

  // ── 4. the items router really was extracted ───────────────────────
  const itemsRouter = readFileSync(join(server, "src/trpc/routers/items.ts"), "utf-8");
  assert(
    first.written.includes(srv("src/trpc/routers/items.ts")),
    "the starter's item router was rewritten",
  );
  assert(
    itemsRouter.includes('from "../../services/items/index.js"'),
    "the tRPC item router calls the extracted service",
  );
  assert(
    itemsRouter.includes("scopeForSession(ctx.user)"),
    "the tRPC item router builds its scope from the session",
  );
  // The logic must be GONE from the router, not merely also present in the
  // service — a copy left here is a copy that drifts.
  assert(!itemsRouter.includes("Item.find("), "the router no longer queries the model directly");
  assert(!itemsRouter.includes("Item.create("), "the router no longer writes the model directly");
  assert(
    !readFileSync(join(server, "src/api/v1/routes/items.ts"), "utf-8").includes("trpc"),
    "the REST item routes never reach for tRPC",
  );

  // ── 4a. the client-core blocks survive the rewrite ─────────────────
  // `hatchkit` strips what is between these markers when client-core is not
  // selected. A rewrite that dropped them, reflowed them or left them
  // unbalanced would take the feature's removability with it — and nothing
  // would fail until somebody scaffolded without client-core.
  assert(hasMarkedBlocks(itemsRouter), "the rewritten router still carries client-core blocks");
  assert(
    itemsRouter.includes("// ── client-core ──") &&
      itemsRouter.includes("// ── end client-core ──"),
    "the markers are the ones the strip recognises",
  );
  let strippedRouter = "";
  try {
    strippedRouter = stripMarkedBlocks(itemsRouter);
  } catch (err) {
    failed++;
    console.error(`  ✗ the rewritten router's markers are unbalanced: ${String(err)}`);
  }
  // After a strip there must be no client-core residue at all — a dangling
  // import is a scaffold that fails its very first `pnpm build`.
  for (const residue of ["updateItemSchema", "updateItem", "publishSync", "sync/feed", "update:"]) {
    assert(!strippedRouter.includes(residue), `a stripped router has no ${residue}`);
  }
  // ...and what survives must still be a whole router.
  for (const kept of ["list:", "get:", "create:", "delete:", "scopeForSession(ctx.user)"]) {
    assert(strippedRouter.includes(kept), `a stripped router keeps ${kept}`);
  }

  // The new `update` procedure goes through the service like every other one.
  assert(
    /update: protectedProcedure[\s\S]{0,200}updateItem\(scopeForSession\(ctx\.user\), input\)/.test(
      itemsRouter,
    ),
    "the update procedure delegates to the extracted service",
  );
  assert(
    !itemsRouter.includes("item.save()") && !itemsRouter.includes("publishSync("),
    "update no longer writes the model or publishes from the resolver",
  );

  // ── 4b. the baseline tracks the starter ────────────────────────────
  // The rewrite only fires on a router this feature recognises, so a starter
  // edit that leaves the baseline behind turns the extraction into a silent
  // no-op in every new project. Failing HERE puts that in the pull request
  // that caused it instead of in somebody's scaffold.
  assert(
    template("trpc/routers/items.original.ts.tpl")
      .split("__HATCHKIT_SHARED_PKG__")
      .join("@starter/shared") ===
      readFileSync(join(STARTER_SERVER, "src/trpc/routers/items.ts"), "utf-8"),
    "items.original.ts.tpl is byte-identical to starter/packages/server/src/trpc/routers/items.ts — re-copy it (only the @starter/shared specifier is tokenised)",
  );

  // ── 4c. the sync bridge, soft-coupled like the scheduler ───────────
  assert(
    first.written.includes(srv("src/services/items/sync-bridge.ts")),
    "the sync bridge is written when src/sync/feed.ts exists",
  );
  assert(
    index.includes("registerItemSyncBridge();"),
    "index.ts registers the bridge at module scope",
  );
  assert(
    index.indexOf("registerItemSyncBridge();") < index.indexOf("const app = createApp();"),
    "the bridge is registered before anything can serve a request",
  );
  const bridge = template("services/items/sync-bridge.ts.tpl");
  assert(
    bridge.includes("publishSync(scope.actorId,"),
    "the bridge publishes to the user the write ran as, never a value off input",
  );
  // events.ts must not import the feed itself: that would make client-core a
  // hard dependency of the public API and break every project without it.
  assert(
    !template("services/items/events.ts.tpl").includes("sync/feed"),
    "events.ts does not import the sync feed",
  );
  assert(
    template("services/items/events.ts.tpl").includes(
      "const listeners = new Set<ItemEventListener>()",
    ),
    "listeners are a list, so a second registration does not replace the first",
  );

  // ── 5. second run is a complete no-op ──────────────────────────────
  const second = applyPublicApi({ projectDir: root, projectName: "Demo" });
  assert(second.skipped === undefined, "second run not skipped");
  assert(
    second.written.length === 0,
    `second run wrote ${second.written.length} file(s), expected 0`,
  );
  assert(
    second.conflicted.length === 0,
    `second run reported ${second.conflicted.length} conflict(s), expected 0`,
  );
  assert(
    second.patched.length === 0,
    `second run patched ${second.patched.join(", ") || "nothing"}, expected nothing`,
  );
  assert(
    second.unchanged.length === first.written.length,
    "second run reports everything unchanged",
  );
  assert(
    readFileSync(join(server, "src/app.ts"), "utf-8") === app,
    "app.ts is byte-identical after the second run",
  );

  // ── 6. no server package → skipped, and nothing written ────────────
  const bare = mkdtempSync(join(tmpdir(), "public-api-bare-"));
  try {
    writeFileSync(join(bare, "package.json"), `${JSON.stringify({ name: "site" }, null, 2)}\n`);
    const skipped = applyPublicApi({ projectDir: bare, projectName: "Site" });
    assert(typeof skipped.skipped === "string", "a project with no server reports skipped");
    assert(skipped.written.length === 0, "a skipped run writes nothing");
    assert(!existsSync(join(bare, "docs")), "a skipped run leaves no docs behind");
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }

  // ── 7. an edited item router conflicts, with the exact instructions ─
  const edited = mkdtempSync(join(tmpdir(), "public-api-edited-"));
  try {
    const editedServer = makeProject(edited);
    const routerPath = join(editedServer, "src/trpc/routers/items.ts");
    writeFileSync(routerPath, `${readFileSync(routerPath, "utf-8")}\n// a change of my own\n`);
    const result = applyPublicApi({ projectDir: edited, projectName: "Edited" });
    assert(
      result.conflicted.includes(srv("src/trpc/routers/items.ts")),
      "an edited item router is reported as a conflict",
    );
    assert(
      readFileSync(routerPath, "utf-8").includes("// a change of my own"),
      "an edited item router is NOT overwritten",
    );
    assert(
      result.notes.includes(ITEMS_ROUTER_NOTE),
      "the conflict note spells out the manual change",
    );
    assert(
      ITEMS_ROUTER_NOTE.includes("scopeForSession") &&
        ITEMS_ROUTER_NOTE.includes("services/items/index.js"),
      "the note names both imports the user has to add",
    );
    // The rest of the feature still lands: a router the user owns must not
    // block the REST surface that does not touch it.
    assert(existsSync(join(editedServer, "src/api/v1/index.ts")), "the REST surface still landed");
  } finally {
    rmSync(edited, { recursive: true, force: true });
  }

  // ── 8. one route table, read by both the mount and the generator ───
  const mount = template("api/v1/index.ts.tpl");
  const openapi = template("api/v1/openapi.ts.tpl");
  const routesTable = template("api/v1/routes-table.ts.tpl");
  assert(mount.includes('from "./routes-table.js"'), "the Express mount reads the route table");
  assert(
    openapi.includes('from "./routes-table.js"'),
    "the OpenAPI generator reads the route table",
  );
  assert(
    mount.includes("for (const route of API_ROUTES)"),
    "every mounted route comes from the table",
  );
  assert(
    openapi.includes("for (const route of API_ROUTES)"),
    "every documented route comes from the table",
  );
  // A documented route with no implementation is a lie the spec tells. It must
  // stop the boot, where a deploy notices, not 404 in production.
  assert(
    mount.includes('throw new Error(`No handler registered for "${key}"`)') &&
      mount.includes('throw new Error(`No public handler registered for "${key}"`)'),
    "a table entry with no handler throws at boot",
  );
  assert(
    openapi.includes("z.toJSONSchema"),
    "the document is built with zod 4's native JSON Schema emitter",
  );

  // ── 9. no zod-to-openapi, anywhere ─────────────────────────────────
  const serverPkg = JSON.parse(readFileSync(join(server, "package.json"), "utf-8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const declared = Object.keys({ ...serverPkg.dependencies, ...serverPkg.devDependencies });
  assert(
    !declared.some((name) => name.includes("zod-to-openapi") || name.includes("zod-openapi")),
    "no zod-to-openapi dependency was added",
  );
  // The package name appears in `openapi.ts` — in the comment explaining why
  // it is not used — so the check is for an IMPORT of it, not a mention.
  for (const rel of [
    "api/v1/openapi.ts.tpl",
    "api/v1/routes-table.ts.tpl",
    "api/v1/query.ts.tpl",
  ]) {
    const source = template(rel);
    assert(
      !/(?:from|require\()\s*["'][^"']*zod[-/](?:to-)?openapi/.test(source),
      `${rel} does not import a zod-to-openapi package`,
    );
    assert(source.includes("zod") ? source.includes('from "zod"') : true, `${rel} uses zod itself`);
  }

  // ── 10. the body is serialized once and sent unchanged ─────────────
  const delivery = template("services/webhooks/delivery.ts.tpl");
  const serializations = (delivery.match(/JSON\.stringify\(/g) ?? []).length;
  assert(
    serializations === 1,
    `delivery.ts serializes the envelope ${serializations} time(s) — exactly 1 is required, or the HMAC covers bytes that were never sent`,
  );
  assert(
    delivery.includes("const rawBody = JSON.stringify(envelope);"),
    "the delivery body is captured in one variable",
  );
  assert(
    delivery.includes("signWebhookBody(subscription.secret, timestampSeconds, rawBody)"),
    "the HMAC is computed over that variable",
  );
  assert(delivery.includes("body: rawBody,"), "the request sends that same variable");
  assert(
    delivery.indexOf("const rawBody =") < delivery.indexOf("signWebhookBody("),
    "the body is serialized before it is signed",
  );
  assert(delivery.includes("await fetch(url, {"), "the delivery is handed to fetch");
  assert(delivery.includes('redirect: "manual"'), "redirects are recorded, never followed");

  // ── 11. the SSRF guard runs per attempt, not at create time ────────
  assert(
    delivery.includes("await assertDeliverableUrl(subscription.url)"),
    "every delivery attempt re-resolves the target",
  );
  assert(
    delivery.indexOf("assertDeliverableUrl") < delivery.indexOf("await fetch(url, {"),
    "the target is re-checked before the request goes out",
  );
  // The check lives inside `deliverWebhook`, which runs once per attempt —
  // not in a module-level cache or a create-only path.
  const deliverAt = delivery.indexOf("export async function deliverWebhook(");
  assert(
    deliverAt > 0 && delivery.indexOf("assertDeliverableUrl(subscription.url)") > deliverAt,
    "the re-resolution is inside deliverWebhook, so it runs per attempt",
  );
  const ssrf = template("services/webhooks/ssrf.ts.tpl");
  assert(
    ssrf.includes("env.WEBHOOK_ALLOW_PRIVATE_TARGETS"),
    "the private-target escape hatch is in the guard",
  );
  assert(
    !template("api/v1/routes/webhooks.ts.tpl").includes("WEBHOOK_ALLOW_PRIVATE_TARGETS"),
    "the escape hatch is not re-read in the route layer",
  );

  // ── 12. every 5xx detail is one constant ───────────────────────────
  const problem = template("api/v1/problem.ts.tpl");
  assert(
    problem.includes("export const INTERNAL_DETAIL ="),
    "there is a single internal-error detail constant",
  );
  const fixedDetails = (
    problem.match(/detail: (?:status|err\.status) >= 500 \? INTERNAL_DETAIL/g) ?? []
  ).length;
  assert(fixedDetails === 2, `both 5xx branches use the constant (found ${fixedDetails})`);
  assert(
    problem.includes("detail: INTERNAL_DETAIL,"),
    "the unrecognised-error branch uses the constant too",
  );
  // No environment branch anywhere near the detail: the global errorHandler
  // returns err.message verbatim outside production, and v1 exists partly to
  // not do that.
  assert(!problem.includes("isProduction"), "the 5xx detail does not depend on the environment");
  assert(
    mount.includes("problemFrom(err, req.originalUrl)"),
    "the mount maps every thrown error through the problem mapper",
  );

  // ── 13. envelope and 404-over-403 rules ────────────────────────────
  const envelope = template("api/v1/envelope.ts.tpl");
  assert(
    envelope.includes("nextCursor: string | null"),
    "nextCursor is always present and nullable, never optional",
  );
  const itemsService = template("services/items/index.ts.tpl");
  assert(
    itemsService.includes('code: "NOT_FOUND"') && itemsService.includes('code: "FORBIDDEN"'),
    "the item service distinguishes not-found from a real permission refusal",
  );
  assert(
    itemsService.indexOf("readableOwnerIds(scope).includes") <
      itemsService.indexOf('code: "FORBIDDEN"'),
    "visibility is decided (404) before writability is (403)",
  );

  // ── 14. the committed spec matches the route table ─────────────────
  const specText = readFileSync(join(root, "docs-site/static/openapi.json"), "utf-8");
  let spec: {
    paths?: Record<string, Record<string, unknown>>;
    openapi?: string;
    info?: { title?: string };
  };
  try {
    spec = JSON.parse(specText);
  } catch (err) {
    failed++;
    console.error(`  ✗ the committed openapi.json does not parse: ${String(err)}`);
    spec = {};
  }
  assert(spec.openapi === "3.1.0", "the committed spec declares OpenAPI 3.1.0");
  assert(spec.info?.title === "Demo API", "the project name was substituted into the spec");

  // Every `{ method, path }` in the table must appear in the document, and
  // nothing else may. This is the check that catches a spec regenerated from
  // a different table than the one that ships.
  const tableEntries = [
    ...routesTable.matchAll(/method: "(get|post|patch|delete)",\s*\n\s*path: "([^"]+)"/g),
  ].map(
    ([, method, path]) =>
      `${method} /api/v1${(path as string).replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}")}`,
  );
  assert(tableEntries.length === 11, `parsed ${tableEntries.length} table entries, expected 11`);
  const specEntries: string[] = [];
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of Object.keys(item)) specEntries.push(`${method} ${path}`);
  }
  assert(
    [...tableEntries].sort().join("\n") === [...specEntries].sort().join("\n"),
    `the committed spec's paths match the route table\n    table: ${[...tableEntries].sort().join(", ")}\n    spec:  ${[...specEntries].sort().join(", ")}`,
  );

  // The reference page is generated from the same array, so every path in the
  // table has to be listed on it too.
  const reference = readFileSync(join(root, "docs-site/docs/api/reference.md"), "utf-8");
  for (const path of [
    "/items",
    "/items/:id",
    "/webhooks",
    "/webhooks/:id",
    "/me",
    "/openapi.json",
  ]) {
    assert(reference.includes(`\`${path}\``), `the reference page lists ${path}`);
  }

  // ── 15. the sibling features, when they are installed ──────────────
  // `scheduler` and `server-migrations` may have been applied first. Their
  // registries are THEIR files, so the patches target the shapes those
  // features actually ship and leave anything else alone with a note.
  const withRegistries = mkdtempSync(join(tmpdir(), "public-api-registries-"));
  try {
    const regServer = makeProject(withRegistries);
    mkdirSync(join(regServer, "src/services/scheduler"), { recursive: true });
    mkdirSync(join(regServer, "src/models"), { recursive: true });
    // Copied from the `scheduler` feature's own template, reduced to the two
    // lines this patch anchors on. A leading block comment on purpose: an
    // import placed on line one would land inside it.
    writeFileSync(
      join(regServer, "src/services/scheduler/index.ts"),
      [
        "/*",
        " * The scheduler's public surface.",
        " */",
        'import { HEARTBEAT_JOB, registerHeartbeatJob } from "./heartbeat.js";',
        'import { jobRegistry } from "./registry.js";',
        "",
        "export function registerBuiltInJobs(): void {",
        "  const registered = new Set(jobRegistry.list().map((job) => job.name));",
        "",
        "  if (!registered.has(HEARTBEAT_JOB)) registerHeartbeatJob();",
        "}",
        "",
      ].join("\n"),
    );
    // `server-migrations` registers models by side-effect import.
    writeFileSync(
      join(regServer, "src/models/registry.ts"),
      [
        'import mongoose from "mongoose";',
        'import "./Item.js";',
        'import "./Profile.js";',
        "",
        "export function allModels(): mongoose.Model<unknown>[] {",
        "  return Object.values(mongoose.models).map((model) => model as mongoose.Model<unknown>);",
        "}",
        "",
      ].join("\n"),
    );

    const withReg = applyPublicApi({ projectDir: withRegistries, projectName: "Reg" });

    assert(
      withReg.written.includes(srv("src/services/webhooks/sweep-job.ts")),
      "the scheduler adapter is written only when there is a scheduler",
    );
    const scheduler = readFileSync(join(regServer, "src/services/scheduler/index.ts"), "utf-8");
    assert(
      withReg.patched.includes(srv("src/services/scheduler/index.ts")),
      "registerBuiltInJobs is patched when the scheduler is installed",
    );
    assert(
      scheduler.includes("if (!registered.has(WEBHOOK_SWEEP_JOB_NAME)) registerWebhookSweepJob();"),
      "the sweep is registered the way the scheduler's own jobs are",
    );
    assert(
      scheduler.indexOf('from "../webhooks/sweep-job.js"') > scheduler.indexOf("*/"),
      "the import lands after the leading block comment, not inside it",
    );
    assert(
      scheduler.indexOf('from "../webhooks/sweep-job.js"') <
        scheduler.indexOf("registerWebhookSweepJob();"),
      "the import precedes its use",
    );
    assert(
      scheduler.includes("if (!registered.has(HEARTBEAT_JOB)) registerHeartbeatJob();"),
      "the scheduler's own job survives the patch",
    );
    // With a leased scheduler owning the sweep, the standalone interval must
    // NOT also be started: the claim in delivery.ts makes that safe, but it is
    // still every replica polling for work one of them can take.
    assert(
      !readFileSync(join(regServer, "src/index.ts"), "utf-8").includes("startWebhookSweeper"),
      "index.ts is left alone when the scheduler took the job",
    );
    // The only file allowed to import the scheduler is the adapter. Anything
    // else would make an optional feature a hard dependency.
    // The comment in sweeper.ts explains the split, so the check is for an
    // IMPORT of the scheduler rather than a mention of it.
    assert(
      !/^import .*["'].*scheduler/m.test(template("services/webhooks/sweeper.ts.tpl")),
      "sweeper.ts does not import the scheduler",
    );
    assert(
      /^import .*["']\.\.\/scheduler\/index\.js["']/m.test(
        template("services/webhooks/sweep-job.ts.tpl"),
      ),
      "the adapter is the one file that does",
    );

    const models = readFileSync(join(regServer, "src/models/registry.ts"), "utf-8");
    assert(
      withReg.patched.includes(srv("src/models/registry.ts")),
      "the model registry is patched",
    );
    for (const model of ["ApiToken", "ApiMember", "WebhookSubscription", "WebhookDelivery"]) {
      assert(models.includes(`import "./${model}.js";`), `the model registry imports ${model}`);
    }
    assert(models.includes('import "./Item.js";'), "the model registry keeps what was there");

    const regSecond = applyPublicApi({ projectDir: withRegistries, projectName: "Reg" });
    assert(
      regSecond.patched.length === 0,
      `a second run re-patched ${regSecond.patched.join(", ")}, expected nothing`,
    );
    assert(
      regSecond.written.length === 0,
      `a second run rewrote ${regSecond.written.length} file(s), expected 0`,
    );
    assert(
      readFileSync(join(regServer, "src/models/registry.ts"), "utf-8") === models,
      "the model registry is byte-identical after the second run",
    );
    assert(
      readFileSync(join(regServer, "src/services/scheduler/index.ts"), "utf-8") === scheduler,
      "the scheduler surface is byte-identical after the second run",
    );
  } finally {
    rmSync(withRegistries, { recursive: true, force: true });
  }

  // ── 15b. the OTHER scaffold: client-core stripped ─────────────────
  // This is the case the byte-identical baseline missed. `hatchkit create`
  // removes the marked blocks when client-core is not selected, so half of
  // all projects have a router that is not the starter file on disk and is
  // still completely unedited. It must be extracted too.
  const stripped = mkdtempSync(join(tmpdir(), "public-api-stripped-"));
  try {
    const strippedServer = makeProject(stripped, { clientCore: false });
    const before = readFileSync(join(strippedServer, "src/trpc/routers/items.ts"), "utf-8");
    assert(!hasMarkedBlocks(before), "the fixture really is the stripped scaffold");

    const noCore = applyPublicApi({ projectDir: stripped, projectName: "NoCore" });
    const router = readFileSync(join(strippedServer, "src/trpc/routers/items.ts"), "utf-8");

    assert(
      noCore.written.includes(srv("src/trpc/routers/items.ts")),
      "a client-core-less router is extracted too",
    );
    assert(noCore.conflicted.length === 0, "and is not mistaken for an edited file");
    assert(
      router.includes('from "../../services/items/index.js"'),
      "the stripped rewrite calls the extracted service",
    );
    // It must come out WITHOUT the blocks — writing the with-blocks version
    // into a project that has no client-core would import a module that does
    // not exist, and the scaffold would not build.
    assert(!hasMarkedBlocks(router), "the stripped project gets the stripped rewrite");
    assert(!router.includes("updateItemSchema"), "and no reference to what was stripped");
    assert(
      router ===
        stripMarkedBlocks(
          template("trpc/routers/items.rewritten.ts.tpl")
            .split("__HATCHKIT_SHARED_PKG__")
            .join("@starter/shared"),
        ),
      "the two shapes come from ONE template put through the scaffold's own strip",
    );

    // No sync feed in this project, so no bridge and no import of one.
    assert(
      !existsSync(join(strippedServer, "src/services/items/sync-bridge.ts")),
      "no sync bridge without a sync feed",
    );
    assert(
      !readFileSync(join(strippedServer, "src/index.ts"), "utf-8").includes(
        "registerItemSyncBridge",
      ),
      "and nothing in index.ts refers to one",
    );
    assert(
      noCore.notes.some((note) => note.includes("src/sync/feed.ts")),
      "the missing feed is reported rather than silently skipped",
    );

    const noCoreSecond = applyPublicApi({ projectDir: stripped, projectName: "NoCore" });
    assert(
      noCoreSecond.written.length === 0 && noCoreSecond.conflicted.length === 0,
      "the stripped project's second run is a no-op too",
    );
    assert(
      noCoreSecond.patched.length === 0,
      `stripped second run patched ${noCoreSecond.patched.join(", ") || "nothing"}`,
    );
  } finally {
    rmSync(stripped, { recursive: true, force: true });
  }

  // ── 16. an unrecognised registry is left alone, with a note ────────
  const odd = mkdtempSync(join(tmpdir(), "public-api-odd-"));
  try {
    const oddServer = makeProject(odd);
    mkdirSync(join(oddServer, "src/services/scheduler"), { recursive: true });
    const oddSource = "export function registerBuiltInJobs() {}\n";
    writeFileSync(join(oddServer, "src/services/scheduler/index.ts"), oddSource);

    const oddResult = applyPublicApi({ projectDir: odd, projectName: "Odd" });
    assert(
      readFileSync(join(oddServer, "src/services/scheduler/index.ts"), "utf-8") === oddSource,
      "a scheduler surface we do not recognise is not touched",
    );
    assert(
      oddResult.notes.some((note) => note.includes("registerWebhookSweepJob()")),
      "the note says exactly what to wire by hand",
    );
    // And the standalone loop is wired instead, so webhooks work regardless.
    assert(
      readFileSync(join(oddServer, "src/index.ts"), "utf-8").includes("startWebhookSweeper();"),
      "the standalone sweeper is wired when the scheduler could not be patched",
    );
  } finally {
    rmSync(odd, { recursive: true, force: true });
  }

  if (failed === 0) {
    console.log("test-public-api: ok");
    process.exit(0);
  } else {
    console.error(`test-public-api: ${failed} assertion(s) failed`);
    process.exit(1);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
