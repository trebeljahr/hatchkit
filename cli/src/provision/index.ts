/*
 * Provision orchestrator.
 *
 * Model:
 *   · GlitchTip and OpenPanel are "observability" providers. Per
 *     product, one project handles all environments — events are
 *     tagged with `environment: ...` on the SDK side, so dev/staging/
 *     prod share the same DSN/client credentials. This keeps the
 *     dashboards clean even as more envs get added.
 *   · Observability credentials are written to `.env.production`
 *     ONLY by default. Most teams don't want dev events polluting
 *     their real error / analytics metrics. Opt in via
 *     `--enable-dev-obs` when you need to debug the SDK wiring.
 *   · Resend is different: dev and prod keys are genuinely separated
 *     so a bug in dev can't email real users. We still mint two keys
 *     (`<name>-dev` / `<name>-prod`) and write them into the server's
 *     dev/prod env respectively.
 *   · Surfaces: a project can have a server, a client, or both. When
 *     both, the common case is a single shared GlitchTip/OpenPanel
 *     project (same DSN on both SDKs, each tagged automatically by
 *     `sdk.name`). Strict-isolation setups can opt into two projects
 *     via `Surfaces.mode = "separate"`.
 *
 * A 0600-permission cache copy of every written env is kept under
 * ~/<conf-dir>/provisioned/ for recoverability. Secret values never
 * touch stdout.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { confirm, input, select } from "@inquirer/prompts";
import chalk from "chalk";
import {
  ensureGlitchtip,
  ensureGoogleSearchConsole,
  ensureOpenpanel,
  ensurePlausible,
  ensureResend,
  ensureS3,
  getConfigPath,
} from "../config.js";
import { mirrorEnvKeysIfAbsent } from "../deploy/keys.js";
import {
  MANIFEST_FILENAME,
  MANIFEST_VERSION,
  type ProjectManifest,
  readManifest,
  writeManifest,
} from "../scaffold/manifest.js";
import { exec } from "../utils/exec.js";
import { validateDomain, validateProjectName } from "../utils/validate.js";
import { getCliVersion } from "../utils/version.js";
import {
  type GlitchtipClient,
  deleteGlitchtipClient,
  glitchtipProjectExists,
  provisionGlitchtipClient,
} from "./glitchtip.js";
import {
  type OpenpanelClient,
  deleteOpenpanelClient,
  openpanelProjectExists,
  provisionOpenpanelClient,
} from "./openpanel.js";
import {
  type PlausibleSite,
  deletePlausibleSite,
  plausibleSiteExists,
  provisionPlausibleSite,
} from "./plausible.js";
import {
  type ResendAudience,
  type ResendClient,
  createResendAudience,
  createResendDomain,
  deleteResendAudience,
  deleteResendClient,
  listResendApiKeys,
  listResendAudiences,
  listResendDomains,
  normalizeDomainInput,
  provisionResendClient,
} from "./resend.js";
import { publishResendDnsToCloudflare } from "./resend-dns.js";
import {
  type ProvisionR2TokensResult,
  provisionR2BucketTokens,
  renderR2BucketTokensEnv,
  unprovisionR2BucketTokens,
} from "./s3.js";
import {
  type SearchConsoleProvisionResult,
  provisionSearchConsoleForDomain,
  unprovisionSearchConsoleForDomain,
} from "./search-console.js";
import { parseEnvLines, writeDevEnv, writeProdEnv } from "./write-env.js";

export type ProvisionService =
  | "glitchtip"
  | "openpanel"
  | "plausible"
  | "resend"
  | "s3"
  | "email"
  | "search-console";

export type SurfaceMode = "shared" | "separate" | "server-only" | "client-only";

export interface Surfaces {
  /** Which SDK surfaces the project has. Drives where env values land
   *  and whether we mint one or two projects per observability vendor. */
  mode: SurfaceMode;
  /** Absolute path to the directory that owns `.env.{development,
   *  production}` for the server bundle. Required unless `mode` is
   *  `"client-only"`. */
  serverEnvDir?: string;
  /** Absolute path for the client bundle's env files. Required unless
   *  `mode` is `"server-only"`. */
  clientEnvDir?: string;
  /** Absolute path to the project root (where `.hatchkit.json` lives).
   *  Optional for most services, useful for Plausible to infer the
   *  project domain, and required for `s3` — the s3 handler
   *  reads `s3Buckets` from the manifest to decide which buckets to
   *  mint scoped tokens for. */
  projectDir?: string;
}

/** Per-resource event surfaced to the caller as each provider succeeds.
 *  Used by `hatchkit adopt` to record into the run ledger immediately
 *  after a resource is created — that way a later failure inside
 *  runProvision (e.g. Resend after GlitchTip already succeeded) still
 *  leaves a complete trail of what to undo. */
export type ProvisionedEvent =
  | { service: "glitchtip"; project: string }
  | { service: "openpanel"; project: string }
  | { service: "plausible"; project: string; domain: string; created: boolean }
  | { service: "resend"; client: string }
  | { service: "resendAudience"; audience: string; audienceId: string; kind: "live" | "test" }
  | {
      service: "resendDns";
      domainId: string;
      domainName: string;
      zoneId: string;
      zoneName: string;
      /** Records this run CREATED — undo can DELETE these by id without
       *  touching anything else in the zone. */
      createdRecords: Array<{ id: string; name: string; type: "TXT" | "MX" | "CNAME" }>;
      /** SPF rows we merged into instead of creating — auto-rollback
       *  skips these to avoid yanking includes the user added by hand. */
      mergedSpf: Array<{ name: string }>;
      finalStatus: string;
    }
  | {
      service: "s3";
      bucketKey: string;
      bucketName: string;
      tokenId: string;
      accountId: string;
      minted: boolean;
    }
  | {
      service: "email";
      domain: string;
      zoneId: string;
      accountId: string;
      destinationId: string;
      destinationEmail: string;
      destinationCreatedThisRun: boolean;
      routingEnabledThisRun: boolean;
      dnsRecords: Array<{ id: string; name: string; type: "MX" | "TXT" }>;
      rules: Array<{ id: string; address: string; created: boolean }>;
    }
  | {
      service: "search-console";
      domain: string;
      siteUrl: string;
      dnsRecord?: {
        id: string;
        zoneId: string;
        name: string;
        type: "TXT";
        created: boolean;
        updated: boolean;
      };
    }
  /** Emitted when `runProvision` mirrors a freshly-minted dotenvx
   *  private key from `.env.keys` into the OS keychain. Only fires
   *  when the keychain was empty before this run, i.e. the provision
   *  was responsible for introducing dotenvx to the project — typical
   *  of a client-only scaffold whose first provisioner (Plausible,
   *  GlitchTip, etc.) triggered the keypair generation. */
  | { service: "dotenvxKey"; project: string; account: string };

export interface ProvisionOptions {
  baseName: string;
  services: ProvisionService[];
  /** Optional pre-selected Resend domain id, skipping the picker. */
  resendDomainId?: string;
  /** Optional Resend domain name paired with `resendDomainId`; used
   *  to seed a useful RESEND_FROM_EMAIL for scaffolded apps. */
  resendDomainName?: string;
  /** Create a per-project Resend Audience (mailing list) alongside the
   *  -dev / -prod keys. When true, also creates a `<project>-test`
   *  audience so a developer can rehearse broadcasts without touching
   *  the live list. Writes `RESEND_AUDIENCE_ID` (and `_TEST`) into the
   *  server bundle env. Off by default — most projects only need
   *  transactional sending. */
  resendWithAudience?: boolean;
  /** Automatically publish Resend's required DKIM/SPF DNS records into
   *  Cloudflare after the domain is created. Requires `hatchkit config
   *  add dns` to be set up (Cloudflare token + the Resend domain's
   *  parent zone already on the account). Defaults to true when DNS is
   *  configured; the publisher no-ops if the records already match. */
  resendPublishDns?: boolean;
  /** If set, resolves the write destinations without prompting.
   *  Pass `false` to force cache-only mode (no writes). */
  surfaces?: Surfaces | false;
  /** Also write observability values to `.env.development`. Off by
   *  default — see the file header. */
  enableDevObs?: boolean;
  /** Domain for services that are site/domain-scoped, e.g. Plausible. */
  domain?: string;
  /** Fired after each provider successfully creates a resource. The
   *  callback runs synchronously between the `withSpinner` succeed
   *  and the next provider, so it can append to a ledger / log
   *  without racing the next API call. */
  onProvisioned?: (event: ProvisionedEvent) => void;
  /** When true, run read-only existence probes before creating remote
   *  resources and abort if anything selected already exists. */
  failIfExists?: boolean;
}

export interface SearchConsoleDomainGuess {
  domain: string;
  source: string;
}

interface SearchConsoleTarget {
  projectDir?: string;
  domain: string;
}

interface ResendDomainSelection {
  id?: string;
  name?: string;
}

interface WriteBucket {
  /** Display label like "server" or "client". */
  label: string;
  /** Absolute dir containing `.env.{development,production}`. */
  envDir: string;
  /** KEY=VALUE lines destined for `.env.production`. */
  prodLines: string[];
  /** KEY=VALUE lines destined for `.env.development` (only if
   *  enableDevObs or when values are genuinely dev-scoped, e.g.
   *  Resend's dev key). */
  devLines: string[];
}

async function assertNoExistingProviderResources(args: {
  baseName: string;
  services: ProvisionService[];
  surfaces: Surfaces | null;
  plausibleDomain?: string;
  resendWithAudience?: boolean;
}): Promise<void> {
  const conflicts: string[] = [];

  if (args.services.includes("glitchtip")) {
    const names =
      args.surfaces && args.surfaces.mode === "separate"
        ? [`${args.baseName}-server`, `${args.baseName}-client`]
        : [args.baseName];
    for (const name of names) {
      if (await glitchtipProjectExists(name)) conflicts.push(`GlitchTip project ${name}`);
    }
  }

  if (args.services.includes("openpanel")) {
    const names =
      args.surfaces && args.surfaces.mode === "separate"
        ? [`${args.baseName}-server`, `${args.baseName}-client`]
        : [args.baseName];
    for (const name of names) {
      if (await openpanelProjectExists(name)) conflicts.push(`OpenPanel project ${name}`);
    }
  }

  if (args.services.includes("plausible") && args.plausibleDomain) {
    if (await plausibleSiteExists(args.plausibleDomain)) {
      conflicts.push(`Plausible site ${args.plausibleDomain}`);
    }
  }

  if (args.services.includes("resend")) {
    const keys = await listResendApiKeys();
    const names = new Set(keys.map((key) => key.name));
    for (const name of [`${args.baseName}-dev`, `${args.baseName}-prod`]) {
      if (names.has(name)) conflicts.push(`Resend API key ${name}`);
    }
    if (args.resendWithAudience) {
      const audiences = await listResendAudiences();
      const audienceNames = new Set(audiences.map((a) => a.name));
      for (const name of [args.baseName, `${args.baseName}-test`]) {
        if (audienceNames.has(name)) conflicts.push(`Resend audience ${name}`);
      }
    }
  }

  if (conflicts.length > 0) {
    throw new Error(
      [
        "Refusing to add services because these resources already exist:",
        ...conflicts.map((conflict) => `  - ${conflict}`),
        "",
        "Remove or rename the existing resources, or run `hatchkit remove` if Hatchkit created them before.",
      ].join("\n"),
    );
  }
}

export async function runProvision(opts: ProvisionOptions): Promise<void> {
  const nameCheck = validateProjectName(opts.baseName);
  if (nameCheck !== true) throw new Error(`Invalid base name: ${nameCheck}`);

  const surfaces = await resolveSurfaces(opts);
  const enableDevObs = opts.enableDevObs ?? false;
  const plausibleDomain = opts.services.includes("plausible")
    ? await resolvePlausibleDomain(opts, surfaces)
    : undefined;
  const searchConsoleTarget = opts.services.includes("search-console")
    ? await resolveSearchConsoleTarget(opts, surfaces)
    : undefined;

  // Ensure every selected provider is configured *before* any spinner
  // starts. Otherwise a lazy `ensure*` prompt fires underneath the ora
  // spinner and inquirer waits forever for invisible input.
  if (opts.services.includes("glitchtip")) await ensureGlitchtip();
  if (opts.services.includes("openpanel")) await ensureOpenpanel();
  if (opts.services.includes("plausible")) await ensurePlausible();
  if (opts.services.includes("resend")) await ensureResend();
  // S3 is currently R2-only — `ensureS3("r2")` prompts for the admin
  // token (Account>R2:Edit + User>API Tokens:Edit) and stores the
  // endpoint metadata. Same lazy-config-before-spinner contract.
  if (opts.services.includes("s3")) await ensureS3("r2");
  if (opts.services.includes("email")) {
    const { ensureDns, ensureDefaultForwardingEmail } = await import("../config.js");
    await ensureDns();
    await ensureDefaultForwardingEmail();
  }
  if (searchConsoleTarget?.domain) {
    const { ensureDns } = await import("../config.js");
    await ensureGoogleSearchConsole();
    await ensureDns();
  }

  // Resend domain: pick once, reused across dev + prod.
  let resendDomain: ResendDomainSelection | undefined = opts.resendDomainId
    ? { id: opts.resendDomainId, name: opts.resendDomainName }
    : undefined;
  if (opts.services.includes("resend") && !resendDomain) {
    resendDomain = await pickResendDomain();
  }

  const buckets = initBuckets(surfaces);

  if (opts.failIfExists) {
    await assertNoExistingProviderResources({
      baseName: opts.baseName,
      services: opts.services,
      surfaces,
      plausibleDomain,
      resendWithAudience: opts.resendWithAudience,
    });
  }

  console.log(chalk.bold(`\n  ── Provisioning ${opts.baseName} ──────────────────────────\n`));

  // ── GlitchTip ──
  if (opts.services.includes("glitchtip")) {
    if (surfaces?.mode === "separate") {
      for (const side of ["server", "client"] as const) {
        const projectName = `${opts.baseName}-${side}`;
        const res = await withSpinner(`GlitchTip: creating project ${projectName}`, () =>
          provisionGlitchtipClient(projectName),
        );
        opts.onProvisioned?.({ service: "glitchtip", project: projectName });
        pushObsLines(buckets, side, renderGlitchtipEnv(res, side === "client"), enableDevObs);
      }
    } else {
      const projectName = opts.baseName;
      const res = await withSpinner(`GlitchTip: creating project ${projectName}`, () =>
        provisionGlitchtipClient(projectName),
      );
      opts.onProvisioned?.({ service: "glitchtip", project: projectName });
      // Shared-DSN case: the server SDK reads GLITCHTIP_DSN; the client
      // SDK reads GLITCHTIP_DSN_CLIENT (same value). Both SDKs tag
      // events with `sdk.name`, so filtering by surface in the UI is
      // automatic.
      if (surfaces && (surfaces.mode === "shared" || surfaces.mode === "server-only")) {
        pushObsLines(buckets, "server", renderGlitchtipEnv(res, false), enableDevObs);
      }
      if (surfaces && (surfaces.mode === "shared" || surfaces.mode === "client-only")) {
        pushObsLines(buckets, "client", renderGlitchtipEnv(res, true), enableDevObs);
      }
    }
  }

  // ── OpenPanel ──
  if (opts.services.includes("openpanel")) {
    if (surfaces?.mode === "separate") {
      for (const side of ["server", "client"] as const) {
        const projectName = `${opts.baseName}-${side}`;
        const res = await withSpinner(`OpenPanel: creating project ${projectName}`, () =>
          provisionOpenpanelClient(projectName),
        );
        opts.onProvisioned?.({ service: "openpanel", project: projectName });
        pushObsLines(buckets, side, renderOpenpanelEnv(res, side === "client"), enableDevObs);
      }
    } else {
      const projectName = opts.baseName;
      const res = await withSpinner(`OpenPanel: creating project ${projectName}`, () =>
        provisionOpenpanelClient(projectName),
      );
      opts.onProvisioned?.({ service: "openpanel", project: projectName });
      if (surfaces && (surfaces.mode === "shared" || surfaces.mode === "server-only")) {
        pushObsLines(buckets, "server", renderOpenpanelEnv(res, false), enableDevObs);
      }
      if (surfaces && (surfaces.mode === "shared" || surfaces.mode === "client-only")) {
        pushObsLines(buckets, "client", renderOpenpanelEnv(res, true), enableDevObs);
      }
    }
  }

  // ── Plausible ── (site-scoped browser analytics)
  if (opts.services.includes("plausible")) {
    const clientBucket = buckets.find((b) => b.label === "client");
    if (!clientBucket) {
      console.log(
        chalk.yellow(
          `  Skipping Plausible — this project has no client surface, so there's nowhere to put NEXT_PUBLIC_PLAUSIBLE_*.`,
        ),
      );
    } else if (!plausibleDomain) {
      console.log(
        chalk.yellow(
          `  Skipping Plausible — couldn't resolve the public site domain for ${opts.baseName}.`,
        ),
      );
    } else {
      const res = await withSpinner(`Plausible: wiring site ${plausibleDomain}`, () =>
        provisionPlausibleSite(opts.baseName, plausibleDomain),
      );
      if (res.manual) {
        console.log(
          chalk.yellow(
            `  Plausible Sites API unavailable at ${res.baseUrl}; wrote tracker env for ${res.domain}. Create/confirm that site manually in Plausible.`,
          ),
        );
      }
      opts.onProvisioned?.({
        service: "plausible",
        project: opts.baseName,
        domain: res.domain,
        created: res.created,
      });
      pushObsLines(buckets, "client", renderPlausibleEnv(res), enableDevObs);
    }
  }

  // ── Resend ── (always server-side; dev/prod keys are not observability)
  if (opts.services.includes("resend")) {
    const serverBucket = buckets.find((b) => b.label === "server");
    if (!serverBucket) {
      console.log(
        chalk.yellow(
          `  Skipping Resend — this project has no server surface, so there's nowhere to put RESEND_API_KEY.`,
        ),
      );
    } else {
      const devRes = await withSpinner(
        `Resend: creating restricted API key ${opts.baseName}-dev`,
        () => provisionResendClient(`${opts.baseName}-dev`, resendDomain?.id, resendDomain?.name),
      );
      opts.onProvisioned?.({ service: "resend", client: `${opts.baseName}-dev` });
      const prodRes = await withSpinner(
        `Resend: creating restricted API key ${opts.baseName}-prod`,
        () => provisionResendClient(`${opts.baseName}-prod`, resendDomain?.id, resendDomain?.name),
      );
      opts.onProvisioned?.({ service: "resend", client: `${opts.baseName}-prod` });
      // Resend is the one case where dev gets its OWN value, not the
      // prod value — dev keys are audience-restricted so they can't
      // email real users.
      serverBucket.devLines.push(...renderResendEnv(devRes));
      serverBucket.prodLines.push(...renderResendEnv(prodRes));

      // ── Audience ── (optional — only for projects that need a mailing list)
      if (opts.resendWithAudience) {
        const liveName = opts.baseName;
        const testName = `${opts.baseName}-test`;
        const live = await withSpinner(
          `Resend: creating audience ${liveName}`,
          () => createResendAudience(liveName),
        );
        opts.onProvisioned?.({
          service: "resendAudience",
          audience: liveName,
          audienceId: live.id,
          kind: "live",
        });
        const test = await withSpinner(
          `Resend: creating audience ${testName}`,
          () => createResendAudience(testName),
        );
        opts.onProvisioned?.({
          service: "resendAudience",
          audience: testName,
          audienceId: test.id,
          kind: "test",
        });
        // Same prod/dev split as the API keys: prod env hits the live
        // list, dev env hits the test list. Both audiences are usable
        // from either API key (audiences aren't scoped to a key), so
        // the env value is the only thing that decides which list a
        // broadcast targets.
        serverBucket.prodLines.push(`RESEND_AUDIENCE_ID=${live.id}`);
        serverBucket.devLines.push(`RESEND_AUDIENCE_ID=${test.id}`);
      }

      // ── DNS publish ── (best-effort; opt-out via `resendPublishDns: false`)
      const wantDnsPublish = opts.resendPublishDns !== false && resendDomain?.id;
      if (wantDnsPublish && resendDomain?.id) {
        try {
          const publishRes = await publishResendDnsToCloudflare(resendDomain.id, {
            triggerVerify: true,
          });
          opts.onProvisioned?.({
            service: "resendDns",
            domainId: resendDomain.id,
            domainName: publishRes.domain.name,
            zoneId: publishRes.zoneId,
            zoneName: publishRes.zoneName,
            createdRecords: publishRes.createdRecords,
            mergedSpf: publishRes.mergedSpf,
            finalStatus: publishRes.finalStatus,
          });
          console.log(
            chalk.dim(
              `  Resend DNS: ${publishRes.created} created, ${publishRes.updated} updated, ${publishRes.unchanged} unchanged in zone ${publishRes.zoneName}. Domain status: ${publishRes.finalStatus}.`,
            ),
          );
          for (const note of publishRes.skippedExtra) {
            console.log(chalk.yellow(`  Resend DNS: skipped ${note}`));
          }
          for (const m of publishRes.mergedSpf) {
            console.log(
              chalk.dim(
                `  Resend DNS: merged SPF include into pre-existing record at ${m.name} — auto-rollback will not touch it (manual un-merge required if you ever undo).`,
              ),
            );
          }
        } catch (err) {
          console.log(
            chalk.yellow(
              `  Resend DNS auto-publish failed: ${(err as Error).message}\n  Publish records manually from https://resend.com/domains/${resendDomain.id} and re-run with --no-resend-dns to skip this step.`,
            ),
          );
        }
      }
    }
  }

  // ── Email (Cloudflare Email Routing) ── (zone-level, not env-bucketed)
  //
  // Reads the domain from the project's `.hatchkit.json` (via
  // `surfaces.projectDir`), prompts for forwarding addresses + the
  // destination inbox the first time, and applies MX/SPF/DMARC +
  // forwarding rules. Doesn't write into .env.{production,development}
  // — email forwarding is a DNS-only concern; no app-runtime secret.
  if (opts.services.includes("email")) {
    const projectDir = surfaces?.projectDir;
    if (!projectDir) {
      console.log(
        chalk.yellow(
          "  Skipping Email — need a project dir (.hatchkit.json) to read the domain. Pass --project-dir, or run `hatchkit email setup --domain <fqdn>` directly.",
        ),
      );
    } else {
      const { readManifest } = await import("../scaffold/manifest.js");
      const manifest = readManifest(projectDir);
      if (!manifest?.domain) {
        console.log(chalk.yellow("  Skipping Email — manifest has no `domain` field."));
      } else {
        const { runEmailSetupForDomain } = await import("../email/index.js");
        const result = await runEmailSetupForDomain({ domain: manifest.domain }, projectDir);
        opts.onProvisioned?.({
          service: "email",
          domain: result.domain,
          zoneId: result.zoneId,
          accountId: result.accountId,
          destinationId: result.destination.record.id,
          destinationEmail: result.destination.record.email,
          destinationCreatedThisRun: result.destination.createdThisRun,
          routingEnabledThisRun: result.routingEnabledThisRun,
          dnsRecords: result.dnsRecords
            .filter((r) => r.created)
            .map((r) => ({ id: r.id, name: r.name, type: r.type })),
          rules: result.rules.map((r) => ({
            id: r.id,
            address: r.address,
            created: r.created,
          })),
        });
        writeManifest(projectDir, {
          ...manifest,
          integrations: {
            ...manifest.integrations,
            email: {
              domain: result.domain,
              configuredAt: new Date().toISOString(),
              destinationEmail: result.destination.record.email,
            },
          },
        });
      }
    }
  }

  // ── Google Search Console ── (domain verification + property add)
  //
  // Uses Google OAuth stored once during setup, then proves ownership
  // with a Cloudflare DNS TXT record. It writes no runtime env because
  // Search Console is account state, not app config.
  if (opts.services.includes("search-console")) {
    if (!searchConsoleTarget) throw new Error("Search Console target was not resolved.");
    const projectDir = searchConsoleTarget.projectDir;
    const domain = searchConsoleTarget.domain;
    const result = await withSpinner(`Search Console: verifying ${domain}`, () =>
      provisionSearchConsoleForDomain(domain, {
        onDnsRecord: (dnsRecord) => {
          if (!dnsRecord.created) return;
          opts.onProvisioned?.({
            service: "search-console",
            domain,
            siteUrl: `sc-domain:${domain}`,
            dnsRecord,
          });
        },
      }),
    );
    opts.onProvisioned?.({
      service: "search-console",
      domain: result.domain,
      siteUrl: result.siteUrl,
    });

    if (projectDir) {
      const latestManifest = readManifest(projectDir);
      writeSearchConsoleManifest(projectDir, latestManifest, opts.baseName, result);
    } else {
      console.log(
        chalk.dim(
          "  Search Console was added in Google. No project dir was provided, so Hatchkit did not record local integration metadata.",
        ),
      );
    }
  }

  // ── S3 / R2 ── (server-side only; per-bucket scoped tokens)
  if (opts.services.includes("s3")) {
    const serverBucket = buckets.find((b) => b.label === "server");
    if (!serverBucket) {
      console.log(
        chalk.yellow(
          `  Skipping S3 — this project has no server surface, so there's nowhere to put R2_*.`,
        ),
      );
    } else if (!surfaces || !surfaces.projectDir) {
      // surfaces=null happens with --no-write; surfaces.projectDir is
      // populated by resolveSurfaces. Without it we can't read the
      // manifest to know which buckets to mint tokens for.
      console.log(
        chalk.yellow(
          `  Skipping S3 — couldn't resolve the project directory (need .hatchkit.json to read s3Buckets).`,
        ),
      );
    } else {
      const r2Result: ProvisionR2TokensResult = await provisionR2BucketTokens({
        projectName: opts.baseName,
        projectDir: surfaces.projectDir,
      });
      for (const bt of r2Result.bucketTokens) {
        opts.onProvisioned?.({
          service: "s3",
          bucketKey: bt.bucketKey,
          bucketName: bt.bucketName,
          tokenId: bt.tokenId,
          accountId: bt.accountId,
          minted: bt.minted,
        });
      }
      serverBucket.prodLines.push(...renderR2BucketTokensEnv(r2Result));
    }
  }

  const hasEnvLines = buckets.some((b) => b.devLines.length > 0 || b.prodLines.length > 0);

  // Persist 0600 cache copies keyed by surface label.
  const outDir = join(dirname(getConfigPath()), "provisioned");
  if (hasEnvLines) {
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    for (const b of buckets) {
      for (const phase of ["dev", "prod"] as const) {
        const lines = phase === "dev" ? b.devLines : b.prodLines;
        if (lines.length === 0) continue;
        const path = join(outDir, `${opts.baseName}.${b.label}.${phase}.env`);
        const banner = `# --- ${opts.baseName} / ${b.label} / ${phase} ---`;
        writeFileSync(path, `${banner}\n${lines.join("\n")}\n`, { mode: 0o600 });
      }
    }
  }

  // Cache-only mode (surfaces === false or user said no to write):
  // summarize + point at cache files.
  if (surfaces === null) {
    console.log(chalk.bold("\n  ── Provisioned ────────────────────────────────────────────\n"));
    if (!hasEnvLines) {
      console.log(chalk.dim("  No environment values were produced for the selected services.\n"));
      return;
    }
    for (const b of buckets) {
      const prodKeys = parseEnvLines(b.prodLines).map((p) => p.key);
      const devKeys = parseEnvLines(b.devLines).map((p) => p.key);
      if (prodKeys.length > 0 || devKeys.length > 0) {
        console.log(`  ${chalk.bold(b.label)}:`);
        if (prodKeys.length > 0) {
          console.log(
            `    prod: ${chalk.green(`${prodKeys.length} vars`)}  ${chalk.dim(prodKeys.join(", "))}`,
          );
        }
        if (devKeys.length > 0) {
          console.log(
            `    dev:  ${chalk.green(`${devKeys.length} vars`)}  ${chalk.dim(devKeys.join(", "))}`,
          );
        }
      }
    }
    console.log(
      chalk.yellow(
        `\n  Values cached at ${outDir}/${opts.baseName}.*.env (mode 0600).\n` +
          `  Read them with \`cat\` or re-run with a project directory to write directly.\n`,
      ),
    );
    return;
  }

  if (!hasEnvLines) {
    console.log(chalk.dim("\n  No environment values to write for the selected services.\n"));
    return;
  }

  // Write values into the resolved directories.
  console.log(chalk.bold("\n  ── Writing env into the project ──────────────────────────\n"));
  for (const b of buckets) {
    const prodPairs = parseEnvLines(b.prodLines);
    const devPairs = parseEnvLines(b.devLines);
    if (prodPairs.length === 0 && devPairs.length === 0) continue;

    const relLabel = chalk.dim(`${b.label} → ${relativeTo(b.envDir)}`);
    console.log(`  ${chalk.bold(b.label)}  ${relLabel}`);
    if (prodPairs.length > 0) {
      const prodPath = join(b.envDir, ".env.production");
      const keys = writeProdEnv(prodPath, prodPairs);
      console.log(
        `    ${chalk.green("✓")} .env.production  (encrypted)  ${chalk.dim(keys.join(", "))}`,
      );
    }
    if (devPairs.length > 0) {
      const devPath = join(b.envDir, ".env.development");
      const keys = writeDevEnv(devPath, devPairs);
      console.log(
        `    ${chalk.green("✓")} .env.development ${chalk.dim("(plaintext, gitignored)")}  ${chalk.dim(keys.join(", "))}`,
      );
    }
  }

  // Mirror DOTENV_PRIVATE_KEY_PRODUCTION into the OS keychain when one
  // of the writes above minted a brand-new keypair on disk and the
  // keychain has no entry for this project yet. Without this, a
  // client-only scaffold that adds Plausible (which is the first
  // dotenvx-touching code path for that surface mode) leaves the key
  // on disk only — and the subsequent `pushProjectKeyToGh` step in
  // `hatchkit create` fails with "No dotenvx key in keychain". Refuses
  // to overwrite an existing keychain entry; that path is `hatchkit
  // keys set`.
  if (surfaces?.projectDir) {
    try {
      const mirror = await mirrorEnvKeysIfAbsent(opts.baseName, surfaces.projectDir);
      if (mirror.mirrored && mirror.envKeysPath) {
        console.log(
          chalk.dim(
            `  ${chalk.green("✓")} dotenvx key mirrored from ${relativeTo(mirror.envKeysPath)} into the OS keychain`,
          ),
        );
        opts.onProvisioned?.({
          service: "dotenvxKey",
          project: opts.baseName,
          account: mirror.account,
        });
      }
    } catch (err) {
      console.log(
        chalk.yellow(
          `  Couldn't mirror dotenvx key into the keychain: ${(err as Error).message}\n` +
            `  Run \`hatchkit keys set ${opts.baseName}\` from the project directory to fix.`,
        ),
      );
    }
  }

  console.log();
  if (
    !enableDevObs &&
    (opts.services.includes("glitchtip") ||
      opts.services.includes("openpanel") ||
      opts.services.includes("plausible"))
  ) {
    console.log(
      chalk.dim(
        "  Note: observability (GlitchTip/OpenPanel/Plausible) values went to prod only.\n" +
          "  Dev errors/events would pollute real metrics — pass --enable-dev-obs to\n" +
          "  also populate .env.development when you need to debug SDK wiring.",
      ),
    );
  }
  console.log(chalk.dim(`\n  Cached copies (0600): ${outDir}/${opts.baseName}.*.env\n`));
}

// ---------------------------------------------------------------------------
// Surface resolution
// ---------------------------------------------------------------------------

/** Resolve the Surfaces config. Returns the concrete surfaces on
 *  success, or `null` when the user opted out of writing (cache-only
 *  mode). */
async function resolveSurfaces(opts: ProvisionOptions): Promise<Surfaces | null> {
  if (opts.surfaces === false) return null;
  if (opts.surfaces) return opts.surfaces;
  const needsEnvSurfaces = servicesNeedEnvSurfaces(opts.services);

  // Step 1 — project dir. Prefer the current Hatchkit project when cwd
  // is inside one; otherwise default to `./<baseName>` if it exists.
  const manifestGuess = inferProjectDir(process.cwd());
  const baseDirGuess = resolve(opts.baseName);
  const cwdGuess = looksLikeProjectDir(process.cwd()) ? process.cwd() : undefined;
  const guess =
    manifestGuess ?? (existsSync(baseDirGuess) ? baseDirGuess : (cwdGuess ?? baseDirGuess));
  const guessExists = existsSync(guess);
  const wantWrite = await confirm({
    message: needsEnvSurfaces
      ? guessExists
        ? `Write values into ${chalk.cyan(relativeTo(guess))} (prod → encrypted .env.production)?`
        : "Write values into a project directory?"
      : guessExists
        ? `Use ${chalk.cyan(relativeTo(guess))} as the project directory?`
        : "Use a project directory?",
    default: true,
  });
  if (!wantWrite) return null;

  const projectDir = resolve(
    (
      await input({
        message: "Project directory (relative to cwd):",
        default: guessExists ? relativeTo(guess) : `./${opts.baseName}`,
        validate: (v) => {
          const abs = resolve(v.trim());
          return existsSync(abs) ? true : `No such directory: ${abs}`;
        },
      })
    ).trim(),
  );
  if (!needsEnvSurfaces) return { mode: "client-only", projectDir };

  const manifest = readManifest(projectDir);
  const defaultMode: SurfaceMode =
    manifest?.surfaces === "server-only"
      ? "server-only"
      : manifest?.surfaces === "client-only"
        ? "client-only"
        : "shared";

  // Step 2 — surfaces.
  const mode = (await select<SurfaceMode>({
    message: "What surfaces does this project have?",
    choices: [
      {
        name: "Server + client — shared observability project (recommended)",
        value: "shared",
      },
      { name: "Server only", value: "server-only" },
      { name: "Client only", value: "client-only" },
      {
        name: "Server + client — separate projects per surface (strict isolation)",
        value: "separate",
      },
    ],
    default: defaultMode,
  })) as SurfaceMode;

  // Step 3 — env dirs per surface. Auto-detect common monorepo layouts
  // (packages/server, apps/web, etc.) and offer the first match as the
  // default.
  const surfaces: Surfaces = { mode, projectDir };
  if (mode === "server-only" || mode === "shared" || mode === "separate") {
    const def = detectSurfaceDir(projectDir, [
      "packages/server",
      "apps/server",
      "apps/api",
      "server",
      "", // project root fallback
    ]);
    surfaces.serverEnvDir = resolve(
      projectDir,
      (
        await input({
          message: "Server env directory (relative to project root):",
          default: def,
          validate: (v) => {
            const abs = resolve(projectDir, v.trim());
            return existsSync(abs) ? true : `No such directory: ${abs}`;
          },
        })
      ).trim(),
    );
  }
  if (mode === "client-only" || mode === "shared" || mode === "separate") {
    const def = detectSurfaceDir(projectDir, [
      "packages/client",
      "packages/web",
      "apps/web",
      "apps/client",
      "client",
      "web",
      "", // project root fallback
    ]);
    surfaces.clientEnvDir = resolve(
      projectDir,
      (
        await input({
          message: "Client env directory (relative to project root):",
          default: def,
          validate: (v) => {
            const abs = resolve(projectDir, v.trim());
            return existsSync(abs) ? true : `No such directory: ${abs}`;
          },
        })
      ).trim(),
    );
  }
  return surfaces;
}

async function resolvePlausibleDomain(
  opts: ProvisionOptions,
  surfaces: Surfaces | null,
): Promise<string | undefined> {
  if (opts.domain) return opts.domain.trim().toLowerCase();

  if (surfaces?.projectDir) {
    try {
      const { readManifest } = await import("../scaffold/manifest.js");
      const manifest = readManifest(surfaces.projectDir);
      if (manifest?.domain) return manifest.domain.trim().toLowerCase();
    } catch {
      // Fall through to prompt below.
    }
  }

  const picked = (
    await input({
      message: "Plausible site domain:",
      default: `${opts.baseName}.com`,
      validate: (v) => validateDomain(v.trim()),
    })
  ).trim();
  return picked ? picked.toLowerCase() : undefined;
}

function servicesNeedEnvSurfaces(services: ProvisionService[]): boolean {
  return services.some((service) =>
    ["glitchtip", "openpanel", "plausible", "resend", "s3"].includes(service),
  );
}

function looksLikeProjectDir(dir: string): boolean {
  return [
    "package.json",
    ".git",
    "CNAME",
    "public/CNAME",
    "static/CNAME",
    "docs/CNAME",
    "site/CNAME",
  ].some((relPath) => existsSync(join(dir, relPath)));
}

function normalizeSearchConsoleDomainCandidate(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  let candidate = raw;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    try {
      candidate = new URL(candidate).hostname;
    } catch {
      return undefined;
    }
  } else {
    candidate = candidate.split(/[/?#]/)[0] ?? candidate;
  }
  candidate = candidate.replace(/^\*\./, "").replace(/\.$/, "").toLowerCase();
  return validateDomain(candidate) === true ? candidate : undefined;
}

function readSearchConsoleDomainCandidatesFromPackage(
  projectDir: string,
): SearchConsoleDomainGuess[] {
  const path = join(projectDir, "package.json");
  if (!existsSync(path)) return [];
  try {
    const pkg = JSON.parse(readFileSync(path, "utf-8")) as {
      name?: string;
      homepage?: string;
    };
    const out: SearchConsoleDomainGuess[] = [];
    const homepage = normalizeSearchConsoleDomainCandidate(pkg.homepage);
    if (homepage) out.push({ domain: homepage, source: "package.json homepage" });
    if (pkg.name) {
      for (const domain of domainCandidatesFromSlug(pkg.name.replace(/^@[^/]+\//, ""))) {
        out.push({ domain, source: "package.json name" });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function readSearchConsoleDomainCandidatesFromCname(
  projectDir: string,
): SearchConsoleDomainGuess[] {
  const paths = [
    "CNAME",
    "public/CNAME",
    "static/CNAME",
    "docs/CNAME",
    "docs/static/CNAME",
    "docs/public/CNAME",
    "site/CNAME",
    "www/CNAME",
  ];
  const out: SearchConsoleDomainGuess[] = [];
  for (const relPath of paths) {
    const path = join(projectDir, relPath);
    if (!existsSync(path)) continue;
    const domain = normalizeSearchConsoleDomainCandidate(
      readFileSync(path, "utf-8").split(/\r?\n/)[0],
    );
    if (domain) out.push({ domain, source: relPath });
  }
  return out;
}

function domainCandidatesFromSlug(value: string): string[] {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/^@[^/]+\//, "")
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return [];
  const out: string[] = [];
  const direct = normalizeSearchConsoleDomainCandidate(slug);
  if (direct) out.push(direct);
  const parts = slug.split("-").filter(Boolean);
  if (parts.length >= 2) {
    const tldGuess = `${parts.slice(0, -1).join("-")}.${parts.at(-1)}`;
    const domain = normalizeSearchConsoleDomainCandidate(tldGuess);
    if (domain) out.push(domain);
  }
  const dotCom = normalizeSearchConsoleDomainCandidate(`${slug}.com`);
  if (dotCom) out.push(dotCom);
  return [...new Set(out)];
}

async function readGitRemoteOrigin(projectDir: string): Promise<string | undefined> {
  try {
    const result = await exec("git", ["remote", "get-url", "origin"], {
      cwd: projectDir,
      silent: true,
    });
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}

function repoNameFromRemote(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const ssh = url.match(/^git@github\.com:[^/]+\/([^/]+?)(?:\.git)?$/);
  if (ssh) return ssh[1];
  const https = url.match(/^https?:\/\/github\.com\/[^/]+\/([^/]+?)(?:\.git)?(?:\/.*)?$/);
  return https?.[1];
}

export async function inferSearchConsoleDomainDefault(
  projectDir: string,
  baseName: string,
): Promise<SearchConsoleDomainGuess | null> {
  const candidates: SearchConsoleDomainGuess[] = [
    ...readSearchConsoleDomainCandidatesFromCname(projectDir),
    ...readSearchConsoleDomainCandidatesFromPackage(projectDir),
  ];

  const remoteName = repoNameFromRemote(await readGitRemoteOrigin(projectDir));
  if (remoteName) {
    candidates.push(
      ...domainCandidatesFromSlug(remoteName).map((domain) => ({
        domain,
        source: "git remote",
      })),
    );
  }

  candidates.push(
    ...domainCandidatesFromSlug(baseName).map((domain) => ({
      domain,
      source: "project name",
    })),
  );

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.domain)) continue;
    seen.add(candidate.domain);
    return candidate;
  }
  return null;
}

async function resolveSearchConsoleDomain(
  opts: ProvisionOptions,
  manifest: ReturnType<typeof readManifest>,
  projectDir: string | undefined,
): Promise<string> {
  const explicit = normalizeSearchConsoleDomainCandidate(opts.domain);
  if (explicit) return explicit;
  if (opts.domain) throw new Error(`Invalid Search Console domain: ${opts.domain}`);
  const fromManifest = normalizeSearchConsoleDomainCandidate(manifest?.domain);
  if (fromManifest) return fromManifest;
  if (manifest?.domain) throw new Error(`Invalid Search Console domain: ${manifest.domain}`);
  if (process.stdin.isTTY) {
    const guess = projectDir
      ? await inferSearchConsoleDomainDefault(projectDir, opts.baseName)
      : null;
    const fallback = domainCandidatesFromSlug(opts.baseName)[0] ?? `${opts.baseName}.com`;
    const answer = await input({
      message: guess ? `Search Console domain (${guess.source}):` : "Search Console domain:",
      default: guess?.domain ?? fallback,
      validate: (value) =>
        normalizeSearchConsoleDomainCandidate(value)
          ? true
          : "Enter a valid domain, for example example.com.",
    });
    const resolved = normalizeSearchConsoleDomainCandidate(answer);
    if (resolved) return resolved;
  }
  throw new Error(
    "Search Console domain is required. Pass --domain <domain>, or add `domain` to .hatchkit.json.",
  );
}

function detectMinimalManifestSurfaces(projectDir: string): ProjectManifest["surfaces"] {
  const hasServer = ["packages/server", "apps/server", "apps/api", "server"].some((dir) =>
    existsSync(join(projectDir, dir)),
  );
  const hasClient = [
    "packages/client",
    "packages/web",
    "apps/web",
    "apps/client",
    "client",
    "web",
  ].some((dir) => existsSync(join(projectDir, dir)));
  if (hasServer && hasClient) return "both";
  if (hasServer) return "server-only";
  if (hasClient) return "client-only";
  return "both";
}

function minimalSearchConsoleManifest(args: {
  projectDir: string;
  baseName: string;
  result: SearchConsoleProvisionResult;
  verifiedAt: string;
}): ProjectManifest {
  return {
    version: MANIFEST_VERSION,
    cliVersion: getCliVersion(),
    scaffoldedAt: new Date().toISOString(),
    name: args.baseName,
    domain: args.result.domain,
    features: [],
    mlServices: [],
    s3Provider: "none",
    deployTarget: "existing",
    surfaces: detectMinimalManifestSurfaces(args.projectDir),
    ports: { server: 3000, client: 5173 },
    integrations: {
      searchConsole: {
        domain: args.result.domain,
        siteUrl: args.result.siteUrl,
        verifiedAt: args.verifiedAt,
      },
    },
  };
}

export function writeSearchConsoleManifest(
  projectDir: string,
  manifest: ProjectManifest | null,
  baseName: string,
  result: SearchConsoleProvisionResult,
): void {
  const verifiedAt = new Date().toISOString();
  const searchConsole = {
    domain: result.domain,
    siteUrl: result.siteUrl,
    verifiedAt,
  };
  if (manifest) {
    writeManifest(projectDir, {
      ...manifest,
      domain: manifest.domain || result.domain,
      integrations: {
        ...manifest.integrations,
        searchConsole,
      },
    });
    return;
  }
  writeManifest(
    projectDir,
    minimalSearchConsoleManifest({ projectDir, baseName, result, verifiedAt }),
  );
}

async function resolveSearchConsoleTarget(
  opts: ProvisionOptions,
  surfaces: Surfaces | null,
): Promise<SearchConsoleTarget> {
  const projectDir = surfaces?.projectDir;
  if (projectDir && !existsSync(projectDir)) {
    throw new Error(`Search Console project dir does not exist: ${projectDir}`);
  }
  const manifest = projectDir ? readManifest(projectDir) : null;
  return {
    projectDir,
    domain: await resolveSearchConsoleDomain(opts, manifest, projectDir),
  };
}

function detectSurfaceDir(projectDir: string, candidates: string[]): string {
  for (const c of candidates) {
    if (existsSync(join(projectDir, c))) return c || ".";
  }
  return ".";
}

function inferProjectDir(startDir: string | undefined): string | undefined {
  if (!startDir) return undefined;
  let cur = startDir;
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(cur, MANIFEST_FILENAME))) return cur;
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return undefined;
}

function relativeTo(p: string, from = process.cwd()): string {
  const rel = relative(from, p);
  return rel === "" ? "." : rel.startsWith("..") ? p : `./${rel}`;
}

function initBuckets(surfaces: Surfaces | null): WriteBucket[] {
  if (!surfaces) {
    // Cache-only: still separate by surface label for readable output.
    return [
      { label: "server", envDir: "", prodLines: [], devLines: [] },
      { label: "client", envDir: "", prodLines: [], devLines: [] },
    ];
  }
  const out: WriteBucket[] = [];
  if (surfaces.serverEnvDir) {
    out.push({ label: "server", envDir: surfaces.serverEnvDir, prodLines: [], devLines: [] });
  }
  if (surfaces.clientEnvDir) {
    out.push({ label: "client", envDir: surfaces.clientEnvDir, prodLines: [], devLines: [] });
  }
  return out;
}

/** Append observability env lines to the right bucket(s). In default
 *  mode these go to prod only; `enableDevObs` mirrors them into dev
 *  too for wiring debugging. */
function pushObsLines(
  buckets: WriteBucket[],
  side: "server" | "client",
  lines: string[],
  enableDevObs: boolean,
): void {
  const bucket = buckets.find((b) => b.label === side);
  if (!bucket) return;
  bucket.prodLines.push(...lines);
  if (enableDevObs) bucket.devLines.push(...lines);
}

// ---------------------------------------------------------------------------
// Unprovision — inverse of runProvision. Deletes the -dev and -prod
// clients from each selected service, plus the local .env cache.
// ---------------------------------------------------------------------------

export interface UnprovisionOptions {
  baseName: string;
  services: ProvisionService[];
  /** Don't hit any API or remove any file — just print what would happen. */
  dryRun?: boolean;
  /** Project root for `s3` removal — needed to read the manifest's
   *  s3Buckets list so we can target each per-bucket token. Optional;
   *  when omitted, the keychain is swept by name pattern instead. */
  projectDir?: string;
}

export async function runUnprovision(opts: UnprovisionOptions): Promise<void> {
  const nameCheck = validateProjectName(opts.baseName);
  if (nameCheck !== true) throw new Error(`Invalid base name: ${nameCheck}`);

  // Configure providers before any spinner — same reasoning as runProvision.
  if (opts.services.includes("glitchtip")) await ensureGlitchtip();
  if (opts.services.includes("openpanel")) await ensureOpenpanel();
  if (opts.services.includes("plausible")) await ensurePlausible();
  if (opts.services.includes("resend")) await ensureResend();

  if (opts.dryRun) {
    console.log(chalk.yellow("\n  [dry-run] No clients will be deleted.\n"));
  }
  console.log(chalk.bold(`\n  ── Deleting ${opts.baseName} ─────────────────────────────\n`));

  // Observability: try the shared name first, then the -server/-client
  // split variants. Each `runDelete` quietly reports "already gone" on
  // a 404, so best-effort teardown covers both layouts.
  if (opts.services.includes("glitchtip")) {
    for (const name of observabilityNames(opts.baseName)) {
      await runDelete(`GlitchTip: deleting project ${name}`, opts.dryRun, () =>
        deleteGlitchtipClient(name),
      );
    }
  }
  if (opts.services.includes("openpanel")) {
    for (const name of observabilityNames(opts.baseName)) {
      await runDelete(`OpenPanel: deleting project ${name}`, opts.dryRun, () =>
        deleteOpenpanelClient(name),
      );
    }
  }
  if (opts.services.includes("plausible")) {
    await runDelete(`Plausible: deleting site for ${opts.baseName}`, opts.dryRun, () =>
      deletePlausibleSite(opts.baseName),
    );
  }
  // Resend keeps the -dev/-prod pair plus (optionally) two audiences.
  if (opts.services.includes("resend")) {
    for (const env of ["dev", "prod"] as const) {
      const name = `${opts.baseName}-${env}`;
      await runDelete(`Resend: deleting API key ${name}`, opts.dryRun, () =>
        deleteResendClient(name),
      );
    }
    for (const name of [opts.baseName, `${opts.baseName}-test`]) {
      await runDelete(`Resend: deleting audience ${name} (if present)`, opts.dryRun, () =>
        deleteResendAudience(name),
      );
    }
  }

  // Search Console: remove the property from the configured Google
  // account. Ownership verification is left alone; Google may share it
  // with other services/properties for the same domain.
  if (opts.services.includes("search-console")) {
    let domain: string | undefined;
    if (opts.projectDir) {
      const { readManifest } = await import("../scaffold/manifest.js");
      domain = readManifest(opts.projectDir)?.domain;
    }
    if (!domain) {
      console.log(
        chalk.yellow(
          "  Skipping Search Console — need --project-dir with .hatchkit.json to read the domain.",
        ),
      );
    } else {
      await runDelete(`Search Console: removing property for ${domain}`, opts.dryRun, () =>
        unprovisionSearchConsoleForDomain(domain),
      );
    }
  }

  // Email — delete every Email Routing rule on the project's zone that
  // matches an address on `<project-domain>`. MX/SPF/DMARC records and
  // the destination address are intentionally left in place: multiple
  // projects can share one zone, and the destination is a per-user
  // resource (CF revokes it via the dashboard, not per-project).
  if (opts.services.includes("email")) {
    if (opts.dryRun) {
      console.log(chalk.dim(`  would delete Email Routing rules for ${opts.baseName}'s domain`));
    } else {
      try {
        await unprovisionEmailForProject({ projectDir: opts.projectDir });
      } catch (err) {
        console.log(chalk.red(`  ✗ Email teardown: ${(err as Error).message}`));
      }
    }
  }

  // S3 / R2 — delete the per-bucket scoped tokens (CF API + keychain).
  if (opts.services.includes("s3")) {
    if (opts.dryRun) {
      console.log(chalk.dim(`  would delete per-bucket R2 tokens for ${opts.baseName}`));
    } else {
      try {
        const result = await unprovisionR2BucketTokens({
          projectName: opts.baseName,
          projectDir: opts.projectDir,
        });
        if (result.buckets.length === 0) {
          console.log(
            chalk.dim(`  · No R2 bucket tokens found for ${opts.baseName} — already gone`),
          );
        } else {
          for (const b of result.buckets) {
            const status = b.outcome === "deleted" ? chalk.green("✓") : chalk.dim("·");
            console.log(
              `  ${status} R2: deleted token for bucket ${b.bucketKey} (${b.outcome === "deleted" ? "deleted" : "already gone"})`,
            );
          }
        }
      } catch (err) {
        console.log(chalk.red(`  ✗ R2 token teardown: ${(err as Error).message}`));
      }
    }
  }

  // Clean up the local .env cache. Mirror runProvision's write locations.
  const outDir = join(dirname(getConfigPath()), "provisioned");
  const cachedPaths = [
    `${opts.baseName}.server.dev.env`,
    `${opts.baseName}.server.prod.env`,
    `${opts.baseName}.client.dev.env`,
    `${opts.baseName}.client.prod.env`,
    // Legacy pre-surfaces layout — clean up so re-runs don't leave junk.
    `${opts.baseName}.dev.env`,
    `${opts.baseName}.prod.env`,
  ];
  for (const name of cachedPaths) {
    const path = join(outDir, name);
    if (!existsSync(path)) continue;
    if (opts.dryRun) {
      console.log(chalk.dim(`  would remove ${path}`));
      continue;
    }
    rmSync(path);
    console.log(chalk.dim(`  ✓ removed ${path}`));
  }
  console.log();
}

/** Candidate project names for observability teardown. Covers the
 *  shared (single-project) and split (server/client) layouts so a
 *  single `hatchkit remove` cleans up either. */
function observabilityNames(baseName: string): string[] {
  return [baseName, `${baseName}-server`, `${baseName}-client`];
}

/** Tear down Email Routing rules for the project's zone. Reads the
 *  domain from `.hatchkit.json`. Best-effort: walks every rule on the
 *  zone and deletes those whose literal `to` matcher ends with
 *  `@<projectDomain>`. The catch-all, MX/SPF/DMARC, and the destination
 *  address are left intact — they're zone-level / account-level state
 *  that may belong to other projects on the same zone. */
async function unprovisionEmailForProject(args: { projectDir?: string }): Promise<void> {
  const { getDnsConfig } = await import("../config.js");
  const { readManifest } = await import("../scaffold/manifest.js");
  const { CloudflareApi } = await import("../utils/cloudflare-api.js");
  if (!args.projectDir) {
    console.log(chalk.dim("  · Skipping Email teardown — need a project dir to read the domain."));
    return;
  }
  const manifest = readManifest(args.projectDir);
  if (!manifest?.domain) {
    console.log(chalk.dim("  · Skipping Email teardown — manifest has no domain."));
    return;
  }
  const dns = await getDnsConfig();
  if (!dns?.apiToken) {
    console.log(
      chalk.yellow("  · Skipping Email teardown — DNS config / Cloudflare token missing."),
    );
    return;
  }
  const cf = new CloudflareApi({ token: dns.apiToken, accountId: dns.accountId });
  const zone = await cf.resolveZoneForName(manifest.domain);
  if (!zone) {
    console.log(chalk.dim(`  · No zone for ${manifest.domain} — nothing to tear down.`));
    return;
  }
  const rules = await cf.listEmailRoutingRules(zone.id);
  const suffix = `@${manifest.domain}`;
  const matching = rules.filter((r) =>
    r.matchers?.some(
      (m) =>
        m.type === "literal" &&
        m.field === "to" &&
        m.value?.toLowerCase().endsWith(suffix.toLowerCase()),
    ),
  );
  if (matching.length === 0) {
    console.log(chalk.dim(`  · No Email Routing rules to remove on ${manifest.domain}.`));
    return;
  }
  for (const rule of matching) {
    const id = rule.id ?? rule.tag;
    if (!id) continue;
    const address = rule.matchers?.find((m) => m.field === "to")?.value ?? "?";
    const result = await cf.deleteEmailRoutingRule(zone.id, id);
    const tag = result === "deleted" ? chalk.green("✓") : chalk.dim("·");
    console.log(`  ${tag} Email: deleted rule ${address}`);
  }
  console.log(
    chalk.dim(
      "  · MX / SPF / DMARC records and the destination address were left intact — they're zone-level / account-level state.",
    ),
  );
}

/** Run a delete via spinner, mapping "not-found" to a dim "already gone"
 *  so re-runs stay quiet. */
async function runDelete(
  label: string,
  dryRun: boolean | undefined,
  fn: () => Promise<"deleted" | "not-found">,
): Promise<void> {
  if (dryRun) {
    console.log(chalk.dim(`  would ${label.toLowerCase()}`));
    return;
  }
  const ora = (await import("ora")).default;
  const spinner = ora(label).start();
  try {
    const result = await fn();
    if (result === "deleted") {
      spinner.succeed(label);
    } else {
      spinner.info(`${label} — already gone`);
    }
  } catch (err) {
    spinner.fail(label);
    // Don't throw on one failure — a single service being flaky shouldn't
    // block the rest of the teardown.
    console.log(chalk.red(`    ${(err as Error).message}`));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withSpinner<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const ora = (await import("ora")).default;
  const spinner = ora(label).start();
  try {
    const res = await fn();
    spinner.succeed(label);
    return res;
  } catch (err) {
    spinner.fail(label);
    throw err;
  }
}

async function pickResendDomain(): Promise<ResendDomainSelection> {
  const domains = await listResendDomains();
  const sorted = [...domains].sort((a, b) => {
    const av = a.status === "verified" ? 0 : 1;
    const bv = b.status === "verified" ? 0 : 1;
    return av - bv || a.name.localeCompare(b.name);
  });

  const ADD_NEW = "__add_new__";
  const NONE = "";

  const choices = [
    ...sorted.map((d) => ({
      name: d.status === "verified" ? d.name : `${d.name}  ${chalk.dim(`(${d.status})`)}`,
      value: d.id,
    })),
    { name: chalk.cyan("＋ Add a new sending domain…"), value: ADD_NEW },
    { name: "— no domain restriction (account-wide) —", value: NONE },
  ];

  const picked = await select({
    message: "Resend sending domain (both keys will be scoped to it):",
    choices,
  });

  if (picked === NONE) return {};
  if (picked !== ADD_NEW) {
    const domain = sorted.find((d) => d.id === picked);
    return { id: picked, name: domain?.name };
  }

  // Add-new flow.
  const raw = await input({
    message: "New sending domain (bare domain — e.g. playtiao.com or mail.playtiao.com):",
    validate: (v) => {
      const n = normalizeDomainInput(v);
      if (!n) return "Enter a domain.";
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(n)) {
        return "That doesn't look like a valid domain.";
      }
      return true;
    },
  });
  const name = normalizeDomainInput(raw);
  const created = await withSpinner(`Resend: creating domain ${name}`, () =>
    createResendDomain(name),
  );
  console.log(
    chalk.yellow(
      `  ${created.name} created (status: ${created.status}). Add the DNS records in the Resend dashboard before sending — https://resend.com/domains/${created.id}`,
    ),
  );
  return { id: created.id, name: created.name };
}

/** Server env uses the plain names; browser env uses a `PUBLIC_`
 *  prefix (Vite / Astro / SvelteKit / Remix convention — bundlers
 *  typically only expose variables with this kind of prefix to
 *  browser code). The client SDK doesn't need OPENPANEL_CLIENT_SECRET
 *  — browser events are anonymous — so we omit it from the client
 *  bundle. */
function renderGlitchtipEnv(c: GlitchtipClient, forClient: boolean): string[] {
  return [`${forClient ? "PUBLIC_GLITCHTIP_DSN" : "GLITCHTIP_DSN"}=${c.dsn}`];
}

function renderOpenpanelEnv(c: OpenpanelClient, forClient: boolean): string[] {
  if (forClient) {
    return [`PUBLIC_OPENPANEL_API_URL=${c.apiUrl}`, `PUBLIC_OPENPANEL_CLIENT_ID=${c.clientId}`];
  }
  return [
    `OPENPANEL_API_URL=${c.apiUrl}`,
    `OPENPANEL_CLIENT_ID=${c.clientId}`,
    `OPENPANEL_CLIENT_SECRET=${c.clientSecret}`,
  ];
}

function renderPlausibleEnv(c: PlausibleSite): string[] {
  return [
    `PUBLIC_PLAUSIBLE_DOMAIN=${c.domain}`,
    `PUBLIC_PLAUSIBLE_SCRIPT_URL=${c.scriptUrl}`,
    `NEXT_PUBLIC_PLAUSIBLE_DOMAIN=${c.domain}`,
    `NEXT_PUBLIC_PLAUSIBLE_SCRIPT_URL=${c.scriptUrl}`,
  ];
}

function renderResendEnv(c: ResendClient): string[] {
  return [
    `RESEND_API_KEY=${c.apiKey}`,
    ...(c.domainName ? [`RESEND_FROM_EMAIL=noreply@${c.domainName}`] : []),
  ];
}
