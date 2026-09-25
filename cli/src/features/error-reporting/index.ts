/*
 * cli/src/features/error-reporting/index.ts — write-through entry point
 * for the error-reporting module.
 *
 * Everything that decides anything lives in the other four modules and
 * is pure: `allowlist.ts` decides what a report may carry, `scrub.ts`
 * enforces it, `render.ts` writes the client code, `privacy.ts` writes
 * the page text from the same list. This file only reads the project's
 * version, puts the generated files on the ledger, and reports what is
 * left for a person to do.
 *
 * It writes no configuration of its own. The endpoint arrives through
 * the build argument the client image already takes
 * (`scaffold/client-build-args.ts` passes `vars.NEXT_PUBLIC_SENTRY_DSN`
 * with an empty fallback), and the note below tells the user the one
 * command that sets it. A second channel for the same value is how two
 * builds end up reporting to two different places.
 *
 * Every write goes through `ctx.ledger`. Nothing here touches `node:fs`:
 * the ledger is where `--dry-run` is decided, and a module that reads or
 * writes around it breaks the dry run silently — see the header of
 * operational-context.ts.
 */

import { dirname } from "node:path";
import {
  type OperationalContext,
  type OperationalOutcome,
  applied,
  hasClientHalf,
  skipped,
} from "../operational-context.js";
import { renderPrivacyCopy } from "./privacy.js";
import {
  CLIENT_ERROR_REPORTING_DIR,
  ERROR_REPORTING_DSN_VAR,
  ERROR_REPORTING_SDK_PACKAGE,
  ERROR_REPORTING_SDK_VERSION,
  errorReportingFiles,
} from "./render.js";

export * from "./allowlist.js";
export * from "./privacy.js";
export * from "./render.js";
export { scrubBreadcrumb, scrubEvent, scrubText, stripUrl } from "./scrub.js";

/** Where the generated privacy text is left for whoever writes the page.
 *  A file rather than a print-out: the page is written weeks later, by
 *  someone who was not at the terminal. */
export const PRIVACY_COPY_REL_PATH = ".hatchkit/privacy-error-reports.md";

/**
 * The header the privacy file carries, as an HTML comment so it
 * disappears the moment the text is pasted into a page.
 *
 * The file is regenerated on every `update`, which is the point — it is
 * how the copy keeps up with the allowlist. That only works if nobody
 * treats this file as the place to edit the wording, so it has to say so
 * in the file rather than in a note nobody kept.
 */
const PRIVACY_COPY_HEADER = [
  "<!--",
  "  Generated and owned by hatchkit from the report allowlist in",
  "  cli/src/features/error-reporting/allowlist.ts. `hatchkit update`",
  "  rewrites this file, so edit the allowlist, not this copy. Paste the",
  "  text below into your privacy page; this comment does not render.",
  "-->",
  "",
  "",
].join("\n");

/**
 * Every `package.json` above a directory, nearest first, ending at the
 * project root.
 *
 * Paths, not files: the caller asks the ledger which of them exist, so
 * this stays pure and the disk is read in one place.
 */
export function ancestorPackageJsonPaths(dir: string): string[] {
  const paths: string[] = [];
  let current = dir.replace(/\\/g, "/").replace(/\/+$/, "");
  while (current && current !== "." && current !== "/") {
    paths.push(`${current}/package.json`);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent === "." ? "" : parent;
  }
  paths.push("package.json");
  return paths;
}

/** What the walk up from the generated directory found. */
interface ClientPackage {
  /** The nearest `package.json`: in a monorepo, the client package. The
   *  SDK dependency belongs in this one and no other. */
  rel?: string;
  /** The nearest version above the generated directory. */
  version?: string;
}

/**
 * The client package and the project's version, from one walk.
 *
 * The two answers differ more often than they look like they should: a
 * monorepo root package is usually private and unversioned, so the
 * nearest `package.json` and the nearest one carrying a version are not
 * always the same file. The dependency goes in the first; the release
 * string is built from the second.
 *
 * A `package.json` that does not parse is skipped rather than fatal —
 * that is the project's problem, not a reason to refuse to generate a
 * reporter.
 */
function findClientPackage(ctx: OperationalContext, dir: string): ClientPackage {
  const found: ClientPackage = {};
  for (const rel of ancestorPackageJsonPaths(dir)) {
    const raw = ctx.ledger.read(rel);
    if (raw === undefined) continue;
    found.rel ??= rel;
    if (found.version !== undefined) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      const version = (parsed as { version?: unknown }).version;
      if (typeof version === "string" && version) found.version = version;
    } catch {
      // Unparseable: keep walking.
    }
  }
  return found;
}

/**
 * Generate the client error-reporting modules and the privacy copy.
 *
 * The four generated files are OWNED: the module writes them and
 * rewrites them, so they go through `writeIfChanged` and say in their
 * own headers that an edit is lost on the next run. That is what lets a
 * later CLI tighten the scrubber without asking anyone to re-apply the
 * change by hand.
 *
 * The client's `package.json` is the opposite case and is merged, not
 * written: a version the project already pins is reported as a conflict
 * and kept, because a dependency the user chose is theirs.
 */
export function applyErrorReporting(ctx: OperationalContext): OperationalOutcome {
  const dir = CLIENT_ERROR_REPORTING_DIR;

  if (!hasClientHalf(ctx.project.surfaces)) {
    return skipped(
      "this project has no browser half, and error reporting here is client-side only",
    );
  }

  const pkg = findClientPackage(ctx, dir);
  // A release string that is merely uninformative beats no error
  // reporting at all, so a project with no version anywhere still gets a
  // reporter — tagged `0.0.0`, which is visibly a placeholder.
  const version = pkg.version ?? "0.0.0";

  const files = errorReportingFiles(ctx.project, { version, dir });
  for (const file of files) {
    ctx.ledger.writeIfChanged(file.path, file.contents);
  }

  const privacy = renderPrivacyCopy(ctx.project);
  ctx.ledger.writeIfChanged(PRIVACY_COPY_REL_PATH, `${PRIVACY_COPY_HEADER}${privacy.markdown}`);

  const notes: string[] = [];

  if (pkg.rel === undefined) {
    notes.push(
      `Add ${ERROR_REPORTING_SDK_PACKAGE}@${ERROR_REPORTING_SDK_VERSION} to the package that holds ${dir}. No package.json was found above it, so hatchkit could not add it for you, and ${dir}/sdk.ts will not resolve`,
    );
  } else {
    // Add-only on purpose. A project that already pins a different major
    // pinned it for a reason, and reverting that on every `update` is the
    // failure mergePackageJson exists to prevent — the ledger reports the
    // conflict and the run says so. `force` is the caller's explicit
    // "overwrite what the layer owns", so it is passed through here and
    // nowhere decided by this module.
    ctx.ledger.mergePackageJson(
      pkg.rel,
      { dependencies: { [ERROR_REPORTING_SDK_PACKAGE]: ERROR_REPORTING_SDK_VERSION } },
      { force: ctx.force === true },
    );
  }

  notes.push(
    `Error reporting is off until \`${ERROR_REPORTING_DSN_VAR}\` is set. It is a repository variable, not a secret — the endpoint is in the shipped bundle either way: gh variable set ${ERROR_REPORTING_DSN_VAR} --body 'https://<key>@<host>/<id>'`,
  );
  notes.push(
    `Call startErrorReporting() from an effect after the app mounts, and reportClientError() from your error boundaries (${dir}/reporter.ts)`,
  );
  if (privacy.unresolved) {
    notes.push(
      "Decide who runs the error tracker before publishing the privacy page: an endpoint another company runs makes that company a processor the page has to name",
    );
  }

  ctx.log(
    `  error-reporting: ${files.length + 1} generated files, reporting off until the DSN is set`,
  );
  return applied(notes);
}
