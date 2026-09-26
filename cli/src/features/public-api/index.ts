/*
 * cli/src/features/public-api/index.ts — the `public-api` server platform
 * feature: a token-authenticated REST surface under `/api/v1`, an OpenAPI
 * document generated from the same route table Express mounts from, and
 * signed webhooks with a background delivery queue.
 *
 * Everything this writes is a template under
 * `cli/src/templates/features/public-api/`. The only files it PATCHES are the
 * user's own: `src/app.ts` (mount), `src/index.ts` (sweeper lifecycle),
 * `src/trpc/router.ts` (token management), `src/config/env.ts` (two keys), and
 * — conditionally, and only when it recognises them — the scheduler and model
 * registries the sibling features ship.
 *
 * The one rewrite that is not a patch is `src/trpc/routers/items.ts`. The
 * feature's central claim is that REST never enters tRPC: both surfaces call
 * the same extracted `services/items/`, which means the tRPC router has to
 * stop holding the logic. That cannot be done with literal-anchor insertion —
 * it is a deletion — so the file is replaced ONLY when its contents are still
 * byte-for-byte the starter's. A router the user has touched is reported as a
 * conflict with the exact change spelled out, because silently clobbering
 * somebody's resolvers is worse than shipping the feature half-wired and
 * saying so.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { hasMarkedBlocks, stripMarkedBlocks } from "../client-core/markers.js";
import {
  type FeatureTokens,
  type ServerFeatureInput,
  type ServerFeatureResult,
  type SourcePatch,
  addPackageScript,
  appendClaudeMdSection,
  appendEnvBlock,
  emptyResult,
  patchEnvConfig,
  patchSourceFile,
  renderFeatureTemplate,
  resolveServerDir,
  writeFeatureFiles,
  writeManaged,
} from "../server-platform/kit.js";

/** Files written into the server package, `[template, dest-relative-to-serverDir]`. */
const SERVER_FILES: ReadonlyArray<readonly [string, string]> = [
  ["auth/api-permissions.ts.tpl", "src/auth/api-permissions.ts"],
  ["auth/api-token.ts.tpl", "src/auth/api-token.ts"],
  ["models/ApiToken.ts.tpl", "src/models/ApiToken.ts"],
  ["models/ApiMember.ts.tpl", "src/models/ApiMember.ts"],
  ["models/WebhookSubscription.ts.tpl", "src/models/WebhookSubscription.ts"],
  ["models/WebhookDelivery.ts.tpl", "src/models/WebhookDelivery.ts"],
  ["services/tenancy.ts.tpl", "src/services/tenancy.ts"],
  ["services/items/index.ts.tpl", "src/services/items/index.ts"],
  ["services/items/events.ts.tpl", "src/services/items/events.ts"],
  ["services/api-tokens/index.ts.tpl", "src/services/api-tokens/index.ts"],
  ["services/webhooks/types.ts.tpl", "src/services/webhooks/types.ts"],
  ["services/webhooks/signature.ts.tpl", "src/services/webhooks/signature.ts"],
  ["services/webhooks/ssrf.ts.tpl", "src/services/webhooks/ssrf.ts"],
  ["services/webhooks/projection.ts.tpl", "src/services/webhooks/projection.ts"],
  ["services/webhooks/backoff.ts.tpl", "src/services/webhooks/backoff.ts"],
  ["services/webhooks/emit.ts.tpl", "src/services/webhooks/emit.ts"],
  ["services/webhooks/delivery.ts.tpl", "src/services/webhooks/delivery.ts"],
  ["services/webhooks/sweeper.ts.tpl", "src/services/webhooks/sweeper.ts"],
  ["api/v1/index.ts.tpl", "src/api/v1/index.ts"],
  ["api/v1/auth.ts.tpl", "src/api/v1/auth.ts"],
  ["api/v1/envelope.ts.tpl", "src/api/v1/envelope.ts"],
  ["api/v1/problem.ts.tpl", "src/api/v1/problem.ts"],
  ["api/v1/query.ts.tpl", "src/api/v1/query.ts"],
  ["api/v1/rate-limit.ts.tpl", "src/api/v1/rate-limit.ts"],
  ["api/v1/routes-table.ts.tpl", "src/api/v1/routes-table.ts"],
  ["api/v1/openapi.ts.tpl", "src/api/v1/openapi.ts"],
  ["api/v1/emit-openapi.ts.tpl", "src/api/v1/emit-openapi.ts"],
  ["api/v1/routes/meta.ts.tpl", "src/api/v1/routes/meta.ts"],
  ["api/v1/routes/items.ts.tpl", "src/api/v1/routes/items.ts"],
  ["api/v1/routes/webhooks.ts.tpl", "src/api/v1/routes/webhooks.ts"],
  ["trpc/routers/api-tokens.ts.tpl", "src/trpc/routers/api-tokens.ts"],
  ["tests/openapi-document.test.ts.tpl", "src/tests/openapi-document.test.ts"],
  ["tests/webhooks.test.ts.tpl", "src/tests/webhooks.test.ts"],
];

/**
 * Files written at the repo root.
 *
 * The two docs-site artifacts are COMMITTED output, shipped pre-generated so a
 * freshly scaffolded project's test suite passes before anybody runs the
 * emitter. They are written managed, not forced: a project that has changed a
 * route and re-run `openapi:emit` legitimately has different bytes, and
 * overwriting those would silently revert the spec to this release's routes.
 */
const ROOT_FILES: ReadonlyArray<readonly [string, string]> = [
  ["docs/public-api.md.tpl", "docs/public-api.md"],
  ["docs-site/openapi.json.tpl", "docs-site/static/openapi.json"],
  ["docs-site/reference.md.tpl", "docs-site/docs/api/reference.md"],
];

/**
 * What the user is told when their item router cannot be rewritten safely.
 *
 * Exported because the test asserts on it: a note that drifts out of step with
 * what the feature actually did is worse than no note, and the only way to
 * pin that is to make the string itself the contract.
 */
export const ITEMS_ROUTER_NOTE =
  "src/trpc/routers/items.ts differs from the starter's — left untouched, so the typed API still holds its own copy of the item logic. " +
  'Two lines per resolver connect it: import { scopeForSession } from "../../services/tenancy.js" and the CRUD functions from "../../services/items/index.js", ' +
  "then replace each resolver body with e.g. `listItems(scopeForSession(ctx.user), input)`. " +
  "Until that is done a REST write publishes realtime events and webhooks that a tRPC write does not.";

/** Read a workspace package's declared name, or fall back to the starter's. */
function packageName(dir: string, fallback: string): string {
  try {
    const raw = readFileSync(join(dir, "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as { name?: unknown };
    return typeof parsed.name === "string" && parsed.name.length > 0 ? parsed.name : fallback;
  } catch {
    return fallback;
  }
}

/**
 * A guarded patch against a file another feature owns.
 *
 * `scheduler` and `server-migrations` ship their own registries, and the
 * shapes below are THEIRS — read off those templates, not guessed. When a
 * project has been edited past recognition the anchor simply misses, nothing
 * is written, and the caller prints the manual step. Guessing at an
 * unrecognised file is how a generator corrupts somebody's source.
 *
 * Three outcomes, not two. "already" and "patched" both mean the registration
 * is in place, but only one of them is a change THIS run made — collapsing
 * them into a boolean is how a second `hatchkit update` reports work it did
 * not do, and an idempotency test that cannot tell them apart is not testing
 * idempotency.
 */
type RegistryOutcome = "patched" | "already" | "unrecognised";

function patchSibling(
  absPath: string,
  args: { guard: string; patches: readonly SourcePatch[] },
  dryRun: boolean | undefined,
): RegistryOutcome {
  if (!existsSync(absPath)) return "unrecognised";
  if (readFileSync(absPath, "utf-8").includes(args.guard)) return "already";
  return patchSourceFile(absPath, args.patches, { dryRun }).changed ? "patched" : "unrecognised";
}

/** Agent memory. Every bullet below is a rule that fails QUIETLY when
 *  it is broken, and none of them can be inferred from the generated
 *  code by reading it — which is the whole reason they are written
 *  down where the next agent looks first. */
const CLAUDE_MD_HEADING = "### Public REST API and webhooks";

const CLAUDE_MD_BODY = `\`/api/v1\` is the token-authenticated REST surface third parties integrate
against, with webhooks pushing the same events out. \`docs/public-api.md\` is the
maintainer's view; \`docs-site/docs/api/reference.md\` is the integrator's.

**REST never enters tRPC.** A request authenticates in \`api/v1/auth.ts\`, builds a
\`TenantScope\`, and calls the same extracted services (\`services/items/\`) the
tRPC resolvers call. No synthetic context, no token path through a protected
procedure. That is what makes "a token can never name a tenant of its own"
structural rather than a rule per handler: the request never reaches a place
where a tenant id is read from input. It also means a REST write publishes the
same events and enqueues the same webhooks as a tRPC one — nothing under
\`api/v1/\` re-implements a business rule.

**Announce changes through \`services/items/events.ts\`, never from a resolver.**
\`publishItemEvent\` fans out to webhooks and to every \`onItemEvent\` listener. A
publish written into one resolver is a publish the other surface does not make,
which is exactly the drift that put \`publishSync\` in the sync bridge rather
than back in the tRPC router.

**\`src/trpc/routers/items.ts\` carries \`// ── client-core ──\` blocks and must
keep carrying them.** \`hatchkit\` strips what is between those markers when
\`client-core\` is not selected, so the file legitimately has two shapes. Anything
that compares it against a fixture has to compare the STRIPPED form of both
sides, or it silently does nothing in half of all projects.

\`\`\`bash
pnpm run openapi:emit                 # regenerate the two committed artifacts
\`\`\`

Five rules, each of which fails quietly if broken:

- **\`API_ROUTES\` in \`api/v1/routes-table.ts\` is the only source of truth.**
  Express mounts from it and \`z.toJSONSchema\` builds the OpenAPI document from
  the same zod schemas the handlers validate with (zod 4, native — never add a
  zod-to-openapi dependency). A route not in the table is not mounted; a route
  in it with no handler throws at boot rather than 404-ing in production.
- **\`docs-site/static/openapi.json\` and \`docs-site/docs/api/reference.md\` are
  committed.** A spec regenerated at deploy time is a spec nobody reviews in a
  diff. \`tests/openapi-document.test.ts\` fails when either is stale.
- **A token's permissions are live, intersected with a frozen ceiling.**
  Revoking narrows on the next request; granting never widens a token minted
  before. A removed member's token is dead — 401, not 403.
- **Cross-tenant and foreign ids answer 404, never 403.** A 403 confirms the id
  exists somewhere. 403 is for a scope refusal on a resource this tenant
  genuinely owns, and every 5xx \`detail\` is the same fixed string in every
  environment — the global \`errorHandler\` returns \`err.message\` verbatim outside
  production, so v1 answers its own errors instead of throwing into it.
- **Webhooks sign over a \`rawBody\` computed ONCE** and handed to \`fetch\`
  unchanged — stringify it twice and every receiver doing its job rejects the
  delivery as forged. Deliveries are projected at send time against the owner's
  live visibility (withheld is a permission outcome, not a failure), and
  \`assertDeliverableUrl\` re-resolves DNS before every attempt because a
  create-time-only SSRF check is decorative against rebinding.
  \`WEBHOOK_ALLOW_PRIVATE_TARGETS=true\` lifts the https and private-address rules
  for a local listener and belongs nowhere else.

Errors are RFC 9457 \`application/problem+json\`; successes are \`{ data }\`, with
\`nextCursor\` always present and \`null\` on a list's last page. Rate limiting is a
fixed 60s window per token (\`API_RATE_LIMIT_PER_MINUTE\`, default 600), Redis when
there is one and per-process when there is not.`;

export function applyPublicApi(input: ServerFeatureInput): ServerFeatureResult {
  const result = emptyResult("public-api");
  const serverDir = resolveServerDir(input.projectDir);
  if (!serverDir) {
    result.skipped =
      "no server package found (looked for packages/server/src/index.ts and ./src/index.ts) — public-api needs one";
    return result;
  }

  const dryRun = input.dryRun;
  const flattened = serverDir === input.projectDir;
  const tokens: FeatureTokens = {
    PROJECT_NAME: input.projectName,
    SERVER_PKG: packageName(serverDir, "@starter/server"),
    SHARED_PKG: packageName(join(input.projectDir, "packages", "shared"), "@starter/shared"),
  };

  writeFeatureFiles(result, { baseDir: serverDir, files: SERVER_FILES, tokens, dryRun });
  writeFeatureFiles(result, { baseDir: input.projectDir, files: ROOT_FILES, tokens, dryRun });

  rewriteItemsRouter(result, serverDir, tokens, dryRun);
  wireSyncBridge(result, serverDir, tokens, dryRun);
  patchApp(result, serverDir, dryRun);
  patchTrpcRouter(result, serverDir, dryRun);
  patchEnvironment(result, serverDir, dryRun);
  wireSweeper(result, serverDir, tokens, dryRun);
  registerModels(result, serverDir, dryRun);

  // The emitter is run from the repo root either way; only the way to reach
  // the server package differs between the two layouts.
  const emit = flattened
    ? "tsx src/api/v1/emit-openapi.ts"
    : `pnpm --filter ${tokens.SERVER_PKG} exec tsx src/api/v1/emit-openapi.ts`;
  if (addPackageScript(input.projectDir, "openapi:emit", emit, { dryRun })) {
    result.patched.push("package.json");
  }

  // Said once, always: the committed spec was generated against the zod
  // version this release of hatchkit was built with, and `z.toJSONSchema`
  // output can move between zod releases. One command settles it, and the
  // staleness test is what makes the mismatch visible rather than mysterious.
  result.notes.push(
    "Run `pnpm run openapi:emit` once after install, then commit docs-site/static/openapi.json and docs-site/docs/api/reference.md.",
  );
  result.notes.push(
    "Mint the first token from the typed API: `trpc.apiTokens.create.mutate({ label, scopes })`. The plaintext is returned once.",
  );

  if (appendClaudeMdSection(input.projectDir, CLAUDE_MD_HEADING, CLAUDE_MD_BODY, input)) {
    result.patched.push("CLAUDE.md");
  }

  reportFromRepoRoot(result, input.projectDir, serverDir);
  return result;
}

/**
 * Restate every recorded path relative to the repo root.
 *
 * Most of this feature writes through `baseDir: serverDir`, so it records
 * `src/app.ts` — which is a real path from inside `packages/server` and a
 * dead one from where the user is standing. The sibling features already
 * report from the root, and the path a user actually sees is the conflict
 * line, which is the one moment they need to be able to open the file.
 *
 * Paths written against the project root (docs, the OpenAPI artifacts,
 * `package.json`, `CLAUDE.md`) are already correct and are left alone.
 */
function reportFromRepoRoot(
  result: ServerFeatureResult,
  projectDir: string,
  serverDir: string,
): void {
  const prefix = toPosix(relative(projectDir, serverDir));
  if (!prefix) return;
  const rootRelative = new Set<string>([
    ...ROOT_FILES.map(([, dest]) => dest),
    "package.json",
    "CLAUDE.md",
  ]);
  // Deduplicated as well as rebased. `src/index.ts` is patched twice in one
  // run — once for the sweeper, once for the sync bridge — and a summary that
  // lists it twice reads as two separate edits to a file the user is about to
  // review.
  const rebase = (paths: string[]) => [
    ...new Set(paths.map((path) => (rootRelative.has(path) ? path : `${prefix}/${path}`))),
  ];
  result.written = rebase(result.written);
  result.unchanged = rebase(result.unchanged);
  result.conflicted = rebase(result.conflicted);
  result.patched = rebase(result.patched);
}

const toPosix = (value: string): string => value.split(sep).join("/");

/**
 * Replace the item router with one that calls the extracted service — but only
 * when it is still the starter's.
 *
 * ── Why this is not a byte comparison ──────────────────────────────────
 *
 * There is no single "the starter's router". `client-core` lives INSIDE that
 * file as `// ── client-core ──` blocks, and `hatchkit create` strips them
 * when the feature is not selected — so a freshly scaffolded project has the
 * with-blocks router or the without-blocks one depending on a choice that has
 * nothing to do with this feature. A byte comparison against one of them
 * silently declines to extract in half of all projects, and breaks again the
 * next time any feature adds a block here.
 *
 * So the comparison runs on the STRIPPED form of both sides. One baseline
 * covers both scaffolds, and a block added, grown or removed by another
 * feature changes neither side of the comparison. The same is true of the
 * output: `items.rewritten.ts.tpl` is written with its blocks intact, and the
 * version for a project without `client-core` is that same template put
 * through the same strip the scaffold uses — so the two can never disagree,
 * because there is only one of them.
 *
 * What this deliberately does NOT do is loosen into a structural guess ("does
 * it still call `Item.find`?"). That would rewrite a router somebody edited,
 * which is the one failure worth avoiding at any cost. An unrecognised router
 * keeps its contents and the user gets {@link ITEMS_ROUTER_NOTE}.
 *
 * The baseline still goes stale when the starter's own resolvers change, and
 * that is the safe direction — a stale baseline conflicts, it never clobbers.
 * `test-public-api.ts` asserts the baseline is byte-identical to
 * `starter/packages/server/src/trpc/routers/items.ts`, so that staleness fails
 * in the pull request that causes it rather than in somebody's scaffold.
 */
function rewriteItemsRouter(
  result: ServerFeatureResult,
  serverDir: string,
  tokens: FeatureTokens,
  dryRun: boolean | undefined,
): void {
  const rel = "src/trpc/routers/items.ts";
  const abs = join(serverDir, rel);

  if (!existsSync(abs)) {
    // No item router at all: this project's typed API is shaped differently,
    // so there is nothing to extract from and nothing to warn about beyond the
    // service now existing unused by tRPC.
    result.notes.push(
      `${rel} not found — the extracted services in src/services/items/ are wired to REST only.`,
    );
    return;
  }

  const current = readFileSync(abs, "utf-8");
  const rewritten = renderFeatureTemplate(
    "public-api",
    "trpc/routers/items.rewritten.ts.tpl",
    tokens,
  );

  // Which shape this project should end up with is read off the file in front
  // of us, not off a feature list: the router that is there is the only
  // reliable statement of whether `client-core` was kept.
  const expected = hasMarkedBlocks(current) ? rewritten : stripMarkedBlocks(rewritten);
  if (current === expected) {
    result.unchanged.push(rel);
    return;
  }

  const original = renderFeatureTemplate(
    "public-api",
    "trpc/routers/items.original.ts.tpl",
    tokens,
  );
  if (normaliseRouter(current) !== normaliseRouter(original)) {
    result.conflicted.push(rel);
    result.notes.push(ITEMS_ROUTER_NOTE);
    return;
  }

  // Recognisably the starter's, in whichever of its two shapes: safe to
  // replace outright with the matching shape.
  writeManaged(abs, expected, { dryRun, force: true });
  result.written.push(rel);
}

/**
 * A router with every feature block removed.
 *
 * `stripMarkedBlocks` is `client-core`'s own function — the one `hatchkit
 * create` strips with — rather than a second implementation here. Two
 * implementations of "what does a stripped file look like" is exactly the
 * drift the marker convention exists to remove, and this one only has to be
 * wrong by a blank line to start reporting phantom conflicts.
 *
 * It is idempotent, which is what lets both an already-stripped scaffold and a
 * with-blocks one land on the same normal form.
 */
function normaliseRouter(source: string): string {
  try {
    return stripMarkedBlocks(source);
  } catch {
    // Unbalanced markers: somebody edited around them, badly or cleverly.
    // Either way this is not a file to rewrite, so return something that
    // cannot match the baseline and let the conflict path report it.
    return source;
  }
}

/**
 * Bridge item events onto the `client-core` sync feed, when there is one.
 *
 * The starter published to the feed from inside each tRPC resolver. Those
 * resolvers now delegate to `services/items/`, so without this a record
 * created through `/api/v1` would never reach the author's other devices —
 * the exact drift between the two surfaces the extraction exists to prevent.
 *
 * Soft-coupled the same way the scheduler is: the one file that imports
 * `sync/feed.js` is written only when that file exists, so the service layer
 * keeps resolving in a project that declined `client-core`.
 */
function wireSyncBridge(
  result: ServerFeatureResult,
  serverDir: string,
  tokens: FeatureTokens,
  dryRun: boolean | undefined,
): void {
  if (!existsSync(join(serverDir, "src", "sync", "feed.ts"))) {
    result.notes.push(
      "No src/sync/feed.ts — item events go to webhooks and to any listener registered with `onItemEvent`. Adding client-core later re-runs this and wires the feed.",
    );
    return;
  }

  writeFeatureFiles(result, {
    baseDir: serverDir,
    files: [["services/items/sync-bridge.ts.tpl", "src/services/items/sync-bridge.ts"]],
    tokens,
    dryRun,
  });

  const rel = "src/index.ts";
  const outcome = patchSourceFile(
    join(serverDir, rel),
    [
      {
        guard: 'from "./services/items/sync-bridge.js"',
        anchor: 'import { env } from "./config/env.js";',
        insert: '\nimport { registerItemSyncBridge } from "./services/items/sync-bridge.js";',
      },
      {
        // Module scope, before anything can serve a request. A listener
        // registered inside `start()` would miss nothing in practice, but
        // "registered before the first write is possible" is a property worth
        // being able to read off the file.
        guard: "registerItemSyncBridge()",
        anchor: "const app = createApp();",
        position: "before",
        insert:
          "// Item writes reach this person's other devices through the sync feed,\n" +
          "// whether they came from tRPC or from /api/v1 — both go through\n" +
          "// services/items/, and this is the one listener that forwards them.\n" +
          "registerItemSyncBridge();\n\n",
      },
    ],
    { dryRun },
  );

  if (outcome.changed) result.patched.push(rel);
  if (outcome.missingAnchors.length > 0) {
    result.notes.push(
      `${rel}: call registerItemSyncBridge() from "./services/items/sync-bridge.js" at module scope — without it a REST write never reaches the sync feed.`,
    );
  }
}

/**
 * Mount v1 in `src/app.ts`.
 *
 * AFTER `express.json()` — the handlers read a parsed body — and after the
 * tRPC mount, so the typed API keeps first claim on its own prefix. Before the
 * health endpoint and well before `notFoundHandler`, which would otherwise
 * answer every v1 path in the app's own error shape.
 *
 * Nothing here adds a second `express.raw()`. The webhook signature is over a
 * body this server SERIALIZES, not one it receives, so the raw bytes are
 * computed in `services/webhooks/delivery.ts` and never read off a request —
 * a second raw-body mount would fight the existing Stripe one for no reason.
 */
function patchApp(
  result: ServerFeatureResult,
  serverDir: string,
  dryRun: boolean | undefined,
): void {
  const rel = "src/app.ts";
  const outcome = patchSourceFile(
    join(serverDir, rel),
    [
      {
        guard: 'from "./api/v1/index.js"',
        anchor: 'from "./middleware/error-handler.js";',
        insert: '\nimport { registerApiV1Routes } from "./api/v1/index.js";',
      },
      {
        guard: "registerApiV1Routes(app)",
        anchor: 'app.use("/api/trpc", trpcMiddleware);',
        insert:
          "\n\n  // ── 5a. Public REST API (token-authenticated, /api/v1) ────────────\n" +
          "  // After express.json() because the handlers read a parsed body, and\n" +
          "  // after tRPC so the typed API keeps first claim on its own prefix.\n" +
          "  // Before notFoundHandler, which would otherwise answer every v1 path\n" +
          "  // in the app's own error shape instead of problem+json.\n" +
          "  registerApiV1Routes(app);",
      },
    ],
    { dryRun },
  );

  if (outcome.changed) result.patched.push(rel);
  if (outcome.missingAnchors.length > 0) {
    result.notes.push(
      `${rel}: could not find ${outcome.missingAnchors.join(" / ")} — add \`registerApiV1Routes(app)\` by hand, after express.json() and the tRPC mount and before the 404 handler.`,
    );
  }
}

/** Register the token-management router on the typed API. */
function patchTrpcRouter(
  result: ServerFeatureResult,
  serverDir: string,
  dryRun: boolean | undefined,
): void {
  const rel = "src/trpc/router.ts";
  const outcome = patchSourceFile(
    join(serverDir, rel),
    [
      {
        guard: 'from "./routers/api-tokens.js"',
        anchor: 'import { itemsRouter } from "./routers/items.js";',
        insert: '\nimport { apiTokensRouter } from "./routers/api-tokens.js";',
      },
      {
        guard: "apiTokens: apiTokensRouter",
        anchor: "  items: itemsRouter,",
        insert: "\n  apiTokens: apiTokensRouter,",
      },
    ],
    { dryRun },
  );

  if (outcome.changed) result.patched.push(rel);
  if (outcome.missingAnchors.length > 0) {
    result.notes.push(
      `${rel}: add \`apiTokens: apiTokensRouter\` from "./routers/api-tokens.js" by hand — there is no other way to mint a token.`,
    );
  }
}

/** The two env keys, in the config object and in the example files. */
function patchEnvironment(
  result: ServerFeatureResult,
  serverDir: string,
  dryRun: boolean | undefined,
): void {
  const outcome = patchEnvConfig(
    serverDir,
    "Public API",
    [
      "// Fixed 60-second window per token. Redis-backed when REDIS_URL is set,",
      "// per-process otherwise — two replicas without Redis effectively double it.",
      'API_RATE_LIMIT_PER_MINUTE: parseInt(getOptional("API_RATE_LIMIT_PER_MINUTE", "600"), 10),',
      "// Lifts the https and private-address rules on webhook targets so a local",
      "// listener can be used during development. Never set this in production.",
      'WEBHOOK_ALLOW_PRIVATE_TARGETS: getOptional("WEBHOOK_ALLOW_PRIVATE_TARGETS") === "true",',
    ],
    { dryRun },
  );
  if (outcome.changed) result.patched.push("src/config/env.ts");
  if (outcome.missingAnchors.length > 0) {
    result.notes.push(
      "src/config/env.ts: add API_RATE_LIMIT_PER_MINUTE (default 600) and WEBHOOK_ALLOW_PRIVATE_TARGETS to the env object by hand.",
    );
  }

  for (const file of appendEnvBlock(
    serverDir,
    "Public API",
    [
      "API_RATE_LIMIT_PER_MINUTE=600",
      "# Local webhook listeners only. Lifts https + private-address checks.",
      "WEBHOOK_ALLOW_PRIVATE_TARGETS=false",
    ],
    { dryRun },
  )) {
    result.patched.push(file);
  }
}

/**
 * Give the delivery queue something to run it.
 *
 * Preference order, and it matters: a scheduler that LEASES its jobs runs the
 * sweep on one replica, while this module's own interval runs it on all of
 * them. The claim in `delivery.ts` makes that safe rather than duplicative,
 * but it is still N times the queries for one queue's worth of work.
 */
function wireSweeper(
  result: ServerFeatureResult,
  serverDir: string,
  tokens: FeatureTokens,
  dryRun: boolean | undefined,
): void {
  // The `scheduler` feature's public surface. Its `registerBuiltInJobs()` is
  // the one place a shipped job is wired in — the registry module below it
  // only holds the mechanism — so that is what gets patched.
  const schedulerIndex = join(serverDir, "src", "services", "scheduler", "index.ts");
  if (existsSync(schedulerIndex)) {
    // Written only here. It is the single file in this feature that imports
    // the scheduler, and shipping it unconditionally would make an optional
    // feature a hard dependency — the server would fail to resolve it in
    // every project that declined the scheduler.
    writeFeatureFiles(result, {
      baseDir: serverDir,
      files: [["services/webhooks/sweep-job.ts.tpl", "src/services/webhooks/sweep-job.ts"]],
      tokens,
      dryRun,
    });

    const outcome = patchSibling(
      schedulerIndex,
      {
        guard: "registerWebhookSweepJob",
        patches: [
          {
            guard: 'from "../webhooks/sweep-job.js"',
            anchor: 'import { jobRegistry } from "./registry.js";',
            insert:
              '\nimport { registerWebhookSweepJob } from "../webhooks/sweep-job.js";' +
              '\nimport { WEBHOOK_SWEEP_JOB_NAME } from "../webhooks/sweeper.js";',
          },
          {
            guard: "registerWebhookSweepJob()",
            anchor: "  const registered = new Set(jobRegistry.list().map((job) => job.name));",
            insert:
              "\n\n  // Drains the webhook delivery queue. Leased, so one replica sweeps\n" +
              "  // rather than all of them — the claim in services/webhooks/delivery.ts\n" +
              "  // makes a duplicate safe, not free.\n" +
              "  if (!registered.has(WEBHOOK_SWEEP_JOB_NAME)) registerWebhookSweepJob();",
          },
        ],
      },
      dryRun,
    );
    if (outcome !== "unrecognised") {
      if (outcome === "patched") result.patched.push("src/services/scheduler/index.ts");
      result.notes.push(
        "Webhook sweeping runs as a leased scheduler job, so one replica sweeps rather than all of them.",
      );
      // Deliberately no standalone interval on top of it.
      return;
    }
    result.notes.push(
      "src/services/scheduler/index.ts exists but its shape was not recognised — call registerWebhookSweepJob() from src/services/webhooks/sweep-job.js in registerBuiltInJobs(), then drop startWebhookSweeper() from src/index.ts.",
    );
  }

  const rel = "src/index.ts";
  const abs = join(serverDir, rel);
  // The starter numbers the steps in `start()` with comments. Inserting above
  // `server.listen` directly would orphan the "// 4. Start listening" comment
  // over the sweeper call, so when that comment is there it is the anchor —
  // the block lands above it and the comment keeps describing the listen.
  const source = existsSync(abs) ? readFileSync(abs, "utf-8") : "";
  const numbered = source.includes("    // 4. Start listening");
  const startAnchor = numbered ? "    // 4. Start listening" : "server.listen(env.PORT";
  // The two anchors sit at different columns — one owns its line's
  // indentation, the other starts after it — so the block carries the leading
  // whitespace in one case and the trailing whitespace in the other. Getting
  // this wrong produces a correctly working file that is visibly mangled,
  // which is how a generated patch loses the reader's trust.
  const startBlock =
    "// Drain queued webhook deliveries in the background. No-op under\n" +
    "    // NODE_ENV=test, and unref'd everywhere else so a shutdown never\n" +
    "    // waits on the next tick.\n" +
    "    startWebhookSweeper();\n\n";
  const startInsert = numbered ? `    ${startBlock}` : `${startBlock}    `;

  const outcome = patchSourceFile(
    abs,
    [
      {
        guard: 'from "./services/webhooks/sweeper.js"',
        anchor: 'import { env } from "./config/env.js";',
        insert:
          '\nimport { startWebhookSweeper, stopWebhookSweeper } from "./services/webhooks/sweeper.js";',
      },
      {
        guard: "startWebhookSweeper()",
        anchor: startAnchor,
        position: "before",
        insert: startInsert,
      },
      {
        // AFTER `server.close()`, not before: stop accepting new work first,
        // then stop the loop that is still holding outbound requests open.
        guard: "stopWebhookSweeper()",
        anchor: "server.close();",
        insert:
          "\n\n  // Stop the delivery loop before the database connection goes away,\n" +
          "  // or an in-flight sweep writes its outcome into a closed client.\n" +
          "  stopWebhookSweeper();",
      },
    ],
    { dryRun },
  );

  if (outcome.changed) result.patched.push(rel);
  if (outcome.missingAnchors.length > 0) {
    result.notes.push(
      `${rel}: call startWebhookSweeper() before the server listens and stopWebhookSweeper() in the shutdown path — nothing sends webhooks until you do.`,
    );
  }
}

/**
 * Add this feature's models to the migration feature's registry, if there is
 * one.
 *
 * Without it the four collections still work — mongoose builds indexes lazily
 * — but the index preparation `server-migrations` runs at boot will not know
 * about them, and the first slow query nobody can explain is the delivery
 * sweep.
 */
function registerModels(
  result: ServerFeatureResult,
  serverDir: string,
  dryRun: boolean | undefined,
): void {
  const registry = join(serverDir, "src", "models", "registry.ts");
  if (!existsSync(registry)) return;

  // `server-migrations` registers models by SIDE-EFFECT import — its
  // `allModels()` reads `mongoose.models`, so a bare import is the whole
  // registration. Four lines, appended after the last one it ships with.
  const outcome = patchSibling(
    registry,
    {
      guard: 'import "./WebhookDelivery.js";',
      patches: [
        {
          guard: 'import "./WebhookDelivery.js";',
          anchor: 'import "./Profile.js";',
          insert:
            '\nimport "./ApiToken.js";\nimport "./ApiMember.js";' +
            '\nimport "./WebhookSubscription.js";\nimport "./WebhookDelivery.js";',
        },
      ],
    },
    dryRun,
  );

  if (outcome !== "unrecognised") {
    if (outcome === "patched") result.patched.push("src/models/registry.ts");
    return;
  }
  result.notes.push(
    "src/models/registry.ts exists but its shape was not recognised — add ApiToken, ApiMember, WebhookSubscription and WebhookDelivery to it so their indexes are prepared at boot.",
  );
}
