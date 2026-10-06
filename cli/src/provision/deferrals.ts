/*
 * Deferrals — "I don't have that credential to hand right now."
 *
 * Most steps in `hatchkit create` / `adopt` / `add` configure something
 * OPTIONAL that needs a secret the user may not have on them: Stripe
 * keys, an R2 admin token, SES/Listmonk credentials, a GlitchTip auth
 * token, a Cloudflare DNS token, Google OAuth. Historically, answering
 * "no" at that prompt (or a provider returning 401 mid-run) blew up the
 * whole flow and the user had to start again from the top.
 *
 * The contract here is: declining an optional step is a FIRST-CLASS
 * OUTCOME, not an error.
 *
 *   · It never throws out of the parent flow.
 *   · It never reaches the rollback path — nothing was created, so
 *     there is nothing to undo (see `deploy/rollback.ts`; only genuinely
 *     fatal throws get that far).
 *   · It is recorded in `.hatchkit.json` under `deferred[]`, so
 *     `hatchkit status` can say "3 steps deferred" and
 *     `hatchkit add <project> <service>` / `hatchkit adopt --resume`
 *     can pick up exactly where the run left off.
 *   · It is echoed in the end-of-run summary with the exact follow-up
 *     command.
 *
 * Three kinds of deferral, all treated identically downstream:
 *   · `declined`    — user said no / later / left the answer empty.
 *   · `failed`      — provider call blew up (401, network, 5xx).
 *   · `unavailable` — the step can't apply to this project shape (e.g.
 *                     Plausible on a backend-only surface). Recorded so
 *                     the summary explains the omission rather than
 *                     leaving a silent gap.
 *
 * What is NOT deferrable: anything the run genuinely cannot continue
 * without (an invalid project name, a resource-conflict abort), plus
 * programmer errors. Those raise {@link FatalProvisionError} or are
 * detected by {@link isFatalProvisionError} and keep aborting.
 *
 * ============================================================
 * AUDIT: which prompts in create / adopt / add are deferrable
 * ============================================================
 *
 * OPTIONAL — declining is a clean skip, recorded here:
 *   · GlitchTip auth token            (service:glitchtip)
 *   · Plausible API key               (service:plausible)
 *   · SES IAM key + Listmonk token    (service:listmonk-ses)
 *   · Cloudflare R2 admin token       (service:s3)
 *   · Cloudflare DNS token + default
 *     forwarding inbox                (service:email)
 *   · Google OAuth + DNS token        (service:search-console)
 *   · Stripe master + per-project
 *     sk/pk pairs                     (stripe)
 *   · dotenvx key push to Coolify     (keys-push-coolify)
 *   · GitHub Pages wiring             (gh-pages)
 *   · GHCR pull credentials           (adopt: already a caveat, see adopt.ts)
 *   · Code signing certs              (explicit `hatchkit signing`, opt-in by
 *                                      construction — never blocks a run)
 *
 * REQUIRED — still aborts, because the flow produces a wrong or
 * unusable result without it:
 *   · Project name / domain validation      (FatalProvisionError)
 *   · Pre-existing-resource conflict under
 *     `failIfExists`                        (FatalProvisionError)
 *   · Where to write env (`resolveSurfaces`) — the answer decides
 *     whether anything can be written at all; declining it already has
 *     a first-class outcome (cache-only mode), not an error
 *   · GitHub + Coolify + Hetzner + DNS for a `--deploy` run — these
 *     are the deploy itself, not an optional add-on
 *   · Ctrl+C anywhere
 */

import chalk from "chalk";
import { readManifest, readManifestWithMigrationInfo, writeManifest } from "../scaffold/manifest.js";
import type { ProvisionService } from "./index.js";

/** Why a step didn't run. All three continue the flow; only the
 *  wording in the summary differs. */
export type DeferralKind = "declined" | "failed" | "unavailable";

export interface DeferredStep {
  /** Stable id. `service:<name>` for anything routed through
   *  `runProvision`; a bare slug (`stripe`) for the special-cased
   *  steps that live outside the service fan-out. Used as the dedupe
   *  key on re-runs and as the handle `resolveDeferredSteps` clears
   *  once the step finally succeeds. */
  key: string;
  /** Human label, e.g. "GlitchTip (error tracking)". */
  label: string;
  kind: DeferralKind;
  /** One-line explanation shown under the label. */
  reason: string;
  /** The exact command that completes this step later. */
  command: string;
  /** Extra commands / notes shown beneath `command` — typically the
   *  `hatchkit config add <provider>` that has to happen first. */
  hint?: string[];
  /** ISO timestamp of the most recent deferral of this step. */
  deferredAt: string;
}

/* ─────────────────────────────────────────────────────────────────── */
/*  Sentinels                                                          */
/* ─────────────────────────────────────────────────────────────────── */

/** Thrown by an optional step to say "the user opted out — skip me and
 *  keep going". Callers catch it via {@link isStepDeferral}; nothing
 *  else in the codebase should treat it as a failure. */
export class StepDeferredError extends Error {
  /** Structural marker so the check survives a duplicated module
   *  instance (tsx vs. dist, or two copies of the package). */
  readonly hatchkitDeferred = true as const;
  /** Which flavour of deferral this is. Defaults to `declined` (the
   *  user said no); pass `unavailable` for "this step can't apply to
   *  this project shape" so the summary words it correctly. */
  readonly kind: DeferralKind;
  constructor(reason: string, kind: DeferralKind = "declined") {
    super(reason);
    this.name = "StepDeferredError";
    this.kind = kind;
  }
}

/** Thrown when a step that *looked* optional turns out to be load-
 *  bearing. Escapes `runOptionalStep` untouched and aborts the run. */
export class FatalProvisionError extends Error {
  readonly hatchkitFatal = true as const;
  constructor(message: string) {
    super(message);
    this.name = "FatalProvisionError";
  }
}

/** Shorthand for `throw new StepDeferredError(reason)` in expression
 *  position. */
export function deferStep(reason: string, kind: DeferralKind = "declined"): never {
  throw new StepDeferredError(reason, kind);
}

export function isStepDeferral(err: unknown): err is StepDeferredError {
  if (err instanceof StepDeferredError) return true;
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { hatchkitDeferred?: unknown }).hatchkitDeferred === true
  );
}

/** Errors that must keep aborting the run even inside an optional step:
 *
 *   · Explicit {@link FatalProvisionError} (resource conflicts, invalid
 *     inputs — anything where continuing would produce a wrong result).
 *   · Ctrl+C. inquirer converts SIGINT into `ExitPromptError`; swallowing
 *     it would turn "user wants out" into "user deferred one step" and
 *     the run would grind on through every remaining prompt.
 *   · ReferenceError / SyntaxError — programmer errors, where masking
 *     the crash behind a friendly "you can finish this later" hides a
 *     real bug.
 *
 * Deliberately NOT in the list: `TypeError`. Node's `fetch` reports
 * every transport failure (DNS, connection refused, TLS) as
 * `TypeError: fetch failed`, which is exactly the "provider unreachable
 * mid-run" case that has to degrade into a deferral.
 */
export function isFatalProvisionError(err: unknown): boolean {
  if (err instanceof FatalProvisionError) return true;
  if (
    typeof err === "object" &&
    err !== null &&
    (err as { hatchkitFatal?: unknown }).hatchkitFatal === true
  ) {
    return true;
  }
  if (err instanceof ReferenceError || err instanceof SyntaxError) return true;
  if (err instanceof Error) {
    return (
      err.name === "ExitPromptError" ||
      err.name === "AbortPromptError" ||
      err.name === "CancelPromptError"
    );
  }
  return false;
}

/** Map a thrown value onto a deferral, or null when it must keep
 *  propagating. The single decision point every optional step routes
 *  through — keeping the fatal/deferrable split in one place instead of
 *  re-deciding it at ~15 call sites. */
export function classifyOptionalStepError(
  err: unknown,
): { kind: DeferralKind; reason: string } | null {
  if (isFatalProvisionError(err)) return null;
  if (isStepDeferral(err)) return { kind: err.kind ?? "declined", reason: err.message };
  const reason = err instanceof Error ? err.message : String(err);
  return { kind: "failed", reason };
}

/* ─────────────────────────────────────────────────────────────────── */
/*  Service metadata                                                   */
/* ─────────────────────────────────────────────────────────────────── */

const SERVICE_LABELS: Record<ProvisionService, string> = {
  glitchtip: "GlitchTip (error tracking)",
  plausible: "Plausible (web analytics)",
  "listmonk-ses": "Listmonk + SES (email)",
  s3: "S3 / R2 (object storage)",
  email: "Email forwarding (Cloudflare Email Routing)",
  "search-console": "Google Search Console",
};

/** Global provider whose credentials gate each service. Drives both the
 *  "set it up now?" gate and the `hatchkit config add …` hint printed
 *  next to the follow-up command. */
const SERVICE_SETUP_COMMANDS: Record<ProvisionService, string[]> = {
  glitchtip: ["hatchkit config add glitchtip"],
  plausible: ["hatchkit config add plausible"],
  "listmonk-ses": ["hatchkit config add ses", "hatchkit config add listmonk"],
  s3: ["hatchkit config add s3"],
  email: ["hatchkit config add dns"],
  "search-console": ["hatchkit config add search-console", "hatchkit config add dns"],
};

export function deferralKeyForService(service: ProvisionService): string {
  return `service:${service}`;
}

export function labelForService(service: ProvisionService): string {
  return SERVICE_LABELS[service] ?? service;
}

export function setupCommandsForService(service: ProvisionService): string[] {
  return SERVICE_SETUP_COMMANDS[service] ?? [];
}

/** The exact command that finishes a deferred service later. Mirrors
 *  the `hatchkit add` dispatcher, which is idempotent: services already
 *  present in the env files are refused rather than re-minted. */
export function followUpCommandForService(service: ProvisionService, project: string): string {
  return `hatchkit add ${project} ${service}`;
}

export function deferralForService(args: {
  service: ProvisionService;
  project: string;
  kind: DeferralKind;
  reason: string;
  /** Suppress the `hatchkit config add …` hints — used for
   *  `unavailable`, where no credential is missing. */
  withoutSetupHint?: boolean;
}): DeferredStep {
  const hint = args.withoutSetupHint ? [] : setupCommandsForService(args.service);
  return {
    key: deferralKeyForService(args.service),
    label: labelForService(args.service),
    kind: args.kind,
    reason: args.reason,
    command: followUpCommandForService(args.service, args.project),
    hint: hint.length > 0 ? hint : undefined,
    deferredAt: new Date().toISOString(),
  };
}

/** Steps that don't route through `runProvision`'s service fan-out but
 *  are just as deferrable. Stripe is the current member: the create
 *  flow wires it inline (it writes to both env files and mints webhook
 *  endpoints, which doesn't fit the `ProvisionService` env-bucket
 *  shape), and `hatchkit add <project> stripe` special-cases it the
 *  same way `signing` is special-cased. */
export const STANDALONE_STEP_KEYS = {
  stripe: "stripe",
} as const;

/** Generic builder for a deferrable step that isn't a
 *  {@link ProvisionService} — used by the create flow for the
 *  best-effort steps (dotenvx key push, GitHub Pages wiring) that
 *  already tolerated failure but had nowhere to record it. */
export function deferralForStep(args: {
  key: string;
  label: string;
  kind: DeferralKind;
  reason: string;
  command: string;
  hint?: string[];
}): DeferredStep {
  return {
    key: args.key,
    label: args.label,
    kind: args.kind,
    reason: args.reason,
    command: args.command,
    hint: args.hint && args.hint.length > 0 ? args.hint : undefined,
    deferredAt: new Date().toISOString(),
  };
}

export function deferralForStripe(args: {
  project: string;
  kind: DeferralKind;
  reason: string;
}): DeferredStep {
  return {
    key: STANDALONE_STEP_KEYS.stripe,
    label: "Stripe (payments)",
    kind: args.kind,
    reason: args.reason,
    command: `hatchkit add ${args.project} stripe`,
    hint: ["hatchkit config add stripe"],
    deferredAt: new Date().toISOString(),
  };
}

/* ─────────────────────────────────────────────────────────────────── */
/*  Collection                                                         */
/* ─────────────────────────────────────────────────────────────────── */

/** Merge freshly-deferred steps into a previously-recorded list.
 *  Deduped by `key`, newest wins — a re-run that defers the same step
 *  again refreshes the reason/timestamp instead of stacking duplicates.
 *  Order follows first-seen so the summary stays stable across runs. */
export function mergeDeferredSteps(
  existing: readonly DeferredStep[],
  incoming: readonly DeferredStep[],
): DeferredStep[] {
  const out: DeferredStep[] = [];
  const index = new Map<string, number>();
  for (const step of [...existing, ...incoming]) {
    const at = index.get(step.key);
    if (at === undefined) {
      index.set(step.key, out.length);
      out.push(step);
    } else {
      out[at] = step;
    }
  }
  return out;
}

/** Drop entries whose step has since completed. Called with the set of
 *  services a run actually configured, which is what makes a resume
 *  clean: finish the step, the deferral disappears. */
export function withoutDeferredSteps(
  existing: readonly DeferredStep[],
  keys: readonly string[],
): DeferredStep[] {
  const drop = new Set(keys);
  return existing.filter((step) => !drop.has(step.key));
}

/** Deferral keys for services hatchkit no longer provisions. Manifests
 *  written by older versions can still carry them; their follow-up
 *  command no longer exists, so they are dropped on read and on the
 *  next write instead of being shown as pending work. */
const RETIRED_DEFERRAL_KEYS: ReadonlySet<string> = new Set(["service:openpanel"]);

function withoutRetiredSteps(steps: readonly DeferredStep[]): DeferredStep[] {
  return steps.filter((step) => !RETIRED_DEFERRAL_KEYS.has(step.key));
}

/* ─────────────────────────────────────────────────────────────────── */
/*  Manifest persistence                                               */
/* ─────────────────────────────────────────────────────────────────── */

/** Read the recorded deferrals for a project. Returns `[]` for a
 *  project with no manifest (or an unreadable one) — a missing record
 *  means "nothing deferred", never an error. */
export function readDeferredSteps(projectDir: string | undefined): DeferredStep[] {
  if (!projectDir) return [];
  try {
    const manifest = readManifestWithMigrationInfo(projectDir)?.manifest;
    return manifest?.deferred ? withoutRetiredSteps(manifest.deferred) : [];
  } catch {
    return [];
  }
}

/** Persist the merge of `steps` into the manifest's `deferred[]`, and
 *  simultaneously clear anything in `resolvedKeys` (steps that
 *  succeeded this run). Returns the written list, or null when there's
 *  no manifest to write into (cache-only / pre-scaffold runs).
 *
 *  Idempotent: writing the same deferrals twice produces the same file.
 */
export function persistDeferredSteps(
  projectDir: string | undefined,
  steps: readonly DeferredStep[],
  resolvedKeys: readonly string[] = [],
): DeferredStep[] | null {
  if (!projectDir) return null;
  let manifest: ReturnType<typeof readManifest>;
  try {
    manifest = readManifest(projectDir);
  } catch {
    return null;
  }
  if (!manifest) return null;

  const previous = manifest.deferred ?? [];
  const next = mergeDeferredSteps(
    withoutDeferredSteps(withoutRetiredSteps(previous), resolvedKeys),
    steps,
  );
  if (deferredStepsEqual(previous, next)) return next;

  writeManifest(projectDir, { ...manifest, deferred: next.length > 0 ? next : undefined });
  return next;
}

/** Remove deferrals for steps that have now completed. Thin wrapper
 *  over {@link persistDeferredSteps} for the success-only path. */
export function resolveDeferredSteps(
  projectDir: string | undefined,
  resolvedKeys: readonly string[],
): DeferredStep[] | null {
  if (resolvedKeys.length === 0) return readDeferredSteps(projectDir);
  return persistDeferredSteps(projectDir, [], resolvedKeys);
}

function deferredStepsEqual(a: readonly DeferredStep[], b: readonly DeferredStep[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((step, i) => {
    const other = b[i];
    return (
      step.key === other.key &&
      step.kind === other.kind &&
      step.reason === other.reason &&
      step.command === other.command &&
      step.label === other.label &&
      step.deferredAt === other.deferredAt &&
      (step.hint ?? []).join(" ") === (other.hint ?? []).join(" ")
    );
  });
}

/* ─────────────────────────────────────────────────────────────────── */
/*  Interactive gate                                                   */
/* ─────────────────────────────────────────────────────────────────── */

const KIND_VERB: Record<DeferralKind, string> = {
  declined: "skipped",
  failed: "failed",
  unavailable: "not applicable",
};

/** Ask whether to configure a not-yet-configured global provider, with
 *  "no" wired to a clean deferral instead of an abort.
 *
 *  Non-interactive runs (no TTY) defer automatically — the alternative
 *  is an `input()` waiting forever on a pipe, which is what made
 *  scripted `hatchkit create` runs hang.
 *
 *  Throws {@link StepDeferredError} when the answer is no; returns
 *  normally when the caller should go ahead and prompt for credentials. */
export async function confirmConfigureOrDefer(args: {
  label: string;
  /** Already configured? Skips the gate entirely. */
  configured: boolean;
  /** `hatchkit config add …` shown in the "later" hint. */
  setupCommands?: string[];
}): Promise<void> {
  if (args.configured) return;
  if (!process.stdin.isTTY) {
    deferStep(`${args.label} is not configured and there's no TTY to collect credentials`);
  }
  const { confirm } = await import("@inquirer/prompts");
  console.log(
    chalk.yellow(`\n  ${args.label} needs credentials Hatchkit doesn't have yet.`) +
      chalk.dim("\n  Answering no skips this step — the rest of the run continues."),
  );
  const now = await confirm({
    message: `Set up ${args.label} now?`,
    default: true,
  });
  if (!now) {
    const later = (args.setupCommands ?? [])[0];
    console.log(chalk.dim(`  · Deferred${later ? ` — finish later with \`${later}\`` : ""}.`));
    deferStep("declined at the credential prompt");
  }
}

/* ─────────────────────────────────────────────────────────────────── */
/*  Rendering                                                          */
/* ─────────────────────────────────────────────────────────────────── */

/** End-of-run summary: what got configured, what didn't, and the exact
 *  command per skipped item. Returns "" when there's nothing to say, so
 *  callers can `if (block) console.log(block)` without a length check. */
export function renderDeferralSummary(args: {
  configured: readonly string[];
  deferred: readonly DeferredStep[];
  title?: string;
}): string {
  if (args.configured.length === 0 && args.deferred.length === 0) return "";
  const lines: string[] = [];
  lines.push("");
  lines.push(chalk.bold(`  ── ${args.title ?? "Steps"} ──────────────────────────────────────`));
  lines.push("");
  if (args.configured.length > 0) {
    lines.push(`  ${chalk.green("Configured")} (${args.configured.length}):`);
    for (const item of args.configured) lines.push(`    ${chalk.green("✓")} ${item}`);
    lines.push("");
  }
  if (args.deferred.length > 0) {
    lines.push(`  ${chalk.yellow("Deferred")} (${args.deferred.length}):`);
    for (const step of args.deferred) {
      lines.push(
        `    ${chalk.yellow("»")} ${chalk.bold(step.label)} ${chalk.dim(`— ${KIND_VERB[step.kind]}: ${step.reason}`)}`,
      );
      lines.push(`      ${chalk.dim("→")} ${chalk.cyan(step.command)}`);
      for (const hint of step.hint ?? []) {
        lines.push(`      ${chalk.dim("→")} ${chalk.dim(hint)}`);
      }
    }
    lines.push("");
    lines.push(
      chalk.dim("  Nothing was rolled back — deferred steps left no partial state behind."),
    );
  }
  lines.push("");
  return lines.join("\n");
}

/** One-liner for `hatchkit status` / the top-level menu. */
export function summarizeDeferredSteps(steps: readonly DeferredStep[]): string {
  if (steps.length === 0) return "";
  return `${steps.length} step${steps.length === 1 ? "" : "s"} deferred`;
}
