#!/usr/bin/env node
/**
 * Instance admin CLI for __HATCHKIT_PROJECT_NAME__.
 *
 *   pnpm --filter __HATCHKIT_SERVER_PKG__ admin migrate --status
 *   node dist/cli/admin.js doctor            (inside a built container)
 *
 * A process of its own rather than an HTTP endpoint on purpose: the operator
 * proves who they are by being able to run a command inside the server
 * container, which is a stronger check than any password the instance could
 * ask for, and it leaves no admin surface on the network to attack.
 *
 * `migrate` and `doctor` read the SAME state — the same `MIGRATIONS` array,
 * the same `schema_migrations` collection, the same model registry that the
 * boot uses. A second implementation of "what is the schema" is a second
 * answer, and the one you are not looking at is the one that is right.
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { connectToDB, disconnectFromDB } from "../db/connection.js";
import { type IndexOutcome, describeIndex, inspectModelIndexes } from "../db/indexes.js";
import { allModels } from "../models/registry.js";
import {
  MIGRATIONS,
  SCHEMA_VERSION,
  SchemaTooNewError,
  type MigrationStatus,
  migrationStatus,
  runMigrations,
} from "../services/migrations/index.js";

const USAGE = `Usage: admin <command>

  migrate [--status | --dry-run | --apply] [--json]
        --status   (default) applied migrations, what is pending, and the
                   schema version this build reads
        --dry-run  what an apply would run; changes nothing
        --apply    run the pending migrations now, under the same lock the
                   server uses. The server also applies them at every start;
                   this is for applying without starting it.

  doctor [--json]
        database, schema and index health. Read-only.

Exit codes: 0 success, 1 a check or the command failed, 2 usage error.
`;

export type AdminCommand =
  | { kind: "help" }
  | { kind: "usage-error"; error: string }
  | { kind: "migrate"; mode: "status" | "dry-run" | "apply"; json: boolean }
  | { kind: "doctor"; json: boolean };

export function parseAdminArgs(argv: readonly string[]): AdminCommand {
  const [command, ...rest] = argv;
  const json = rest.includes("--json");
  const flags = rest.filter((arg) => arg !== "--json");
  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return { kind: "help" };
    case "doctor":
      return flags.length > 0
        ? { kind: "usage-error", error: `doctor takes no ${flags[0]}` }
        : { kind: "doctor", json };
    case "migrate": {
      const modes = flags.map((flag) => flag.replace(/^--/, ""));
      if (modes.length > 1) return { kind: "usage-error", error: "migrate takes one mode flag" };
      const mode = modes[0] ?? "status";
      if (mode !== "status" && mode !== "dry-run" && mode !== "apply") {
        return { kind: "usage-error", error: `migrate does not take --${mode}` };
      }
      return { kind: "migrate", mode, json };
    }
    default:
      return { kind: "usage-error", error: `unknown command: ${command}` };
  }
}

// ── migrate ───────────────────────────────────────────────────────────────

export function formatStatus(
  status: MigrationStatus,
  mode: "status" | "dry-run" | "apply",
): string {
  const lines: string[] = [
    `This build reads schema up to ${status.schemaVersion}; the database requires ${status.requiredReaderSchema}.`,
  ];
  if (!status.readable) {
    const release = status.raisedBy?.release ? `v${status.raisedBy.release}` : "a newer release";
    lines.push(
      `REFUSED: the database was migrated by ${release}. Deploy that release or later, or ` +
        "restore the dump taken before the upgrade.",
    );
  }
  if (mode === "status") {
    lines.push("", "Applied:");
    if (status.applied.length === 0) lines.push("  (none)");
    for (const record of status.applied) {
      const unknown = status.unknownApplied.includes(record) ? " [from a newer release]" : "";
      lines.push(
        `  ${String(record._id).padStart(3)}  ${record.description} ` +
          `(${record.appliedAt.toISOString()}, v${record.release || "?"})${unknown}`,
      );
    }
  }
  lines.push("", mode === "dry-run" ? "Would apply:" : "Pending:");
  if (status.pending.length === 0) lines.push("  (none)");
  for (const migration of status.pending) {
    lines.push(`  ${String(migration.id).padStart(3)}  ${migration.description}`);
  }
  if (mode === "dry-run") lines.push("", "Dry run: nothing was changed.");
  return `${lines.join("\n")}\n`;
}

export function statusJson(status: MigrationStatus): Record<string, unknown> {
  return {
    schemaVersion: status.schemaVersion,
    requiredReaderSchema: status.requiredReaderSchema,
    readable: status.readable,
    applied: status.applied.map((record) => ({
      id: record._id,
      description: record.description,
      minReaderSchema: record.minReaderSchema,
      appliedAt: record.appliedAt.toISOString(),
      release: record.release,
    })),
    pending: status.pending.map(({ id, description, minReaderSchema }) => ({
      id,
      description,
      minReaderSchema,
    })),
  };
}

async function runMigrateCommand(
  db: import("mongodb").Db,
  mode: "status" | "dry-run" | "apply",
  json: boolean,
): Promise<{ stdout: string; exitCode: number }> {
  const before = await migrationStatus(db, MIGRATIONS, SCHEMA_VERSION);
  // An unreadable database is reported, never migrated: this build does not
  // know what the newer release did, so "apply" would mean guessing.
  if (mode !== "apply" || !before.readable) {
    return {
      stdout: json
        ? `${JSON.stringify(statusJson(before), null, 2)}\n`
        : formatStatus(before, mode),
      exitCode: before.readable ? 0 : 1,
    };
  }

  const lines: string[] = [];
  try {
    const applied = await runMigrations({
      db,
      migrations: MIGRATIONS,
      schemaVersion: SCHEMA_VERSION,
      owner: `admin:${hostname()}:${process.pid}:${randomUUID()}`,
      release: env.RELEASE,
      logger: { log: (line) => lines.push(line), error: (line) => lines.push(line) },
    });
    const after = await migrationStatus(db, MIGRATIONS, SCHEMA_VERSION);
    if (json) {
      return {
        stdout: `${JSON.stringify({ ...statusJson(after), appliedNow: applied }, null, 2)}\n`,
        exitCode: 0,
      };
    }
    lines.push(applied.length === 0 ? "Nothing to apply." : `Applied ${applied.join(", ")}.`);
    return { stdout: `${lines.join("\n")}\n`, exitCode: 0 };
  } catch (error) {
    if (error instanceof SchemaTooNewError) {
      const head = lines.length > 0 ? `${lines.join("\n")}\n` : "";
      return { stdout: `${head}${error.message}\n`, exitCode: 1 };
    }
    throw error;
  }
}

// ── doctor ────────────────────────────────────────────────────────────────

export type CheckStatus = "pass" | "warn" | "fail";
export type CheckResult = { name: string; status: CheckStatus; detail: string; fix?: string };

/** The fields of a `MigrationStatus` the check reads, so a test can hand it
 *  a state instead of a database. */
export type SchemaState = Pick<
  MigrationStatus,
  "schemaVersion" | "requiredReaderSchema" | "readable"
> & {
  raisedBy: { release: string } | null;
  pending: readonly { id: number }[];
};

export function checkSchema(state: SchemaState): CheckResult {
  const name = "schema";
  if (!state.readable) {
    const release = state.raisedBy?.release ? `v${state.raisedBy.release}` : "a newer release";
    return {
      name,
      status: "fail",
      detail:
        `the database requires schema ${state.requiredReaderSchema}, written by ${release}; ` +
        `this build reads up to ${state.schemaVersion}, and the server refuses to start`,
      fix: "deploy that release or later, or restore the dump taken before the upgrade",
    };
  }
  if (state.pending.length > 0) {
    return {
      name,
      status: "warn",
      detail:
        `${state.pending.length} migration(s) pending ` +
        `(${state.pending.map((migration) => migration.id).join(", ")}); the server applies ` +
        "them at its next start",
      fix: "take a database dump, then restart the server or run: admin migrate --apply",
    };
  }
  return { name, status: "pass", detail: `schema ${state.schemaVersion}, no migrations pending` };
}

export function checkIndexes(indexes: readonly IndexOutcome[]): CheckResult {
  const name = "indexes";
  const missing = indexes.filter((index) => index.error !== null);
  const critical = missing.filter((index) => index.critical);
  if (critical.length > 0) {
    return {
      name,
      status: "fail",
      detail: `missing: ${critical.map(describeIndex).join("; ")}; the invariant it enforces is not guaranteed`,
      fix: "restart the server and read its log: it builds each index and names the one that fails, usually over duplicate documents",
    };
  }
  if (missing.length > 0) {
    return {
      name,
      status: "warn",
      detail: `missing: ${missing.map(describeIndex).join("; ")}`,
      fix: "restart the server, which builds missing indexes; its log says why one fails",
    };
  }
  return { name, status: "pass", detail: `all ${indexes.length} declared indexes exist` };
}

export function formatChecks(checks: readonly CheckResult[]): string {
  const lines = checks.map((check) => {
    const head = `${check.status.toUpperCase().padEnd(4)}  ${check.name.padEnd(10)} ${check.detail}`;
    return check.fix ? `${head}\n        → ${check.fix}` : head;
  });
  return `${lines.join("\n")}\n`;
}

async function runDoctorCommand(
  db: import("mongodb").Db,
  json: boolean,
): Promise<{ stdout: string; exitCode: number }> {
  const checks: CheckResult[] = [];
  const started = Date.now();
  await db.command({ ping: 1 });
  checks.push({
    name: "database",
    status: "pass",
    detail: `answered a ping in ${Date.now() - started} ms`,
  });
  checks.push(checkSchema(await migrationStatus(db, MIGRATIONS, SCHEMA_VERSION)));
  checks.push(checkIndexes(await inspectModelIndexes(db, allModels())));
  const failed = checks.some((check) => check.status === "fail");
  return {
    stdout: json ? `${JSON.stringify({ checks }, null, 2)}\n` : formatChecks(checks),
    exitCode: failed ? 1 : 0,
  };
}

// ── entry point ───────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const command = parseAdminArgs(process.argv.slice(2));
  if (command.kind === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command.kind === "usage-error") {
    process.stderr.write(`admin: ${command.error}\n\n${USAGE}`);
    return 2;
  }

  await connectToDB();
  try {
    const db = mongoose.connection.db;
    if (!db) throw new Error("no database connection");
    const { stdout, exitCode } =
      command.kind === "migrate"
        ? await runMigrateCommand(db, command.mode, command.json)
        : await runDoctorCommand(db, command.json);
    process.stdout.write(stdout);
    return exitCode;
  } finally {
    await disconnectFromDB();
  }
}

const code = await main().catch((error: unknown) => {
  process.stderr.write(
    `admin: unexpected error\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  return 1;
});

// Exit explicitly: the modules this imports can leave timers behind, and a CLI
// that hangs after printing its answer looks like one that did not finish.
// Flush first — on a pipe, stdout is asynchronous and exit would cut it off.
await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
await new Promise<void>((resolve) => process.stderr.write("", () => resolve()));
process.exit(code);
