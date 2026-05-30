import { confirm, input, select } from "@inquirer/prompts";
import chalk from "chalk";
import {
  detectPersonalEmailLocalPart,
  getCoolifyConfig,
  getDefaultRootDomain,
  getMlServices,
  getPersonalEmailLocalPart,
} from "./config.js";
import { DEFAULT_CATCH_ALL, buildForwardPresets } from "./email/presets.js";
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
import { type Step, runSteps } from "./utils/step-runner.js";
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
 *  whether to mint server-side env (Listmonk/SES creds, server-side
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
 *                  env-seeded providers (Listmonk/SES, server-side
 *                  GlitchTip, S3 tokens) are skipped — there is no
 *                  server to consume them. */
export type Surface = "fullstack" | "split" | "backend" | "static";

export type Feature = "websocket" | "stripe" | "analytics" | "s3" | "desktop" | "mobile";
export type AnalyticsProvider = "glitchtip" | "openpanel" | "plausible";

/** Provider for transactional sends (signup confirmations, password
 *  resets, receipts — single-recipient). `listmonk-ses` is the canonical
 *  path: SES delivers; Listmonk's /api/tx wraps it with a templated
 *  subject + body. `none` means the user explicitly opted out —
 *  distinguishes a decision from a missing answer. */
export type EmailTransactionalProvider = "none" | "listmonk-ses";
/** Provider for mailing-list broadcasts. Listmonk owns list / subscriber /
 *  campaign management; SES is the SMTP relay it sends through. */
export type EmailMailingListProvider = "none" | "listmonk-ses";

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
  /** Override for the docker-compose service that receives the public
   *  domain on Coolify's dockercompose build pack. Almost always
   *  unset — `toManifest` derives a sensible default from `surfaces`
   *  via {@link defaultPublicServiceForSurfaces}. Only set this when a
   *  caller (preset, scripted flow) needs to pin a non-standard service
   *  name. See {@link ProjectManifest.publicService} for the full
   *  resolution chain. */
  publicService?: string;

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
  /** Which database engine the scaffolded server uses.
   *    "mongodb"  — Mongoose models + better-auth mongodb adapter (default).
   *    "postgres" — Drizzle ORM + pg + better-auth drizzle adapter.
   *  Picked in the stepper before the provider question; controls both
   *  template overlay during scaffold and which engine gets provisioned
   *  on Coolify. */
  dbEngine?: "mongodb" | "postgres";
  /** Where the production database lives (applies to whichever engine
   *  is chosen via {@link dbEngine}):
   *    "coolify"  — hatchkit will provision a per-project DB container
   *                 on Coolify after the app deploys, and encrypt the
   *                 resulting URL into .env.production.
   *    "external" — the user provides the connection URI themselves
   *                 (Atlas/Neon/Supabase/self-hosted/etc.).
   *  Defaults to "coolify" when runDeployment is true, "external"
   *  otherwise. */
  dbProvider?: "coolify" | "external";
  /** @deprecated Pre-postgres alias for {@link dbProvider}. Still
   *  accepted in presets (manifests, scripted callers) and mapped over;
   *  new code reads {@link dbProvider}. */
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
  /** Explicit GitHub owner for the scaffold's GHCR image refs. When set,
   *  bypasses the `git config` / `gh api user` fallbacks in
   *  `inferGhOwner`. Currently unset by the interactive prompt — kept
   *  optional so callers (tests, scripted flows, future "scaffold for
   *  this org" prompt) can pin the owner deterministically. */
  githubOwner?: string;
  /** Visibility for repos created by `hatchkit create`. Defaults to
   *  private for backwards compatibility and safer first deploys. */
  githubRepoVisibility?: GitHubRepoVisibility;
  /** Pre-resolved Coolify GitHub App source picked upfront in the
   *  stepper when the user selects a private repo + coolify deploy. Lets
   *  the Coolify setup step run unattended instead of pausing mid-deploy
   *  for the source picker / walkthrough. Cleared when visibility flips
   *  back to public or deployment mode changes off coolify. */
  coolifyGithubSource?: { uuid: string; htmlUrl?: string };
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
  /** Cloudflare Email Routing for the project domain (incoming mail
   *  → user's inbox). Answered up-front so the create execution phase
   *  doesn't block on the addresses/catch-all picker. When `enabled`
   *  is true, `"email"` is also added to `provisionServices` and the
   *  provision step uses these answers to call `runEmailSetupForDomain`
   *  non-interactively. */
  emailForwarding?: {
    enabled: boolean;
    addresses: string[];
    catchAll: boolean;
  };
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Main prompt flow
// ---------------------------------------------------------------------------

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
export async function askEmailNeeds(
  opts: {
    defaults?: EmailNeeds;
  } = {},
): Promise<EmailNeeds> {
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

/** Per-need provider picker. Listmonk + SES is the canonical path —
 *  Listmonk owns the subscribe/confirm/broadcast UI and the /api/tx
 *  wrapper; SES is the SMTP relay it delivers through. SES alone is
 *  ~€0.10/1k. The only other choice is opting out. */
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
      { name: "None — skip", value: "none" },
    ],
  });
}

/** Higher-level helper: ask the intent question once and map directly
 *  to the opinionated provider. Hatchkit only wires Listmonk + SES for
 *  both needs — same stack handles tx (`/api/tx`) and broadcasts
 *  (campaigns), so picking the same thing twice keeps the manifest
 *  simple and the env surface small. Opt-out lands as `"none"` on
 *  whichever need the user skipped. */
export async function askEmailIntent(opts: { current?: EmailIntent } = {}): Promise<EmailIntent> {
  const needs = await askEmailNeeds({
    defaults: opts.current
      ? {
          transactional: opts.current.transactional !== "none",
          mailingList: opts.current.mailingList !== "none",
        }
      : undefined,
  });
  return opinionatedIntentFromNeeds(needs);
}

/** Pure mapping from "what does this project need" → "which providers
 *  Hatchkit will wire". Exposed for the non-interactive code paths
 *  (presets / scripted create) that pass `email` in directly. */
export function opinionatedIntentFromNeeds(needs: EmailNeeds): EmailIntent {
  return {
    transactional: needs.transactional ? "listmonk-ses" : "none",
    mailingList: needs.mailingList ? "listmonk-ses" : "none",
  };
}

/** Project-level provision services implied by an email intent. The
 *  `none` cases drop their provider — keeping the list to just the
 *  services the user actually opted into. */
export function emailIntentToProvisionServices(email: EmailIntent): ProvisionService[] {
  const services = new Set<ProvisionService>();
  for (const p of [email.transactional, email.mailingList]) {
    if (p === "listmonk-ses") services.add("listmonk-ses");
  }
  return [...services];
}

/** Merge a fresh email intent into an existing provisionServices list.
 *  Strips any previously-recorded email providers so a "no email"
 *  re-answer removes the lingering services. Order is preserved for
 *  the non-email entries. */
export function mergeEmailIntoProvisionServices(
  existing: ProvisionService[],
  email: EmailIntent,
): ProvisionService[] {
  const stripped = existing.filter((s) => s !== "listmonk-ses");
  return uniqueProvisionServices([...stripped, ...emailIntentToProvisionServices(email)]);
}

/** Single-line render of an email intent for the review-edit summary
 *  row. "none" collapses to a dim "(none)". */
export function summarizeEmailIntent(email: EmailIntent | undefined): string {
  if (!email || (email.transactional === "none" && email.mailingList === "none")) {
    return chalk.dim("(none)");
  }
  const parts: string[] = [];
  if (email.transactional !== "none") {
    parts.push(`transactional → ${providerLabel(email.transactional)}`);
  }
  if (email.mailingList !== "none") {
    parts.push(`newsletter → ${providerLabel(email.mailingList)}`);
  }
  return parts.join(", ");
}

function providerLabel(p: EmailTransactionalProvider | EmailMailingListProvider): string {
  if (p === "listmonk-ses") return "Listmonk + SES";
  return "(none)";
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

  // The email provider (listmonk-ses) is handled by the dedicated
  // "Email" step. Inbound forwarding (Cloudflare Email Routing) is
  // handled by the dedicated "Email forwarding" step. The multi-select
  // here only covers the remaining domain/launch ops services.
  const extra = await multiselect<ProvisionService>({
    message: "Launch services to provision now:",
    choices: [
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
  // Listmonk + SES is edited via the dedicated "Email" review row.
  // Cloudflare Email Routing (inbound forwarding) is edited via the
  // dedicated "Email forwarding" review row. The two are kept off this
  // list so the user can't desynchronise the addresses/catch-all
  // answers from the `"email"` provisionService entry.
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
        name: "Google Search Console (DNS verification + domain property)",
        value: "search-console",
        checked: cfg.provisionServices.includes("search-console"),
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Email forwarding step — Cloudflare Email Routing (inbound mail)
// ---------------------------------------------------------------------------

/** Prompt for Cloudflare Email Routing settings up-front so the create
 *  execution phase doesn't block on the picker. Mirrors the choices
 *  the runtime `runEmailSetupForDomain` would have asked, except the
 *  domain comes from `c.domain` (not interactive) and the catch-all
 *  question follows the addresses one immediately so the user can
 *  step through both without context switches. */
async function askEmailForwardingStep(c: ProjectConfig): Promise<ProjectConfig> {
  const wantsForwarding = await confirm({
    message: `Set up email forwarding for ${chalk.cyan(c.domain)} (Cloudflare Email Routing → your inbox)?`,
    default: c.emailForwarding?.enabled ?? true,
  });
  if (!wantsForwarding) {
    const provisionServices = uniqueProvisionServices(
      c.provisionServices.filter((s) => s !== "email"),
    );
    return {
      ...c,
      emailForwarding: { enabled: false, addresses: [], catchAll: false },
      provisionServices,
    };
  }

  const personalAlias = getPersonalEmailLocalPart() ?? (await detectPersonalEmailLocalPart());
  const presetList = buildForwardPresets(personalAlias);
  const previouslyPicked = c.emailForwarding?.enabled ? c.emailForwarding.addresses : null;
  const addresses = await multiselect<string>({
    message: `Which addresses on ${c.domain} should forward to your inbox?`,
    choices: presetList.map((p) => ({
      name: `${p.localPart}@${c.domain} — ${p.description}`,
      value: p.localPart,
      checked: previouslyPicked ? previouslyPicked.includes(p.localPart) : p.defaultChecked,
    })),
    required: false,
  });
  const catchAll = await confirm({
    message: `Also enable catch-all (*@${c.domain} → your inbox)?`,
    default: c.emailForwarding?.enabled ? c.emailForwarding.catchAll : DEFAULT_CATCH_ALL,
  });
  const provisionServices = uniqueProvisionServices([...c.provisionServices, "email"]);
  return {
    ...c,
    emailForwarding: { enabled: true, addresses, catchAll },
    provisionServices,
  };
}

/** One-line render of the email-forwarding answer for the review summary. */
export function summarizeEmailForwarding(ef: ProjectConfig["emailForwarding"]): string {
  if (!ef || !ef.enabled) return chalk.dim("(off)");
  const list =
    ef.addresses.length > 0 ? ef.addresses.map((a) => `${a}@`).join(", ") : chalk.dim("(none)");
  const catchAll = ef.catchAll ? chalk.dim(" + catch-all") : "";
  return `${list}${catchAll}`;
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
  /** Runs after config is assembled but before the review loop (and
   *  again after each in-review edit). Use to run provider pre-flight
   *  checks so credentials are collected before "Proceed". Idempotent
   *  — already-configured providers return instantly. */
  beforeReview?: (config: ProjectConfig) => Promise<void>;
}

export async function collectProjectConfig(options: CollectOptions): Promise<ProjectConfig> {
  const presets = options.presets ?? {};
  const nonInteractive = options.nonInteractive ?? false;
  const dryRun = options.dryRun || false;

  if (!nonInteractive) {
    console.log(chalk.bold("\n  ── New Project ─────────────────────────────────────────────\n"));
  }

  // ── Non-interactive path: presets + defaults, no prompts ───────────
  if (nonInteractive) {
    return collectProjectConfigNonInteractive(options);
  }

  // ── Interactive path: sequential steps with undo ───────────────────
  // Each step prompts the user and returns updated config. Ctrl+C
  // inside any step goes back to the previous step. After all steps,
  // the existing review-and-edit loop lets the user tweak anything.

  const initial: ProjectConfig = {
    name: presets.name ?? "",
    description: presets.description,
    domain: presets.domain ?? "",
    baseDomain: "",
    subdomain: "",
    surfaces: presets.surfaces ?? "fullstack",
    deployTarget: presets.deployTarget ?? "new",
    serverId: presets.serverId,
    serverUuid: presets.serverUuid,
    serverIp: presets.serverIp,
    serverIpv4: presets.serverIpv4,
    serverIpv6: presets.serverIpv6,
    serverSize: presets.serverSize ?? "cpx21",
    serverLocation: presets.serverLocation ?? "nbg1",
    features: presets.features ?? [],
    analyticsProviders: presets.analyticsProviders,
    provisionServices: presets.provisionServices ?? [],
    s3Provider: presets.s3Provider ?? "none",
    s3ExistingEndpoint: presets.s3ExistingEndpoint,
    s3ExistingBucket: presets.s3ExistingBucket,
    s3ExistingAccessKey: presets.s3ExistingAccessKey,
    s3ExistingSecretKey: presets.s3ExistingSecretKey,
    s3ExistingRegion: presets.s3ExistingRegion,
    mlServices: presets.mlServices ?? [],
    forceRedeployMl: presets.forceRedeployMl ?? [],
    dbEngine: presets.dbEngine ?? "mongodb",
    dbProvider: presets.dbProvider ?? presets.mongodbProvider ?? "coolify",
    mongodbProvider: presets.mongodbProvider,
    gpuPlatforms: presets.gpuPlatforms,
    customHfModelId: presets.customHfModelId,
    customHfGpuType: presets.customHfGpuType,
    scaffoldRepo: presets.scaffoldRepo ?? true,
    createGithubRepo: presets.createGithubRepo ?? true,
    githubRepoVisibility: presets.githubRepoVisibility ?? "public",
    installDeps: presets.installDeps ?? true,
    deploymentMode: presets.deploymentMode ?? "coolify",
    runDeployment: presets.runDeployment ?? !dryRun,
    envValues: presets.envValues,
    localDev: options.forceNoLocalDev ? undefined : presets.localDev,
    email: presets.email,
    emailForwarding: presets.emailForwarding,
    dryRun,
  };

  const steps: Step<ProjectConfig>[] = [
    {
      name: "Project name",
      skip: () => !!presets.name,
      run: async (c) => {
        const name = (
          await input({
            message: "Project name:",
            default: c.name || undefined,
            validate: validateProjectName,
          })
        ).trim();
        const rootDomain = getDefaultRootDomain();
        const domain =
          !c.domain || (rootDomain && c.domain === `${c.name}.${rootDomain}`)
            ? rootDomain
              ? `${name}.${rootDomain}`
              : c.domain
            : c.domain;
        const parsed = parseDomain(domain);
        return { ...c, name, domain, baseDomain: parsed.baseDomain, subdomain: parsed.subdomain };
      },
    },
    {
      name: "Description",
      skip: () => presets.description !== undefined,
      run: async (c) => {
        const description = (
          await input({
            message: "Description (one-liner for package.json + Coolify, optional):",
            default: c.description ?? "",
            validate: validateCoolifyDescription,
          })
        ).trim();
        return { ...c, description: description || undefined };
      },
    },
    {
      name: "Domain",
      skip: () => presets.domain !== undefined,
      run: async (c) => {
        const domain = await input({
          message: "Domain:",
          default:
            c.domain ||
            (getDefaultRootDomain() ? `${c.name}.${getDefaultRootDomain()}` : undefined),
          validate: (v) => validateDomain(v),
        });
        const parsed = parseDomain(domain);
        return {
          ...c,
          domain,
          baseDomain: parsed.baseDomain,
          subdomain: parsed.subdomain,
          envValues: {
            ...c.envValues,
            FRONTEND_URL: `https://${domain}`,
            BETTER_AUTH_URL: `https://${domain}`,
          },
        };
      },
    },
    {
      name: "Project type",
      skip: () => presets.surfaces !== undefined,
      run: async (c) => {
        const surfaces = await select<Surface>({
          message: "What kind of project is this?",
          default: c.surfaces,
          choices: [
            { name: "Full-stack (single package, server runtime)", value: "fullstack" },
            { name: "Split server + client packages (server runtime)", value: "split" },
            { name: "Backend only (API / worker, no UI bundle)", value: "backend" },
            { name: "Static (gh-pages / SPA — no server runtime)", value: "static" },
          ],
        });
        return { ...c, surfaces };
      },
    },
    {
      name: "Deployment mode",
      skip: () => presets.deploymentMode !== undefined,
      run: async (c) => {
        const mode = await askDeploymentMode(c.surfaces, undefined, false);
        if (mode === "gh-pages") {
          return {
            ...c,
            deploymentMode: mode,
            runDeployment: !dryRun,
            features: [],
            s3Provider: "none" as const,
            mlServices: [],
            forceRedeployMl: [],
            dbProvider: "external" as const,
            mongodbProvider: "external" as const,
            // gh-pages has no server runtime — drop email providers + their
            // queued services so the manifest doesn't claim email intent
            // for a project that can't actually send mail.
            email: EMAIL_INTENT_NONE,
            provisionServices: c.provisionServices.filter((s) => s !== "listmonk-ses"),
          };
        }
        return {
          ...c,
          deploymentMode: mode,
          runDeployment: mode === "scaffold-only" ? false : c.runDeployment,
        };
      },
    },
    {
      name: "Deploy target",
      skip: (c) => c.deploymentMode !== "coolify" || presets.deployTarget !== undefined,
      run: async (c) => {
        const target = await selectDeployTarget();
        if (target === "existing") {
          const server = await selectExistingServer();
          return {
            ...c,
            deployTarget: "existing" as const,
            serverId: server.id,
            serverUuid: server.uuid,
            serverIp: server.ip,
            serverIpv4: server.ipv4,
            serverIpv6: server.ipv6,
            serverSize: undefined,
            serverLocation: undefined,
          };
        }
        return { ...c, deployTarget: "new" as const };
      },
    },
    {
      name: "Server size",
      skip: (c) =>
        c.deploymentMode !== "coolify" ||
        c.deployTarget !== "new" ||
        presets.serverSize !== undefined,
      run: async (c) => {
        const serverSize = await select({
          message: "Server size:",
          default: c.serverSize ?? "cpx21",
          choices: [
            { name: "cpx21 — 3 vCPU / 4 GB (€4.35/mo)", value: "cpx21" },
            { name: "cpx31 — 4 vCPU / 8 GB (€8.10/mo)", value: "cpx31" },
            { name: "cpx41 — 8 vCPU / 16 GB (€15.90/mo)", value: "cpx41" },
          ],
        });
        return { ...c, serverSize };
      },
    },
    {
      name: "Server location",
      skip: (c) =>
        c.deploymentMode !== "coolify" ||
        c.deployTarget !== "new" ||
        presets.serverLocation !== undefined,
      run: async (c) => {
        const serverLocation = await select({
          message: "Server location:",
          default: c.serverLocation ?? "nbg1",
          choices: [
            { name: "Nuremberg (nbg1) — Central Europe", value: "nbg1" },
            { name: "Falkenstein (fsn1) — Eastern Germany", value: "fsn1" },
            { name: "Helsinki (hel1) — Northern Europe", value: "hel1" },
          ],
        });
        return { ...c, serverLocation };
      },
    },
    {
      name: "Features",
      skip: (c) => c.deploymentMode === "gh-pages" || presets.features !== undefined,
      run: async (c) => {
        const features = await multiselect<Feature>({
          message: "Features:",
          choices: [
            {
              name: "WebSocket/realtime (includes Redis)",
              value: "websocket",
              checked: c.features.includes("websocket"),
            },
            { name: "Stripe billing", value: "stripe", checked: c.features.includes("stripe") },
            { name: "S3 file storage", value: "s3", checked: c.features.includes("s3") },
            {
              name: "Analytics / observability providers",
              value: "analytics",
              checked: c.features.includes("analytics"),
            },
            {
              name: "Desktop app (Electron + itch.io release)",
              value: "desktop",
              checked: c.features.includes("desktop"),
            },
            {
              name: "Mobile app (Capacitor / iOS + Android)",
              value: "mobile",
              checked: c.features.includes("mobile"),
            },
          ],
        });
        return { ...c, features };
      },
    },
    {
      name: "Analytics providers",
      skip: (c) => !c.features.includes("analytics") || presets.analyticsProviders !== undefined,
      run: async (c) => {
        const analyticsProviders = await multiselect<AnalyticsProvider>({
          message: "Analytics / observability providers to provision now:",
          choices: [
            {
              name: "GlitchTip (error tracking)",
              value: "glitchtip",
              checked: c.analyticsProviders?.includes("glitchtip") ?? true,
            },
            {
              name: "OpenPanel (product analytics)",
              value: "openpanel",
              checked: c.analyticsProviders?.includes("openpanel") ?? false,
            },
            {
              name: "Plausible (web analytics)",
              value: "plausible",
              checked: c.analyticsProviders?.includes("plausible") ?? false,
            },
          ],
        });
        const provisionServices = uniqueProvisionServices([
          ...c.provisionServices.filter((s) => !isAnalyticsProvisionService(s)),
          ...analyticsProviders,
        ]);
        return { ...c, analyticsProviders, provisionServices };
      },
    },
    {
      name: "Email",
      // Static / gh-pages projects have no server runtime, so
      // LISTMONK_*/SES_* env vars have nowhere to live. Skip the
      // email-intent prompt entirely in that case; the manifest gets
      // `{ transactional: "none", mailingList: "none" }`.
      skip: (c) =>
        c.surfaces === "static" || c.deploymentMode === "gh-pages" || presets.email !== undefined,
      run: async (c) => {
        const email = await askEmailIntent({ current: c.email });
        const provisionServices = mergeEmailIntoProvisionServices(c.provisionServices, email);
        return { ...c, email, provisionServices };
      },
    },
    {
      name: "Email forwarding",
      // Cloudflare Email Routing is DNS-only, so it works for any
      // deployment mode that has a real domain. Skip only when the
      // domain is missing or the preset already answered.
      skip: (c) => !c.domain || presets.emailForwarding !== undefined,
      run: async (c) => askEmailForwardingStep(c),
    },
    {
      name: "Extra services",
      skip: () => presets.provisionServices !== undefined,
      run: async (c) => {
        const extra = await collectExtraProvisionServices({
          preset: undefined,
          nonInteractive: false,
          surfaces: c.surfaces,
          analyticsProviders: c.analyticsProviders,
        });
        const merged = uniqueProvisionServices([
          ...c.provisionServices,
          ...(c.analyticsProviders ?? []),
          ...extra,
        ]);
        return { ...c, provisionServices: merged };
      },
    },
    {
      name: "S3 provider",
      skip: (c) => !c.features.includes("s3") || presets.s3Provider !== undefined,
      run: async (c) => {
        // Only Cloudflare R2 has a working `hatchkit add s3` bucket
        // provisioner today (see cli/src/provision/s3.ts) — Hetzner /
        // AWS used to be in this list but rejected at provision time
        // with "not yet supported". The collapsed prompt offers R2 by
        // default and an `existing` escape hatch for users bringing
        // their own bucket (any S3-API endpoint).
        const initial: "r2" | "existing" = c.s3Provider === "existing" ? "existing" : "r2";
        const s3Provider = await select<"r2" | "existing">({
          message: "S3 storage provider:",
          default: initial,
          choices: [
            { name: "Cloudflare R2 (zero egress) — recommended", value: "r2" },
            { name: "Use existing bucket (any S3-API endpoint)", value: "existing" },
          ],
        });
        return { ...c, s3Provider };
      },
    },
    {
      name: "S3 bucket details",
      skip: (c) => c.s3Provider !== "existing",
      run: async (c) => {
        const s3ExistingEndpoint = await input({
          message: "S3 endpoint URL:",
          default: c.s3ExistingEndpoint,
        });
        const s3ExistingBucket = await input({
          message: "S3 bucket name:",
          default: c.s3ExistingBucket,
        });
        const s3ExistingAccessKey = await input({
          message: "S3 access key:",
          default: c.s3ExistingAccessKey,
        });
        const s3ExistingSecretKey = await input({
          message: "S3 secret key:",
          default: c.s3ExistingSecretKey,
        });
        const s3ExistingRegion = await input({
          message: "S3 region:",
          default: c.s3ExistingRegion ?? "us-east-1",
        });
        return {
          ...c,
          s3ExistingEndpoint,
          s3ExistingBucket,
          s3ExistingAccessKey,
          s3ExistingSecretKey,
          s3ExistingRegion,
        };
      },
    },
    {
      name: "ML services",
      skip: (c) => c.deploymentMode === "gh-pages" || presets.mlServices !== undefined,
      run: async (c) => {
        const mlServices = await multiselect<MlService>({
          message: "ML services:",
          choices: [
            {
              name: "3D — SAM 3D Objects (Meta, single image → mesh; SOTA real-image textures)",
              value: "3d-sam-objects",
              checked: c.mlServices.includes("3d-sam-objects"),
            },
            {
              name: "3D — SAM 3D Body (Meta, single image → posed human body; apparel/try-on)",
              value: "3d-sam-body",
              checked: c.mlServices.includes("3d-sam-body"),
            },
            {
              name: "3D — Hunyuan3D 3.0 (Tencent, 8K PBR textures, open weights)",
              value: "3d-hunyuan",
              checked: c.mlServices.includes("3d-hunyuan"),
            },
            {
              name: "3D — TRELLIS 2 (Microsoft, sparse-voxel geometry, strong topology)",
              value: "3d-trellis",
              checked: c.mlServices.includes("3d-trellis"),
            },
            {
              name: "3D — TripoSR (legacy, fast but lower quality)",
              value: "3d-extraction",
              checked: c.mlServices.includes("3d-extraction"),
            },
            {
              name: "Subtitle generation (audio/video → SRT)",
              value: "subtitles",
              checked: c.mlServices.includes("subtitles"),
            },
            {
              name: "Image recognition",
              value: "image-recognition",
              checked: c.mlServices.includes("image-recognition"),
            },
            {
              name: "Background removal",
              value: "background-removal",
              checked: c.mlServices.includes("background-removal"),
            },
            {
              name: "Custom HuggingFace model",
              value: "custom-hf",
              checked: c.mlServices.includes("custom-hf"),
            },
          ],
        });
        return { ...c, mlServices };
      },
    },
    {
      name: "GPU platforms",
      skip: (c) => {
        if (c.mlServices.length === 0) return true;
        const registry = getMlServices();
        const needsDeploy = c.mlServices.filter(
          (s) => !registry[s] || c.forceRedeployMl.includes(s),
        );
        return needsDeploy.length === 0;
      },
      run: async (c) => {
        const gpuPlatforms = await multiselect<GpuPlatform>({
          message: "GPU platforms to deploy to (multi-select — first becomes default ML_BACKEND):",
          choices: [
            {
              name: "Modal (recommended — best DX, $30/mo free, 2-4s cold starts)",
              value: "modal",
              checked: c.gpuPlatforms?.includes("modal") ?? true,
            },
            {
              name: "RunPod Serverless (cheapest, Docker-native)",
              value: "runpod",
              checked: c.gpuPlatforms?.includes("runpod") ?? false,
            },
            {
              name: "HuggingFace Inference Endpoints (simplest for HF models)",
              value: "hf",
              checked: c.gpuPlatforms?.includes("hf") ?? false,
            },
            {
              name: "Replicate (via Cog, good for sharing)",
              value: "replicate",
              checked: c.gpuPlatforms?.includes("replicate") ?? false,
            },
          ],
          required: true,
        });
        return { ...c, gpuPlatforms };
      },
    },
    {
      name: "Scaffold / GitHub / install",
      run: async (c) => {
        const scaffoldRepo = await confirm({
          message: "Scaffold app repo?",
          default: c.scaffoldRepo,
        });
        let createGithubRepo = false;
        let githubRepoVisibility: GitHubRepoVisibility | undefined;
        let installDeps = false;
        if (scaffoldRepo) {
          createGithubRepo = await confirm({
            message: "Create GitHub remote repo?",
            default: c.createGithubRepo,
          });
          if (createGithubRepo) {
            githubRepoVisibility = await promptGithubRepoVisibility(
              "GitHub repo visibility:",
              c.githubRepoVisibility,
            );
          }
          installDeps = await confirm({
            message: "Run pnpm install after scaffolding?",
            default: c.installDeps,
          });
        }
        const coolifyGithubSource = await resolveCoolifyGithubSourceForStepper({
          createGithubRepo,
          githubRepoVisibility,
          deploymentMode: c.deploymentMode,
          existing: c.coolifyGithubSource,
        });
        return {
          ...c,
          scaffoldRepo,
          createGithubRepo,
          githubRepoVisibility,
          installDeps,
          coolifyGithubSource,
        };
      },
    },
    {
      name: "Local dev URL",
      skip: () => !!options.forceNoLocalDev || presets.localDev !== undefined,
      run: async (c) => {
        const { localDevDomainFromProjectDomain, localDevUrl, sanitiseSlug } = await import(
          "@hatchkit/dev-shared"
        );
        const localDevDomain = localDevDomainFromProjectDomain(c.domain) ?? undefined;
        const enabled = await confirm({
          message: `Enable Tailscale dev URL (${localDevUrl("<slug>", localDevDomain)})?`,
          default: !!c.localDev,
        });
        if (!enabled) return { ...c, localDev: undefined };
        const defaultSlug = c.localDev?.slug || sanitiseSlug(c.name);
        const slug = await input({
          message: "Slug (subdomain) for this project:",
          default: defaultSlug,
          validate: (v: string) => {
            const sanitised = sanitiseSlug(v);
            if (sanitised.length === 0)
              return "Slug must contain at least one [a-z0-9-] character.";
            if (sanitised !== v) return `Use only [a-z0-9-]. Did you mean "${sanitised}"?`;
            return true;
          },
        });
        return { ...c, localDev: { slug: sanitiseSlug(slug), domain: localDevDomain } };
      },
    },
    {
      name: "Deploy now",
      skip: (c) =>
        c.deploymentMode === "scaffold-only" || c.deploymentMode === "gh-pages" || dryRun,
      run: async (c) => {
        const runDeployment = await confirm({
          message: "Run deployment now?",
          default: c.runDeployment,
        });
        return { ...c, runDeployment };
      },
    },
    {
      name: "Database engine",
      skip: (c) => c.surfaces === "static" || c.deploymentMode === "gh-pages",
      run: async (c) => {
        const dbEngine = await select<"mongodb" | "postgres">({
          message: "Database engine:",
          default: c.dbEngine ?? "mongodb",
          choices: [
            { name: "MongoDB (Mongoose, better-auth mongodb adapter)", value: "mongodb" },
            { name: "Postgres (Drizzle ORM, better-auth drizzle adapter)", value: "postgres" },
          ],
        });
        return { ...c, dbEngine };
      },
    },
    {
      name: "Database provider",
      skip: (c) => c.surfaces === "static" || c.deploymentMode === "gh-pages",
      run: async (c) => {
        const engineLabel = c.dbEngine === "postgres" ? "Postgres" : "MongoDB";
        const externalHint =
          c.dbEngine === "postgres" ? "Neon, Supabase, self-hosted, …" : "Atlas, self-hosted, …";
        const dbProvider = await select<"coolify" | "external">({
          message: `Prod ${engineLabel}:`,
          default: c.dbProvider ?? c.mongodbProvider ?? (c.runDeployment ? "coolify" : "external"),
          choices: [
            { name: "Provision a dedicated container on Coolify (recommended)", value: "coolify" },
            { name: `I'll provide a URI (${externalHint})`, value: "external" },
          ],
        });
        return {
          ...c,
          dbProvider,
          // Keep the legacy field in sync so any preset / manifest readers
          // that still look at `mongodbProvider` see the same value.
          mongodbProvider: dbProvider,
        };
      },
    },
  ];

  // Derive localDev default if not preset and not force-disabled
  if (!options.forceNoLocalDev && !presets.localDev && initial.name) {
    const { localDevDomainFromProjectDomain, sanitiseSlug } = await import("@hatchkit/dev-shared");
    const localDevDomain = localDevDomainFromProjectDomain(initial.domain) ?? undefined;
    initial.localDev = { slug: sanitiseSlug(initial.name), domain: localDevDomain };
  }

  let config = await runSteps(steps, initial);

  // Derive env values from final domain
  config.envValues = {
    ...config.envValues,
    FRONTEND_URL: `https://${config.domain}`,
    BETTER_AUTH_URL: `https://${config.domain}`,
  };

  // Fill in parsed domain fields
  if (config.domain) {
    const parsed = parseDomain(config.domain);
    config.baseDomain = parsed.baseDomain;
    config.subdomain = parsed.subdomain;
  }

  // Pre-flight (credential checks, etc.) before entering the review loop
  if (options.beforeReview) await options.beforeReview(config);

  // Review-and-edit loop at the end
  config = await reviewAndEditLoop(config, options.beforeReview);

  return config;
}

/** Non-interactive config collection. Presets + defaults, no prompts. */
async function collectProjectConfigNonInteractive(options: CollectOptions): Promise<ProjectConfig> {
  const presets = options.presets ?? {};
  const dryRun = options.dryRun ?? false;

  const name = presets.name;
  if (!name) throw new Error("--name is required in non-interactive mode (--yes).");
  const nameErr = validateProjectName(name);
  if (nameErr !== true) throw new Error(`--name invalid: ${nameErr}`);

  const description = (presets.description ?? "").trim();
  const rootDomain = getDefaultRootDomain();
  const domain = presets.domain ?? (rootDomain ? `${name}.${rootDomain}` : name);
  const domainErr = validateDomain(domain);
  if (domainErr !== true) throw new Error(`--domain invalid: ${domainErr}`);
  const { baseDomain, subdomain } = parseDomain(domain);

  const surfaces = presets.surfaces ?? "fullstack";
  const deploymentMode = presets.deploymentMode ?? "coolify";
  if (deploymentMode === "gh-pages" && surfaces !== "static") {
    throw new Error(`--deployment-mode gh-pages requires --surfaces static (got: ${surfaces}).`);
  }

  const deployTarget = presets.deployTarget ?? "new";
  if (
    deployTarget === "existing" &&
    (presets.serverId === undefined || presets.serverIp === undefined)
  ) {
    throw new Error("--deploy-target existing requires serverId + serverIp in --config.");
  }

  const features = presets.features ?? [];
  const analyticsProviders =
    presets.analyticsProviders ??
    (features.includes("analytics") ? ["glitchtip" as const] : undefined);
  // Mirror the interactive planning step: an `emailForwarding.enabled`
  // preset implies the project also wants `"email"` provisioned. The
  // explicit preset still wins — we only ADD it when missing.
  const wantsEmailForwarding = presets.emailForwarding?.enabled === true;
  const provisionServicesBase = presets.provisionServices
    ? uniqueProvisionServices(presets.provisionServices)
    : uniqueProvisionServices(analyticsProviders ? [...analyticsProviders] : []);
  const provisionServices =
    wantsEmailForwarding && !provisionServicesBase.includes("email")
      ? uniqueProvisionServices([...provisionServicesBase, "email"])
      : provisionServicesBase;

  const s3Provider: S3Provider = presets.s3Provider ?? (features.includes("s3") ? "r2" : "none");
  const mlServices = presets.mlServices ?? [];
  const gpuPlatforms =
    presets.gpuPlatforms ?? (mlServices.length > 0 ? ["modal" as const] : undefined);
  const scaffoldRepo = presets.scaffoldRepo ?? true;
  const createGithubRepo = scaffoldRepo ? (presets.createGithubRepo ?? true) : false;
  const githubRepoVisibility = createGithubRepo
    ? (presets.githubRepoVisibility ?? "public")
    : undefined;
  const installDeps = scaffoldRepo ? (presets.installDeps ?? true) : false;
  const runDeployment =
    deploymentMode === "scaffold-only" || dryRun ? false : (presets.runDeployment ?? true);
  const dbEngine: "mongodb" | "postgres" = presets.dbEngine ?? "mongodb";
  const dbProvider: "coolify" | "external" =
    surfaces === "static"
      ? "external"
      : (presets.dbProvider ?? presets.mongodbProvider ?? (runDeployment ? "coolify" : "external"));

  // Email intent in non-interactive mode is whatever the caller supplied
  // (manifest preset / scripted create). Absent → "none" both ways, and
  // any matching listmonk-ses entries in provisionServices stay intact
  // (the caller chose them explicitly). For static surfaces force it to
  // "none" — no server to read the env vars.
  const email =
    surfaces === "static" || deploymentMode === "gh-pages"
      ? EMAIL_INTENT_NONE
      : (presets.email ?? EMAIL_INTENT_NONE);

  const envValues: Record<string, string> = { ...(presets.envValues ?? {}) };
  envValues.FRONTEND_URL ??= `https://${domain}`;
  envValues.BETTER_AUTH_URL ??= `https://${domain}`;
  let localDev: { slug: string; domain?: string } | undefined;
  if (!options.forceNoLocalDev) {
    const { localDevDomainFromProjectDomain, sanitiseSlug } = await import("@hatchkit/dev-shared");
    const localDevDomain = localDevDomainFromProjectDomain(domain) ?? undefined;
    localDev = presets.localDev
      ? {
          slug: sanitiseSlug(presets.localDev.slug || name),
          domain: presets.localDev.domain ?? localDevDomain,
        }
      : { slug: sanitiseSlug(name), domain: localDevDomain };
  }

  return {
    name,
    description: description || undefined,
    domain,
    baseDomain,
    subdomain,
    surfaces,
    deployTarget,
    serverId: presets.serverId,
    serverUuid: presets.serverUuid,
    serverIp: presets.serverIp,
    serverIpv4: presets.serverIpv4 ?? presets.serverIp,
    serverIpv6: presets.serverIpv6,
    serverSize: deployTarget === "new" ? (presets.serverSize ?? "cpx21") : undefined,
    serverLocation: deployTarget === "new" ? (presets.serverLocation ?? "nbg1") : undefined,
    features,
    analyticsProviders,
    provisionServices,
    s3Provider,
    s3ExistingEndpoint: presets.s3ExistingEndpoint,
    s3ExistingBucket: presets.s3ExistingBucket,
    s3ExistingAccessKey: presets.s3ExistingAccessKey,
    s3ExistingSecretKey: presets.s3ExistingSecretKey,
    s3ExistingRegion: presets.s3ExistingRegion,
    mlServices,
    forceRedeployMl: presets.forceRedeployMl ?? [],
    dbEngine,
    dbProvider,
    mongodbProvider: dbProvider,
    gpuPlatforms,
    customHfModelId: presets.customHfModelId,
    customHfGpuType: presets.customHfGpuType,
    scaffoldRepo,
    createGithubRepo,
    githubRepoVisibility,
    installDeps,
    deploymentMode,
    runDeployment,
    envValues,
    localDev,
    email,
    emailForwarding: presets.emailForwarding,
    dryRun,
  };
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
async function reviewAndEditLoop(
  initial: ProjectConfig,
  afterEdit?: (config: ProjectConfig) => Promise<void>,
): Promise<ProjectConfig> {
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
      if (afterEdit) await afterEdit(latestConfig);
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
            key: "email",
            label: "Email",
            // Static-surface projects skip the prompt and the row is
            // omitted from the summary list (see filter below). For
            // server-surface projects, "set" is true once the user has
            // answered (even if the answer was "none") — absent
            // `cfg.email` means the prompt hasn't run yet.
            set: cfg.email !== undefined,
            summary: summarizeEmailIntent(cfg.email),
          },
          {
            key: "emailForwarding",
            label: "Email forwarding",
            set: cfg.emailForwarding !== undefined,
            summary: summarizeEmailForwarding(cfg.emailForwarding),
          },
          {
            key: "services",
            label: "Services",
            set: true,
            summary: summarizeProvisionServices(cfg.provisionServices),
          },
          {
            key: "db",
            label: "Database",
            set: !!(cfg.dbProvider ?? cfg.mongodbProvider),
            summary: (() => {
              const engineLabel = cfg.dbEngine === "postgres" ? "Postgres" : "MongoDB";
              const provider = cfg.dbProvider ?? cfg.mongodbProvider;
              if (provider === "coolify") {
                return `${engineLabel}  ${chalk.dim("→ Coolify container (auto-provisioned)")}`;
              }
              if (provider === "external") {
                return `${engineLabel}  ${chalk.dim("→ external URI")}`;
              }
              return engineLabel;
            })(),
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
          key: "emailForwarding",
          label: "Email forwarding",
          set: cfg.emailForwarding !== undefined,
          summary: summarizeEmailForwarding(cfg.emailForwarding),
        },
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
    // Static surfaces have no server to read LISTMONK_*/SES_SMTP_*, so
    // drop the email intent + queued email providers when the user
    // switches to static. Anyone re-enabling a server surface can
    // re-answer via the Email review row.
    const emailAfter = next === "static" ? EMAIL_INTENT_NONE : cfg.email;
    return {
      ...cfg,
      surfaces: next,
      dbProvider: next === "static" ? "external" : cfg.dbProvider,
      mongodbProvider: next === "static" ? "external" : (cfg.dbProvider ?? cfg.mongodbProvider),
      deploymentMode: nextDeploymentMode,
      runDeployment: nextDeploymentMode === "scaffold-only" ? false : cfg.runDeployment,
      email: emailAfter,
      provisionServices: cfg.provisionServices.filter((service) => {
        if (next === "static" && service === "listmonk-ses") return false;
        if (next === "backend" && service === "plausible") return false;
        return true;
      }),
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
        dbProvider: "external",
        mongodbProvider: "external",
        gpuPlatforms: undefined,
        customHfModelId: undefined,
        customHfGpuType: undefined,
        // gh-pages has no server runtime — clear queued email intent
        // so the manifest doesn't claim outbound mail for a static site.
        email: EMAIL_INTENT_NONE,
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
    const edited = await promptProvisionServicesEditor(cfg);
    // The editor excludes listmonk-ses (the dedicated Email row owns
    // that). Carry it back in from cfg.email so toggling an unrelated
    // service like Search Console doesn't accidentally drop the user's
    // email provider.
    const provisionServices = uniqueProvisionServices([
      ...edited,
      ...emailIntentToProvisionServices(cfg.email ?? EMAIL_INTENT_NONE),
    ]);
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
  if (section === "email") {
    // Static / gh-pages projects have no server runtime — refuse the
    // re-prompt and leave the intent at "none". The review row stays
    // visible so the user sees that email is intentionally disabled.
    // (See onboardingPlanToProjectConfig for the same gate on the
    // non-interactive path.)
    if (cfg.surfaces === "static" || cfg.deploymentMode === "gh-pages") {
      console.log(
        chalk.yellow(
          "  ⚠ Email needs a server runtime — switch surfaces / deployment mode first to enable it.",
        ),
      );
      return { ...cfg, email: EMAIL_INTENT_NONE };
    }
    const email = await askEmailIntent({ current: cfg.email });
    const provisionServices = mergeEmailIntoProvisionServices(cfg.provisionServices, email);
    return { ...cfg, email, provisionServices };
  }
  if (section === "emailForwarding") {
    if (!cfg.domain) {
      console.log(chalk.yellow("  ⚠ Set a domain first."));
      return cfg;
    }
    return askEmailForwardingStep(cfg);
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
  if (section === "db" || section === "mongo") {
    const dbEngine = await select<"mongodb" | "postgres">({
      message: "Database engine:",
      choices: [
        { name: "MongoDB (Mongoose, better-auth mongodb adapter)", value: "mongodb" },
        { name: "Postgres (Drizzle ORM, better-auth drizzle adapter)", value: "postgres" },
      ],
      default: cfg.dbEngine ?? "mongodb",
    });
    const engineLabel = dbEngine === "postgres" ? "Postgres" : "MongoDB";
    const externalHint =
      dbEngine === "postgres" ? "Neon, Supabase, self-hosted, …" : "Atlas, self-hosted, …";
    const next = await select<"coolify" | "external">({
      message: `Prod ${engineLabel}:`,
      choices: [
        { name: "Coolify container (recommended)", value: "coolify" },
        { name: `External URI (${externalHint})`, value: "external" },
      ],
      default: cfg.dbProvider ?? cfg.mongodbProvider ?? "coolify",
    });
    return { ...cfg, dbEngine, dbProvider: next, mongodbProvider: next };
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
    const coolifyGithubSource = await resolveCoolifyGithubSourceForStepper({
      createGithubRepo,
      githubRepoVisibility,
      deploymentMode: cfg.deploymentMode,
      existing: cfg.coolifyGithubSource,
    });
    return {
      ...cfg,
      scaffoldRepo,
      createGithubRepo,
      githubRepoVisibility,
      installDeps,
      runDeployment,
      coolifyGithubSource,
    };
  }
  return cfg;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Frontload the Coolify GitHub App source picker when the user selects
 *  a private repo + coolify deploy. Without this, the picker (or App
 *  walkthrough when no sources exist yet) gets wedged between auto-
 *  running deploy steps — the user walks away thinking it's running
 *  unattended and comes back to a stalled inquirer prompt.
 *
 *  Returns the cached source unchanged when the user didn't touch the
 *  relevant inputs; clears it when private + coolify is no longer the
 *  active combo; re-prompts when entering that combo afresh. */
async function resolveCoolifyGithubSourceForStepper(input: {
  createGithubRepo: boolean;
  githubRepoVisibility: GitHubRepoVisibility | undefined;
  deploymentMode: DeploymentMode;
  existing: ProjectConfig["coolifyGithubSource"];
}): Promise<ProjectConfig["coolifyGithubSource"]> {
  const needsSource =
    input.createGithubRepo &&
    input.githubRepoVisibility === "private" &&
    input.deploymentMode === "coolify";
  if (!needsSource) return undefined;
  if (input.existing) return input.existing;
  try {
    const { prefetchCoolifyGithubAppSource } = await import("./deploy/coolify.js");
    const source = await prefetchCoolifyGithubAppSource();
    return source ?? undefined;
  } catch (err) {
    console.log(
      chalk.yellow(
        `  Couldn't pre-pick a Coolify GitHub source (${(err as Error).message}). The Coolify step will prompt during deploy.`,
      ),
    );
    return undefined;
  }
}

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
