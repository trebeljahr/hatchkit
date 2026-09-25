/*
 * cli/src/features/verified-deploy/migration-guard.ts — the one case
 * where rolling the server back is worse than leaving it broken.
 *
 * ---------------------------------------------------------------------
 * The failure this closes
 * ---------------------------------------------------------------------
 *
 * The server migrates its database at boot. A migration can raise the
 * minimum version a build must be at to read that database above what
 * the PREVIOUS build is at. The previous server then refuses to start on
 * the migrated database — and from outside nobody can tell whether the
 * new server got far enough to run the migration before it failed the
 * gate. So a rollback that assumes it did not is a coin flip on an
 * outage.
 *
 * The decision taken here is: when the new commit carries a migration
 * the previous build cannot read, roll back only the CLIENT. A client on
 * the previous build talking to a server one commit ahead is the
 * combination a version handshake is designed for; a server that refuses
 * to boot is an outage with no way back that does not involve a database
 * dump — which is a person's decision, never a job's.
 *
 * ---------------------------------------------------------------------
 * Unknown is not safe
 * ---------------------------------------------------------------------
 *
 * Every path that cannot answer the question answers "no": a commit
 * missing from the checkout, a registry directory that exists and cannot
 * be listed, a migration file with no readable id. Those are not the
 * same as a project with NO registry at all, which is the easy case —
 * an empty registry can carry no breaking migration, so nothing blocks
 * the rollback.
 *
 * Comparing two commits' registries means reading them out of git, which
 * is why the generated deploy job checks out with `fetch-depth: 0`. A
 * shallow checkout is the single most likely reason this guard blocks a
 * rollback that would have been fine.
 */

import type {
  MigrationEntry,
  MigrationRegistry,
  RegistryRead,
  ServerRollbackVerdict,
} from "./types.js";

/** A registry with nothing in it: the shape a project with no
 *  migrations at all reads as. */
export const EMPTY_REGISTRY: MigrationRegistry = Object.freeze({
  migrations: Object.freeze([]) as readonly MigrationEntry[],
  schemaVersion: 0,
});

/** Where a hatchkit project's migration registry lives, and the literal
 *  field names the reader looks for inside each file. Defaults, not
 *  literals: every one of them is a field on `VerifiedDeployPlan`.
 *
 *  These MATCH what the `server-migrations` feature generates —
 *  `packages/server/src/services/migrations/`, entries carrying `id`
 *  and `minReaderSchema` (see
 *  cli/src/templates/features/server-migrations/). That agreement is
 *  load-bearing and it fails in the dangerous direction: a guard
 *  looking in the wrong directory finds no registry, an absent registry
 *  is the easy case that blocks nothing, and the job then rolls the
 *  server back past a migration the previous build cannot read — the
 *  exact outage this module exists to prevent. A project whose
 *  migrations live elsewhere overrides them on the plan. */
export const DEFAULT_MIGRATIONS_DIR = "packages/server/src/services/migrations";
export const DEFAULT_ID_FIELD = "id";
export const DEFAULT_MIN_READER_FIELD = "minReaderSchema";

/** The text of a thrown value, whatever it turned out to be. A reader
 *  that throws is a registry that could not be read, which is a reason
 *  the guard has to be able to quote. */
function messageOf(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/** Options for {@link readMigrationRegistry}. */
export interface RegistryReadOptions {
  /** Repository-relative directory holding one file per migration. */
  dir?: string;
  /** Field naming the migration's monotonic id. */
  idField?: string;
  /** Field naming the lowest schema version that can read the database
   *  once this migration has run. */
  minReaderField?: string;
  /** Which files in the directory are migrations. */
  filePattern?: RegExp;
}

/** Files that look like a migration rather than an index or a test. */
const DEFAULT_FILE_PATTERN = /^(?!index\.)(?!.*\.(test|spec)\.).+\.(ts|js|mjs|cjs|sql)$/;

/** `<field>: <number>` as a source literal, which is how a migration
 *  declares itself in every shape this reader supports — an object
 *  literal, a class property, a JSON file. Deliberately a text match
 *  rather than an import: the registry is read at an arbitrary commit
 *  out of git, where nothing is installed and nothing can be executed. */
function numericField(text: string, field: string): number | null {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`\\b"?${escaped}"?\\s*[:=]\\s*(\\d+)`).exec(text);
  return match ? Number(match[1]) : null;
}

/**
 * Read one commit's migration registry.
 *
 * @param readFile  contents of a repository-relative path at that
 *                  commit, or null when the path does not exist there.
 * @param listDir   file names in a repository-relative directory at that
 *                  commit; `[]` when the directory does not exist, and
 *                  `null` when it could not be read. The two are NOT the
 *                  same — see the module header.
 */
export function readMigrationRegistry(
  readFile: (path: string) => string | null,
  listDir: (dir: string) => string[] | null,
  options: RegistryReadOptions = {},
): RegistryRead {
  const dir = options.dir ?? DEFAULT_MIGRATIONS_DIR;
  const idField = options.idField ?? DEFAULT_ID_FIELD;
  const minReaderField = options.minReaderField ?? DEFAULT_MIN_READER_FIELD;
  const pattern = options.filePattern ?? DEFAULT_FILE_PATTERN;

  let names: string[] | null;
  try {
    names = listDir(dir);
  } catch (caught) {
    return { ok: false, error: `${dir} could not be listed (${messageOf(caught)})` };
  }
  if (names === null) return { ok: false, error: `${dir} could not be listed` };
  if (names.length === 0) return { ok: true, registry: EMPTY_REGISTRY };

  const migrations: MigrationEntry[] = [];
  for (const name of names.filter((candidate) => pattern.test(candidate))) {
    const path = `${dir}/${name}`;
    let text: string | null;
    try {
      text = readFile(path);
    } catch (caught) {
      return { ok: false, error: `${path} could not be read (${messageOf(caught)})` };
    }
    if (text === null) return { ok: false, error: `${path} could not be read` };
    const id = numericField(text, idField);
    const minReader = numericField(text, minReaderField);
    if (id === null || minReader === null) {
      return {
        ok: false,
        error: `${path} has no literal \`${idField}: <n>\` and \`${minReaderField}: <n>\``,
      };
    }
    migrations.push({ id, file: name, minReader });
  }

  if (migrations.length === 0) return { ok: true, registry: EMPTY_REGISTRY };
  migrations.sort((a, b) => a.id - b.id);
  return {
    ok: true,
    registry: { migrations, schemaVersion: migrations[migrations.length - 1].id },
  };
}

/**
 * Migrations in `next` that `previous` cannot read the database after.
 *
 * Both conditions matter. `id > previous.schemaVersion` is "this
 * migration is new to the older build"; `minReader > previous.schemaVersion`
 * is "and the older build is below what it now requires". A new
 * migration that only adds something the old build ignores has a
 * `minReader` at or below the old schema version and is not breaking.
 */
export function breakingMigrations(
  previous: MigrationRegistry,
  next: MigrationRegistry,
): MigrationEntry[] {
  return next.migrations.filter(
    (migration) =>
      migration.id > previous.schemaVersion && migration.minReader > previous.schemaVersion,
  );
}

/** Input to {@link canRollBackServer}. */
export interface ServerRollbackQuestion {
  /** Registry of the commit that is running now (the one being left). */
  newRegistry: RegistryRead;
  /** Registry of the commit being restored. */
  previousRegistry: RegistryRead;
  /** Commits, for the error line. */
  newSha?: string;
  previousSha?: string;
}

/**
 * May the server be put back from `newSha` to `previousSha`?
 *
 * Three outcomes, and only the first is a yes:
 *
 *   · **safe** — both registries read, and nothing in the new commit
 *     raises the minimum reader above the previous build's schema
 *     version.
 *   · **blocked** — both registries read, and the new commit carries a
 *     migration the previous build cannot read.
 *   · **unknown** — either registry could not be read. Answered NO. The
 *     question is whether the rollback is safe, and "I could not tell"
 *     is not "yes".
 */
export function canRollBackServer(question: ServerRollbackQuestion): ServerRollbackVerdict {
  const newSha = question.newSha ?? "the new commit";
  const previousSha = question.previousSha ?? "the previous commit";

  if (!question.newRegistry.ok || !question.previousRegistry.ok) {
    const problems = [
      question.newRegistry.ok ? null : `${newSha}: ${question.newRegistry.error}`,
      question.previousRegistry.ok ? null : `${previousSha}: ${question.previousRegistry.error}`,
    ].filter((problem): problem is string => problem !== null);
    return {
      allowed: false,
      reason: `the migration registries of ${newSha} and ${previousSha} could not be compared (${problems.join("; ")}), and an unknown answer is not a safe one — a shallow checkout is the usual cause, so the deploy job needs fetch-depth: 0`,
    };
  }

  const previous = question.previousRegistry.registry;
  const next = question.newRegistry.registry;
  const breaking = breakingMigrations(previous, next);
  if (breaking.length === 0) {
    return {
      allowed: true,
      reason: `no migration in ${newSha} raises the minimum reader above the schema version ${previous.schemaVersion} of ${previousSha}`,
    };
  }

  const list = breaking
    .map(
      (migration) => `${migration.id} (${migration.file}, minimum reader ${migration.minReader})`,
    )
    .join(", ");
  return {
    allowed: false,
    reason: `${newSha} carries migration ${list}, above the schema version ${previous.schemaVersion} of ${previousSha}, so a server built from ${previousSha} would refuse to start on that database`,
  };
}
