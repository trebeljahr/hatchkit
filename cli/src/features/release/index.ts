/*
 * cli/src/features/release/index.ts — the `release` feature definition.
 *
 * What it installs into a project, and why each piece is there:
 *
 *   .hatchkit-release.json         the derived picture of this project's
 *                                  release surfaces. Everything else
 *                                  reads it; nothing else is generated.
 *   scripts/release.mjs            cut a release: check, tag, and say
 *                                  what each surface will do.
 *   scripts/release-status.mjs     what each channel produced for a tag,
 *                                  and what is still pending.
 *   scripts/release-policy-check.mjs  refuse the combinations that ship
 *                                  something wrong. CI runs it before a
 *                                  build starts.
 *   scripts/release-version-sync.test.mjs  every copy of the version
 *                                  against the root, so a missed bump
 *                                  fails long before an upload.
 *   .github/workflows/release-summary.yml  one place per tag with every
 *                                  channel's outcome.
 *   .github/workflows/compat.yml   old client vs new server, both ways,
 *                                  with the script that starts each
 *                                  stack. Written only when the project
 *                                  has a server others host and a client
 *                                  that ships separately.
 *   docs/releasing.md              the procedure.
 *   docs/release-credentials.md    the credentials, what absence does,
 *                                  and the manual steps nobody can
 *                                  automate.
 *
 * Every one of those is a file this feature OWNS and regenerates: a
 * project that gains a phone app gets new rows in all of them on the
 * next `hatchkit update`. They are written with `writeIfChanged`, which
 * overwrites, and each generated document says so in its own header so
 * a reader learns that before they start editing.
 *
 * The one file the user is expected to edit — `package.json` — is
 * touched only through `mergePackageJson`, which is add-only and
 * reports a differing value rather than replacing it.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type FeatureContext, registerFeature } from "../contract.js";
import { type ProjectFacts, buildReleaseConfig, derivationInputFromProject } from "./config.js";
import { renderCredentialsDoc, renderReleasingDoc } from "./docs.js";
import type { ReleaseConfig, ReleaseSetupAudit } from "./types.js";
import { RELEASE_CONFIG_FILENAME } from "./types.js";
import { renderCompatWorkflow, renderSummaryWorkflow } from "./workflows.js";

export * from "./types.js";
export { buildReleaseConfig, derivationInputFromProject, readReleaseConfig } from "./config.js";
export { deriveChannels } from "./channels.js";
export { deriveCredentials, signingSecretsFor } from "./credentials.js";
export { derivePolicy } from "./policy-rules.js";
export { deriveVersionCopies, deriveVersionReads } from "./version-targets.js";
export { renderCredentialsDoc, renderReleasingDoc } from "./docs.js";
export { renderCompatWorkflow, renderSummaryWorkflow } from "./workflows.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** templates/release/ inside the compiled tree: dist/features/release/
 *  → dist/templates/release/, the same two hops the signing feature
 *  makes. `scripts/copy-templates.mjs` copies the whole tree at build
 *  time, so a new file under it needs no registration. */
const TEMPLATES_DIR = join(__dirname, "..", "..", "templates", "release");

/** Copied verbatim from templates/release/scripts/ into the project's
 *  scripts/. They read the config and contain no project-specific text,
 *  which is why they need no render pass — and why a new surface never
 *  edits them. */
const RUNTIME_SCRIPTS = [
  "release.mjs",
  "release-status.mjs",
  "release-policy-check.mjs",
  "release-version-sync.test.mjs",
  "lib/release-config.mjs",
  "lib/release-plan.mjs",
  "lib/release-policy.mjs",
  "lib/release-status.mjs",
] as const;

/** The four entry points, add-only. Chaining the version-sync test into
 *  the project's own `test` script was tempting and is not done here:
 *  `mergePackageJson` reports a differing value rather than replacing
 *  it, and silently rewriting somebody's test script on every `update`
 *  is the exact bug the contract warns about. `release.mjs` runs the
 *  version-sync test itself, and the policy check asserts the same
 *  thing again in CI before anything is built, so the guarantee holds
 *  without touching a script the user owns. */
const SCRIPTS: Record<string, string> = {
  release: "node scripts/release.mjs",
  "release:status": "node scripts/release-status.mjs",
  "release:check": "node scripts/release-policy-check.mjs",
  "test:version-sync": "node --test scripts/release-version-sync.test.mjs",
};

export const releaseFeature = registerFeature({
  id: "release",
  title: "Release coordination",
  summary:
    "One version across every surface: a cut command, a status table, a policy check, and generated credential docs.",
  // Purely additive. It reads the other features to decide which
  // channels exist, and writes only files of its own — so it can be
  // added to any project at any time, and re-added after a surface is.
  addableAfterScaffold: true,
  apply(ctx: FeatureContext): void {
    const config = configFor(ctx);
    const { ledger, log } = ctx;

    log(
      config.channels.length === 0
        ? "  Release: no channels yet — nothing ships from a version tag."
        : `  Release channels: ${config.channels.map((channel) => channel.label).join(", ")}`,
    );

    ledger.writeIfChanged(RELEASE_CONFIG_FILENAME, `${JSON.stringify(config, null, 2)}\n`);

    for (const relative of RUNTIME_SCRIPTS) {
      ledger.writeIfChanged(`scripts/${relative}`, readTemplate(`scripts/${relative}`));
    }

    ledger.writeIfChanged(".github/workflows/release-summary.yml", renderSummaryWorkflow(config));

    const compat = renderCompatWorkflow(config);
    if (compat !== null) {
      ledger.writeIfChanged(".github/workflows/compat.yml", compat);
      // The workflow is useless without it: both directions start their
      // stack through this script. Installed only alongside the
      // workflow, so a project with no compat run gets no stray shell
      // script it would have to wonder about.
      ledger.writeIfChanged(
        config.compat?.serverScript ?? "scripts/compat-server.sh",
        readTemplate("scripts/compat-server.sh"),
      );
    }

    ledger.writeIfChanged("docs/releasing.md", renderReleasingDoc(config));
    ledger.writeIfChanged("docs/release-credentials.md", renderCredentialsDoc(config));

    ledger.mergePackageJson("package.json", { scripts: SCRIPTS });
  },
});

/** The derived config for a project, from the manifest alone. Exported
 *  because `hatchkit release plan` answers "what would a tag do?"
 *  without applying anything. */
export function configFor(ctx: FeatureContext): ReleaseConfig {
  return buildReleaseConfig(derivationInputFromProject(ctx.projectDir, factsFrom(ctx)));
}

function factsFrom(ctx: FeatureContext): ProjectFacts {
  return {
    name: ctx.manifest.name,
    identifiers: ctx.identifiers,
    features: ctx.manifest.features,
    surfaces: ctx.manifest.surfaces,
    deploymentMode: ctx.manifest.deploymentMode,
    signing: ctx.manifest.signing
      ? { enabled: ctx.manifest.signing.enabled, platforms: ctx.manifest.signing.platforms }
      : undefined,
  };
}

/**
 * Things only a person can do, collected so a caller prints them once
 * at the end of a run rather than scattering them through it.
 *
 * Kept out of `apply` because a dry run should list them too, and a
 * combined run should print them after every feature has applied.
 */
export function releaseResidue(config: ReleaseConfig): string[] {
  const residue: string[] = [];

  const needingSecrets = config.credentials.filter((group) => group.secrets.length > 0);
  if (needingSecrets.length > 0) {
    const total = needingSecrets.reduce((sum, group) => sum + group.secrets.length, 0);
    residue.push(
      `${total} repo secrets across ${needingSecrets.length} channels are not set by hatchkit. ` +
        "docs/release-credentials.md says what each one is, where it comes from, and what happens without it.",
    );
  }
  for (const group of config.credentials) {
    for (const step of group.manualSteps) residue.push(`${group.label}: ${step}`);
  }
  if (config.compat !== null) {
    residue.push(
      `compat.yml runs the suite at ${config.compat.suiteEntry}. ` +
        "Until that file exists, both directions skip with a notice instead of failing.",
    );
  }
  return residue;
}

/** What one `apply` did, for a caller to print. Built from the ledger
 *  rather than tracked separately, so the dry run and the real run
 *  report through one code path. */
export function releaseAudit(ctx: FeatureContext, config: ReleaseConfig): ReleaseSetupAudit {
  const summary = ctx.ledger.summary();
  return {
    ok: ctx.ledger.conflicts().length === 0,
    written: [...summary.written, ...summary["would-write"]],
    unchanged: summary.unchanged,
    conflicts: ctx.ledger
      .conflicts()
      .map((entry) => `${entry.file}: ${entry.detail ?? "conflict"}`),
    channels: config.channels.map((channel) => channel.label),
    manualResidue: releaseResidue(config),
  };
}

function readTemplate(relative: string): string {
  const full = join(TEMPLATES_DIR, relative);
  if (!existsSync(full)) {
    throw new Error(
      `Release template not found: ${full}. Your hatchkit install looks incomplete — reinstall, or run pnpm --filter hatchkit run build in a checkout.`,
    );
  }
  return readFileSync(full, "utf-8");
}

/** Templates dir on disk — exposed so a test can assert every file in
 *  {@link RUNTIME_SCRIPTS} exists and parses. */
export function getReleaseTemplatesDir(): string {
  return TEMPLATES_DIR;
}

/** Every runtime script this feature installs, project-relative. */
export function releaseRuntimeScripts(): string[] {
  return RUNTIME_SCRIPTS.map((relative) => `scripts/${relative}`);
}
