/*
 * Backup source drift — registered selectors vs. the host's live containers.
 *
 * The host runner finds each database by an exact Docker selector. When a
 * project's database moves (compose `app-mongo` → a Coolify-managed one) or
 * is removed (a dropped cache, a retired service), the selector matches
 * nothing and that project's run fails every night until someone edits
 * /etc/hatchkit-backups/config.json by hand.
 *
 * The run keeps failing on purpose. From the host, a removed database and a
 * crashed one look the same, and skipping a source would let retention
 * prune the last snapshots that still contain its data. What changes here
 * is that the failure is named ("source missing", not "backup failed"), it
 * is visible before the nightly run (`backup sources`, `backup status`,
 * `doctor`), it comes with the exact command that fixes the policy, and
 * the hatchkit commands that delete data containers fix the policy
 * themselves.
 *
 * Every host program here runs the CLI's own copy of the script over
 * Tailscale SSH, so a host installed before this change gets the same
 * answers without a reinstall. `sources` and `plan` only read.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { backupHostExec, backupProvider } from "./provider.js";
import type { BackupProject, BackupSource } from "./register.js";
import { backupProjectName } from "./scripts.js";

export type Selector = NonNullable<BackupSource["selector"]>;

export interface SourceCandidate {
  container: string;
  image?: string | null;
  selector: Selector;
  coolifyProject?: string | null;
  coolifyResource?: string | null;
  kinds: string[];
}

export interface SourceFix {
  action: "retarget" | "remove-source" | "deregister" | "review";
  summary: string;
  command: string;
  preview: string;
  alternatives?: string[];
}

export interface SourceRow {
  project: string;
  source: string;
  kind: BackupSource["kind"];
  state: "ok" | "missing" | "ambiguous";
  selector?: Selector;
  matches?: number;
  container?: string;
  paths?: string[];
  missingPaths?: string[];
  candidates?: SourceCandidate[];
  fix?: SourceFix;
}

export interface SourceReport {
  host: string;
  sources: SourceRow[];
  stale: SourceRow[];
}

function template(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../templates/backups/${name}`, import.meta.url)),
    "utf8",
  );
}

/** Run the bundled runner.py with `args`, the script itself on stdin. */
async function hostRunner(args: string[]): Promise<string> {
  for (const arg of args) {
    if (!/^[a-z0-9_-]+$/.test(arg)) throw new Error("Unsafe runner argument.");
  }
  return backupHostExec(`python3 - ${args.join(" ")}`, template("runner.py"), 60_000);
}

/** Run the bundled register.py next to the installed runner, payload on stdin. */
async function hostRegister(mode: "add" | "replace" | "remove", payload: unknown) {
  const script = Buffer.from(template("register.py")).toString("base64");
  return JSON.parse(
    await backupHostExec(
      `cd /opt/hatchkit-backups && python3 -c 'import base64,sys;sys.argv=["register.py","${mode}"];exec(base64.b64decode("${script}"))'`,
      JSON.stringify(payload),
    ),
  ) as Record<string, unknown>;
}

export function hostRegisterProject(project: BackupProject) {
  return hostRegister("add", project) as Promise<{
    project: string;
    registered: boolean;
    existing: boolean;
  }>;
}

/** The policy exactly as the host holds it; the guard for every change. */
export async function hostPolicy(project: string): Promise<BackupProject> {
  backupProjectName(project);
  const plan = JSON.parse(await hostRunner(["plan", "--project", project])) as {
    projects: BackupProject[];
  };
  const policy = plan.projects.find((p) => p.name === project);
  if (!policy) throw new Error(`${project} is not registered for backups on the host.`);
  return policy;
}

/** Read-only: resolve every registered source on the host. */
export async function fetchSourceReport(project?: string): Promise<SourceReport> {
  if (project) backupProjectName(project);
  const raw = JSON.parse(
    await hostRunner(["sources", ...(project ? ["--project", project] : [])]),
  ) as { sources: SourceRow[] };
  const sources = attachFixes(raw.sources);
  return {
    host: backupProvider().host.target,
    sources,
    stale: sources.filter((row) => row.state !== "ok"),
  };
}

/** Candidates that look like they belong to `project`: Coolify names its
 *  databases `<project>-<engine>` inside a Coolify project of the same name. */
export function ownedCandidates(project: string, candidates: SourceCandidate[] = []) {
  return candidates.filter(
    (c) =>
      c.coolifyProject === project ||
      c.coolifyResource === project ||
      c.coolifyResource?.startsWith(`${project}-`) ||
      c.container.startsWith(`${project}-`),
  );
}

const cmd = (args: string) => `hatchkit backup ${args}`;

/** Pure: decide the fix for each stale row. */
export function attachFixes(rows: SourceRow[]): SourceRow[] {
  return rows.map((row) => {
    if (row.state === "ok") return row;
    const siblings = rows.filter((r) => r.project === row.project);
    const allStale = siblings.every((r) => r.state !== "ok");
    const remove =
      siblings.length === 1 || allStale
        ? {
            action: "deregister" as const,
            args: `deregister --project ${row.project}`,
            summary:
              siblings.length === 1
                ? `${row.project}'s only backup source is gone. Deregister the project; its snapshots stay in the bucket.`
                : `None of ${row.project}'s backup sources exist any more. Deregister the project; its snapshots stay in the bucket.`,
          }
        : {
            action: "remove-source" as const,
            args: `update-source --project ${row.project} --source ${row.source} --remove`,
            summary: `Drop ${row.source} from ${row.project}'s backups; the other sources keep running.`,
          };
    const retarget = (c: SourceCandidate) =>
      `update-source --project ${row.project} --source ${row.source} --container ${c.container}`;
    let fix: SourceFix;
    if (row.state === "ambiguous") {
      const options = row.candidates ?? [];
      fix = {
        action: "review",
        summary: `${row.source} matches ${row.matches} running containers; pin it to one.`,
        command: options[0] ? cmd(retarget(options[0])) : cmd(`sources --project ${row.project}`),
        preview: options[0]
          ? cmd(`${retarget(options[0])} --dry-run`)
          : cmd(`sources --project ${row.project}`),
        alternatives: options.slice(1).map((c) => cmd(retarget(c))),
      };
    } else if (row.kind === "files") {
      fix = {
        action: remove.action,
        summary: `${row.source} path(s) ${(row.missingPaths ?? []).join(", ")} no longer exist. ${remove.summary}`,
        command: cmd(remove.args),
        preview: cmd(`${remove.args} --dry-run`),
      };
    } else {
      const owned = ownedCandidates(row.project, row.candidates);
      if (owned.length === 1) {
        fix = {
          action: "retarget",
          summary: `${row.source} (${row.kind}) moved: ${owned[0].container}${owned[0].coolifyResource ? ` (${owned[0].coolifyResource})` : ""} is ${row.project}'s running ${row.kind} and no other source backs it up.`,
          command: cmd(retarget(owned[0])),
          preview: cmd(`${retarget(owned[0])} --dry-run`),
          alternatives: [cmd(remove.args)],
        };
      } else {
        fix = {
          action: remove.action,
          summary:
            owned.length > 1
              ? `${row.source} (${row.kind}) matches no running container, and ${owned.length} of ${row.project}'s ${row.kind} containers could replace it. Pick one, or remove the source.`
              : `${row.source} (${row.kind}) matches no running container and ${row.project} has no other ${row.kind} running. If it was removed on purpose: ${remove.summary} If it crashed or is stopped, start it instead.`,
          command: cmd(remove.args),
          preview: cmd(`${remove.args} --dry-run`),
          ...(owned.length > 1 ? { alternatives: owned.map((c) => cmd(retarget(c))) } : {}),
        };
      }
    }
    return { ...row, fix };
  });
}

/** Pure: does `row` read anything that lives under one of `uuids`? */
export function sourceReferences(row: SourceRow, uuids: string[]): boolean {
  const values = [
    ...Object.values(row.selector ?? {}),
    row.container ?? "",
    ...(row.paths ?? []),
  ].filter(Boolean) as string[];
  return uuids.some((uuid) => uuid && values.some((value) => value.includes(uuid)));
}

export interface PolicyChange {
  project: string;
  action: "replace" | "deregister";
  before: BackupProject;
  after?: BackupProject;
  removedSources: string[];
}

/** Pure: the policy left after dropping `drop` sources. */
export function policyWithout(policy: BackupProject, drop: string[]): PolicyChange {
  const sources = policy.sources.filter((s) => !drop.includes(s.name));
  return sources.length === 0
    ? { project: policy.name, action: "deregister", before: policy, removedSources: drop }
    : {
        project: policy.name,
        action: "replace",
        before: policy,
        after: { ...policy, sources },
        removedSources: drop,
      };
}

export async function applyPolicyChange(change: PolicyChange) {
  return change.action === "deregister"
    ? hostRegister("remove", { name: change.project, expected: change.before })
    : hostRegister("replace", { project: change.after, expected: change.before });
}

/** `backup update-source`: point one source at another running container,
 *  or drop it. Only containers the report offers (running, same engine,
 *  claimed by no other source) are accepted as a new target. */
export async function updateBackupSource(input: {
  project: string;
  source: string;
  container?: string;
  remove?: boolean;
  dryRun: boolean;
}) {
  if (!!input.container === !!input.remove)
    throw new Error("Pass exactly one of --container <name> or --remove.");
  const policy = await hostPolicy(input.project);
  const current = policy.sources.find((s) => s.name === input.source);
  if (!current)
    throw new Error(
      `${input.project} has no backup source named ${input.source}. Sources: ${policy.sources.map((s) => s.name).join(", ")}.`,
    );
  let change: PolicyChange;
  if (input.remove) {
    change = policyWithout(policy, [input.source]);
    if (change.action === "deregister")
      throw new Error(
        `${input.source} is ${input.project}'s last source. Run hatchkit backup deregister --project ${input.project} instead.`,
      );
  } else {
    const report = await fetchSourceReport(input.project);
    const row = report.sources.find((r) => r.source === input.source);
    if (row?.state === "ok")
      throw new Error(
        `${input.source} still resolves to ${row.container}; nothing to retarget. Remove it first if the database changed.`,
      );
    const target = row?.candidates?.find((c) => c.container === input.container);
    if (!target)
      throw new Error(
        `${input.container} is not a running, unclaimed ${current.kind} container on the backup host. Candidates: ${
          (row?.candidates ?? []).map((c) => c.container).join(", ") || "none"
        }.`,
      );
    change = {
      project: input.project,
      action: "replace",
      before: policy,
      after: {
        ...policy,
        sources: policy.sources.map((s) =>
          s.name === input.source ? { ...s, selector: target.selector } : s,
        ),
      },
      removedSources: [],
    };
  }
  if (input.dryRun) return { ...change, applied: false };
  return { ...change, applied: true, host: await applyPolicyChange(change) };
}

/** `backup deregister`: drop a whole project from the schedule. */
export async function deregisterBackupProject(input: { project: string; dryRun: boolean }) {
  const policy = await hostPolicy(input.project);
  const report = await fetchSourceReport(input.project);
  const change = policyWithout(
    policy,
    policy.sources.map((s) => s.name),
  );
  const live = report.sources.filter((r) => r.state === "ok").map((r) => r.source);
  const result = {
    ...change,
    // Deregistering live data is allowed (it is an explicit command), but say so.
    stillRunning: live,
    snapshotsKept: true,
  };
  if (input.dryRun) return { ...result, applied: false };
  return { ...result, applied: true, host: await applyPolicyChange(change) };
}

/** Registered sources that read anything under `uuids`. [] when backups
 *  are not configured; `error` when the host could not be read. */
export async function backupSourcesReading(
  uuids: string[],
): Promise<{ rows: SourceRow[]; error?: string }> {
  try {
    backupProvider();
  } catch {
    return { rows: [] };
  }
  try {
    const report = await fetchSourceReport();
    return { rows: report.sources.filter((row) => sourceReferences(row, uuids)) };
  } catch (error) {
    return { rows: [], error: (error as Error).message };
  }
}

/**
 * After a command deleted Coolify resources: drop the backup sources that
 * read them, but only the ones the host confirms are gone. Sources that
 * still resolve stay registered (a delete that did not finish must not
 * stop backups). Never throws; returns the lines to print.
 */
export async function reconcileBackupsAfterRemoval(input: {
  uuids: string[];
  dryRun: boolean;
  /** Wait for Coolify's asynchronous container teardown. */
  settleMs?: number;
}): Promise<{ lines: string[]; changes: PolicyChange[]; failed: boolean }> {
  const lines: string[] = [];
  try {
    backupProvider();
  } catch {
    return { lines, changes: [], failed: false };
  }
  const uuids = input.uuids.filter(Boolean);
  if (uuids.length === 0) return { lines, changes: [], failed: false };
  try {
    let affected: SourceRow[] = [];
    const deadline = Date.now() + (input.settleMs ?? 0);
    for (;;) {
      const report = await fetchSourceReport();
      affected = report.sources.filter((row) => sourceReferences(row, uuids));
      if (affected.every((row) => row.state === "missing") || Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 5_000));
    }
    if (affected.length === 0) return { lines, changes: [], failed: false };
    const changes: PolicyChange[] = [];
    for (const project of [...new Set(affected.map((r) => r.project))]) {
      const rows = affected.filter((r) => r.project === project);
      for (const row of rows.filter((r) => r.state !== "missing"))
        lines.push(
          `Backup source ${project}/${row.source} still resolves on the host; left registered. Check later: hatchkit backup sources --project ${project}`,
        );
      const gone = rows.filter((r) => r.state === "missing").map((r) => r.source);
      if (gone.length === 0) continue;
      const change = policyWithout(await hostPolicy(project), gone);
      changes.push(change);
      const what =
        change.action === "deregister"
          ? `${project} deregistered from backups (snapshots stay in the bucket)`
          : `backup source(s) ${gone.join(", ")} removed from ${project}`;
      if (input.dryRun) {
        lines.push(`Would be applied: ${what}.`);
      } else {
        await applyPolicyChange(change);
        lines.push(`Applied: ${what}.`);
      }
    }
    return { lines, changes, failed: false };
  } catch (error) {
    lines.push(
      `Couldn't update backup sources: ${(error as Error).message}`,
      "Check and fix by hand: hatchkit backup sources --json",
    );
    return { lines, changes: [], failed: true };
  }
}
