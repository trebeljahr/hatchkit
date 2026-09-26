/*
 * cli/src/features/server-migrations/index.ts — writes the boot-time
 * schema machinery into a scaffolded project: numbered migrations
 * under a lease, then index preparation, both before the server
 * listens.
 *
 * The starter ships models and a router and nothing that says what
 * happens to a database between releases. That gap is invisible until
 * the day it costs data: a unique index mongoose failed to build and
 * swallowed the error for, a backfill run twice by a container that
 * died before recording it, a rolled-back build reading a shape the
 * newer one wrote. Every file written here exists because one of those
 * fails silently.
 *
 * What lands in the project:
 *   src/services/migrations/  the runner, the lease, the registry
 *   src/db/prepare.ts         migrations → indexes, called from index.ts
 *   src/db/indexes.ts         per-index build, critical vs. warning
 *   src/models/registry.ts    the model list both boot and doctor read
 *   src/models/README.md      the no-enum-on-copied-fields rule
 *   src/cli/admin.ts          migrate --status/--dry-run/--apply, doctor
 *   src/tests/migrations.test.ts
 *   docs/server-migrations.md
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  type ServerFeatureInput,
  type ServerFeatureResult,
  addPackageDeps,
  addPackageScript,
  appendClaudeMdSection,
  appendEnvBlock,
  emptyResult,
  patchEnvConfig,
  patchSourceFile,
  resolveServerDir,
  writeFeatureFiles,
} from "../server-platform/kit.js";

/** The driver mongoose 9 bundles. Declared explicitly because every
 *  migration is written against the raw `Db` and pnpm's node_modules
 *  only exposes what a package declares — an undeclared `mongodb`
 *  import resolves in a hoisted install and fails in a strict one,
 *  which is the worst place for that difference to show up. */
const MONGODB_DEP = "^7.2.0";

/** Marker for the env block and the `env` object entry. Both are
 *  idempotent on it, so a second `hatchkit update` adds neither. */
const ENV_MARKER = "server-migrations";

/** Matches a side-effect import of a sibling model in the registry:
 *  `import "./Item.js";`. The registry is read rather than assumed
 *  because it is an extension point — the user adds their models, and
 *  `public-api` appends its four when it is applied. Comparing against
 *  a hardcoded list would report models as unregistered seconds after a
 *  sibling feature registered them. */
const REGISTRY_IMPORT = /^\s*import\s+"\.\/([A-Za-z0-9_-]+)\.js";/gm;

/** Agent memory. Every bullet below is a rule that fails QUIETLY when
 *  it is broken, and none of them can be inferred from the generated
 *  code by reading it — which is the whole reason they are written
 *  down where the next agent looks first. */
const CLAUDE_MD_HEADING = "### Migrations and indexes at boot";

const CLAUDE_MD_BODY = `\`db/prepare.ts\` runs right after the database connects and before anything
else: numbered migrations first (recorded in \`schema_migrations\`, under a lease
in \`app_meta\`), then the index build in \`db/indexes.ts\`. \`SCHEMA_VERSION\` is the
id of the last entry in \`services/migrations/registry.ts\`.
\`pnpm admin migrate --status|--dry-run\` and \`admin doctor\` read that same state
through the same functions, not a parallel copy. User docs:
\`docs/server-migrations.md\`.

Five rules, each of which fails quietly if broken:

- **Migrations are append-only, 1…n, idempotent, and written on the raw
  driver.** A process can die between running one and recording it, and a lease
  can lapse mid-run; both re-run it. Today's mongoose models are not what an old
  database needs.
- **\`minReaderSchema\` stays low** unless older code would misread the result.
  Raising it makes every older build refuse to start on that database — the
  point of a breaking change, an outage for an additive one.
- **The readable check runs before the lock.** A too-old build must exit without
  touching the database and without blocking on a lock the newer build holds.
- **Never call \`syncIndexes()\`.** It drops indexes a newer release added. A
  failure in \`CRITICAL_INDEXES\` stops the boot; every other failure warns. A new
  model goes in \`models/registry.ts\`, or neither the boot nor \`admin doctor\`
  checks it.
- **No \`enum\` on a field a create copies from another stored document**
  (\`models/README.md\`). A newer release may have written a value this build does
  not know; normalise it where it is read instead.`;

export function applyServerMigrations(input: ServerFeatureInput): ServerFeatureResult {
  const result = emptyResult("server-migrations");
  const serverDir = resolveServerDir(input.projectDir);
  if (!serverDir) {
    result.skipped =
      "no server package found (looked for packages/server/src/index.ts and ./src/index.ts)";
    return result;
  }

  const serverPkg = readPackageName(serverDir) ?? "@starter/server";
  const tokens = {
    PROJECT_NAME: input.projectName,
    SERVER_PKG: serverPkg,
    SHARED_PKG: serverPkg.replace(/\/server$/, "/shared"),
  };

  // Every destination is reported relative to the project root, not to
  // the server package: a `written` list mixing the two reads as if the
  // same file were written twice.
  const srv = (rel: string) => toPosix(join(relative(input.projectDir, serverDir), rel));

  writeFeatureFiles(result, {
    baseDir: input.projectDir,
    tokens,
    dryRun: input.dryRun,
    files: [
      ["services/migrations/types.ts.tpl", srv("src/services/migrations/types.ts")],
      ["services/migrations/lease.ts.tpl", srv("src/services/migrations/lease.ts")],
      ["services/migrations/runner.ts.tpl", srv("src/services/migrations/runner.ts")],
      ["services/migrations/registry.ts.tpl", srv("src/services/migrations/registry.ts")],
      ["services/migrations/001-baseline.ts.tpl", srv("src/services/migrations/001-baseline.ts")],
      ["services/migrations/index.ts.tpl", srv("src/services/migrations/index.ts")],
      ["db/indexes.ts.tpl", srv("src/db/indexes.ts")],
      ["db/prepare.ts.tpl", srv("src/db/prepare.ts")],
      ["models/registry.ts.tpl", srv("src/models/registry.ts")],
      ["models/README.md.tpl", srv("src/models/README.md")],
      ["cli/admin.ts.tpl", srv("src/cli/admin.ts")],
      ["tests/migrations.test.ts.tpl", srv("src/tests/migrations.test.ts")],
      ["docs/server-migrations.md.tpl", "docs/server-migrations.md"],
    ],
    // The registry exists to be added to — by the user for their own
    // models, and by `public-api`, which appends its four. Rewriting or
    // flagging it on a later run would fight both.
    extensionPoints: [srv("src/models/registry.ts")],
  });

  patchBootSequence(result, serverDir, srv, input);

  if (addPackageDeps(serverDir, { mongodb: MONGODB_DEP }, { dryRun: input.dryRun }).length > 0) {
    result.notes.push(`added mongodb ${MONGODB_DEP} to ${serverPkg} — run pnpm install`);
  }
  if (addPackageScript(serverDir, "admin", "tsx src/cli/admin.ts", { dryRun: input.dryRun })) {
    result.notes.push(`pnpm --filter ${serverPkg} admin migrate --status`);
  }

  // RELEASE is stamped onto every migration record, so `migrate
  // --status` can say which release wrote each row. Empty is a valid
  // value — a local build has no release — which is why it is optional
  // and falls back to the commit the image was built from.
  appendEnvBlock(
    serverDir,
    ENV_MARKER,
    [
      "# Version string recorded against every migration this build applies,",
      "# so `admin migrate --status` says which release wrote each row. Empty",
      "# is fine locally; CI sets it to the tag or commit it built.",
      "RELEASE=",
    ],
    { dryRun: input.dryRun },
  );
  const envConfig = patchEnvConfig(
    serverDir,
    ENV_MARKER,
    [
      "// Recorded against every migration this build applies, so the schema",
      "// history says which release wrote each row.",
      'RELEASE: getOptional("RELEASE", getOptional("COMMIT_SHA")),',
    ],
    { dryRun: input.dryRun },
  );
  if (envConfig.changed) result.patched.push(srv("src/config/env.ts"));
  else if (envConfig.missingAnchors.length > 0) {
    result.notes.push(
      'could not add RELEASE to src/config/env.ts — add `RELEASE: getOptional("RELEASE")` ' +
        "to the env object yourself, or db/prepare.ts will not compile",
    );
  }

  noteUnregisteredModels(result, serverDir, srv);
  if (appendClaudeMdSection(input.projectDir, CLAUDE_MD_HEADING, CLAUDE_MD_BODY, input)) {
    result.patched.push("CLAUDE.md");
  }

  return result;
}

/** Wire `prepareDatabase()` into the project's own boot sequence.
 *  Anchored on the two literal lines the starter ships; a project that
 *  rewrote either gets a note instead of a mangled `index.ts`. */
function patchBootSequence(
  result: ServerFeatureResult,
  serverDir: string,
  srv: (rel: string) => string,
  input: ServerFeatureInput,
): void {
  const indexPath = join(serverDir, "src", "index.ts");
  const outcome = patchSourceFile(
    indexPath,
    [
      {
        guard: './db/prepare.js"',
        anchor: 'import { connectToDB, disconnectFromDB } from "./db/connection.js";',
        insert: '\nimport { prepareDatabase } from "./db/prepare.js";',
      },
      {
        guard: "await prepareDatabase();",
        anchor: "    await connectToDB();",
        insert: [
          "",
          "",
          "    // Migrations, then indexes — before anything else touches the",
          "    // database. A build that must not read this schema has to find",
          "    // that out here, not after it has opened Redis, auth and a",
          "    // listening socket.",
          "    await prepareDatabase();",
        ].join("\n"),
      },
    ],
    { dryRun: input.dryRun },
  );
  if (outcome.changed) result.patched.push(srv("src/index.ts"));
  for (const anchor of outcome.missingAnchors) {
    result.notes.push(
      `src/index.ts has no \`${anchor.trim()}\` — call prepareDatabase() yourself, ` +
        "right after the database connects and before anything else",
    );
  }
}

/** A model the generated registry does not import is checked by neither
 *  the boot index build nor `admin doctor`, and nothing says so at
 *  runtime. The registry is the user's file once written, so say it
 *  here rather than rewriting theirs. */
function noteUnregisteredModels(
  result: ServerFeatureResult,
  serverDir: string,
  srv: (rel: string) => string,
): void {
  const modelsDir = join(serverDir, "src", "models");
  if (!existsSync(modelsDir)) return;
  const registryPath = join(modelsDir, "registry.ts");
  if (!existsSync(registryPath)) return;
  const registered = [...readFileSync(registryPath, "utf-8").matchAll(REGISTRY_IMPORT)].map(
    (match) => match[1],
  );
  const found = readdirSync(modelsDir)
    .filter((name) => name.endsWith(".ts") && name !== "registry.ts")
    .map((name) => name.slice(0, -3));
  const missing = registered.filter((name) => !found.includes(name));
  const extra = found.filter((name) => !registered.includes(name));
  if (missing.length > 0) {
    result.notes.push(
      `${srv("src/models/registry.ts")} imports ${missing.join(", ")}, which this project ` +
        "does not have — delete those import lines",
    );
  }
  if (extra.length > 0) {
    result.notes.push(
      `add ${extra.join(", ")} to ${srv("src/models/registry.ts")} — a model missing from it ` +
        "gets no index check at boot and no mention from `admin doctor`",
    );
  }
}

function readPackageName(pkgDir: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8")) as {
      name?: unknown;
    };
    return typeof pkg.name === "string" ? pkg.name : null;
  } catch {
    return null;
  }
}

const toPosix = (path: string): string => path.split(sep).join("/");
