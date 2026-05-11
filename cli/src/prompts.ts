import { Separator, confirm, input, select } from "@inquirer/prompts";
import chalk from "chalk";
import { getCoolifyConfig, getMlServices } from "./config.js";
import { CoolifyApi, type CoolifyServer } from "./utils/coolify-api.js";
import { discoverPublicIps } from "./utils/coolify-server-ips.js";
import { multiselect } from "./utils/multiselect.js";
import { parseDomain, validateDomain, validateProjectName } from "./utils/validate.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DeployTarget = "existing" | "new";
export type DnsProvider = "inwx" | "cloudflare" | "manual";
export type S3Provider = "hetzner" | "r2" | "aws" | "existing" | "none";
export type GpuPlatform = "modal" | "runpod" | "hf" | "replicate";

/** What kind of project is being scaffolded. Mirrors the shape used by
 *  `hatchkit adopt` so the manifest field is interchangeable across the
 *  two flows.
 *
 *  · `both`       — full-stack monorepo (default; matches the starter
 *                   layout as-shipped).
 *  · `server-only`— API / backend; the client package is stripped from
 *                   the scaffold and Coolify routes only the api host.
 *  · `client-only`— static site / SPA; the server package is stripped
 *                   and Coolify deploys a single nginx-static service.
 *                   No MongoDB or server-side env-seeded providers
 *                   (Stripe / GlitchTip / Mailgun) — there's no server
 *                   to consume them. */
export type Surface = "server-only" | "client-only" | "both";

export type Feature = "websocket" | "stripe" | "analytics" | "s3" | "desktop" | "mobile";

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
  domain: string;
  baseDomain: string;
  subdomain: string;

  /** What kind of project to scaffold. Defaults to `both` (the
   *  full-stack starter layout). The two narrower surfaces strip the
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
  /** Set when Coolify's reported public IPv4 disagrees with the
   *  dashboard's DNS A record. Used to surface a yellow warning in
   *  the review summary. */
  serverIpMismatchWarning?: string;
  serverSize?: string;
  serverLocation?: string;

  features: Feature[];
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
  /** Whether to run `pnpm install` in the scaffolded repo right after
   *  files are written. Asked upfront in the stepper (rather than mid-
   *  scaffold) so the whole `hatchkit create` flow is non-blocking once
   *  the user proceeds — they can walk away while it runs. */
  installDeps: boolean;
  runDeployment: boolean;
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

export interface CollectOptions {
  dryRun?: boolean;
  /** Preset values to skip prompts for. Values here override defaults
   *  and skip the corresponding prompt entirely. */
  presets?: Partial<ProjectConfig>;
  /** Non-interactive mode: any missing value falls back to its
   *  default if one exists, else throws. */
  nonInteractive?: boolean;
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

  const domain = await presetOrPrompt(
    presets.domain,
    nonInteractive,
    () =>
      input({
        message: "Domain:",
        default: `${name}.ricos.site`,
        validate: (v) => validateDomain(v),
      }),
    `${name}.ricos.site`,
  );
  const domainErr = validateDomain(domain);
  if (domainErr !== true) throw new Error(`--domain invalid: ${domainErr}`);

  const { baseDomain, subdomain } = parseDomain(domain);

  // Surface — what kind of project this is. Same three-way choice that
  // `hatchkit adopt` exposes. The default is "both" (the full-stack
  // starter layout); the two narrower modes prune the unused package
  // and adjust docker-compose / Coolify routing accordingly.
  const surfaces = await presetOrPrompt<Surface>(
    presets.surfaces,
    nonInteractive,
    () =>
      select<Surface>({
        message: "What kind of project is this?",
        choices: [
          { name: "Server + client (full-stack monorepo)", value: "both" },
          { name: "Server only (backend / API)", value: "server-only" },
          { name: "Client only (static site / SPA — no backend)", value: "client-only" },
        ],
      }),
    "both",
  );

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
  let serverIpMismatchWarning: string | undefined;
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
      serverIpMismatchWarning = server.mismatchWarning;
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
          { name: "Analytics (OpenPanel) + Error tracking (GlitchTip)", value: "analytics" },
          { name: "Desktop app (Electron + itch.io release)", value: "desktop" },
          { name: "Mobile app (Capacitor / iOS + Android)", value: "mobile" },
        ],
      }),
    [],
  );

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

  const runDeployment = options.dryRun
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
  // Client-only surfaces never reach Mongo (there's no server to read
  // MONGODB_URI), so the prompt is skipped and the field forced to
  // "external" — downstream provisioning checks gate on
  // `surfaces === "client-only"` and skip Mongo entirely.
  const mongodbProvider: "coolify" | "external" =
    surfaces === "client-only"
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
      // Client-only scaffolds have no server to consume the URI, so the
      // prompt is skipped entirely (mongodbProvider is forced to
      // "external" upstream but the value is never used).
      if (mongodbProvider === "external" && surfaces !== "client-only") {
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
    serverIpMismatchWarning,
    serverSize,
    serverLocation,
    features,
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
    installDeps,
    runDeployment,
    envValues,
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
  let cfg = initial;

  console.log(chalk.bold("\n  hatchkit create — review"));
  console.log(chalk.dim("  Pick any step to change a choice. Choose 'Proceed' to scaffold.\n"));

  for (;;) {
    const groups = buildCreateStepGroups(cfg);
    const allSteps = groups.flatMap((g) => g.steps);

    // Default the cursor to the first not-yet-set step so a fresh user
    // can press Enter through the review without thinking. After every
    // field has a real value, "Proceed" becomes the default.
    const firstUnset = allSteps.find((s) => !s.set);
    const defaultKey = firstUnset?.key ?? "__proceed__";

    const choices: Array<Separator | { name: string; value: string }> = [];
    for (const group of groups) {
      choices.push(new Separator(renderCreateGroupHeader(group)));
      for (const step of group.steps) {
        choices.push({ name: renderCreateStepLabel(step), value: step.key });
      }
    }
    choices.push(new Separator(" "));
    choices.push({
      name: chalk.bold(chalk.green("✓  Proceed — scaffold now")),
      value: "__proceed__",
    });

    const picked = await select<string>({
      message: "Next step:",
      default: defaultKey,
      pageSize: Math.min(30, choices.length),
      choices,
    });

    if (picked === "__proceed__") return cfg;
    cfg = await editSection(cfg, picked);
  }
}

interface CreateStep {
  /** Stable id used as the select value. */
  key: string;
  /** Display label (left of the summary tail). */
  label: string;
  /** Has the user given this step an explicit value (vs. an unset
   *  default we'd want to nudge them to confirm)? */
  set: boolean;
  /** Right-side tail showing the current value. */
  summary: string;
}

interface CreateStepGroup {
  title: string;
  steps: CreateStep[];
}

function buildCreateStepGroups(cfg: ProjectConfig): CreateStepGroup[] {
  return [
    {
      title: "Project",
      steps: [
        { key: "name", label: "Project name", set: !!cfg.name, summary: cfg.name },
        {
          key: "domain",
          label: "Domain",
          set: !!cfg.domain,
          summary: cfg.domain
            ? `${cfg.domain}  ${chalk.dim("→")}  https://${cfg.domain}`
            : "(unset)",
        },
        {
          key: "surfaces",
          label: "Project type",
          set: !!cfg.surfaces,
          summary: renderSurfaceSummary(cfg.surfaces),
        },
      ],
    },
    {
      title: "Deployment",
      steps: [
        {
          key: "deployTarget",
          label: "Deploy target",
          set: cfg.deployTarget === "existing" ? !!cfg.serverIp : !!cfg.serverSize,
          // Show the validated public IPv4 — that's what Terraform
          // actually writes into DNS. Fall back to the raw Coolify
          // value (`host.docker.internal` etc.) only when discovery
          // hasn't run yet, so the display still reflects state.
          summary:
            cfg.deployTarget === "existing"
              ? `existing server (${cfg.serverIpv4 ?? cfg.serverIp ?? "?"}${cfg.serverIpv6 ? ` · ${cfg.serverIpv6}` : ""})`
              : `new Hetzner ${cfg.serverSize ?? "?"} (${cfg.serverLocation ?? "nbg1"})`,
        },
      ],
    },
    {
      title: "Stack",
      steps: [
        {
          key: "features",
          label: "Features",
          set: true, // an empty selection is a real choice
          summary: cfg.features.length > 0 ? cfg.features.join(", ") : chalk.dim("none"),
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
    {
      title: "Run",
      steps: [
        {
          key: "scaffoldFlags",
          label: "Scaffold / GitHub / Install / Deploy",
          set: true,
          summary: `scaffold=${cfg.scaffoldRepo ? "yes" : "no"} · github=${cfg.createGithubRepo ? "yes" : "no"} · install=${cfg.installDeps ? "yes" : "no"} · deploy=${cfg.runDeployment ? "yes" : "no"}`,
        },
      ],
    },
  ];
}

function renderSurfaceSummary(surface: Surface): string {
  switch (surface) {
    case "both":
      return "server + client (full-stack)";
    case "server-only":
      return "server only (API / backend)";
    case "client-only":
      return "client only (static site / SPA)";
  }
}

function renderCreateStepLabel(step: CreateStep): string {
  const mark = step.set ? chalk.green("✓") : chalk.dim("·");
  const tail = step.summary ? chalk.dim(` — ${step.summary}`) : "";
  return `${mark}  ${step.label.padEnd(18)}${tail}`;
}

function renderCreateGroupHeader(group: CreateStepGroup): string {
  return chalk.bold(`── ${group.title} ──`);
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
  if (section === "domain") {
    const raw = (
      await input({
        message: "Domain (e.g. ai.trebeljahr.com):",
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
        { name: "Server + client (full-stack monorepo)", value: "both" },
        { name: "Server only (backend / API)", value: "server-only" },
        { name: "Client only (static site / SPA — no backend)", value: "client-only" },
      ],
      default: cfg.surfaces,
    });
    // Force mongodbProvider to "external" for client-only — there's no
    // server to read MONGODB_URI, so a Coolify-provisioned container
    // would be wasted. Switching away from client-only keeps the prior
    // value (the user can re-pick on the Mongo step if needed).
    return {
      ...cfg,
      surfaces: next,
      mongodbProvider: next === "client-only" ? "external" : cfg.mongodbProvider,
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
    return { ...cfg, features: next };
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
        serverIpMismatchWarning: server.mismatchWarning,
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
      serverIpMismatchWarning: undefined,
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
    const installDeps = scaffoldRepo
      ? await confirm({
          message: "Run pnpm install after scaffolding?",
          default: cfg.installDeps,
        })
      : false;
    const runDeployment = await confirm({
      message: "Run deployment now (Terraform + Coolify + ML)?",
      default: cfg.runDeployment,
    });
    return { ...cfg, scaffoldRepo, createGithubRepo, installDeps, runDeployment };
  }
  return cfg;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  /** Set when Coolify's reported public IPv4 disagrees with what
   *  dashboard DNS resolves to. */
  mismatchWarning?: string;
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
  const ips = await discoverPublicIps(api, resolved.uuid, chosen.ip, coolifyConfig.url);
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
    mismatchWarning: ips.mismatchWarning,
  };
}
