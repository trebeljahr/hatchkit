/*
 * cli/src/features/scheduler/index.ts — the `scheduler` server platform
 * feature: leased recurring jobs that are safe to run on several
 * replicas of the same image.
 *
 * What lands in the project is deliberately small — one collection, one
 * lease, one 30-second poll — because the alternative (a broker, a
 * worker fleet, a second thing to deploy and pay for) buys one property
 * this already has: several processes never running the same job at
 * once. A single atomic `findOneAndUpdate` against the Mongo the server
 * already has open is enough for a handful of jobs every few minutes,
 * which is what a starter's workload actually is.
 *
 * Everything this writes is additive and idempotent. Applying it twice
 * writes nothing and patches nothing the second time — that is what lets
 * `hatchkit create` and `hatchkit update` be the same call.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  type FeatureTokens,
  type ServerFeatureInput,
  type ServerFeatureResult,
  appendClaudeMdSection,
  appendEnvBlock,
  emptyResult,
  patchEnvConfig,
  patchSourceFile,
  resolveServerDir,
  writeFeatureFiles,
} from "../server-platform/kit.js";

/** `[templateRel, destRel]`, where destRel is relative to the SERVER
 *  package. Order is read order, not write order: registry before lease
 *  before loop, so a reviewer walking the list meets the pieces in the
 *  order they depend on each other. */
const SERVER_FILES = [
  ["models/ScheduledJob.ts.tpl", "src/models/ScheduledJob.ts"],
  ["services/scheduler/registry.ts.tpl", "src/services/scheduler/registry.ts"],
  ["services/scheduler/lease.ts.tpl", "src/services/scheduler/lease.ts"],
  ["services/scheduler/scheduler.ts.tpl", "src/services/scheduler/scheduler.ts"],
  ["services/scheduler/heartbeat.ts.tpl", "src/services/scheduler/heartbeat.ts"],
  ["services/scheduler/index.ts.tpl", "src/services/scheduler/index.ts"],
  ["tests/support/test-database.ts.tpl", "src/tests/support/test-database.ts"],
  ["tests/scheduler-lease.test.ts.tpl", "src/tests/scheduler-lease.test.ts"],
] as const;

/** The `env` object literal gains one computed boolean. It is spelled
 *  out inline rather than calling a helper because `patchEnvConfig` can
 *  only insert entries into the object — it cannot add an import or a
 *  function, and a second patch that did would be one more thing to get
 *  wrong on a file the user owns. */
const ENV_CONFIG_LINES = [
  "// Background job loop (services/scheduler). On unless explicitly",
  "// switched off, so a replica that must NOT run jobs — a one-off",
  "// container, a debug process pointed at the production database —",
  "// sets SCHEDULER_ENABLED=false and nothing else changes.",
  'SCHEDULER_ENABLED: !["false", "0", "no", "off"].includes(',
  '  getOptional("SCHEDULER_ENABLED", "true").trim().toLowerCase(),',
  "),",
];

const ENV_FILE_LINES = [
  "# Background jobs (services/scheduler). Set to false on a replica that",
  "# must not run them; every other replica keeps sharing the same rows.",
  "SCHEDULER_ENABLED=true",
];

/** The last import of the starter's `src/index.ts`, and the one import
 *  no feature strip removes — `env` is read by `server.listen` itself. */
const INDEX_IMPORT_ANCHOR = 'import { env } from "./config/env.js";';

/** `server.listen(...)` and `server.close()` survive every strip
 *  (`stripStripeFromServer`, `stripWebSocketFromServerIndex`) and the
 *  step-comment renumbering, which is why the patches hang off them
 *  rather than off `warnStripeStatus()` or `// 4. Start listening`. */
const INDEX_LISTEN_ANCHOR = "    server.listen(env.PORT, () => {";
const INDEX_CLOSE_ANCHOR = "  server.close();";

const CLAUDE_MD_HEADING = "### Background jobs (scheduler)";

const CLAUDE_MD_BODY = `\`services/scheduler/\` runs recurring jobs inside the server process. One
\`ScheduledJob\` row per job name is shared by every replica on the database; a
job runs only after an atomic \`findOneAndUpdate\` claims it. It polls every 30s,
starts from \`index.ts\` after the DB connects, stops in \`shutdown()\`, and is
gated by \`SCHEDULER_ENABLED\` (on by default). Jobs register through
\`registerRecurringJob(name, intervalMs, handler)\` and nothing else.

Five rules, each of which fails quietly if broken:

- **The claim moves \`nextRunAt\` forward, not the release.** That is what makes
  it once per interval rather than once per free moment.
- **\`lockedUntil\` only keeps a run slower than its interval from starting
  beside itself.** It is not the scheduling mechanism.
- **Release filters on \`lockedBy\`.** A process whose lease lapsed and was taken
  over must not clear the new holder's lease on its way out.
- **A process that dies mid-run loses that run** and frees the job when the
  lease lapses. No resurrection, no replay — every handler must be idempotent
  and safe to skip.
- **One registration point.** A job that does not go through
  \`registerRecurringJob\` is a job the loop cannot see and nothing reports.

\`src/tests/scheduler-lease.test.ts\` pins all five against a real MongoDB and
skips without \`TEST_MONGODB_URI\`; each test file uses a throwaway database of
its own (\`src/tests/support/test-database.ts\`). User docs: \`docs/scheduler.md\`.`;

export function applyScheduler(input: ServerFeatureInput): ServerFeatureResult {
  const result = emptyResult("scheduler");
  const { projectDir, projectName, dryRun } = input;

  const serverDir = resolveServerDir(projectDir);
  if (!serverDir) {
    result.skipped = "no server package found (looked for packages/server/src/index.ts)";
    return result;
  }

  const tokens: FeatureTokens = {
    PROJECT_NAME: projectName,
    SERVER_PKG: readPackageName(serverDir) ?? "server",
    SHARED_PKG: readPackageName(join(projectDir, "packages", "shared")) ?? "shared",
  };

  // Report paths relative to the repo root, not the server package, so a
  // `backend` surface (server flattened to the root) and a monorepo read
  // the same way in the summary and both point at a real file.
  const prefix = toPosix(relative(projectDir, serverDir));
  const at = (to: string) => (prefix ? `${prefix}/${to}` : to);
  writeFeatureFiles(result, {
    baseDir: projectDir,
    files: SERVER_FILES.map(([from, to]) => [from, at(to)] as const),
    tokens,
    dryRun,
    // `registerBuiltInJobs()` lives here, so this file exists to be
    // added to — by the user for their own jobs, and by `public-api`,
    // which registers its webhook sweeper. Diffing it against the
    // pristine template would report a conflict on every later run.
    extensionPoints: [at("src/services/scheduler/index.ts")],
  });

  // The docs live at the repo root next to the rest of the project's
  // prose, not inside the server package — the rules they describe are
  // an operational contract, and whoever is paged reads them from the
  // top of the repo.
  writeFeatureFiles(result, {
    baseDir: projectDir,
    files: [["docs/scheduler.md.tpl", "docs/scheduler.md"]],
    tokens,
    dryRun,
  });

  // ── the switch ───────────────────────────────────────────────────
  const envConfig = patchEnvConfig(serverDir, "scheduler", ENV_CONFIG_LINES, { dryRun });
  if (envConfig.changed) result.patched.push(rel(prefix, "src/config/env.ts"));
  for (const anchor of envConfig.missingAnchors) {
    result.notes.push(
      `src/config/env.ts: could not find ${JSON.stringify(anchor)} — add SCHEDULER_ENABLED to the env object by hand (see docs/scheduler.md).`,
    );
  }
  for (const file of appendEnvBlock(serverDir, "scheduler", ENV_FILE_LINES, { dryRun })) {
    result.patched.push(rel(prefix, file));
  }

  // ── boot and shutdown ────────────────────────────────────────────
  const indexPath = join(serverDir, "src", "index.ts");
  const index = patchSourceFile(
    indexPath,
    [
      {
        guard: './services/scheduler/index.js"',
        anchor: INDEX_IMPORT_ANCHOR,
        insert:
          '\nimport { registerBuiltInJobs, startScheduler, stopScheduler } from "./services/scheduler/index.js";',
      },
      {
        guard: "registerBuiltInJobs()",
        anchor: INDEX_LISTEN_ANCHOR,
        position: "before",
        insert: [
          "    // Background jobs. The registry has to be full before the loop",
          "    // starts — a job registered later only joins the next poll — and",
          "    // the loop claims its rows from Mongo, so this sits after",
          "    // connectToDB() and before the first request is served.",
          "    registerBuiltInJobs();",
          "    startScheduler({ enabled: env.SCHEDULER_ENABLED, isTest: env.isTest });",
          "",
          "",
        ].join("\n"),
      },
      {
        guard: "await stopScheduler()",
        anchor: INDEX_CLOSE_ANCHOR,
        position: "after",
        insert: [
          "",
          "",
          "  // Stop the background job loop before the databases go away. A pass",
          "  // already in flight is awaited; a job claimed and never released",
          "  // frees itself when its lease lapses, so a hard kill here costs one",
          "  // run and nothing else.",
          "  await stopScheduler();",
        ].join("\n"),
      },
    ],
    { dryRun },
  );
  if (index.changed) result.patched.push(rel(prefix, "src/index.ts"));
  for (const anchor of index.missingAnchors) {
    result.notes.push(
      `src/index.ts: could not find ${JSON.stringify(anchor.trim())} — wire registerBuiltInJobs()/startScheduler() into start() and stopScheduler() into shutdown() by hand.`,
    );
  }

  registerScheduledJobModel(result, serverDir, prefix, dryRun);

  if (appendClaudeMdSection(projectDir, CLAUDE_MD_HEADING, CLAUDE_MD_BODY, { dryRun })) {
    result.patched.push("CLAUDE.md");
  }

  if (result.written.length > 0) {
    result.notes.push(
      "Set TEST_MONGODB_URI in CI (e.g. mongodb://127.0.0.1:27017) or the lease tests skip and prove nothing.",
    );
    result.notes.push(
      "services/scheduler/heartbeat.ts is a placeholder — delete it and its line in registerBuiltInJobs() once you have a real job.",
    );
  }

  return result;
}

/**
 * Add `ScheduledJob` to the model registry `server-migrations` ships, when
 * that feature is present.
 *
 * `ensureScheduledJob` calls `ScheduledJob.init()`, so the unique index the
 * whole claim depends on does get built either way. What the registry buys is
 * the other half: a model missing from it is invisible to the boot index check
 * and to `admin doctor`, so the day that unique index is missing — dropped by
 * hand, lost in a restore — nothing reports it and two replicas quietly run
 * every job twice. Registration is a bare side-effect import; `allModels()`
 * reads `mongoose.models`.
 */
function registerScheduledJobModel(
  result: ServerFeatureResult,
  serverDir: string,
  prefix: string,
  dryRun: boolean | undefined,
): void {
  const registry = join(serverDir, "src", "models", "registry.ts");
  if (!existsSync(registry)) return;
  const outcome = patchSourceFile(
    registry,
    [
      {
        guard: 'import "./ScheduledJob.js";',
        anchor: 'import "./Profile.js";',
        insert: '\nimport "./ScheduledJob.js";',
      },
    ],
    { dryRun },
  );
  if (outcome.changed) {
    result.patched.push(rel(prefix, "src/models/registry.ts"));
    return;
  }
  if (outcome.missingAnchors.length > 0) {
    result.notes.push(
      `${rel(prefix, "src/models/registry.ts")}: add \`import "./ScheduledJob.js";\` — a model missing from the registry gets no index check at boot and no mention from \`admin doctor\`.`,
    );
  }
}

function readPackageName(dir: string): string | null {
  const path = join(dir, "package.json");
  if (!existsSync(path)) return null;
  try {
    const name = (JSON.parse(readFileSync(path, "utf-8")) as { name?: unknown }).name;
    return typeof name === "string" && name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

const toPosix = (value: string): string => value.split(sep).join("/");

const rel = (prefix: string, path: string): string => (prefix ? `${prefix}/${path}` : path);
