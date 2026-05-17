import { confirm, input, select } from "@inquirer/prompts";
import chalk from "chalk";
import {
  ensureDefaultRootDomain,
  getCoolifyConfig,
  getDefaultRootDomain,
  getMlServices,
} from "./config.js";
import {
  type ProjectOnboardingPlan,
  onboardingPlanToProjectConfig,
  projectConfigToOnboardingPlan,
  renderOnboardingDeploymentModeSummary,
  renderOnboardingSurfaceSummary,
  summarizeOnboardingDomain,
  summarizeOnboardingFeatures,
} from "./onboarding/plan.js";
import { type OnboardingStepGroup, runProjectOnboardingReview } from "./onboarding/review.js";
import type { ProvisionService } from "./provision/index.js";
import { CoolifyApi, type CoolifyServer } from "./utils/coolify-api.js";
import { discoverPublicIps } from "./utils/coolify-server-ips.js";
import { multiselect } from "./utils/multiselect.js";
import {
  parseDomain,
  validateCoolifyDescription,
  validateDomain,
  validateProjectName,
} from "./utils/validate.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DeployTarget = "existing" | "new";
/** Where the project's runtime ultimately lives.
 *  · `coolify`        — provision (or reuse) a Coolify-managed host. The
 *                       default for full-stack and server-only projects;
 *                       drives the rest of the existing pipeline (Hetzner,
 *                       Mongo, GlitchTip, …).
 *  · `gh-pages`       — static-only deploy via GitHub Pages. Only offered
 *                       when `surfaces === "static"` — Pages has no
 *                       runtime, so a server-bearing project can't use it.
 *                       Skips Coolify/Hetzner/Mongo prompts entirely.
 *  · `scaffold-only`  — write files + (optionally) push to GitHub, no
 *                       deploy. Equivalent to today's `runDeployment: false`. */
export type DeploymentMode = "coolify" | "gh-pages" | "scaffold-only";
export type GitHubRepoVisibility = "private" | "public";
export type DnsProvider = "inwx" | "cloudflare" | "manual";
export type S3Provider = "hetzner" | "r2" | "aws" | "existing" | "none";
export type GpuPlatform = "modal" | "runpod" | "hf" | "replicate";

/** What kind of project is being scaffolded. Mirrors the shape used by
 *  `hatchkit adopt` so the manifest field is interchangeable across the
 *  two flows.
 *
 *  The four values disambiguate code topology (one package vs. split
 *  packages vs. single surface) from runtime shape (has a server
 *  runtime vs. pure static). The provisioner uses the latter to decide
 *  whether to mint server-side env (Resend keys, server-side
 *  observability DSNs, S3 tokens).
 *
 *  · `fullstack` — single repo with a server runtime: Next App Router,
 *                  SvelteKit, Nuxt. One package, server + client share
 *                  the bundle, observability is one project.
 *  · `split`     — distinct `/server` + `/client` packages, both with a
 *                  server runtime. Observability is split per surface
 *                  (strict isolation).
 *  · `backend`   — API / worker, no UI bundle. The client package is
 *                  stripped from the scaffold and Coolify routes only
 *                  the api host.
 *  · `static`    — gh-pages / S3+CDN / pure SPA. NO server runtime,
 *                  even if the framework supports one. Server-side
 *                  env-seeded providers (Resend, server-side GlitchTip,
 *                  S3 tokens) are skipped — there is no server to
 *                  consume them. */
export type Surface = "fullstack" | "split" | "backend" | "static";

export type Feature = "websocket" | "stripe" | "analytics" | "s3" | "desktop" | "mobile";
export type AnalyticsProvider = "glitchtip" | "openpanel" | "plausible";

/** Provider for transactional sends (signup confirmations, password
 *  resets, receipts — single-recipient). `listmonk-ses` is the combo
 *  path that delivers via SES with Listmonk's /api/tx wrapper around it.
 *  `none` means the user explicitly opted out — distinguishes a
 *  decision from a missing answer. */
export type EmailTransactionalProvider = "none" | "resend" | "listmonk-ses";
/** Provider for mailing-list broadcasts. SES alone has no list/audience
 *  management — broadcasting requires Listmonk (or Resend's Audiences
 *  feature) on top. */
export type EmailMailingListProvider = "none" | "resend" | "listmonk-ses";

/** Captured email intent for a project — answered once at create/adopt
 *  time and persisted into the manifest. Independent of the live
 *  `provisionServices` list because the user can opt into both needs
 *  but pick the same provider for both ("listmonk-ses" covers both),
 *  or pick different providers (rare but possible). */
export interface EmailIntent {
  transactional: EmailTransactionalProvider;
  mailingList: EmailMailingListProvider;
}

export const EMAIL_INTENT_NONE: EmailIntent = {
  transactional: "none",
  mailingList: "none",
};

export type MlService =
  | "3d-sam-objects"
  | "3d-sam-body"
  | "3d-hunyuan"
  | "3d-trellis"
  | "3d-extraction"
  | "subtitles"
  | "image-recognition"
  | "background-removal"
  | "custom-hf";

export interface ProjectConfig {
  name: string;
  /** Human-readable one-liner. Written to the root `package.json` and
   *  used as the Coolify project + application description. Empty falls
   *  back to Coolify's built-in default ("Adopted by hatchkit") and
   *  leaves package.json without a description field. */
  description?: string;
  domain: string;
  baseDomain: string;
  subdomain: string;

  /** What kind of project to scaffold. Defaults to `fullstack` (the
   *  full-stack starter layout). The narrower surfaces strip the
   *  unused package half + adjust the docker-compose / Coolify routing
   *  accordingly. See the `Surface` type for the per-value semantics. */
  surfaces: Surface;

  deployTarget: DeployTarget;
  serverId?: number;
  /** Coolify server uuid. Populated for `existing` deploys after we've
   *  resolved the server via /servers; downstream code (Coolify
   *  Mongo / app provisioning) can use it directly without a second
   *  IP-keyed lookup. */
  serverUuid?: string;
  /** Raw `ip` field as returned by Coolify's /servers — may be a
   *  Docker-internal hostname (`host.docker.internal`) on
   *  localhost-Coolify installs, so it's NOT safe to feed into DNS.
   *  Kept for diagnostics + as a coolify-mongo fallback (findServer
   *  matches the same string Coolify reports). For DNS / Terraform,
   *  use `serverIpv4` / `serverIpv6` below. */
  serverIp?: string;
  /** Validated, public-routable IPv4 of the Coolify box. Discovered
   *  from /servers/{uuid}/domains (preferred) or DNS resolution of
   *  the dashboard hostname. This is what Terraform's `target_ipv4`
   *  receives. */
  serverIpv4?: string;
  /** Validated, public-routable IPv6 of the Coolify box, when one
   *  is configured. Empty string when absent — the Cloudflare DNS
   *  module skips AAAA records on empty. */
  serverIpv6?: string;
  serverSize?: string;
  serverLocation?: string;

  features: Feature[];
  /** Project-scoped observability providers to provision during create
   *  when the `analytics` feature is selected. Defaults to the legacy
   *  create behavior (`glitchtip` only) unless the user opts into more. */
  analyticsProviders?: AnalyticsProvider[];
  /** Project-scoped third-party services to provision during create.
   *  Includes observability, transactional email, Cloudflare Email
   *  Routing, and Search Console. Uses the same service names as
   *  `hatchkit add` so create/adopt/add stay aligned. */
  provisionServices: ProvisionService[];
  s3Provider: S3Provider;
  s3ExistingEndpoint?: string;
  s3ExistingBucket?: string;
  s3ExistingAccessKey?: string;
  s3ExistingSecretKey?: string;
  s3ExistingRegion?: string;

  mlServices: MlService[];
  /** Subset of mlServices the user wants to redeploy even though the
   *  registry has them. Used to recover from stale entries (upstream
   *  service was deleted) or platform migrations. */
  forceRedeployMl: MlService[];
  /** Optional key→value map supplied for .env.production seeding
   *  (STRIPE_SECRET_KEY, SENTRY_DSN, etc.). Anything unsupplied lands
   *  as a plaintext CHANGE_ME_<KEY> placeholder that the user can
   *  encrypt later with `dotenvx set`. */
  envValues?: Record<string, string>;
  /** Where the production MongoDB lives:
   *    "coolify"  — hatchkit will provision a per-project MongoDB
   *                 container on Coolify after the app deploys, and
   *                 encrypt the resulting URL into .env.production.
   *    "external" — the user provides MONGODB_URI themselves
   *                 (Atlas, self-hosted, etc.).
   *  Defaults to "coolify" when runDeployment is true, "external"
   *  otherwise. */
  mongodbProvider?: "coolify" | "external";
  /** GPU platforms to deploy each ML service to. The first entry is
   *  the default backend at runtime; switch by setting `ML_BACKEND` on
   *  the deploy. Multi-select lets you side-by-side benchmark or fail
   *  over between Modal / RunPod / HF / Replicate. */
  gpuPlatforms?: GpuPlatform[];
  customHfModelId?: string;
  customHfGpuType?: string;

  scaffoldRepo: boolean;
  createGithubRepo: boolean;
  /** Visibility for repos created by `hatchkit create`. Defaults to
   *  private for backwards compatibility and safer first deploys. */
  githubRepoVisibility?: GitHubRepoVisibility;
  /** Whether to run `pnpm install` in the scaffolded repo right after
   *  files are written. Asked upfront in the stepper (rather than mid-
   *  scaffold) so the whole `hatchkit create` flow is non-blocking once
   *  the user proceeds — they can walk away while it runs. */
  installDeps: boolean;
  /** Where this project deploys. `coolify` (default) drives the existing
   *  Hetzner + Mongo + providers pipeline. `gh-pages` is only offered
   *  alongside `surfaces === "static"` and skips the Coolify path
   *  entirely in favour of `hatchkit gh-pages`. `scaffold-only` writes
   *  files but doesn't deploy. */
  deploymentMode: DeploymentMode;
  /** Derived from {@link deploymentMode} for back-compat with the many
   *  existing call sites that gate on a boolean: true when the mode
   *  triggers an actual deploy step (coolify / gh-pages), false when
   *  scaffold-only. New code should branch on `deploymentMode` directly. */
  runDeployment: boolean;
  /** Tailscale-served dev URL opt-in. When set, scaffold:
   *    · writes ~/.config/dev/projects/<slug>.caddy at the project's
   *      client dev port,
   *    · drops docs/dev-setup.md into the project explaining the host
   *      plumbing,
   *    · wraps next.config with `withLocalDev` from
   *      @hatchkit/dev-plugin-next and adds it as a dep.
   *  Absent → feature disabled for this project (no fragment, no
   *  plugin wiring, no docs). */
  localDev?: { slug: string; domain?: string };
  /** Captured email-intent — answered by `askEmailIntent()` during
   *  create/adopt, persisted in the manifest, drives downstream env
   *  rendering. Absent means the prompt wasn't asked (legacy / scripted
   *  flow); both fields being "none" means the user was asked and
   *  opted out of email entirely. */
  email?: EmailIntent;
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Main prompt flow
// ---------------------------------------------------------------------------

/** If a preset value is provided, use it. In non-interactive mode,
 *  fall back to the provided default (or throw if none). Otherwise
 *  run the interactive prompt. */
async function presetOrPrompt<T>(
  preset: T | undefined,
  nonInteractive: boolean,
  prompt: () => Promise<T>,
  fallback?: T,
): Promise<T> {
  if (preset !== undefined) return preset;
  if (nonInteractive) {
    if (fallback !== undefined) return fallback;
    throw new Error(
      "Required value missing in --config / flags and no default is available. Re-run without --yes to be prompted.",
    );
  }
  return prompt();
}

const ANALYTICS_PROVISION_SERVICES: readonly AnalyticsProvider[] = [
  "glitchtip",
  "openpanel",
  "plausible",
];

function isAnalyticsProvisionService(service: ProvisionService): service is AnalyticsProvider {
  return (ANALYTICS_PROVISION_SERVICES as readonly ProvisionService[]).includes(service);
}

function uniqueProvisionServices(services: ProvisionService[]): ProvisionService[] {
  return [...new Set(services)];
}

function analyticsProvidersFromServices(services: ProvisionService[]): AnalyticsProvider[] {
  return services.filter(isAnalyticsProvisionService);
}

// ---------------------------------------------------------------------------
// Email intent — what kind of email does this project send + via which
// provider. Answered once at create/adopt, persisted in the manifest.
//
// Two needs are independent: transactional (one-off sends like signup
// confirmation) and mailing list (broadcast to a subscriber audience).
// A project can want neither, either, or both. The chosen provider for
// each gets persisted so a later `hatchkit update` doesn't re-prompt
// every run.
// ---------------------------------------------------------------------------

export interface EmailNeeds {
  transactional: boolean;
  mailingList: boolean;
}

/** Translate the high-level "what do you need" question into
 *  per-need booleans. Four options (none / one / the other / both)
 *  rather than two separate yes-no prompts — same information, but
 *  shorter and copy-paste friendly. */
export async function askEmailNeeds(opts: {
  defaults?: EmailNeeds;
} = {}): Promise<EmailNeeds> {
  const choice = await select<"none" | "tx" | "ml" | "both">({
    message: "Email needs for this project:",
    default: emailNeedsToChoiceKey(opts.defaults ?? { transactional: false, mailingList: false }),
    choices: [
      { name: "None", value: "none" },
      { name: "Transactional only (signup confirmations, password resets, receipts)", value: "tx" },
      { name: "Mailing list only (broadcasts to subscribers)", value: "ml" },
      { name: "Transactional + mailing list (the newsletter-app pattern)", value: "both" },
    ],
  });
  return choiceKeyToEmailNeeds(choice);
}

function emailNeedsToChoiceKey(n: EmailNeeds): "none" | "tx" | "ml" | "both" {
  if (n.transactional && n.mailingList) return "both";
  if (n.transactional) return "tx";
  if (n.mailingList) return "ml";
  return "none";
}

function choiceKeyToEmailNeeds(c: "none" | "tx" | "ml" | "both"): EmailNeeds {
  return {
    transactional: c === "tx" || c === "both",
    mailingList: c === "ml" || c === "both",
  };
}

/** Per-need provider picker. Listmonk+SES is the recommended option
 *  because it's the sovereign-cheap path (SES is ~€0.10/1k vs Resend's
 *  €20/month entry tier) and Listmonk owns the subscribe/confirm/
 *  broadcast UI users expect. Resend stays available for users who'd
 *  rather pay for managed simplicity. */
export async function askEmailProvider(
  need: "transactional" | "mailingList",
  opts: {
    /** Existing answer, if any — surfaced as the default so a re-prompt
     *  doesn't undo a deliberate prior choice. */
    current?: EmailTransactionalProvider | EmailMailingListProvider;
  } = {},
): Promise<EmailTransactionalProvider | EmailMailingListProvider> {
  const label = need === "transactional" ? "transactional sends" : "mailing-list broadcasts";
  return select<EmailTransactionalProvider | EmailMailingListProvider>({
    message: `Provider for ${label}:`,
    default: opts.current ?? "listmonk-ses",
    choices: [
      {
        name: "Listmonk + SES — sovereign + cheap (recommended)",
        value: "listmonk-ses",
      },
      {
        name: "Resend — managed SaaS (€20/mo entry tier)",
        value: "resend",
      },
      { name: "None — skip", value: "none" },
    ],
  });
}

/** Higher-level helper: ask the needs question, then per-need provider
 *  questions only for the needs that came back true. Returns the full
 *  intent struct ready to drop into the manifest. */
export async function askEmailIntent(opts: {
  current?: EmailIntent;
} = {}): Promise<EmailIntent> {
  const needs = await askEmailNeeds({
    defaults: opts.current
      ? {
          transactional: opts.current.transactional !== "none",
          mailingList: opts.current.mailingList !== "none",
        }
      : undefined,
  });
  const transactional: EmailTransactionalProvider = needs.transactional
    ? ((await askEmailProvider("transactional", {
        current: opts.current?.transactional,
      })) as EmailTransactionalProvider)
    : "none";
  const mailingList: EmailMailingListProvider = needs.mailingList
    ? ((await askEmailProvider("mailingList", {
        current: opts.current?.mailingList,
      })) as EmailMailingListProvider)
    : "none";
  return { transactional, mailingList };
}

async function collectExtraProvisionServices(args: {
  preset: ProvisionService[] | undefined;
  nonInteractive: boolean;
  surfaces: Surface;
  analyticsProviders: AnalyticsProvider[] | undefined;
}): Promise<ProvisionService[]> {
  if (args.preset !== undefined) return uniqueProvisionServices(args.preset);

  const baseServices: ProvisionService[] = args.analyticsProviders
    ? [...args.analyticsProviders]
    : [];
  if (args.nonInteractive) return uniqueProvisionServices(baseServices);

  const extra = await multiselect<ProvisionService>({
    message: "Email / launch services to provision now:",
    choices: [
      {
        name: "Resend (transactional email API keys)",
        value: "resend",
        checked: false,
        disabled:
          args.surfaces === "static" ? "server surface required for RESEND_API_KEY" : false,
      },
      {
        name: "Email forwarding (Cloudflare Email Routing → your inbox)",
        value: "email",
        checked: false,
      },
      {
        name: "Google Search Console (DNS verification + domain property)",
        value: "search-console",
        checked: false,
      },
    ],
  });

  return uniqueProvisionServices([...baseServices, ...extra]);
}

async function promptProvisionServicesEditor(cfg: ProjectConfig): Promise<ProvisionService[]> {
  return multiselect<ProvisionService>({
    message: "Services to provision now:",
    choices: [
      {
        name: "GlitchTip (error tracking)",
        value: "glitchtip",
        checked: cfg.provisionServices.includes("glitchtip"),
      },
      {
        name: "OpenPanel (product analytics)",
        value: "openpanel",
        checked: cfg.provisionServices.includes("openpanel"),
      },
      {
        name: "Plausible (web analytics)",
        value: "plausible",
        checked: cfg.provisionServices.includes("plausible"),
        disabled: cfg.surfaces === "backend" ? "client surface required" : false,
      },
      {
        name: "Resend (transactional email API keys)",
        value: "resend",
        checked: cfg.provisionServices.includes("resend"),
        disabled:
          cfg.surfaces === "static" ? "server surface required for RESEND_API_KEY" : false,
      },
      {
        name: "Email forwarding (Cloudflare Email Routing → your inbox)",
        value: "email",
        checked: cfg.provisionServices.includes("email"),
      },
      {
        name: "Google Search Console (DNS verification + domain property)",
        value: "search-console",
        checked: cfg.provisionServices.includes("search-console"),
      },
    ],
  });
}

function summarizeProvisionServices(services: ProvisionService[]): string {
  return services.length > 0 ? services.join(", ") : chalk.dim("none");
}

export interface CollectOptions {
  dryRun?: boolean;
  /** Preset values to skip prompts for. Values here override defaults
   *  and skip the corresponding prompt entirely. */
  presets?: Partial<ProjectConfig>;
  /** Non-interactive mode: any missing value falls back to its
   *  default if one exists, else throws. */
  nonInteractive?: boolean;
  /** Hard-disable local-dev wiring, even though new projects default
   *  to enabling it. Used by `hatchkit create --no-local-dev`. */
  forceNoLocalDev?: boolean;
}

export async function collectProjectConfig(options: CollectOptions): Promise<ProjectConfig> {
  const presets = options.presets ?? {};
  const nonInteractive = options.nonInteractive ?? false;

  if (!nonInteractive) {
    console.log(chalk.bold("\n  ── New Project ─────────────────────────────────────────────\n"));
  }

  // Project basics
  const name = await presetOrPrompt(presets.name, nonInteractive, () =>
    input({ message: "Project name:", validate: (v) => validateProjectName(v) }),
  );
  // Validate preset name since we skipped the prompt's built-in check.
  const nameErr = validateProjectName(name);
  if (nameErr !== true) throw new Error(`--name invalid: ${nameErr}`);

  // One-line description. Written to package.json and used as the
  // Coolify project + application description. Empty is a valid choice
  // — Coolify falls back to its built-in blurb and we leave package.json
  // without a description field.
  const description = (
    await presetOrPrompt(
      presets.description,
      nonInteractive,
      () =>
        input({
          message: "Description (one-liner for package.json + Coolify, optional):",
          validate: validateCoolifyDescription,
        }),
      "",
    )
  ).trim();

  // Suggest `<name>.<root-domain>`. The root domain is captured once in
  // `hatchkit setup` so subsequent projects don't keep re-typing it.
  // Interactive flow lazy-prompts when missing; non-interactive reads
  // whatever's already stored and falls back to a generic placeholder.
  let rootDomain: string | null = null;
  if (!presets.domain) {
    rootDomain = nonInteractive ? getDefaultRootDomain() : await ensureDefaultRootDomain();
  }
  const suggestedDomain = rootDomain ? `${name}.${rootDomain}` : `${name}.example.com`;
  const domain = await presetOrPrompt(
    presets.domain,
    nonInteractive,
    () =>
      input({
        message: "Domain:",
        default: suggestedDomain,
        validate: (v) => validateDomain(v),
      }),
    suggestedDomain,
  );
  const domainErr = validateDomain(domain);
  if (domainErr !== true) throw new Error(`--domain invalid: ${domainErr}`);

  const { baseDomain, subdomain } = parseDomain(domain);

  // Surface — what kind of project this is. Same four-way choice that
  // `hatchkit adopt` exposes. The default is "fullstack" (the
  // full-stack starter layout); the narrower modes prune the unused
  // package and adjust docker-compose / Coolify routing accordingly.
  const surfaces = await presetOrPrompt<Surface>(
    presets.surfaces,
    nonInteractive,
    () =>
      select<Surface>({
        message: "What kind of project is this?",
        choices: [
          { name: "Full-stack (single package, server runtime)", value: "fullstack" },
          { name: "Split server + client packages (server runtime)", value: "split" },
          { name: "Backend only (API / worker, no UI bundle)", value: "backend" },
          { name: "Static (gh-pages / SPA — no server runtime)", value: "static" },
        ],
      }),
    "fullstack",
  );

  // Deployment mode — where this project ultimately runs. The
  // `gh-pages` option is *only* offered for `static` surfaces.
  // Pages has no runtime, so server-bearing projects can't deploy
  // there; we hide the option rather than offering it and then
  // having to refuse the choice mid-flow.
  const deploymentMode = await askDeploymentMode(surfaces, presets.deploymentMode, nonInteractive);

  // gh-pages takes a different path than the Coolify pipeline: no
  // server provisioning, no Mongo, no features. Collect just the
  // basics, then fall through to the same review-and-edit loop the
  // Coolify path uses (with Coolify-specific groups hidden).
  if (deploymentMode === "gh-pages") {
    let pagesConfig = await collectPagesProjectConfig({
      name,
      domain,
      baseDomain,
      subdomain,
      surfaces,
      deploymentMode,
      presets,
      nonInteractive,
      dryRun: options.dryRun || false,
    });
    if (!nonInteractive) {
      pagesConfig = await reviewAndEditLoop(pagesConfig);
    }
    return pagesConfig;
  }

  // Deploy target. Non-interactive default is "new" rather than
  // "existing": "existing" has no sensible default (it needs a real
  // serverId + serverIp that only make sense with a configured
  // Coolify), while "new" provisions a Hetzner server with defaults
  // (cpx21, nbg1). Users who want existing pass `--deploy-target
  // existing` + serverId/serverIp via --config.
  const deployTarget = await presetOrPrompt(
    presets.deployTarget,
    nonInteractive,
    selectDeployTarget,
    "new",
  );

  let serverId: number | undefined;
  let serverUuid: string | undefined;
  let serverIp: string | undefined;
  let serverIpv4: string | undefined;
  let serverIpv6: string | undefined;
  let serverSize: string | undefined;
  let serverLocation: string | undefined;

  if (deployTarget === "existing") {
    if (presets.serverId !== undefined && presets.serverIp !== undefined) {
      serverId = presets.serverId;
      serverIp = presets.serverIp;
      // Trust presets when supplied: if the operator passes
      // serverIp via --config, treat it as the validated public
      // IPv4 (it has to be — they're driving Terraform with it).
      // Optional preset overrides keep the IPv6 / uuid path open.
      serverUuid = presets.serverUuid;
      serverIpv4 = presets.serverIpv4 ?? presets.serverIp;
      serverIpv6 = presets.serverIpv6;
    } else if (nonInteractive) {
      throw new Error(
        "--deploy-target existing requires serverId + serverIp in --config (or remove --yes to pick interactively).",
      );
    } else {
      const server = await selectExistingServer();
      serverId = server.id;
      serverUuid = server.uuid;
      serverIp = server.ip;
      serverIpv4 = server.ipv4;
      serverIpv6 = server.ipv6;
    }
  } else {
    serverSize = await presetOrPrompt(
      presets.serverSize,
      nonInteractive,
      () =>
        select({
          message: "Server size:",
          choices: [
            { name: "cpx21 — 3 vCPU / 4 GB (€4.35/mo)", value: "cpx21" },
            { name: "cpx31 — 4 vCPU / 8 GB (€8.10/mo)", value: "cpx31" },
            { name: "cpx41 — 8 vCPU / 16 GB (€15.90/mo)", value: "cpx41" },
          ],
        }),
      "cpx21",
    );
    serverLocation = await presetOrPrompt(
      presets.serverLocation,
      nonInteractive,
      () =>
        select({
          message: "Server location:",
          choices: [
            { name: "Nuremberg (nbg1) — Central Europe", value: "nbg1" },
            { name: "Falkenstein (fsn1) — Eastern Germany", value: "fsn1" },
            { name: "Helsinki (hel1) — Northern Europe", value: "hel1" },
          ],
        }),
      "nbg1",
    );
  }

  // Features
  const features = await presetOrPrompt(
    presets.features,
    nonInteractive,
    () =>
      multiselect<Feature>({
        message: "Features:",
        choices: [
          { name: "WebSocket/realtime (includes Redis)", value: "websocket" },
          { name: "Stripe billing", value: "stripe" },
          { name: "S3 file storage", value: "s3" },
          { name: "Analytics / observability providers", value: "analytics" },
          { name: "Desktop app (Electron + itch.io release)", value: "desktop" },
          { name: "Mobile app (Capacitor / iOS + Android)", value: "mobile" },
        ],
      }),
    [],
  );

  let analyticsProviders: AnalyticsProvider[] | undefined;
  if (features.includes("analytics")) {
    analyticsProviders = await presetOrPrompt(
      presets.analyticsProviders,
      nonInteractive,
      () =>
        multiselect<AnalyticsProvider>({
          message: "Analytics / observability providers to provision now:",
          choices: [
            { name: "GlitchTip (error tracking)", value: "glitchtip", checked: true },
            { name: "OpenPanel (product analytics)", value: "openpanel", checked: false },
            { name: "Plausible (web analytics)", value: "plausible", checked: false },
          ],
        }),
      ["glitchtip"],
    );
  }

  const provisionServices = await collectExtraProvisionServices({
    preset: presets.provisionServices,
    nonInteractive,
    surfaces,
    analyticsProviders,
  });
  if (!analyticsProviders) {
    const fromServices = analyticsProvidersFromServices(provisionServices);
    analyticsProviders = fromServices.length > 0 ? fromServices : undefined;
  }

  // S3 provider (if selected)
  let s3Provider: S3Provider = "none";
  let s3ExistingEndpoint: string | undefined;
  let s3ExistingBucket: string | undefined;
  let s3ExistingAccessKey: string | undefined;
  let s3ExistingSecretKey: string | undefined;
  let s3ExistingRegion: string | undefined;

  if (features.includes("s3")) {
    s3Provider = await presetOrPrompt(
      presets.s3Provider,
      nonInteractive,
      () =>
        select<S3Provider>({
          message: "S3 storage provider:",
          choices: [
            { name: "Hetzner Object Storage", value: "hetzner" },
            { name: "Cloudflare R2 (zero egress)", value: "r2" },
            { name: "AWS S3", value: "aws" },
            { name: "Use existing bucket", value: "existing" },
          ],
        }),
      "hetzner",
    );

    if (s3Provider === "existing") {
      // Existing-bucket credentials are never defaulted — these are
      // secrets and infrastructure coords that must be explicit.
      if (nonInteractive && (!presets.s3ExistingEndpoint || !presets.s3ExistingBucket)) {
        throw new Error(
          "--s3-provider existing requires s3ExistingEndpoint/Bucket/AccessKey/SecretKey/Region in --config.",
        );
      }
      s3ExistingEndpoint = await presetOrPrompt(presets.s3ExistingEndpoint, nonInteractive, () =>
        input({ message: "S3 endpoint URL:" }),
      );
      s3ExistingBucket = await presetOrPrompt(presets.s3ExistingBucket, nonInteractive, () =>
        input({ message: "S3 bucket name:" }),
      );
      s3ExistingAccessKey = await presetOrPrompt(presets.s3ExistingAccessKey, nonInteractive, () =>
        input({ message: "S3 access key:" }),
      );
      s3ExistingSecretKey = await presetOrPrompt(presets.s3ExistingSecretKey, nonInteractive, () =>
        input({ message: "S3 secret key:" }),
      );
      s3ExistingRegion = await presetOrPrompt(
        presets.s3ExistingRegion,
        nonInteractive,
        () => input({ message: "S3 region:", default: "us-east-1" }),
        "us-east-1",
      );
    }
  }

  // ML services
  const mlServices = await presetOrPrompt(
    presets.mlServices,
    nonInteractive,
    () =>
      multiselect<MlService>({
        message: "ML services:",
        choices: [
          {
            name: "3D — SAM 3D Objects (Meta, single image → mesh; SOTA real-image textures)",
            value: "3d-sam-objects",
          },
          {
            name: "3D — SAM 3D Body (Meta, single image → posed human body; apparel/try-on)",
            value: "3d-sam-body",
          },
          {
            name: "3D — Hunyuan3D 3.0 (Tencent, 8K PBR textures, open weights)",
            value: "3d-hunyuan",
          },
          {
            name: "3D — TRELLIS 2 (Microsoft, sparse-voxel geometry, strong topology)",
            value: "3d-trellis",
          },
          {
            name: "3D — TripoSR (legacy, fast but lower quality)",
            value: "3d-extraction",
          },
          { name: "Subtitle generation (audio/video → SRT)", value: "subtitles" },
          { name: "Image recognition", value: "image-recognition" },
          { name: "Background removal", value: "background-removal" },
          { name: "Custom HuggingFace model", value: "custom-hf" },
        ],
      }),
    [],
  );

  let gpuPlatforms: GpuPlatform[] | undefined;
  let customHfModelId: string | undefined;
  let customHfGpuType: string | undefined;

  const forceRedeploy = new Set<MlService>();
  if (mlServices.length > 0) {
    // Check for existing services in registry
    const registry = getMlServices();
    const reusable = mlServices.filter((s) => registry[s]);
    if (reusable.length > 0) {
      console.log(chalk.dim(`\n  Found existing ML services in registry:`));
      for (const svc of reusable) {
        const entry = registry[svc];
        console.log(
          chalk.dim(
            `    ${svc}: ${entry.endpoint} (${entry.platform}, deployed ${entry.deployedAt})`,
          ),
        );
      }
      // Let the user force re-deploy — covers stale entries (service
      // was deleted upstream) or platform changes.
      const toRedeploy = await multiselect<MlService>({
        message: "Redeploy any of these (leave empty to reuse all)?",
        choices: reusable.map((s) => ({ name: s, value: s })),
      });
      for (const s of toRedeploy) forceRedeploy.add(s);
    }

    const needsDeploy = mlServices.filter((s) => !registry[s] || forceRedeploy.has(s));
    if (needsDeploy.length > 0) {
      gpuPlatforms = await presetOrPrompt(
        presets.gpuPlatforms,
        nonInteractive,
        () =>
          multiselect<GpuPlatform>({
            message:
              "GPU platforms to deploy to (multi-select — first becomes default ML_BACKEND):",
            choices: [
              {
                name: "Modal (recommended — best DX, $30/mo free, 2-4s cold starts)",
                value: "modal",
                checked: true,
              },
              { name: "RunPod Serverless (cheapest, Docker-native)", value: "runpod" },
              { name: "HuggingFace Inference Endpoints (simplest for HF models)", value: "hf" },
              { name: "Replicate (via Cog, good for sharing)", value: "replicate" },
            ],
            required: true,
          }),
        ["modal"],
      );
    }

    if (mlServices.includes("custom-hf")) {
      customHfModelId = await presetOrPrompt(presets.customHfModelId, nonInteractive, () =>
        input({ message: "HuggingFace model ID (e.g. meta-llama/Llama-3-8B):" }),
      );
      customHfGpuType = await presetOrPrompt(
        presets.customHfGpuType,
        nonInteractive,
        () =>
          select({
            message: "GPU type for custom model:",
            choices: [
              { name: "T4 (16GB VRAM, cheapest)", value: "T4" },
              { name: "A10G (24GB VRAM, good balance)", value: "A10G" },
              { name: "A100 (40/80GB VRAM, large models)", value: "A100" },
              { name: "H100 (80GB VRAM, fastest)", value: "H100" },
            ],
          }),
        "A10G",
      );
    }
  }

  // Scaffold options
  const scaffoldRepo = await presetOrPrompt(
    presets.scaffoldRepo,
    nonInteractive,
    () => confirm({ message: "Scaffold app repo?", default: true }),
    true,
  );

  let createGithubRepo = false;
  let githubRepoVisibility: GitHubRepoVisibility | undefined;
  if (scaffoldRepo) {
    createGithubRepo = await presetOrPrompt(
      presets.createGithubRepo,
      nonInteractive,
      () =>
        confirm({
          message: "Create GitHub remote repo?",
          default: true,
        }),
      true,
    );
    if (createGithubRepo) {
      githubRepoVisibility = await presetOrPrompt(
        presets.githubRepoVisibility,
        nonInteractive,
        () => promptGithubRepoVisibility("GitHub repo visibility:"),
        "public",
      );
    }
  }

  // Ask about pnpm install BEFORE we proceed — we used to ask this
  // mid-scaffold, which broke "kick off create and walk away" flows.
  // The actual install runs later in handleCreate; we just capture the
  // user's preference here so the rest of the flow is uninterrupted.
  const installDeps = scaffoldRepo
    ? await presetOrPrompt(
        presets.installDeps,
        nonInteractive,
        () => confirm({ message: "Run pnpm install after scaffolding?", default: true }),
        true,
      )
    : false;

  // Tailscale-served local-dev URL opt-in. Default true: the integration
  // wires this project up to `https://<slug>.local.<project-base-domain>/` so
  // phones / tablets on the tailnet can reach the dev server with no
  // per-project DNS or port wrangling. The host-wide plumbing (Caddy,
  // tailscale serve, plist) is a one-time setup the user runs via
  // `hatchkit dev-setup init` — disabling the per-project opt-in here
  // skips writing the Caddy fragment and the plugin wiring, leaving the
  // project untouched by the integration.
  const { localDevDomainFromProjectDomain, localDevUrl, sanitiseSlug } = await import(
    "@hatchkit/dev-shared"
  );
  const localDevDomain = localDevDomainFromProjectDomain(domain) ?? undefined;
  let localDev: { slug: string; domain?: string } | undefined;
  if (options.forceNoLocalDev) {
    localDev = undefined;
  } else if (presets.localDev !== undefined) {
    const slugSource = presets.localDev.slug || name;
    localDev = {
      slug: sanitiseSlug(slugSource),
      domain: presets.localDev.domain ?? localDevDomain,
    };
  } else if (!nonInteractive) {
    const enableLocalDev = await confirm({
      message: `Enable Tailscale dev URL (${localDevUrl("<slug>", localDevDomain)})?`,
      default: true,
    });
    if (enableLocalDev) {
      const defaultSlug = sanitiseSlug(name);
      const slug = await input({
        message: "Slug (subdomain) for this project:",
        default: defaultSlug,
        validate: (v) => {
          const sanitised = sanitiseSlug(v);
          if (sanitised.length === 0) return "Slug must contain at least one [a-z0-9-] character.";
          if (sanitised !== v) return `Use only [a-z0-9-]. Did you mean "${sanitised}"?`;
          return true;
        },
      });
      localDev = { slug: sanitiseSlug(slug), domain: localDevDomain };
    }
  } else {
    localDev = { slug: sanitiseSlug(name), domain: localDevDomain };
  }

  // Late-stage "deploy now?" still makes sense for the Coolify path —
  // it lets a user pick the Coolify mode upfront but defer the actual
  // provisioning to a later run. For `scaffold-only` it's already
  // implied false. `gh-pages` exits via the short path above and never
  // reaches this branch.
  const runDeployment =
    deploymentMode === "scaffold-only" || options.dryRun
      ? false
      : await presetOrPrompt(
          presets.runDeployment,
          nonInteractive,
          () =>
            confirm({
              message: "Run deployment now?",
              default: true,
            }),
          true,
        );

  // MongoDB strategy: provisioned by Coolify (recommended for the
  // self-hosted path) vs. an external URI (Atlas, existing self-hosted
  // Mongo, etc.). When "coolify", we DON'T ask for MONGODB_URI here —
  // hatchkit provisions the container after the app deploys and writes
  // the encrypted URL into .env.production automatically.
  //
  // Static surfaces never reach Mongo (there's no server to read
  // MONGODB_URI), so the prompt is skipped and the field forced to
  // "external" — downstream provisioning checks gate on
  // `surfaces === "static"` and skip Mongo entirely.
  const mongodbProvider: "coolify" | "external" =
    surfaces === "static"
      ? "external"
      : await presetOrPrompt<"coolify" | "external">(
          presets.mongodbProvider,
          nonInteractive,
          () =>
            select<"coolify" | "external">({
              message: "Prod MongoDB:",
              choices: [
                {
                  name: "Provision a dedicated container on Coolify (recommended)",
                  value: "coolify",
                },
                {
                  name: "I'll provide a URI (Atlas, self-hosted, …)",
                  value: "external",
                },
              ],
              default: runDeployment ? "coolify" : "external",
            }),
          runDeployment ? "coolify" : "external",
        );

  // Production env values. Anything not supplied gets a plaintext
  // CHANGE_ME_<KEY> placeholder the user can encrypt later with
  // `dotenvx set`. In non-interactive mode we only take presets —
  // don't prompt. BETTER_AUTH_SECRET is auto-generated by the
  // dotenvx seed helper, not prompted.
  //
  // URLs are auto-derived from the chosen domain: the frontend lives
  // at the bare domain, the API at `/api` on the same domain. No
  // separate `api.<domain>` subdomain is required for Better Auth or
  // the SPA; the starter's server mounts at `/api/*` and the auth
  // library uses the bare URL as its base.
  const envValues: Record<string, string> = { ...(presets.envValues ?? {}) };
  envValues.FRONTEND_URL ??= `https://${domain}`;
  envValues.BETTER_AUTH_URL ??= `https://${domain}`;
  if (!nonInteractive) {
    if (scaffoldRepo) {
      console.log(chalk.bold("\n  ── Production env (press enter to leave as CHANGE_ME) ──────"));
      console.log(
        chalk.dim(
          `  FRONTEND_URL    https://${domain}\n  BETTER_AUTH_URL https://${domain}\n  ${chalk.italic("(auto-derived — both use the bare domain; the API is mounted at /api)")}`,
        ),
      );
      const askOptional = async (key: string, label: string): Promise<void> => {
        if (envValues[key]) return;
        const v = await input({
          message: `${label} [${key}]:`,
          default: "",
        });
        if (v.trim()) envValues[key] = v.trim();
      };
      // Only ask for MONGODB_URI when the user opted out of Coolify
      // provisioning — otherwise hatchkit fills it in post-deploy.
      // Static scaffolds have no server to consume the URI, so the
      // prompt is skipped entirely (mongodbProvider is forced to
      // "external" upstream but the value is never used).
      if (mongodbProvider === "external" && surfaces !== "static") {
        await askOptional("MONGODB_URI", "MongoDB URI");
      }
      // STRIPE_* and GLITCHTIP_DSN / SENTRY_DSN are NOT prompted here:
      //   · Stripe — `provisionStripeProject` runs after scaffold, walks
      //     the user through per-project sandbox + live keys (paste once
      //     each), auto-mints webhook signing secrets via the master
      //     keys configured at `hatchkit setup` time, and writes
      //     sandbox creds to .env.development + live creds to
      //     .env.production (encrypted).
      //   · GlitchTip — the DSN is minted by `provisionGlitchtipClient`
      //     post-scaffold and written encrypted into .env.production.
      // The pre-flight in index.ts confirms each provider is configured.
      if (features.includes("s3") && s3Provider === "existing") {
        await askOptional("S3_ENDPOINT", "S3 endpoint");
        await askOptional("S3_BUCKET_NAME", "S3 bucket");
        await askOptional("AWS_ACCESS_KEY_ID", "AWS access key id");
        await askOptional("AWS_SECRET_ACCESS_KEY", "AWS secret access key");
      }
    }
  }

  let config: ProjectConfig = {
    name,
    description: description || undefined,
    domain,
    baseDomain,
    subdomain,
    surfaces,
    deployTarget,
    serverId,
    serverUuid,
    serverIp,
    serverIpv4,
    serverIpv6,
    serverSize,
    serverLocation,
    features,
    analyticsProviders,
    provisionServices,
    s3Provider,
    s3ExistingEndpoint,
    s3ExistingBucket,
    s3ExistingAccessKey,
    s3ExistingSecretKey,
    s3ExistingRegion,
    mlServices,
    forceRedeployMl: [...forceRedeploy],
    mongodbProvider,
    gpuPlatforms,
    customHfModelId,
    customHfGpuType,
    scaffoldRepo,
    createGithubRepo,
    githubRepoVisibility,
    installDeps,
    deploymentMode,
    runDeployment,
    envValues,
    localDev,
    dryRun: options.dryRun || false,
  };

  // Final review-and-edit loop. Lets the user step BACK and tweak any
  // headline choice before scaffold begins — mirrors the structure of
  // `hatchkit setup`'s stepper. Skipped in non-interactive mode.
  if (!nonInteractive) {
    config = await reviewAndEditLoop(config);
  }

  return config;
}

// ---------------------------------------------------------------------------
// Deployment-mode prompt + gh-pages short path
// ---------------------------------------------------------------------------

async function askDeploymentMode(
  surfaces: Surface,
  preset: DeploymentMode | undefined,
  nonInteractive: boolean,
): Promise<DeploymentMode> {
  // gh-pages requires static — Pages has no runtime. Validate
  // presets the same way so `--deployment-mode gh-pages` paired with
  // a server-bearing surface fails fast.
  if (preset === "gh-pages" && surfaces !== "static") {
    throw new Error(
      `--deployment-mode gh-pages requires --surfaces static (got: ${surfaces}). GitHub Pages serves static files only.`,
    );
  }
  if (preset !== undefined) return preset;
  if (nonInteractive) return "coolify";

  const choices: Array<{ name: string; value: DeploymentMode; description?: string }> = [
    {
      name: "Coolify — full-stack on Hetzner (Mongo / providers / Docker)",
      value: "coolify",
    },
  ];
  if (surfaces === "static") {
    choices.push({
      name: "GitHub Pages — static-only, served from your repo",
      value: "gh-pages",
    });
  }
  choices.push({
    name: "Scaffold only — write files, don't deploy",
    value: "scaffold-only",
  });

  return select<DeploymentMode>({
    message: "Where do you want to deploy?",
    choices,
    default: "coolify",
  });
}

interface PagesCollectArgs {
  name: string;
  domain: string;
  baseDomain: string;
  subdomain: string;
  surfaces: Surface;
  deploymentMode: DeploymentMode;
  presets: Partial<ProjectConfig>;
  nonInteractive: boolean;
  dryRun: boolean;
}

/** Minimal config collection for the `gh-pages` deployment mode.
 *  Skips every Coolify-tied prompt (server target, features, S3, ML,
 *  Mongo, env values) — Pages is a static-only deploy with no
 *  runtime, so none of those concepts apply. */
async function collectPagesProjectConfig(args: PagesCollectArgs): Promise<ProjectConfig> {
  const { name, domain, baseDomain, subdomain, surfaces, deploymentMode, presets, nonInteractive } =
    args;

  // gh-pages requires static. The check in askDeploymentMode
  // also catches this for presets, but defend against direct calls.
  if (surfaces !== "static") {
    throw new Error(`gh-pages deployment mode requires surfaces="static" (got: ${surfaces}).`);
  }

  const scaffoldRepo = await presetOrPrompt(
    presets.scaffoldRepo,
    nonInteractive,
    () => confirm({ message: "Scaffold the starter into ./<name>/?", default: true }),
    true,
  );

  let createGithubRepo = false;
  let githubRepoVisibility: GitHubRepoVisibility | undefined;
  if (scaffoldRepo) {
    createGithubRepo = await presetOrPrompt(
      presets.createGithubRepo,
      nonInteractive,
      () => confirm({ message: "Create GitHub remote repo?", default: true }),
      true,
    );
    if (createGithubRepo) {
      githubRepoVisibility = await presetOrPrompt(
        presets.githubRepoVisibility,
        nonInteractive,
        () => promptGithubRepoVisibility("GitHub repo visibility:"),
        "public",
      );
    }
  }

  const installDeps = scaffoldRepo
    ? await presetOrPrompt(
        presets.installDeps,
        nonInteractive,
        () => confirm({ message: "Run pnpm install after scaffolding?", default: true }),
        true,
      )
    : false;

  const provisionServices = await collectExtraProvisionServices({
    preset: presets.provisionServices,
    nonInteractive,
    surfaces,
    analyticsProviders: undefined,
  });

  // gh-pages always "deploys" when not in dry-run — there's no
  // late-stage opt-out the way coolify has. If they wanted to skip
  // deploy, they'd pick scaffold-only.
  const runDeployment = !args.dryRun;

  return {
    name,
    domain,
    baseDomain,
    subdomain,
    surfaces,
    // Placeholder — gh-pages doesn't use a Coolify server target.
    // Set to "new" rather than `undefined` so any incidental reads
    // (e.g. summary renderers) don't crash. Downstream code MUST
    // gate Coolify steps on `deploymentMode === "coolify"`.
    deployTarget: "new",
    features: [],
    provisionServices,
    s3Provider: "none",
    mlServices: [],
    forceRedeployMl: [],
    mongodbProvider: "external",
    scaffoldRepo,
    createGithubRepo,
    githubRepoVisibility,
    installDeps,
    deploymentMode,
    runDeployment,
    dryRun: args.dryRun,
  };
}

// ---------------------------------------------------------------------------
// Review-and-edit loop
// ---------------------------------------------------------------------------

/** Render the review-and-edit stepper for `hatchkit create`. Mirrors
 *  the layout of `hatchkit setup`'s onboarding stepper: grouped
 *  sections with ✓/· marks per step, a summary tail showing the
 *  current value, and a "Proceed" item at the bottom that closes the
 *  loop. Selecting any step re-runs only that section's prompt(s).
 *
 *  Loops until the user picks "Proceed" (or aborts via Ctrl-C, which
 *  inquirer turns into an exception caught by the outer handler).  */
async function reviewAndEditLoop(initial: ProjectConfig): Promise<ProjectConfig> {
  console.log(chalk.bold("\n  hatchkit create — review"));
  let latestConfig = initial;
  const reviewedPlan = await runProjectOnboardingReview({
    initial: projectConfigToOnboardingPlan(initial),
    intro: chalk.dim("  Pick any step to change a choice. Choose 'Proceed' to scaffold.\n"),
    proceedLabel: "Proceed — scaffold now",
    buildGroups: (plan) =>
      buildCreateStepGroups(plan, onboardingPlanToProjectConfig(plan, latestConfig)),
    editStep: async (plan, picked) => {
      const currentConfig = onboardingPlanToProjectConfig(plan, latestConfig);
      latestConfig = await editSection(currentConfig, picked);
      return projectConfigToOnboardingPlan(latestConfig);
    },
  });
  return onboardingPlanToProjectConfig(reviewedPlan, latestConfig);
}

type CreateStepGroup = OnboardingStepGroup;

function buildCreateStepGroups(plan: ProjectOnboardingPlan, cfg: ProjectConfig): CreateStepGroup[] {
  const isPages = plan.deployment.mode === "gh-pages";
  const groups: CreateStepGroup[] = [
    {
      title: "Project",
      steps: [
        {
          key: "name",
          label: "Project name",
          set: !!plan.identity.name,
          summary: plan.identity.name,
        },
        {
          key: "description",
          label: "Description",
          // Empty description is a deliberate choice (Coolify will use
          // its default blurb), so this step is always considered "set"
          // once the user has been past the initial prompt.
          set: true,
          summary: plan.identity.description ? plan.identity.description : chalk.dim("(none)"),
        },
        {
          key: "domain",
          label: "Domain",
          set: !!plan.identity.domain,
          summary: summarizeOnboardingDomain(plan),
        },
        {
          key: "surfaces",
          label: "Project type",
          set: !!plan.layout.surfaces,
          summary: renderOnboardingSurfaceSummary(plan.layout.surfaces),
        },
      ],
    },
    {
      title: "Deployment",
      steps: [
        {
          key: "deploymentMode",
          label: "Deployment mode",
          set: !!plan.deployment.mode,
          summary: renderOnboardingDeploymentModeSummary(plan.deployment.mode),
        },
        // The Coolify target picker is only relevant when the mode is
        // coolify. gh-pages and scaffold-only both skip it.
        ...(plan.deployment.mode === "coolify"
          ? [
              {
                key: "deployTarget",
                label: "Deploy target",
                set: plan.deployment.target === "existing" ? !!cfg.serverIp : !!cfg.serverSize,
                summary:
                  plan.deployment.target === "existing"
                    ? `existing server (${cfg.serverIpv4 ?? cfg.serverIp ?? "?"}${cfg.serverIpv6 ? ` · ${cfg.serverIpv6}` : ""})`
                    : `new Hetzner ${cfg.serverSize ?? "?"} (${cfg.serverLocation ?? "nbg1"})`,
              },
            ]
          : []),
      ],
    },
  ];

  // The Stack and ML/GPU groups don't apply to a gh-pages deploy —
  // it's static-only by definition, no features/Mongo/ML to wire.
  if (!isPages) {
    groups.push(
      {
        title: "Stack",
        steps: [
          {
            key: "features",
            label: "Features",
            set: true,
            summary: summarizeOnboardingFeatures(plan.provisioning.features),
          },
          {
            key: "services",
            label: "Services",
            set: true,
            summary: summarizeProvisionServices(cfg.provisionServices),
          },
          {
            key: "mongo",
            label: "MongoDB",
            set: !!cfg.mongodbProvider,
            summary:
              cfg.mongodbProvider === "coolify"
                ? "Coolify container (auto-provisioned)"
                : cfg.mongodbProvider === "external"
                  ? "external URI"
                  : "(unset)",
          },
        ],
      },
      {
        title: "ML & GPU",
        steps: [
          {
            key: "ml",
            label: "ML services",
            set: true,
            summary:
              cfg.mlServices.length > 0
                ? `${cfg.mlServices.join(", ")}  ${chalk.dim(`→ ${(cfg.gpuPlatforms ?? ["modal"]).join(", ")}`)}`
                : chalk.dim("none"),
          },
        ],
      },
    );
  }

  if (isPages) {
    groups.push({
      title: "Services",
      steps: [
        {
          key: "services",
          label: "Services",
          set: true,
          summary: summarizeProvisionServices(cfg.provisionServices),
        },
      ],
    });
  }

  groups.push({
    title: "Run",
    steps: [
      {
        key: "scaffoldFlags",
        label: isPages ? "Scaffold / GitHub / Install" : "Scaffold / GitHub / Install / Deploy",
        set: true,
        summary: isPages
          ? `scaffold=${plan.repo.writeProject ? "yes" : "no"} · github=${renderGithubCreateSummary(plan)} · install=${plan.repo.installDeps ? "yes" : "no"}`
          : `scaffold=${plan.repo.writeProject ? "yes" : "no"} · github=${renderGithubCreateSummary(plan)} · install=${plan.repo.installDeps ? "yes" : "no"} · deploy=${plan.deployment.runNow ? "yes" : "no"}`,
      },
    ],
  });

  return groups;
}

function renderGithubCreateSummary(plan: ProjectOnboardingPlan): string {
  if (!plan.repo.createGithubRepo) return "no";
  return plan.repo.githubRepoVisibility ?? "public";
}

/** Per-section editors — re-run the relevant prompt(s) and return an
 *  updated config. Each is intentionally minimal: just the field the
 *  user wanted to change, no cascading re-prompts. */
async function editSection(cfg: ProjectConfig, section: string): Promise<ProjectConfig> {
  if (section === "name") {
    const name = (
      await input({
        message: "Project name:",
        default: cfg.name,
        validate: validateProjectName,
      })
    ).trim();
    return { ...cfg, name };
  }
  if (section === "description") {
    const description = (
      await input({
        message: "Description (one-liner for package.json + Coolify, optional):",
        default: cfg.description ?? "",
        validate: validateCoolifyDescription,
      })
    ).trim();
    return { ...cfg, description: description || undefined };
  }
  if (section === "domain") {
    const rootHint = getDefaultRootDomain();
    const message = rootHint
      ? `Domain (e.g. ${cfg.name || "app"}.${rootHint}):`
      : "Domain (e.g. app.example.com):";
    const raw = (
      await input({
        message,
        default: cfg.domain,
        validate: validateDomain,
      })
    ).trim();
    const parsed = parseDomain(raw);
    return {
      ...cfg,
      domain: raw,
      baseDomain: parsed.baseDomain,
      subdomain: parsed.subdomain,
      // Re-derive auto-seeded URLs from the new domain.
      envValues: {
        ...cfg.envValues,
        FRONTEND_URL: `https://${raw}`,
        BETTER_AUTH_URL: `https://${raw}`,
      },
    };
  }
  if (section === "surfaces") {
    const next = await select<Surface>({
      message: "What kind of project is this?",
      choices: [
        { name: "Full-stack (single package, server runtime)", value: "fullstack" },
        { name: "Split server + client packages (server runtime)", value: "split" },
        { name: "Backend only (API / worker, no UI bundle)", value: "backend" },
        { name: "Static (gh-pages / SPA — no server runtime)", value: "static" },
      ],
      default: cfg.surfaces,
    });
    // Force mongodbProvider to "external" for static — there's no
    // server to read MONGODB_URI, so a Coolify-provisioned container
    // would be wasted. Switching away from static keeps the prior
    // value (the user can re-pick on the Mongo step if needed).
    //
    // Switching away from static also invalidates `gh-pages`
    // deployment mode (Pages requires a static-only project). Snap
    // it back to coolify in that case.
    const nextDeploymentMode =
      cfg.deploymentMode === "gh-pages" && next !== "static" ? "coolify" : cfg.deploymentMode;
    if (cfg.deploymentMode === "gh-pages" && next !== "static") {
      console.log(
        chalk.yellow(
          "  ⚠ gh-pages requires static surfaces — switched deployment mode back to coolify.",
        ),
      );
    }
    return {
      ...cfg,
      surfaces: next,
      mongodbProvider: next === "static" ? "external" : cfg.mongodbProvider,
      deploymentMode: nextDeploymentMode,
      runDeployment: nextDeploymentMode === "scaffold-only" ? false : cfg.runDeployment,
      provisionServices: cfg.provisionServices.filter(
        (service) =>
          !(next === "static" && service === "resend") &&
          !(next === "backend" && service === "plausible"),
      ),
    };
  }
  if (section === "deploymentMode") {
    const next = await askDeploymentMode(cfg.surfaces, undefined, false);
    if (next === cfg.deploymentMode) return cfg;
    // Switching INTO gh-pages clears the Coolify-shaped fields so
    // the review doesn't show stale Hetzner / Mongo / feature
    // choices that don't apply. The user can still edit them back
    // if they later switch to coolify mode.
    if (next === "gh-pages") {
      return {
        ...cfg,
        deploymentMode: next,
        runDeployment: !cfg.dryRun,
        deployTarget: "new",
        serverId: undefined,
        serverUuid: undefined,
        serverIp: undefined,
        serverIpv4: undefined,
        serverIpv6: undefined,
        serverSize: undefined,
        serverLocation: undefined,
        features: [],
        analyticsProviders: undefined,
        provisionServices: cfg.provisionServices.filter(
          (service) => service === "email" || service === "search-console",
        ),
        s3Provider: "none",
        mlServices: [],
        forceRedeployMl: [],
        mongodbProvider: "external",
        gpuPlatforms: undefined,
        customHfModelId: undefined,
        customHfGpuType: undefined,
      };
    }
    // Switching to coolify or scaffold-only just updates the mode +
    // derived `runDeployment`. Existing values (if any) are preserved
    // so the user can step through them in the review.
    return {
      ...cfg,
      deploymentMode: next,
      runDeployment: next === "scaffold-only" ? false : cfg.runDeployment,
    };
  }
  if (section === "features") {
    const next = await multiselect<Feature>({
      message: "Features:",
      choices: [
        {
          name: "websocket (real-time)",
          value: "websocket",
          checked: cfg.features.includes("websocket"),
        },
        { name: "stripe (payments)", value: "stripe", checked: cfg.features.includes("stripe") },
        {
          name: "analytics (GlitchTip + OpenPanel)",
          value: "analytics",
          checked: cfg.features.includes("analytics"),
        },
        { name: "s3 (object storage)", value: "s3", checked: cfg.features.includes("s3") },
        {
          name: "desktop (Electron wrapper)",
          value: "desktop",
          checked: cfg.features.includes("desktop"),
        },
        {
          name: "mobile (Capacitor wrapper)",
          value: "mobile",
          checked: cfg.features.includes("mobile"),
        },
      ],
    });
    let analyticsProviders = cfg.analyticsProviders;
    let provisionServices = cfg.provisionServices;
    if (!next.includes("analytics")) {
      analyticsProviders = undefined;
      provisionServices = provisionServices.filter(
        (service) => !isAnalyticsProvisionService(service),
      );
    } else if (!cfg.features.includes("analytics")) {
      analyticsProviders = await multiselect<AnalyticsProvider>({
        message: "Analytics / observability providers to provision now:",
        choices: [
          { name: "GlitchTip (error tracking)", value: "glitchtip", checked: true },
          { name: "OpenPanel (product analytics)", value: "openpanel", checked: false },
          { name: "Plausible (web analytics)", value: "plausible", checked: false },
        ],
      });
      provisionServices = uniqueProvisionServices([
        ...provisionServices.filter((service) => !isAnalyticsProvisionService(service)),
        ...analyticsProviders,
      ]);
    }
    return { ...cfg, features: next, analyticsProviders, provisionServices };
  }
  if (section === "services") {
    const provisionServices = await promptProvisionServicesEditor(cfg);
    const analyticsProviders = analyticsProvidersFromServices(provisionServices);
    return {
      ...cfg,
      provisionServices,
      analyticsProviders: analyticsProviders.length > 0 ? analyticsProviders : undefined,
      features:
        analyticsProviders.length > 0 && !cfg.features.includes("analytics")
          ? [...cfg.features, "analytics"]
          : cfg.features,
    };
  }
  if (section === "deployTarget") {
    const target = await selectDeployTarget();
    if (target === "existing") {
      const server = await selectExistingServer();
      return {
        ...cfg,
        deployTarget: "existing",
        serverId: server.id,
        serverUuid: server.uuid,
        serverIp: server.ip,
        serverIpv4: server.ipv4,
        serverIpv6: server.ipv6,
        serverSize: undefined,
        serverLocation: undefined,
      };
    }
    // New Hetzner
    const serverSize = await select({
      message: "Hetzner server size:",
      choices: [
        { name: "cpx11 (2 vCPU, 2GB RAM)", value: "cpx11" },
        { name: "cpx21 (3 vCPU, 4GB RAM, recommended)", value: "cpx21" },
        { name: "cpx31 (4 vCPU, 8GB RAM)", value: "cpx31" },
      ],
      default: cfg.serverSize ?? "cpx21",
    });
    return {
      ...cfg,
      deployTarget: "new",
      serverId: undefined,
      serverUuid: undefined,
      serverIp: undefined,
      serverIpv4: undefined,
      serverIpv6: undefined,
      serverSize,
      serverLocation: cfg.serverLocation ?? "nbg1",
    };
  }
  if (section === "ml") {
    const ml = await multiselect<MlService>({
      message: "ML services:",
      choices: [
        { name: "subtitles", value: "subtitles", checked: cfg.mlServices.includes("subtitles") },
        {
          name: "image-recognition",
          value: "image-recognition",
          checked: cfg.mlServices.includes("image-recognition"),
        },
        {
          name: "background-removal",
          value: "background-removal",
          checked: cfg.mlServices.includes("background-removal"),
        },
        {
          name: "3d-extraction",
          value: "3d-extraction",
          checked: cfg.mlServices.includes("3d-extraction"),
        },
      ],
    });
    let gpuPlatforms = cfg.gpuPlatforms;
    if (ml.length > 0) {
      gpuPlatforms = await multiselect<GpuPlatform>({
        message: "GPU platforms (first is default ML_BACKEND):",
        choices: [
          { name: "Modal", value: "modal", checked: gpuPlatforms?.includes("modal") ?? true },
          { name: "RunPod", value: "runpod", checked: gpuPlatforms?.includes("runpod") ?? false },
          { name: "HuggingFace", value: "hf", checked: gpuPlatforms?.includes("hf") ?? false },
          {
            name: "Replicate",
            value: "replicate",
            checked: gpuPlatforms?.includes("replicate") ?? false,
          },
        ],
        required: true,
      });
    }
    return { ...cfg, mlServices: ml, gpuPlatforms };
  }
  if (section === "mongo") {
    const next = await select<"coolify" | "external">({
      message: "Prod MongoDB:",
      choices: [
        { name: "Coolify container (recommended)", value: "coolify" },
        { name: "External URI (Atlas, self-hosted, …)", value: "external" },
      ],
      default: cfg.mongodbProvider ?? "coolify",
    });
    return { ...cfg, mongodbProvider: next };
  }
  if (section === "scaffoldFlags") {
    const scaffoldRepo = await confirm({
      message: "Scaffold the starter repo?",
      default: cfg.scaffoldRepo,
    });
    const createGithubRepo = scaffoldRepo
      ? await confirm({ message: "Create a GitHub repo?", default: cfg.createGithubRepo })
      : false;
    const githubRepoVisibility = createGithubRepo
      ? await promptGithubRepoVisibility("GitHub repo visibility:", cfg.githubRepoVisibility)
      : undefined;
    const installDeps = scaffoldRepo
      ? await confirm({
          message: "Run pnpm install after scaffolding?",
          default: cfg.installDeps,
        })
      : false;
    // "Deploy now?" is meaningful only for coolify — gh-pages always
    // runs the pages setup, scaffold-only never deploys.
    let runDeployment = cfg.runDeployment;
    if (cfg.deploymentMode === "coolify") {
      runDeployment = await confirm({
        message: "Run deployment now (Terraform + Coolify + ML)?",
        default: cfg.runDeployment,
      });
    } else if (cfg.deploymentMode === "gh-pages") {
      runDeployment = !cfg.dryRun;
    } else {
      runDeployment = false;
    }
    return {
      ...cfg,
      scaffoldRepo,
      createGithubRepo,
      githubRepoVisibility,
      installDeps,
      runDeployment,
    };
  }
  return cfg;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function promptGithubRepoVisibility(
  message: string,
  current: GitHubRepoVisibility | undefined = "public",
): Promise<GitHubRepoVisibility> {
  return select<GitHubRepoVisibility>({
    message,
    choices: [
      {
        name: "Public (recommended — zero extra setup)",
        value: "public",
        description: "Coolify clones over HTTPS; GHCR is made public after first push.",
      },
      {
        name: "Private",
        value: "private",
        description:
          "Needs a Coolify GitHub App source + GHCR pull credentials. Hatchkit walks you through it if missing.",
      },
    ],
    default: current ?? "public",
  });
}

async function selectDeployTarget(): Promise<DeployTarget> {
  return select({
    message: "Deploy to:",
    choices: [
      { name: "Existing Coolify server", value: "existing" as const },
      { name: "New Hetzner server", value: "new" as const },
    ],
  });
}

/** Pick an existing Coolify server AND discover its real public IPs.
 *
 *  Coolify's `/servers` endpoint reports `ip: "host.docker.internal"`
 *  on Docker-based installs — that's the container-internal alias for
 *  the Docker host, not a routable IPv4. Feeding it to Terraform's
 *  `target_ipv4` makes Cloudflare reject the A records. This helper
 *  resolves the server uuid + the validated public IPv4/IPv6 in one
 *  shot, so callers (initial create flow + review-edit) get a
 *  pre-validated picture they can hand straight to tfvars. The same
 *  discovery logic that `hatchkit adopt` uses, behind one shared
 *  module — see utils/coolify-server-ips.ts. */
export interface SelectedServer {
  /** Numeric id from /servers — what `serversCache` keys on. */
  id: number;
  /** Coolify uuid — needed for /servers/{uuid}/domains and direct
   *  application-/database-create calls. */
  uuid: string;
  /** Display name. */
  name: string;
  /** Raw `ip` from /servers (may be `host.docker.internal`). Kept for
   *  diagnostics and as a coolify-mongo fallback. */
  ip: string;
  /** Validated public IPv4 — fed to Terraform's `target_ipv4`. */
  ipv4?: string;
  /** Validated public IPv6 — fed to Terraform's `target_ipv6`. */
  ipv6?: string;
}

async function selectExistingServer(): Promise<SelectedServer> {
  const coolifyConfig = await getCoolifyConfig();

  if (!coolifyConfig?.url || !coolifyConfig?.token) {
    throw new Error("Coolify is not configured. Run hatchkit init first.");
  }

  const api = new CoolifyApi({ url: coolifyConfig.url, token: coolifyConfig.token });

  // Use cached server list if available, otherwise fetch live
  let servers: CoolifyServer[];
  if (coolifyConfig.serversCache && coolifyConfig.serversCache.length > 0) {
    servers = coolifyConfig.serversCache;
  } else {
    servers = await api.listServers();
  }

  if (servers.length === 0) {
    throw new Error(
      "No servers found in Coolify. Create one first or choose 'New Hetzner server'.",
    );
  }

  let chosen: CoolifyServer;
  if (servers.length === 1) {
    console.log(chalk.dim(`  Auto-selected server: ${servers[0].name} (${servers[0].ip})`));
    chosen = servers[0];
  } else {
    const serverId = await select({
      message: "Select server:",
      choices: servers.map((s) => ({
        name: `${s.name} (${s.ip})`,
        value: s.id,
      })),
    });
    chosen = servers.find((s) => s.id === serverId)!;
  }

  // Resolve uuid + discover public IPs. listServers/serversCache only
  // give us the numeric id; the uuid (and the real public_ipv4 /
  // public_ipv6) only come from /servers via findServer + the
  // /servers/{uuid}/domains endpoint.
  const resolved = await api.findServer({ ip: chosen.ip });
  if (!resolved) {
    throw new Error(`Couldn't resolve uuid for server "${chosen.name}" (${chosen.ip}).`);
  }
  const ips = await discoverPublicIps(api, resolved.uuid, chosen.ip);
  if (!ips.v4) {
    console.log(
      chalk.yellow(
        `  ⚠ Couldn't determine a public IPv4 for "${chosen.name}". DNS records can't be created until you set the server's public_ipv4 in the Coolify dashboard.`,
      ),
    );
  } else {
    const v6Note = ips.v6 ? ` · IPv6 ${ips.v6}` : "";
    console.log(chalk.dim(`  Resolved public IPv4: ${ips.v4}${v6Note}`));
  }

  return {
    id: chosen.id,
    uuid: resolved.uuid,
    name: chosen.name,
    ip: chosen.ip,
    ipv4: ips.v4,
    ipv6: ips.v6,
  };
}
