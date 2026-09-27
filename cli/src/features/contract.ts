/*
 * cli/src/features/contract.ts — the shared mechanism every opt-in
 * feature is built on.
 *
 * A "feature" is a unit of scaffolding a user can choose: `hatchkit
 * create` offers it at scaffold time and `hatchkit update` can add it
 * to an already-scaffolded project later. The second half is the hard
 * part. By the time `update` runs, the project is somebody's working
 * repo: the files a feature wants to touch have been edited, the
 * feature may already be half-present from an earlier run, and a
 * `--dry-run` has to describe the whole change without performing any
 * of it.
 *
 * This module holds the four things that make that tractable, so a
 * feature author writes the feature and not the plumbing:
 *
 *   1. {@link FeatureDefinition} — a declarative registration, so
 *      adding a feature is adding one object rather than editing a
 *      dozen switch statements.
 *   2. {@link expandFeatureSelection} — prerequisite closure and a
 *      deterministic apply order, so a feature can say "I need this
 *      other feature" instead of documenting it in prose.
 *   3. {@link FeatureLedger} — every filesystem mutation a feature
 *      makes, through one object that knows whether this is a dry run
 *      and records what happened either way.
 *   4. Edit primitives that are safe to run twice and safe to run over
 *      a file a person has changed: {@link FeatureLedger.writeIfChanged},
 *      {@link FeatureLedger.ensureManagedBlock},
 *      {@link FeatureLedger.ensureLine},
 *      {@link FeatureLedger.mergePackageJson}.
 *
 * The full authoring guide — including which of these to reach for and
 * why — is `docs/feature-authoring.md`. The worked example is the
 * `signing` feature in this directory.
 *
 * ============================================================
 * THE TWO INVARIANTS
 * ============================================================
 *
 * · **Additive.** A feature adds; it never removes. Removal is a
 *   manual operation, because hatchkit cannot tell the difference
 *   between scaffolding it wrote and code the user built on top of it.
 *   `hatchkit update` refuses feature removal for this reason.
 *
 * · **Idempotent.** Applying a feature to a project that already has
 *   it changes nothing and reports nothing as written. This is not a
 *   nicety: `update` re-applies every selected feature on every run, so
 *   a non-idempotent feature corrupts a project a little more each
 *   time. Every primitive below compares before it writes, and a
 *   feature that reaches around them for a bare `writeFileSync` breaks
 *   both the guarantee and the dry run.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Feature, Surface } from "../prompts.js";
import type { ProjectIdentifiers } from "../scaffold/identifiers.js";
import type { ProjectManifest } from "../scaffold/manifest.js";
import { KNOWN_FEATURES } from "../utils/flags.js";

export type FeatureId = Feature;

/* ================================================================== */
/* Ledger                                                             */
/* ================================================================== */

/** What a single filesystem operation did.
 *
 *  `would-*` values are what a dry run produces. They carry the same
 *  information as their real counterparts, so a caller can print one
 *  summary for both modes rather than branching. */
export type FileAction =
  | "written"
  | "unchanged"
  | "removed"
  | "absent"
  | "conflict"
  | "would-write"
  | "would-remove";

export interface LedgerEntry {
  /** Project-relative path, forward slashes. */
  file: string;
  action: FileAction;
  /** Which feature performed it. */
  feature?: FeatureId | string;
  /** Present on `conflict`: what hatchkit wanted to set, and what the
   *  user's file says instead. */
  detail?: string;
}

/**
 * The single choke point for feature filesystem mutations.
 *
 * `--dry-run` is checked here and nowhere else. A feature never asks
 * whether this is a dry run; it calls the same methods either way and
 * the ledger decides whether to touch the disk. That is deliberate:
 * when every writer checked its own flag, adding a writer meant
 * remembering to check, and the ones that forgot were only discovered
 * by a dry run that changed the user's files.
 */
export class FeatureLedger {
  readonly entries: LedgerEntry[] = [];
  private currentFeature?: FeatureId | string;

  constructor(
    readonly projectDir: string,
    readonly dryRun: boolean,
  ) {}

  /** Tag subsequent entries with a feature id, so a combined run can be
   *  reported per feature. */
  scopeTo(feature: FeatureId | string | undefined): void {
    this.currentFeature = feature;
  }

  private record(file: string, action: FileAction, detail?: string): FileAction {
    this.entries.push({ file, action, feature: this.currentFeature, detail });
    return action;
  }

  private abs(rel: string): string {
    return join(this.projectDir, rel);
  }

  /** Read a project file, or undefined when it is absent. */
  read(rel: string): string | undefined {
    const abs = this.abs(rel);
    if (!existsSync(abs)) return undefined;
    return readFileSync(abs, "utf-8");
  }

  exists(rel: string): boolean {
    return existsSync(this.abs(rel));
  }

  /**
   * Write `content` to `rel`, but only when it differs from what is
   * already there.
   *
   * This is the workhorse for files a feature OWNS outright — generated
   * workflows, generated config. It is idempotent by construction: a
   * second identical apply reports `unchanged` and writes nothing, so
   * the file's mtime does not churn and `git status` stays clean.
   *
   * It is NOT for files a user edits. Use
   * {@link ensureManagedBlock} or {@link edit} for those — this method
   * overwrites, and a user's change to an owned file is lost on the
   * next `update`. Owned files should say so in a header comment.
   */
  writeIfChanged(rel: string, content: string): FileAction {
    const abs = this.abs(rel);
    if (existsSync(abs) && readFileSync(abs, "utf-8") === content) {
      return this.record(rel, "unchanged");
    }
    if (this.dryRun) return this.record(rel, "would-write");
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf-8");
    return this.record(rel, "written");
  }

  /**
   * Copy a file from OUTSIDE the project (the `starter/` template) into
   * it, byte for byte, when the destination is not already there.
   *
   * {@link writeIfChanged} cannot do this job for two kinds of file that
   * a feature nonetheless ships:
   *
   *  · **Binary.** It round-trips content through a UTF-8 string, which
   *    corrupts a PNG. The mobile feature's `resources/icon.png` is the
   *    1024px source every launcher icon is generated from.
   *  · **Executable.** `writeFileSync` creates a 0644 file, so a shell
   *    script arrives without its `+x` bit and the script that invokes
   *    it fails with EACCES. `cpSync` carries the source's mode.
   *
   * Copy-IF-ABSENT rather than write-if-changed, because the files this
   * hands over are source the user then edits — a bridge module, a build
   * script. Overwriting them on the next `update` would silently undo
   * their work, which is the same trap {@link writeIfChanged} documents.
   * A destination that exists is therefore `unchanged`, never compared.
   *
   * A missing SOURCE is `absent`, not an error: the path list is shared
   * with the create-time strip, and a path that only ever exists after a
   * generator run (the `ios/` and `android/` trees) has no template copy
   * to hand over.
   */
  copyIfAbsent(rel: string, sourceAbs: string): FileAction {
    const abs = this.abs(rel);
    if (existsSync(abs)) return this.record(rel, "unchanged");
    if (!existsSync(sourceAbs)) return this.record(rel, "absent");
    if (this.dryRun) return this.record(rel, "would-write");
    mkdirSync(dirname(abs), { recursive: true });
    cpSync(sourceAbs, abs);
    return this.record(rel, "written");
  }

  /** Delete a path. Features do not call this during `update` — see the
   *  additive invariant — but `create` uses it to strip the scaffolding
   *  of unselected features out of the copied starter. */
  remove(rel: string): FileAction {
    const abs = this.abs(rel);
    if (!existsSync(abs)) return this.record(rel, "absent");
    if (this.dryRun) return this.record(rel, "would-remove");
    rmSync(abs, { recursive: true, force: true });
    return this.record(rel, "removed");
  }

  /**
   * Transform a file through a pure function.
   *
   * The transform must be a fixed point: `fn(fn(x)) === fn(x)`. That is
   * what makes a re-run report `unchanged` instead of, say, appending a
   * second copy of an import. In practice this means anchoring on what
   * the edit produces rather than on what it consumes — check for the
   * result before inserting, not just for the insertion point.
   *
   * A missing file is `absent`, not an error: a feature that edits a
   * file another feature owns must tolerate that feature being off.
   */
  edit(rel: string, fn: (content: string) => string): FileAction {
    const before = this.read(rel);
    if (before === undefined) return this.record(rel, "absent");
    const after = fn(before);
    if (after === before) return this.record(rel, "unchanged");
    if (this.dryRun) return this.record(rel, "would-write");
    writeFileSync(this.abs(rel), after, "utf-8");
    return this.record(rel, "written");
  }

  /**
   * Maintain a marker-delimited region inside a file the user also
   * edits.
   *
   * ```
   *   # hatchkit:begin desktop-scripts
   *   …hatchkit's lines…
   *   # hatchkit:end desktop-scripts
   * ```
   *
   * Everything outside the markers belongs to the user and is never
   * touched. Everything inside belongs to hatchkit and is replaced
   * wholesale on each apply — which is the whole point: it lets a
   * feature CHANGE what it contributed, in a later CLI version, without
   * either duplicating it or guessing which of the surrounding lines
   * were once its own.
   *
   * The contract has to be stated in the file, so the block is emitted
   * with a one-line notice that edits inside it are overwritten. A user
   * who needs to change one of those lines moves it out of the block.
   *
   * When the markers are absent the block is appended, or inserted
   * after `anchor` when one is given and found.
   */
  ensureManagedBlock(
    rel: string,
    blockId: string,
    body: string,
    opts: {
      /** Line-comment prefix for the host language. Inferred from the
       *  file extension when omitted. */
      commentPrefix?: string;
      /** Insert after the first line containing this string, when the
       *  block does not exist yet. Appended at end of file otherwise. */
      anchor?: string;
      /** Create the file when it does not exist. Off by default: a
       *  feature editing somebody else's file should no-op when that
       *  file is not there. */
      create?: boolean;
    } = {},
  ): FileAction {
    const prefix = opts.commentPrefix ?? inferCommentPrefix(rel);
    const begin = `${prefix} hatchkit:begin ${blockId}`;
    const end = `${prefix} hatchkit:end ${blockId}`;
    const notice = `${prefix} Managed by hatchkit — edits between these markers are overwritten.`;
    const trimmedBody = body.replace(/\n+$/, "");
    const block = `${begin}\n${notice}\n${trimmedBody}\n${end}`;

    const existing = this.read(rel);
    if (existing === undefined) {
      if (!opts.create) return this.record(rel, "absent");
      return this.writeIfChanged(rel, `${block}\n`);
    }

    const beginIdx = existing.indexOf(begin);
    const endIdx = existing.indexOf(end);
    if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
      const before = existing.slice(0, beginIdx);
      const after = existing.slice(endIdx + end.length);
      return this.writeIfChanged(rel, `${before}${block}${after}`);
    }
    if (beginIdx !== -1 || endIdx !== -1) {
      // Exactly one marker survived. Repairing by guessing where the
      // other one belonged would delete user lines, so stop and say so.
      return this.record(
        rel,
        "conflict",
        `hatchkit:${beginIdx !== -1 ? "begin" : "end"} marker for "${blockId}" has no matching partner. Restore or remove both markers, then re-run.`,
      );
    }

    if (opts.anchor) {
      const lines = existing.split("\n");
      const at = lines.findIndex((l) => l.includes(opts.anchor as string));
      if (at !== -1) {
        lines.splice(at + 1, 0, block);
        return this.writeIfChanged(rel, lines.join("\n"));
      }
    }
    const sep = existing.endsWith("\n") ? "" : "\n";
    return this.writeIfChanged(rel, `${existing}${sep}${block}\n`);
  }

  /**
   * Add a single line to a file unless it is already there.
   *
   * For `.gitignore`, `.dockerignore` and the like, where a managed
   * block is more ceremony than the change deserves and the line itself
   * is the idempotency key.
   */
  ensureLine(rel: string, line: string, opts: { create?: boolean } = {}): FileAction {
    const existing = this.read(rel);
    if (existing === undefined) {
      if (!opts.create) return this.record(rel, "absent");
      return this.writeIfChanged(rel, `${line}\n`);
    }
    if (existing.split("\n").some((l) => l.trim() === line.trim())) {
      return this.record(rel, "unchanged");
    }
    const sep = existing.endsWith("\n") || existing === "" ? "" : "\n";
    return this.writeIfChanged(rel, `${existing}${sep}${line}\n`);
  }

  /**
   * Merge scripts and dependencies into a `package.json`, add-only.
   *
   * An entry that is absent is added. An entry that is present with the
   * SAME value is left alone. An entry that is present with a DIFFERENT
   * value is a `conflict`: it is reported and not overwritten, because
   * a changed script is the most common thing a user customises and
   * silently reverting it on every `update` is the worst version of
   * this bug — it undoes their work without ever failing.
   *
   * `force` overwrites anyway, for the cases where the value is
   * genuinely hatchkit's to set (a version pin it also generated).
   */
  mergePackageJson(
    rel: string,
    patch: {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    },
    opts: { force?: boolean } = {},
  ): FileAction {
    const raw = this.read(rel);
    if (raw === undefined) return this.record(rel, "absent");

    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      return this.record(rel, "conflict", `not valid JSON: ${(err as Error).message}`);
    }

    const conflicts: string[] = [];
    let changed = false;

    for (const section of ["scripts", "dependencies", "devDependencies"] as const) {
      const additions = patch[section];
      if (!additions) continue;
      const target = (pkg[section] as Record<string, string> | undefined) ?? {};
      for (const [key, value] of Object.entries(additions)) {
        const current = target[key];
        if (current === value) continue;
        if (current !== undefined && !opts.force) {
          conflicts.push(`${section}.${key}: keeping "${current}", not setting "${value}"`);
          continue;
        }
        target[key] = value;
        changed = true;
      }
      if (Object.keys(target).length > 0) pkg[section] = target;
    }

    if (conflicts.length > 0) this.record(rel, "conflict", conflicts.join("; "));
    if (!changed) return conflicts.length > 0 ? "conflict" : this.record(rel, "unchanged");

    const serialised = `${JSON.stringify(pkg, null, 2)}\n`;
    if (this.dryRun) return this.record(rel, "would-write");
    writeFileSync(this.abs(rel), serialised, "utf-8");
    return this.record(rel, "written");
  }

  /**
   * Record that the feature deliberately did NOT change a file.
   *
   * `ensureManagedBlock` and `mergePackageJson` raise conflicts on their own,
   * but a feature editing through {@link edit} can also find that a file is
   * no longer one it knows how to edit — anchors moved, because the user
   * rewrote it. Leaving that silent is the failure this class exists to
   * prevent: `unchanged` would be indistinguishable from "already applied",
   * and the user would never learn that a piece of the feature is missing
   * from their project.
   *
   * `detail` is what they have to do by hand.
   */
  conflict(rel: string, detail: string): FileAction {
    return this.record(rel, "conflict", detail);
  }

  /** Entries grouped by action, for printing a run summary. */
  summary(): Record<FileAction, string[]> {
    const out = {
      written: [],
      unchanged: [],
      removed: [],
      absent: [],
      conflict: [],
      "would-write": [],
      "would-remove": [],
    } as Record<FileAction, string[]>;
    for (const e of this.entries) out[e.action].push(e.file);
    return out;
  }

  /** Conflicts must be surfaced to the user — they are the cases where
   *  hatchkit deliberately did not apply something. */
  conflicts(): LedgerEntry[] {
    return this.entries.filter((e) => e.action === "conflict");
  }

  /** True when this run would change (or did change) anything. */
  get touched(): boolean {
    return this.entries.some(
      (e) =>
        e.action === "written" ||
        e.action === "removed" ||
        e.action === "would-write" ||
        e.action === "would-remove",
    );
  }
}

/** Line-comment prefix by file extension. Used by
 *  {@link FeatureLedger.ensureManagedBlock} when the caller does not
 *  say. Anything unrecognised gets `#`, which is right for the ignore
 *  files, env files, YAML, Dockerfiles and shell scripts that make up
 *  most of what a feature edits. */
export function inferCommentPrefix(relPath: string): string {
  const lower = relPath.toLowerCase();
  if (
    /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|json5|gradle|kt|swift|rs|java|c|h|cpp|scss|less)$/.test(lower)
  ) {
    return "//";
  }
  if (/\.(sql)$/.test(lower)) return "--";
  return "#";
}

/* ================================================================== */
/* Feature definitions                                                */
/* ================================================================== */

/** What a feature needs in order to apply itself. */
export interface FeatureContext {
  /** Absolute path to the deployable directory — already resolved
   *  through `manifest.projectSubdir`, so a feature joins
   *  project-relative paths onto it without thinking about subdir
   *  layouts. */
  projectDir: string;
  /** Absolute path to the directory holding `.hatchkit.json`. The same
   *  as `projectDir` for a root-deployed project. */
  manifestDir: string;
  manifest: ProjectManifest;
  /** The project's frozen identifier set. A feature NEVER derives a
   *  name of its own — see `cli/src/scaffold/identifiers.ts`. */
  identifiers: ProjectIdentifiers;
  /** Whether this is a fresh scaffold or an addition to an existing
   *  project. A feature should need this rarely; when it does, it is
   *  usually to skip a prompt, not to change what it writes. */
  mode: "create" | "update";
  /** Every mutation goes through here. */
  ledger: FeatureLedger;
  /** Progress output. Goes to stdout in both real and dry runs. */
  log: (message: string) => void;
}

/**
 * What a feature needs in order to say what it WOULD write, without
 * writing it.
 *
 * The apply-time {@link FeatureContext} is a superset, so a feature can
 * use one function for both. Deliberately missing the ledger and the
 * log: nothing here may mutate or print.
 */
export type FeaturePlanContext = Pick<
  FeatureContext,
  "projectDir" | "manifestDir" | "manifest" | "identifiers"
>;

export interface FeatureDefinition {
  id: FeatureId;
  /** Label shown in the `create` / `update` feature picker. */
  title: string;
  /** One line under the label. */
  summary: string;
  /**
   * Features that must be present for this one to work.
   *
   * Declaring a prerequisite is not documentation — it is enforced.
   * {@link expandFeatureSelection} pulls prerequisites into the
   * selection automatically and orders the apply so a prerequisite runs
   * first. A feature may therefore assume, inside `apply`, that
   * everything it requires has already applied in this same run.
   *
   * Prefer a prerequisite over a runtime check. "If the desktop feature
   * happens to be on, also do X" spreads one feature's knowledge across
   * another's code and goes stale; `requires: ["desktop"]` does not.
   */
  requires?: FeatureId[];
  /**
   * Features that cannot be selected alongside this one, because they
   * produce the same artefact in incompatible ways (two shells both
   * claiming the desktop build outputs, say). Reported as a selection
   * error rather than resolved by a precedence rule — hatchkit does not
   * get to decide which of two things the user asked for they meant.
   */
  conflictsWith?: FeatureId[];
  /** Surfaces this feature makes sense on. A feature offered on a
   *  surface it cannot serve is a support question later. Omitted means
   *  every surface. */
  surfaces?: Surface[];
  /** Whether `hatchkit update` can add this to an existing project.
   *  A feature whose scaffold-time effect is a coarse strip of files
   *  across the tree cannot be re-added cleanly, and says so here
   *  rather than half-applying. */
  addableAfterScaffold: boolean;
  /**
   * Apply the feature. Must be additive and idempotent — see the
   * invariants at the top of this file. All writes go through
   * `ctx.ledger`; a feature that calls `node:fs` directly breaks
   * `--dry-run` silently.
   */
  apply(ctx: FeatureContext): void | Promise<void>;
  /**
   * The project-relative paths `apply` would write, for a dry run that
   * wants to itemise them.
   *
   * Optional, and a pure prediction: it must not touch the disk, because
   * `hatchkit update --dry-run` calls it INSTEAD of `apply`. That is the
   * point. Running a real `apply` against a dry ledger would be the
   * obvious way to itemise a feature's plan, and it is not safe in
   * general — `client-core` writes through `node:fs` in its strip and
   * rename helpers, and the server-platform kit carries a dry-run flag
   * of its own rather than deferring to the ledger. A dry run that
   * executed every apply would therefore write files on at least those
   * paths, which is the one thing `--dry-run` promises not to do.
   *
   * So a feature DECLARES its plan here, reading the same table its
   * `apply` reads. An absent implementation means "cannot say", and the
   * dry run prints the feature without a file list rather than an empty
   * one that looks authoritative.
   */
  plannedFiles?(ctx: FeaturePlanContext): readonly string[];
}

const REGISTRY = new Map<FeatureId, FeatureDefinition>();

/** Register a feature. Call once per feature at module load. */
/** Every id the CLI recognises, registered here or applied elsewhere.
 *  `expandFeatureSelection` validates against this rather than against the
 *  registry, so a prerequisite naming a feature another writer applies is a
 *  true statement rather than an error. */
const KNOWN_FEATURE_IDS: ReadonlySet<FeatureId> = new Set(KNOWN_FEATURES);

export function registerFeature(def: FeatureDefinition): FeatureDefinition {
  const existing = REGISTRY.get(def.id);
  if (existing && existing !== def) {
    throw new Error(`Feature "${def.id}" is registered twice.`);
  }
  REGISTRY.set(def.id, def);
  return def;
}

export function getFeature(id: FeatureId): FeatureDefinition | undefined {
  return REGISTRY.get(id);
}

/** Registered features, in registration order. */
export function allFeatures(): FeatureDefinition[] {
  return [...REGISTRY.values()];
}

/** Test-suite helper: drop every registration. Never called by the CLI. */
export function resetFeatureRegistryForTests(): void {
  REGISTRY.clear();
}

/* ================================================================== */
/* Selection resolution                                               */
/* ================================================================== */

export interface ExpandedSelection {
  /** Everything to apply, prerequisites first. */
  ordered: FeatureId[];
  /** Features pulled in because something else required them. Worth
   *  telling the user about: they did not ask for these by name. */
  implied: FeatureId[];
  /** Blocking problems. When non-empty, `ordered` is not safe to use. */
  errors: string[];
}

/**
 * Close a user's selection over prerequisites and put it in apply
 * order.
 *
 * Order is a topological sort with a deterministic tie-break
 * (registration order), so the same selection always applies in the
 * same sequence. That matters more than it looks: two features that
 * both edit one file produce a different result depending on who goes
 * first, and a run whose order varies produces a repo whose diff varies
 * for no reason.
 *
 * Unknown ids and dependency cycles are reported, not thrown — the
 * caller decides whether to prompt again or exit.
 */
export function expandFeatureSelection(selected: readonly FeatureId[]): ExpandedSelection {
  const errors: string[] = [];
  const wanted = new Set<FeatureId>();
  /** Real feature ids that something requires but this registry does not
   *  apply — see `pull`. They are reported through `implied` so a picker
   *  still adds them, and left out of `ordered` because nothing here runs
   *  them. */
  const external = new Set<FeatureId>();
  const implied: FeatureId[] = [];

  const pull = (id: FeatureId, viaChain: FeatureId[]): void => {
    if (wanted.has(id) || external.has(id)) return;
    const def = REGISTRY.get(id);
    if (!def) {
      // A feature this registry does not APPLY is not automatically a
      // feature that does not EXIST. The server-platform trio
      // (`server-migrations`, `scheduler`, `public-api`) are real, offerable
      // ids in the `Feature` union that a different writer applies, so a
      // `requires` naming one is a true statement about a real prerequisite
      // — it just is not one this sort can order.
      //
      // Validate against the union, which is the actual set of ids, and let
      // the sort own only what it applies. Checking against the REGISTRY
      // instead reported `mcp`'s honest `requires: ["public-api"]` as
      // "Unknown feature", and — worse — did so even when the user had
      // selected `public-api` explicitly, so there was no way to satisfy it.
      // A typo is still caught, because a typo is not in the union either.
      if (KNOWN_FEATURE_IDS.has(id)) {
        external.add(id);
        return;
      }
      errors.push(
        `Unknown feature "${id}"${viaChain.length ? ` (required by ${viaChain.join(" → ")})` : ""}.`,
      );
      return;
    }
    wanted.add(id);
    for (const req of def.requires ?? []) {
      if (!wanted.has(req) && !selected.includes(req)) implied.push(req);
      pull(req, [...viaChain, id]);
    }
  };

  for (const id of selected) pull(id, []);

  for (const id of wanted) {
    const def = REGISTRY.get(id);
    for (const other of def?.conflictsWith ?? []) {
      if (wanted.has(other)) {
        errors.push(`Features "${id}" and "${other}" cannot be used together. Pick one.`);
      }
    }
  }

  // Deterministic topological sort. Candidates are considered in
  // registration order so equal-depth features never swap places
  // between runs.
  const order: FeatureId[] = [];
  const placed = new Set<FeatureId>();
  const registrationOrder = [...REGISTRY.keys()].filter((id) => wanted.has(id));
  let progress = true;
  while (placed.size < registrationOrder.length && progress) {
    progress = false;
    for (const id of registrationOrder) {
      if (placed.has(id)) continue;
      const reqs = (REGISTRY.get(id)?.requires ?? []).filter((r) => wanted.has(r));
      if (reqs.every((r) => placed.has(r))) {
        order.push(id);
        placed.add(id);
        progress = true;
      }
    }
  }
  if (placed.size < registrationOrder.length) {
    const stuck = registrationOrder.filter((id) => !placed.has(id));
    errors.push(`Circular feature prerequisites among: ${stuck.join(", ")}.`);
  }

  // Dedupe implied while preserving first-seen order.
  const impliedUnique = [...new Set(implied)].filter((id) => !selected.includes(id));

  return { ordered: order, implied: impliedUnique, errors };
}

/** Run a selection's features in order against one ledger. */
export async function applyFeatures(
  ordered: readonly FeatureId[],
  ctx: Omit<FeatureContext, "ledger"> & { ledger: FeatureLedger },
): Promise<void> {
  for (const id of ordered) {
    const def = REGISTRY.get(id);
    if (!def) continue;
    if (ctx.mode === "update" && !def.addableAfterScaffold) {
      ctx.log(
        `  skipped: ${def.title} — cannot be added to an existing project (${def.id}). Scaffold a new project with it, or copy the files by hand.`,
      );
      continue;
    }
    ctx.ledger.scopeTo(id);
    await def.apply(ctx);
  }
  ctx.ledger.scopeTo(undefined);
}
