/**
 * server-migrations feature writer tests.
 *
 * Builds a throwaway scaffolded project (the minimum shape
 * `resolveServerDir` recognises, with the starter's real boot sequence
 * text in `src/index.ts`) and verifies that:
 *   1. The first run writes every file and wires `prepareDatabase()`
 *      into the boot sequence AFTER `connectToDB()` and BEFORE
 *      `connectRedis()` — the whole point of the feature is that order.
 *   2. The second run is a complete no-op: nothing written, nothing
 *      patched, everything reported unchanged. `hatchkit update` runs
 *      this on projects that already have it.
 *   3. A project with no server package reports `skipped` rather than
 *      writing a server into a static site.
 *   4. The generated migration registry is contiguous from 1 and every
 *      entry declares a `minReaderSchema` — a gap or a missing floor is
 *      a boot-time throw in the user's project, so it is checked here.
 *   5. No generated file calls `syncIndexes()`, which drops the indexes
 *      a newer release added and succeeds while doing it.
 *
 * Run: pnpm --filter hatchkit test:server-migrations
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyServerMigrations } from "./src/features/server-migrations/index.js";

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (!cond) {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

/** Drop line and block comments, so a prose mention of an API is not
 *  mistaken for a call to it. Good enough for the generated sources,
 *  which hold no string literal containing a comment opener. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\n)\s*\/\/[^\n]*/g, "$1");
}

/** The starter's boot sequence, verbatim enough that the literal patch
 *  anchors have to match the real thing rather than a paraphrase. */
const INDEX_TS = `// Sentry must be imported first
import "./instrument.js";

import { createServer } from "http";
import { createApp } from "./app.js";
import { connectToDB, disconnectFromDB } from "./db/connection.js";
import { connectRedis, disconnectRedis } from "./db/redis.js";
import { initAuth, disconnectAuth } from "./auth/auth.js";
import { env } from "./config/env.js";

const app = createApp();
const server = createServer(app);

async function start(): Promise<void> {
  try {
    // 1. Connect to databases
    await connectToDB();
    await connectRedis();

    // 2. Initialize auth (needs DB connection)
    await initAuth();

    // 3. Start listening
    server.listen(env.PORT, () => {
      console.log(\`[server] Listening on http://127.0.0.1:\${env.PORT}\`);
    });
  } catch (err) {
    console.error("[server] Failed to start:", err);
    process.exit(1);
  }
}

start();
`;

const ENV_TS = `function getOptional(key: string, defaultValue = ""): string {
  return process.env[key] ?? defaultValue;
}

export const env = {
  NODE_ENV: getOptional("NODE_ENV", "development"),
  MONGODB_URI: getOptional("MONGODB_URI"),
  COMMIT_SHA: getOptional("COMMIT_SHA"),

  isProduction: getOptional("NODE_ENV") === "production",
  isTest: getOptional("NODE_ENV") === "test",
} as const;
`;

const SERVER_PKG_JSON = `${JSON.stringify(
  {
    name: "@starter/server",
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      dev: "tsx watch src/index.ts",
      test: "node --import tsx --test src/tests/*.test.ts",
    },
    dependencies: { mongoose: "^9.6.2" },
    devDependencies: { tsx: "^4.22.0" },
  },
  null,
  2,
)}\n`;

function scaffold(root: string): string {
  const serverDir = join(root, "packages", "server");
  mkdirSync(join(serverDir, "src", "config"), { recursive: true });
  mkdirSync(join(serverDir, "src", "models"), { recursive: true });
  mkdirSync(join(serverDir, "src", "tests"), { recursive: true });
  writeFileSync(join(serverDir, "package.json"), SERVER_PKG_JSON);
  writeFileSync(join(serverDir, "src", "index.ts"), INDEX_TS);
  writeFileSync(join(serverDir, "src", "config", "env.ts"), ENV_TS);
  writeFileSync(join(serverDir, "src", "models", "Item.ts"), "export const Item = null;\n");
  writeFileSync(join(serverDir, "src", "models", "Profile.ts"), "export const Profile = null;\n");
  writeFileSync(join(serverDir, ".env.example"), "PORT=5000\n");
  return serverDir;
}

const root = mkdtempSync(join(tmpdir(), "hk-server-migrations-"));
const bare = mkdtempSync(join(tmpdir(), "hk-no-server-"));
try {
  const serverDir = scaffold(root);
  const args = { projectDir: root, projectName: "Demo App" };

  // ── 1. First run ────────────────────────────────────────────────────
  const first = applyServerMigrations(args);
  assert(first.skipped === undefined, `first run not skipped (got ${first.skipped})`);

  const expected = [
    "packages/server/src/services/migrations/types.ts",
    "packages/server/src/services/migrations/lease.ts",
    "packages/server/src/services/migrations/runner.ts",
    "packages/server/src/services/migrations/registry.ts",
    "packages/server/src/services/migrations/001-baseline.ts",
    "packages/server/src/services/migrations/index.ts",
    "packages/server/src/db/indexes.ts",
    "packages/server/src/db/prepare.ts",
    "packages/server/src/models/registry.ts",
    "packages/server/src/models/README.md",
    "packages/server/src/cli/admin.ts",
    "packages/server/src/tests/migrations.test.ts",
    "docs/server-migrations.md",
  ];
  for (const rel of expected) assert(first.written.includes(rel), `first run wrote ${rel}`);
  assert(
    first.written.length === expected.length,
    `first run wrote ${first.written.length} files (expected ${expected.length})`,
  );
  assert(first.conflicted.length === 0, `first run reported ${first.conflicted.length} conflicts`);

  // ── 2. Boot order ───────────────────────────────────────────────────
  const indexTs = readFileSync(join(serverDir, "src", "index.ts"), "utf-8");
  assert(
    indexTs.includes('import { prepareDatabase } from "./db/prepare.js";'),
    "index.ts imports prepareDatabase",
  );
  const atConnect = indexTs.indexOf("await connectToDB();");
  const atPrepare = indexTs.indexOf("await prepareDatabase();");
  const atRedis = indexTs.indexOf("await connectRedis();");
  const atAuth = indexTs.indexOf("await initAuth();");
  assert(atConnect >= 0 && atPrepare >= 0 && atRedis >= 0, "all three boot calls are present");
  assert(atConnect < atPrepare, "prepareDatabase() runs after connectToDB()");
  assert(atPrepare < atRedis, "prepareDatabase() runs before connectRedis()");
  assert(atPrepare < atAuth, "prepareDatabase() runs before initAuth()");
  assert(first.patched.includes("packages/server/src/index.ts"), "index.ts is reported as patched");

  // ── 3. package.json + env wiring ────────────────────────────────────
  const pkg = JSON.parse(readFileSync(join(serverDir, "package.json"), "utf-8")) as {
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
  };
  assert(pkg.scripts.admin === "tsx src/cli/admin.ts", "admin script registered");
  assert(typeof pkg.dependencies.mongodb === "string", "mongodb dependency added");
  assert(pkg.dependencies.mongoose === "^9.6.2", "existing mongoose range left alone");

  const envTs = readFileSync(join(serverDir, "src", "config", "env.ts"), "utf-8");
  assert(envTs.includes("RELEASE: getOptional("), "env.ts gained a RELEASE entry");
  assert(
    envTs.indexOf("RELEASE: getOptional(") < envTs.indexOf("isProduction:"),
    "RELEASE lands inside the env object, before isProduction",
  );
  assert(
    first.patched.includes("packages/server/src/config/env.ts"),
    "env.ts is reported as patched",
  );
  assert(
    readFileSync(join(serverDir, ".env.example"), "utf-8").includes("RELEASE="),
    ".env.example gained the RELEASE block",
  );

  // ── 4. Second run is a no-op ────────────────────────────────────────
  const second = applyServerMigrations(args);
  assert(second.skipped === undefined, "second run not skipped");
  assert(second.written.length === 0, `second run wrote ${second.written.length} (expected 0)`);
  assert(second.patched.length === 0, `second run patched ${second.patched.length} (expected 0)`);
  assert(
    second.conflicted.length === 0,
    `second run reported ${second.conflicted.length} conflicts (expected 0)`,
  );
  assert(
    second.unchanged.length === expected.length,
    `second run reported ${second.unchanged.length} unchanged (expected ${expected.length})`,
  );
  assert(
    readFileSync(join(serverDir, "src", "index.ts"), "utf-8") === indexTs,
    "second run left index.ts byte-identical",
  );
  assert(
    (
      readFileSync(join(serverDir, "src", "config", "env.ts"), "utf-8").match(
        /RELEASE: getOptional/g,
      ) ?? []
    ).length === 1,
    "second run did not duplicate the RELEASE entry",
  );

  // ── 5. No server package ────────────────────────────────────────────
  const skipped = applyServerMigrations({ projectDir: bare, projectName: "Static Site" });
  assert(typeof skipped.skipped === "string", "a project with no server reports skipped");
  assert(skipped.written.length === 0, "a skipped run writes nothing");

  // ── 6. The generated registry ───────────────────────────────────────
  // Imported for real, not grepped: a registry that does not evaluate is
  // a boot-time throw in the user's project.
  const registryPath = join(serverDir, "src", "services", "migrations", "registry.ts");
  const registry = (await import(registryPath)) as {
    MIGRATIONS: ReadonlyArray<{ id: number; description: string; minReaderSchema: number }>;
    SCHEMA_VERSION: number;
    assertMigrationSequence: (m: ReadonlyArray<{ id: number; minReaderSchema: number }>) => void;
  };
  assert(registry.MIGRATIONS.length > 0, "the registry ships at least the baseline");
  registry.MIGRATIONS.forEach((migration, i) => {
    assert(migration.id === i + 1, `migration at position ${i + 1} has id ${migration.id}`);
    assert(
      Number.isInteger(migration.minReaderSchema) &&
        migration.minReaderSchema >= 0 &&
        migration.minReaderSchema <= migration.id,
      `migration ${migration.id} declares a usable minReaderSchema`,
    );
    assert(migration.description.trim() !== "", `migration ${migration.id} has a description`);
  });
  assert(
    registry.SCHEMA_VERSION === registry.MIGRATIONS[registry.MIGRATIONS.length - 1]?.id,
    "SCHEMA_VERSION is the last migration's id",
  );
  let sequenceThrew = false;
  try {
    registry.assertMigrationSequence([
      { id: 1, minReaderSchema: 0 },
      { id: 3, minReaderSchema: 0 },
    ]);
  } catch {
    sequenceThrew = true;
  }
  assert(sequenceThrew, "assertMigrationSequence rejects a gap");

  // ── 7. Never syncIndexes ────────────────────────────────────────────
  // Code only: every generated file NAMES syncIndexes in prose to say
  // never to call it, so the comments have to come out before looking.
  for (const rel of expected.filter((path) => path.endsWith(".ts"))) {
    assert(
      !stripComments(readFileSync(join(root, rel), "utf-8")).includes("syncIndexes"),
      `${rel} does not call syncIndexes()`,
    );
  }
  assert(
    readFileSync(join(serverDir, "src", "db", "indexes.ts"), "utf-8").includes("syncIndexes()"),
    "indexes.ts says in prose why syncIndexes() is never called",
  );
  const indexesTs = readFileSync(join(serverDir, "src", "db", "indexes.ts"), "utf-8");
  assert(indexesTs.includes("CRITICAL_INDEXES"), "indexes.ts declares a critical set");
  assert(
    readFileSync(join(serverDir, "src", "models", "README.md"), "utf-8").includes("enum"),
    "models/README.md states the enum rule",
  );

  if (failed === 0) {
    console.log("test-server-migrations: ok");
  } else {
    console.error(`test-server-migrations: ${failed} assertion(s) failed`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(bare, { recursive: true, force: true });
}

process.exit(failed > 0 ? 1 : 0);
