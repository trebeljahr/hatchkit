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
 *
 * With several backup hosts, a project lives in exactly one host's
 * policy: two hosts writing one restic repository would each prune the
 * other's snapshots. A command finds the project's host by asking every
 * host (or takes `--host`), and registering on another host removes the
 * project from the old one in the same step.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type BackupHost, backupHost, backupHostExec, backupHosts } from "./provider.js";
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
  /** The backup host whose policy holds the project. */
  host?: string;
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
  /** The hosts that answered. */
  hosts: string[];
  sources: SourceRow[];
  stale: SourceRow[];
  /** Hosts that could not be read. A report with no host read throws. */
  errors: { host: string; error: string }[];
}

function template(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../templates/backups/${name}`, import.meta.url)),
    "utf8",
  );
}

/** Run the bundled runner.py with `args`, the script itself on stdin. */
async function hostRunner(host: BackupHost, args: string[]): Promise<string> {
  for (const arg of args) {
    if (!/^[a-z0-9_-]+$/.test(arg)) throw new Error("Unsafe runner argument.");
  }
  return backupHostExec(host, `python3 - ${args.join(" ")}`, template("runner.py"), 60_000);
}

/** Run the bundled register.py next to the installed runner, payload on stdin. */
async function hostRegister(
  host: BackupHost,
  mode: "add" | "replace" | "remove",
  payload: unknown,
) {
  const script = Buffer.from(template("register.py")).toString("base64");
  return JSON.parse(
    await backupHostExec(
      host,
      `cd /opt/hatchkit-backups && python3 -c 'import base64,sys;sys.argv=["register.py","${mode}"];exec(base64.b64decode("${script}"))'`,
      JSON.stringify(payload),
    ),
  ) as Record<string, unknown>;
}

export function hostRegisterProject(host: BackupHost, project: BackupProject) {
  return hostRegister(host, "add", project) as Promise<{
    project: string;
    registered: boolean;
    existing: boolean;
  }>;
}

/** The policy exactly as the host holds it; the guard for every change. */
export async function hostPolicy(host: BackupHost, project: string): Promise<BackupProject> {
  backupProjectName(project);
  const plan = JSON.parse(await hostRunner(host, ["plan", "--project", project])) as {
    projects: BackupProject[];
  };
  const policy = plan.projects.find((p) => p.name === project);
  if (!policy) throw new Error(`${project} is not registered for backups on ${host.name}.`);
  return policy;
}

// A host without /etc/hatchkit-backups/config.json is configured locally
// but not installed yet: it holds no project.
const PROJECTS = `import json,pathlib
path=pathlib.Path('/etc/hatchkit-backups/config.json')
print(json.dumps({'installed':path.exists(),'projects':json.loads(path.read_text())['projects'] if path.exists() else []}))
`;

/** Read-only: every policy `host` holds, exactly as stored. */
export async function hostProjects(
  host: BackupHost,
): Promise<{ installed: boolean; projects: BackupProject[] }> {
  const script = Buffer.from(PROJECTS).toString("base64");
  return JSON.parse(
    await backupHostExec(host, `python3 -c 'import base64;exec(base64.b64decode("${script}"))'`),
  );
}

export interface ProjectLocation {
  host: BackupHost;
  policy: BackupProject;
}

/** Every host whose policy holds `project`. Throws when a host cannot be
 *  read: where a project lives is known only once every host answered. */
export async function locateBackupProject(project: string): Promise<ProjectLocation[]> {
  backupProjectName(project);
  const hosts = backupHosts();
  const answers = await Promise.allSettled(hosts.map((host) => hostProjects(host)));
  const found: ProjectLocation[] = [];
  answers.forEach((answer, i) => {
    if (answer.status === "rejected")
      throw new Error(
        `Couldn't read backup host ${hosts[i].name} to find ${project}'s host: ${(answer.reason as Error).message} Pass --host <name> to skip the lookup.`,
      );
    const policy = answer.value.projects.find((p) => p.name === project);
    if (policy) found.push({ host: hosts[i], policy });
  });
  return found;
}

/** `--host`, the only host, or the one host whose policy holds `project`. */
export async function projectHost(project: string, name?: string): Promise<BackupHost> {
  if (name) return backupHost(name);
  const hosts = backupHosts();
  if (hosts.length === 1) return hosts[0];
  const found = await locateBackupProject(project);
  if (found.length === 1) return found[0].host;
  if (found.length === 0)
    throw new Error(
      `${project} is not registered on any backup host (${hosts.map((h) => h.name).join(", ")}). Pass --host <name>.`,
    );
  throw new Error(
    `${project} is registered on ${found.map((f) => f.host.name).join(" and ")}, and a project belongs to one host. Deregister it from the wrong one: hatchkit backup deregister --project ${project} --host <name> --dry-run`,
  );
}

/** Read-only: resolve every registered source on one host, the project's
 *  host, or every host. Unreadable hosts land in `errors`; throws only
 *  when no host answered. */
export async function fetchSourceReport(project?: string, host?: string): Promise<SourceReport> {
  if (project) backupProjectName(project);
  const hosts = host ? [backupHost(host)] : project ? [await projectHost(project)] : backupHosts();
  const answers = await Promise.allSettled(
    hosts.map(async (h) => {
      const raw = JSON.parse(
        await hostRunner(h, ["sources", ...(project ? ["--project", project] : [])]),
      ) as { sources: SourceRow[] };
      return raw.sources.map((row) => ({ ...row, host: h.name }));
    }),
  );
  const errors: SourceReport["errors"] = [];
  const rows: SourceRow[] = [];
  const read: string[] = [];
  answers.forEach((answer, i) => {
    if (answer.status === "fulfilled") {
      read.push(hosts[i].name);
      rows.push(...answer.value);
    } else errors.push({ host: hosts[i].name, error: (answer.reason as Error).message });
  });
  if (read.length === 0) {
    if (errors.length === 1) throw new Error(errors[0].error);
    throw new Error(errors.map((e) => `${e.host}: ${e.error}`).join("; "));
  }
  const sources = attachFixes(rows, { hostFlag: backupHosts().length > 1 });
  return {
    hosts: read,
    sources,
    stale: sources.filter((row) => row.state !== "ok"),
    errors,
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

/** Pure: decide the fix for each stale row. `hostFlag` names the row's
 *  host in every command, so a fix needs no lookup across hosts. */
export function attachFixes(rows: SourceRow[], opts: { hostFlag?: boolean } = {}): SourceRow[] {
  return rows.map((row) => {
    if (row.state === "ok") return row;
    const on = opts.hostFlag && row.host ? ` --host ${row.host}` : "";
    const siblings = rows.filter((r) => r.project === row.project && r.host === row.host);
    const allStale = siblings.every((r) => r.state !== "ok");
    const remove =
      siblings.length === 1 || allStale
        ? {
            action: "deregister" as const,
            args: `deregister --project ${row.project}${on}`,
            summary:
              siblings.length === 1
                ? `${row.project}'s only backup source is gone. Deregister the project; its snapshots stay in the bucket.`
                : `None of ${row.project}'s backup sources exist any more. Deregister the project; its snapshots stay in the bucket.`,
          }
        : {
            action: "remove-source" as const,
            args: `update-source --project ${row.project} --source ${row.source} --remove${on}`,
            summary: `Drop ${row.source} from ${row.project}'s backups; the other sources keep running.`,
          };
    const retarget = (c: SourceCandidate) =>
      `update-source --project ${row.project} --source ${row.source} --container ${c.container}${on}`;
    let fix: SourceFix;
    if (row.state === "ambiguous") {
      const options = row.candidates ?? [];
      fix = {
        action: "review",
        summary: `${row.source} matches ${row.matches} running containers; pin it to one.`,
        command: options[0]
          ? cmd(retarget(options[0]))
          : cmd(`sources --project ${row.project}${on}`),
        preview: options[0]
          ? cmd(`${retarget(options[0])} --dry-run`)
          : cmd(`sources --project ${row.project}${on}`),
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

/** Pure: is `row` a files source whose every path lies inside one of
 *  these Docker volumes?
 *
 *  `migrate-runtime --carry-volume` mounts a compose app's volume on its
 *  replacement by name. A source that reads the volume by host path
 *  (`/var/lib/docker/volumes/<name>/_data/…`) reads the same bytes
 *  before, during and after the move, so it neither blocks the move nor
 *  needs repointing. A container selector is never this: it names the
 *  compose container, which the move stops. */
export function readsOnlyCarriedVolumes(row: SourceRow, dockerVolumes: string[]): boolean {
  if (row.kind !== "files" || row.selector || row.container) return false;
  const paths = row.paths ?? [];
  return (
    paths.length > 0 &&
    paths.every((path) =>
      dockerVolumes.some(
        (volume) =>
          volume && (path.endsWith(`/volumes/${volume}`) || path.includes(`/volumes/${volume}/`)),
      ),
    )
  );
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

export async function applyPolicyChange(host: BackupHost, change: PolicyChange) {
  return change.action === "deregister"
    ? hostRegister(host, "remove", { name: change.project, expected: change.before })
    : hostRegister(host, "replace", { project: change.after, expected: change.before });
}

/** `backup update-source`: point one source at another running container,
 *  or drop it. Only containers the report offers (running, same engine,
 *  claimed by no other source) are accepted as a new target. */
export async function updateBackupSource(input: {
  project: string;
  source: string;
  container?: string;
  remove?: boolean;
  host?: string;
  dryRun: boolean;
}) {
  if (!!input.container === !!input.remove)
    throw new Error("Pass exactly one of --container <name> or --remove.");
  const host = await projectHost(input.project, input.host);
  const policy = await hostPolicy(host, input.project);
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
    const report = await fetchSourceReport(input.project, host.name);
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
  if (input.dryRun) return { ...change, backupHost: host.name, applied: false };
  return {
    ...change,
    backupHost: host.name,
    applied: true,
    host: await applyPolicyChange(host, change),
  };
}

/** `backup deregister`: drop a whole project from the schedule. */
export async function deregisterBackupProject(input: {
  project: string;
  host?: string;
  dryRun: boolean;
}) {
  const host = await projectHost(input.project, input.host);
  const policy = await hostPolicy(host, input.project);
  const report = await fetchSourceReport(input.project, host.name);
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
    backupHost: host.name,
  };
  if (input.dryRun) return { ...result, applied: false };
  return { ...result, applied: true, host: await applyPolicyChange(host, change) };
}

/** Registered sources, on every host, that read anything under `uuids`.
 *  [] when backups are not configured; `error` when a host could not be
 *  read. */
export async function backupSourcesReading(
  uuids: string[],
): Promise<{ rows: SourceRow[]; error?: string }> {
  try {
    backupHosts();
  } catch {
    return { rows: [] };
  }
  try {
    const report = await fetchSourceReport();
    return {
      rows: report.sources.filter((row) => sourceReferences(row, uuids)),
      ...(report.errors.length
        ? { error: report.errors.map((e) => `${e.host}: ${e.error}`).join("; ") }
        : {}),
    };
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
  /** Docker volumes that outlive the removed resource because another
   *  app mounts them now. Sources reading only these stay registered
   *  whatever the host reports: dropping one would end the backup of
   *  live data. */
  carriedVolumes?: string[];
}): Promise<{ lines: string[]; changes: PolicyChange[]; failed: boolean }> {
  const lines: string[] = [];
  const carried = input.carriedVolumes ?? [];
  try {
    backupHosts();
  } catch {
    return { lines, changes: [], failed: false };
  }
  const uuids = input.uuids.filter(Boolean);
  if (uuids.length === 0) return { lines, changes: [], failed: false };
  try {
    let affected: SourceRow[] = [];
    let kept: SourceRow[] = [];
    let errors: SourceReport["errors"] = [];
    const deadline = Date.now() + (input.settleMs ?? 0);
    for (;;) {
      const report = await fetchSourceReport();
      errors = report.errors;
      const reading = report.sources.filter((row) => sourceReferences(row, uuids));
      kept = reading.filter((row) => readsOnlyCarriedVolumes(row, carried));
      affected = reading.filter((row) => !readsOnlyCarriedVolumes(row, carried));
      if (affected.every((row) => row.state === "missing") || Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 5_000));
    }
    for (const row of kept)
      lines.push(
        row.state === "ok"
          ? `Backup source ${row.project}/${row.source} reads the carried volume; left registered.`
          : `Backup source ${row.project}/${row.source} reads a carried volume, but the host no longer finds ${(row.missingPaths ?? []).join(", ") || "its paths"}. Left registered; check now: hatchkit backup sources --project ${row.project}`,
      );
    for (const { host, error } of errors)
      lines.push(
        `Couldn't read backup host ${host}: ${error}`,
        `Check and fix by hand: hatchkit backup sources --host ${host} --json`,
      );
    const failed = errors.length > 0;
    if (affected.length === 0) return { lines, changes: [], failed };
    const changes: PolicyChange[] = [];
    for (const project of [...new Set(affected.map((r) => r.project))]) {
      const rows = affected.filter((r) => r.project === project);
      const host = backupHost(rows[0].host);
      for (const row of rows.filter((r) => r.state !== "missing"))
        lines.push(
          `Backup source ${project}/${row.source} still resolves on the host; left registered. Check later: hatchkit backup sources --project ${project}`,
        );
      const gone = rows.filter((r) => r.state === "missing").map((r) => r.source);
      if (gone.length === 0) continue;
      const change = policyWithout(await hostPolicy(host, project), gone);
      changes.push(change);
      const what =
        change.action === "deregister"
          ? `${project} deregistered from backups (snapshots stay in the bucket)`
          : `backup source(s) ${gone.join(", ")} removed from ${project}`;
      if (input.dryRun) {
        lines.push(`Would be applied: ${what}.`);
      } else {
        await applyPolicyChange(host, change);
        lines.push(`Applied: ${what}.`);
      }
    }
    return { lines, changes, failed };
  } catch (error) {
    lines.push(
      `Couldn't update backup sources: ${(error as Error).message}`,
      "Check and fix by hand: hatchkit backup sources --json",
    );
    return { lines, changes: [], failed: true };
  }
}
