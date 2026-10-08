/*
 * `hatchkit doctor` — health check for every configured provider.
 *
 * Runs the cheapest idempotent verification call that proves the stored
 * credential still works (GET-only, no writes). Reports a summary.
 */

import chalk from "chalk";
import {
  CLOUDFLARE_PROVISIONER_GRANTS,
  getCloudflareDeployTokenRecords,
  getCloudflareProvisioner,
  getCloudflareWorkersMeta,
  getCoolifyConfig,
  getDnsConfig,
  getGlitchtipConfig,
  getGoogleSearchConsoleConfig,
  getHetznerConfig,
  getListmonkConfig,
  getListmonkDefaultFromEmail,
  getPlausibleConfig,
  getS3Config,
  getSesConfig,
  getStore,
  refreshGoogleSearchConsoleAccessToken,
  validateS3KeyPair,
} from "./config.js";
import { appSlugFromHtmlUrl, listUserInstallations } from "./deploy/github-app-access.js";
import { readDeferredSteps } from "./provision/deferrals.js";
import type {
  SesFeedbackAws,
  SesFeedbackListmonk,
  SnsSubscription,
  WebhookCredentials,
} from "./provision/ses-feedback.js";
import { CoolifyApi, verifyCoolify } from "./utils/coolify-api.js";
import {
  dockerLoginAlreadyOk,
  dockerManifestInspectViaSsh,
  sshProbe,
} from "./utils/coolify-ssh.js";
import { execOk } from "./utils/exec.js";
import { type LedgerStep, loadAllLedgers } from "./utils/run-ledger.js";
import { SECRET_KEYS, getSecret } from "./utils/secrets.js";

// A stalled provider must not prevent later checks from reporting. Keep
// this local to doctor so production API calls retain their own policies.
const fetch: typeof globalThis.fetch = (input, init) =>
  globalThis.fetch(input, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(15_000),
  });

interface CheckResult {
  name: string;
  /** `deferred` is a deliberate user choice ("I'll do it later"), not a
   *  health problem: it renders distinctly and does NOT make doctor
   *  exit non-zero, so a project with skipped optional steps still
   *  passes CI.
   *
   *  `warn` is a latent fault in something that works today — it prints
   *  its hint but, like `deferred`, does not fail the run. */
  status: "ok" | "fail" | "warn" | "skip" | "deferred";
  detail?: string;
  /** Multi-line troubleshooting hint, shown under a failing check. */
  hint?: string[];
  /** A fix doctor can apply itself, offered only under `--fix`. Plain
   *  doctor never calls it. `run` must be idempotent and returns the
   *  line to print on success. */
  repair?: { prompt: string; run: () => Promise<string> };
}

type HintFn = (detail: string) => string[] | undefined;

async function check(
  name: string,
  fn: () => Promise<string | undefined>,
  hintFn?: HintFn,
): Promise<CheckResult> {
  try {
    const detail = await fn();
    return { name, status: "ok", detail: detail || undefined };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { name, status: "fail", detail, hint: hintFn?.(detail) };
  }
}

/** Pull the HTTP status code out of a "HTTP 401 ..." style error message. */
function httpCode(detail: string): number | undefined {
  const m = detail.match(/HTTP (\d{3})/);
  return m ? Number(m[1]) : undefined;
}

async function checkGitHub(): Promise<CheckResult> {
  if (!(await execOk("gh", ["--version"]))) {
    return {
      name: "GitHub (gh CLI)",
      status: "fail",
      detail: "gh CLI not installed",
      hint: [
        "Install: `brew install gh` (macOS) or see https://cli.github.com",
        "Then authenticate: `gh auth login`",
      ],
    };
  }
  if (!(await execOk("gh", ["auth", "status"]))) {
    return {
      name: "GitHub (gh CLI)",
      status: "fail",
      detail: "not authenticated",
      hint: ["Run `gh auth login` and pick GitHub.com → HTTPS → browser."],
    };
  }
  return { name: "GitHub (gh CLI)", status: "ok" };
}

async function checkCoolify(): Promise<CheckResult> {
  const cfg = await getCoolifyConfig();
  if (!cfg) return { name: "Coolify", status: "skip" };
  return check(
    "Coolify",
    async () => {
      const v = await verifyCoolify(cfg.url, cfg.token);
      return `v${v}`;
    },
    (detail) => {
      const code = httpCode(detail);
      if (code === 401 || code === 403) {
        return [
          "API token invalid or expired.",
          `Create a new one: ${cfg.url.replace(/\/$/, "")}/security/api-tokens`,
          "Then re-run: `hatchkit config add coolify`",
        ];
      }
      if (/ENOTFOUND|ECONNREFUSED|fetch failed/i.test(detail)) {
        return [
          `Can't reach Coolify at ${cfg.url}.`,
          "Check the URL is reachable from this machine, or re-run `hatchkit config add coolify`.",
        ];
      }
      return undefined;
    },
  );
}

/** Coolify GitHub App health. Two related checks rolled into one
 *  result list because they share a hint URL and a "Coolify must be
 *  reachable first" precondition:
 *
 *    1. Sources present  — Coolify's /github-apps returns ≥1 entry.
 *       Without this, `hatchkit create --private` can't run at all.
 *    2. Installation     — every source's App is installed on at
 *       least one account/org visible to the user's `gh` CLI. The App
 *       being registered in Coolify but never installed on github.com
 *       is a silent failure mode that only shows up at create time
 *       with a 404 — doctor surfaces it ahead of time.
 *
 *  Step (2) is skipped when `gh` is missing/unauthenticated (we can't
 *  enumerate installations) or when the source's html_url doesn't
 *  resolve to a GitHub App URL. */
async function checkCoolifyGithubApp(): Promise<CheckResult[]> {
  const cfg = await getCoolifyConfig();
  if (!cfg) return [{ name: "Coolify GitHub App", status: "skip" }];

  const sourcesUrl = `${cfg.url.replace(/\/$/, "")}/sources`;
  const out: CheckResult[] = [];

  let sources: Array<{ uuid: string; name: string; html_url?: string }> = [];
  try {
    const api = new CoolifyApi({ url: cfg.url, token: cfg.token });
    sources = await api.listGithubSources();
  } catch (err) {
    return [
      {
        name: "Coolify GitHub App (sources)",
        status: "fail",
        detail: err instanceof Error ? err.message : String(err),
        hint: [
          "Couldn't list /github-apps on Coolify — likely the API token lacks the right scope.",
          "Re-run `hatchkit config add coolify` to refresh the token.",
        ],
      },
    ];
  }

  if (sources.length === 0) {
    out.push({
      name: "Coolify GitHub App (sources)",
      status: "fail",
      detail: "no GitHub sources in Coolify",
      hint: [
        "Needed only if you plan to use `hatchkit create --private`. Public repos skip this.",
        "Set up with: `hatchkit config add coolify-github-app`",
        `Or manually at ${sourcesUrl} → 'New' → 'GitHub App'.`,
      ],
    });
    return out;
  }

  out.push({
    name: "Coolify GitHub App (sources)",
    status: "ok",
    detail: `${sources.length} source(s): ${sources.map((s) => s.name).join(", ")}`,
  });

  // Installation check: needs gh CLI authenticated to enumerate the
  // user's installations. Soft-skip when gh is missing — the sources
  // check above already covers the Coolify-side health.
  if (!(await execOk("gh", ["auth", "status"]))) {
    out.push({
      name: "Coolify GitHub App (installation)",
      status: "skip",
      detail: "gh CLI not authenticated",
      hint: ["Run `gh auth login` to let doctor verify the App is installed on github.com."],
    });
    return out;
  }

  const installs = await listUserInstallations();
  const missing: string[] = [];
  const installed: string[] = [];
  const unknown: string[] = [];
  for (const s of sources) {
    const slug = appSlugFromHtmlUrl(s.html_url);
    if (!slug) {
      unknown.push(s.name);
      continue;
    }
    if (installs.some((i) => i.app_slug === slug)) {
      installed.push(slug);
    } else {
      missing.push(slug);
    }
  }

  if (missing.length === 0 && installed.length > 0) {
    out.push({
      name: "Coolify GitHub App (installation)",
      status: "ok",
      detail: `installed: ${installed.join(", ")}${
        unknown.length > 0 ? ` (skipped ${unknown.length} w/o App URL)` : ""
      }`,
    });
    return out;
  }

  out.push({
    name: "Coolify GitHub App (installation)",
    status: "fail",
    detail: `App not installed on any visible account/org: ${missing.join(", ")}`,
    hint: [
      "Open https://github.com/apps/<app-slug>/installations/select_target and install on your account.",
      "Then re-run `hatchkit doctor` — or `hatchkit config add coolify-github-app` to walk through it.",
    ],
  });
  return out;
}

async function checkHetzner(): Promise<CheckResult> {
  const cfg = await getHetznerConfig();
  if (!cfg) return { name: "Hetzner Cloud", status: "skip" };
  return check(
    "Hetzner Cloud",
    async () => {
      const res = await fetch("https://api.hetzner.cloud/v1/servers?per_page=1", {
        headers: { Authorization: `Bearer ${cfg.token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as {
        meta?: { pagination?: { total_entries?: number } };
      };
      return `${body.meta?.pagination?.total_entries ?? "?"} server(s)`;
    },
    (detail) => {
      const code = httpCode(detail);
      if (code === 401) {
        return [
          "Hetzner API token is invalid or was revoked.",
          "Create a new one: https://console.hetzner.cloud/ → project → Security → API tokens (Read & Write)",
          "Then re-run: `hatchkit config add hetzner`",
        ];
      }
      if (code === 403) {
        return [
          "Token lacks permissions — needs Read & Write on the project.",
          "Re-create it and re-run `hatchkit config add hetzner`.",
        ];
      }
      return undefined;
    },
  );
}

async function checkDns(): Promise<CheckResult> {
  const cfg = await getDnsConfig();
  if (!cfg) return { name: "DNS", status: "skip" };
  return check(
    "DNS (Cloudflare)",
    async () => {
      const res = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
        headers: { Authorization: `Bearer ${cfg.apiToken}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { result?: { status?: string } };
      return body.result?.status ?? "active";
    },
    (detail) => {
      const code = httpCode(detail);
      if (code === 401) {
        return [
          "Cloudflare API token is invalid, expired, or revoked.",
          "Create a new one: https://dash.cloudflare.com/profile/api-tokens",
          "Required permissions: Zone:DNS:Edit + Zone:Zone:Read (scope to the zones you'll use).",
          "Then re-run: `hatchkit config add dns`",
        ];
      }
      if (code === 403) {
        return [
          "Token authenticates but lacks Zone:DNS:Edit + Zone:Zone:Read on the target zones.",
          "Edit the token at https://dash.cloudflare.com/profile/api-tokens or create a new one, then `hatchkit config add dns`.",
        ];
      }
      return undefined;
    },
  );
}

async function checkS3(provider: "hetzner" | "aws" | "r2"): Promise<CheckResult> {
  const name = `S3 (${provider})`;
  const cfg = await getS3Config(provider);
  if (!cfg) return { name, status: "skip" };

  // Account-wide access/secret pair only applies to non-R2 providers
  // (Hetzner, AWS). Validate shape there to catch the paste-collision
  // bug (access === secret) where users dual-paste the same value.
  // R2's account-wide pair is no longer the source of truth — per-
  // project pairs live under `s3:r2:<project>:access-key` instead.
  if (provider !== "r2") {
    const issue = validateS3KeyPair(provider, cfg.accessKey, cfg.secretKey);
    if (issue) {
      return {
        name,
        status: "fail",
        detail: issue,
        hint: [
          "Re-paste the Access Key ID + Secret Access Key from the dashboard.",
          "Run: `hatchkit config add s3` for a full re-config.",
        ],
      };
    }
    return { name, status: "ok", detail: "credentials stored (endpoint set)" };
  }

  // R2: verify the admin Bearer token can do BOTH jobs it's responsible
  // for — bucket admin (Account > Workers R2 Storage > Edit) AND
  // minting per-project account tokens (Account > Account Settings >
  // Edit). The legacy `User > API Tokens > Edit` perm is no longer
  // sufficient on its own (provision switched to account-owned tokens
  // via POST /accounts/{id}/tokens), but is still useful during
  // migration of pre-account-tokens projects, so we probe it as a
  // non-fatal hint. Either of the required perms failing tells the
  // user exactly which one to add. Per-project access/secret pairs are
  // checked separately by `checkProjectR2CredsState`, which runs from
  // `collectDoctorResults` when invoked inside a hatchkit project.
  const adminToken = await getSecret(SECRET_KEYS.r2AdminToken);
  if (!adminToken) {
    return {
      name,
      status: "ok",
      detail: "configured; admin token not set (bucket provisioning will prompt)",
      hint: [
        "Optional unless you want bucket auto-create / public-URL setup.",
        "When ready: `hatchkit config add s3 r2` to store + verify the admin token globally.",
      ],
    };
  }
  const accountId = cfg.endpoint?.match(
    /https?:\/\/([0-9a-f]{32})\.r2\.cloudflarestorage\.com/i,
  )?.[1];
  if (!accountId) {
    return {
      name,
      status: "fail",
      detail: `endpoint ${cfg.endpoint} doesn't look like an R2 endpoint`,
    };
  }
  return check(
    name,
    async () => {
      const verifyRes = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (!verifyRes.ok) throw new Error(`HTTP ${verifyRes.status} (token verify)`);

      const r2Res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets`,
        { headers: { Authorization: `Bearer ${adminToken}` } },
      );
      if (!r2Res.ok) {
        const body = (await r2Res.json().catch(() => null)) as {
          errors?: Array<{ code: number; message: string }>;
        } | null;
        const code = body?.errors?.[0]?.code;
        throw new Error(`HTTP ${r2Res.status}${code ? ` (CF code ${code})` : ""} (r2 list)`);
      }
      const body = (await r2Res.json()) as { result?: { buckets?: unknown[] } };
      const n = body.result?.buckets?.length ?? 0;

      // Account-tokens permission probe. Hatchkit provisions per-project
      // R2 credentials via `POST /accounts/{id}/tokens` (visible in
      // `R2 → Manage R2 API Tokens`); that endpoint needs
      // `Account Settings:Edit` on the calling token. Hitting the
      // permission-groups list is the cheapest probe and matches what
      // `createR2AccountToken` does first — a 9109/403 here means
      // provision would fail at the same call.
      const accountTokenRes = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/tokens/permission_groups?per_page=1`,
        { headers: { Authorization: `Bearer ${adminToken}` } },
      );
      if (!accountTokenRes.ok) {
        const aBody = (await accountTokenRes.json().catch(() => null)) as {
          errors?: Array<{ code: number; message: string }>;
        } | null;
        const aCode = aBody?.errors?.[0]?.code;
        throw new Error(
          `HTTP ${accountTokenRes.status}${aCode ? ` (CF code ${aCode})` : ""} (account-tokens list — needs Account Settings:Edit)`,
        );
      }

      // Legacy probe: best-effort, not fatal. Used during migration to
      // revoke pre-account-tokens user-tokens. If it fails, surface as
      // a hint in the OK detail so users know one perm is missing
      // without flagging the whole check as a fail.
      const legacyRes = await fetch("https://api.cloudflare.com/client/v4/user/tokens?per_page=1", {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const legacyNote = legacyRes.ok
        ? "; legacy User>API Tokens also OK"
        : "; legacy User>API Tokens missing (migration of pre-account-tokens projects may leave orphans)";

      return `R2 perm OK (${n} bucket(s)); Account Settings:Edit OK (can mint per-project tokens)${legacyNote}`;
    },
    (detail) => {
      const code = httpCode(detail);
      if (code === 401) {
        return [
          "R2 admin Bearer token is invalid or revoked.",
          "Create a new one: https://dash.cloudflare.com/profile/api-tokens → Custom token",
          "Permissions:    Account > Workers R2 Storage > Edit",
          "                Account > Account Settings   > Edit",
          "Then re-run: `hatchkit config add s3 r2` to re-paste + verify globally.",
        ];
      }
      if (/account-tokens list/i.test(detail)) {
        return [
          "Admin token has R2 perm but lacks `Account > Account Settings > Edit`.",
          "Without it, hatchkit can't mint per-project R2 credentials via account tokens",
          "(POST /accounts/{id}/tokens). Provision will revoke any legacy token first and",
          "then fail to mint its replacement, leaving the project without working creds.",
          "Edit at https://dash.cloudflare.com/profile/api-tokens, add the perm, save —",
          "or re-run `hatchkit config add s3 r2` to paste a fresh token.",
        ];
      }
      if (code === 403 || /10000|10001|9109/.test(detail)) {
        return [
          "Token verifies but lacks `Account > Workers R2 Storage > Edit`.",
          "Edit at https://dash.cloudflare.com/profile/api-tokens, add the perm, save —",
          "or re-run `hatchkit config add s3 r2` to paste a fresh token.",
        ];
      }
      return undefined;
    },
  );
}

async function checkGpu(platform: string): Promise<CheckResult> {
  const store = getStore();
  const meta = store.get(`providers.gpu.${platform}`) as { status?: string } | undefined;
  const name = `GPU (${platform})`;
  if (meta?.status !== "configured") return { name, status: "skip" };
  if (platform === "modal") {
    return check(name, async () => {
      if (!(await execOk("modal", ["token", "current"])))
        throw new Error("`modal token current` failed");
      return "authenticated";
    });
  }
  const key = await getSecret(SECRET_KEYS.gpuApiKey(platform));
  if (!key) {
    return {
      name,
      status: "fail",
      detail: "API key missing from keychain",
      hint: [`Re-run: \`hatchkit config add gpu\` and pick ${platform}.`],
    };
  }
  const gpuHint =
    (label: string, createUrl: string): HintFn =>
    (detail) => {
      const code = httpCode(detail);
      if (code === 401 || code === 403) {
        return [
          `${label} API key is invalid or expired.`,
          `Create a new one: ${createUrl}`,
          "Then re-run: `hatchkit config add gpu`",
        ];
      }
      return undefined;
    };
  if (platform === "hf") {
    return check(
      name,
      async () => {
        const res = await fetch("https://huggingface.co/api/whoami-v2", {
          headers: { Authorization: `Bearer ${key}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { name?: string };
        return body.name ?? "authenticated";
      },
      gpuHint("Hugging Face", "https://huggingface.co/settings/tokens"),
    );
  }
  if (platform === "replicate") {
    return check(
      name,
      async () => {
        const res = await fetch("https://api.replicate.com/v1/account", {
          headers: { Authorization: `Token ${key}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return "authenticated";
      },
      gpuHint("Replicate", "https://replicate.com/account/api-tokens"),
    );
  }
  if (platform === "runpod") {
    return check(
      name,
      async () => {
        const res = await fetch("https://rest.runpod.io/v1/user", {
          headers: { Authorization: `Bearer ${key}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return "authenticated";
      },
      gpuHint("RunPod", "https://www.runpod.io/console/user/settings"),
    );
  }
  return { name, status: "ok", detail: "credentials stored" };
}

async function checkGlitchtip(): Promise<CheckResult> {
  const cfg = await getGlitchtipConfig();
  if (!cfg) return { name: "GlitchTip", status: "skip" };
  return check(
    "GlitchTip",
    async () => {
      const res = await fetch(`${cfg.url}/api/0/organizations/${cfg.organizationSlug}/`, {
        headers: { Authorization: `Bearer ${cfg.token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return `org: ${cfg.organizationSlug}`;
    },
    (detail) => {
      const code = httpCode(detail);
      const base = cfg.url.replace(/\/$/, "");
      if (code === 401) {
        return [
          "Auth token is invalid or expired.",
          `Create a new one: ${base}/profile/auth-tokens`,
          "Then re-run: `hatchkit config add glitchtip`",
        ];
      }
      if (code === 404) {
        return [
          `Organization "${cfg.organizationSlug}" not found — slug may be wrong.`,
          `Check at ${base}/ and re-run: \`hatchkit config add glitchtip\``,
        ];
      }
      return undefined;
    },
  );
}

async function checkPlausible(): Promise<CheckResult> {
  const cfg = await getPlausibleConfig();
  if (!cfg) return { name: "Plausible", status: "skip" };
  const base = cfg.url.replace(/\/$/, "");
  return check(
    "Plausible",
    async () => {
      const res = await fetch(`${base}/api/v1/sites?limit=1`, {
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return cfg.teamId ? `team: ${cfg.teamId}` : "Sites API key valid";
    },
    (detail) => {
      const code = httpCode(detail);
      if (code === 401 || code === 403) {
        return [
          "Plausible Sites API key is invalid, expired, or lacks Sites API access.",
          `Create a Sites API key from ${base}/settings`,
          "Then re-run: `hatchkit config add plausible`",
        ];
      }
      if (code === 404 || code === 406) {
        return [
          `Plausible Sites API is not available at ${base}.`,
          "If this is Plausible Community Edition/self-hosted, auto-provisioning sites is not supported there.",
          "Use a Plausible Cloud/Enterprise account with Sites API access, or create the site manually and set NEXT_PUBLIC_PLAUSIBLE_DOMAIN + NEXT_PUBLIC_PLAUSIBLE_SCRIPT_URL yourself.",
        ];
      }
      return undefined;
    },
  );
}

/**
 * The global Listmonk credential and the instance's default sender.
 *
 *   · API user — `GET /api/profile`, which any user may read about
 *     itself. A deleted API user or a rotated token answers 401/403
 *     here; the stored config alone still says "configured".
 *   · Default sender — `app.from_email` sends Listmonk's own mail
 *     (opt-in confirmations from public forms) and any call without a
 *     sender, for every project on the instance. A project's
 *     `mail.<domain>` sender there brands every other project's mail.
 *     `--fix` writes the neutral sender from `hatchkit config add
 *     listmonk --default-from` when one is set.
 */
export async function checkListmonk(source?: {
  auth: { url: string; apiUser: string; apiToken: string };
  neutralFromEmail?: string;
}): Promise<CheckResult[]> {
  let src = source;
  if (!src) {
    const cfg = await getListmonkConfig();
    if (!cfg) return [{ name: "Listmonk", status: "skip" }];
    src = { auth: cfg, neutralFromEmail: getListmonkDefaultFromEmail() };
  }
  const { auth } = src;
  const base = auth.url.replace(/\/+$/, "");
  const { listmonkAuthHeader, isProjectSender, listmonkFromEmailUnset, senderAddress } =
    await import("./provision/listmonk.js");
  const headers = { Authorization: listmonkAuthHeader(auth) };

  const profile = await check(
    "Listmonk",
    async () => {
      const res = await fetch(`${base}/api/profile`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${base}/api/profile`);
      const body = (await res.json()) as {
        data?: { username?: string; type?: string; user_role?: { name?: string } };
      };
      const d = body.data ?? {};
      const role = d.user_role?.name ? `, role ${d.user_role.name}` : "";
      return `authenticated as ${d.username ?? auth.apiUser} (${d.type ?? "user"}${role})`;
    },
    (detail) => {
      const code = httpCode(detail);
      if (code === 401 || code === 403) {
        return [
          `Listmonk rejected API user "${auth.apiUser}": it was deleted, disabled, or its token changed.`,
          `Create an API user in ${base}/admin/users (Lists, Subscribers, Campaigns and Settings: All).`,
          "Then re-run: `hatchkit config add listmonk`",
          "Projects that use this credential (LISTMONK_API_USER in their env) need `hatchkit secrets rotate --global listmonk` afterwards.",
        ];
      }
      return undefined;
    },
  );
  if (profile.status !== "ok") return [profile];

  const name = "Listmonk default sender";
  const neutral = src.neutralFromEmail?.trim();
  let current: unknown;
  try {
    const res = await fetch(`${base}/api/settings`, { headers });
    if (res.status === 403) {
      return [
        profile,
        {
          name,
          status: "skip",
          detail: `API user "${auth.apiUser}" cannot read settings (needs Settings: All)`,
        },
      ];
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${base}/api/settings`);
    current = ((await res.json()) as { data?: Record<string, unknown> }).data?.["app.from_email"];
  } catch (err) {
    return [
      profile,
      { name, status: "fail", detail: err instanceof Error ? err.message : String(err) },
    ];
  }

  const repair = neutral
    ? {
        prompt: `Set Listmonk's default sender to "${neutral}"?`,
        run: async () => {
          const { putListmonkSetting, waitForListmonk } = await import("./provision/listmonk.js");
          const res = await putListmonkSetting("app.from_email", neutral, auth);
          if (res.needsRestart) {
            return `Listmonk saved the default sender "${neutral}"; a campaign is running, so restart Listmonk after it to load it`;
          }
          await waitForListmonk(auth, { initialDelayMs: 1_500 });
          return `Listmonk default sender is now "${neutral}"`;
        },
      }
    : undefined;
  const setNeutral = neutral
    ? `Run \`hatchkit doctor --fix\` to set it to the configured neutral sender "${neutral}".`
    : 'Set a neutral sender with `hatchkit config add listmonk --default-from "Newsletter <noreply@your-domain>"`, then run `hatchkit doctor --fix`.';
  const optinNote =
    "Listmonk sends opt-in confirmations from public subscription forms, and any call without a sender, under this one address for every project.";

  if (listmonkFromEmailUnset(current)) {
    const value = typeof current === "string" ? current.trim() : "";
    return [
      profile,
      {
        name,
        status: "warn",
        detail: value ? `still the install default: ${value}` : "unset",
        hint: [optinNote, setNeutral],
        ...(repair ? { repair } : {}),
      },
    ];
  }
  const value = String(current).trim();
  if (isProjectSender(value) && (!neutral || senderAddress(value) !== senderAddress(neutral))) {
    const domain =
      senderAddress(value)
        .split("@")[1]
        ?.replace(/^mail\./, "") ?? "";
    return [
      profile,
      {
        name,
        status: "warn",
        detail: `${value} is the sender of the project on ${domain}`,
        hint: [
          optinNote,
          `Every other project's opt-in mail goes out branded as ${domain}.`,
          setNeutral,
        ],
        ...(repair ? { repair } : {}),
      },
    ];
  }
  return [profile, { name, status: "ok", detail: value }];
}

async function checkGoogleSearchConsole(): Promise<CheckResult> {
  const cfg = await getGoogleSearchConsoleConfig();
  if (!cfg) return { name: "Google Search Console", status: "skip" };
  return check(
    "Google Search Console",
    async () => {
      const accessToken = await refreshGoogleSearchConsoleAccessToken(cfg);
      const res = await fetch("https://www.googleapis.com/webmasters/v3/sites", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { siteEntry?: unknown[] };
      return `${body.siteEntry?.length ?? 0} propert${body.siteEntry?.length === 1 ? "y" : "ies"}`;
    },
    (detail) => {
      if (/client_secret is missing/i.test(detail)) {
        return [
          "The stored Google refresh token is tied to a Desktop OAuth client, but Hatchkit does not have that client's generated secret.",
          "Run: `hatchkit config add search-console`",
          "Paste the generated Desktop client secret when prompted; Hatchkit stores it in the OS keychain.",
        ];
      }
      const code = httpCode(detail);
      if (code === 400 || code === 401) {
        return [
          "Google OAuth refresh token is invalid, revoked, or missing required scopes.",
          "Re-run: `hatchkit config add search-console`",
          "Required scopes: Search Console `webmasters` + Site Verification `verify_only`.",
        ];
      }
      if (code === 403) {
        return [
          "Google credentials work but the API or scopes are blocked.",
          "Enable Search Console API and Site Verification API in Google Cloud,",
          "then re-run: `hatchkit config add search-console`.",
        ];
      }
      return undefined;
    },
  );
}

async function checkStripeMode(mode: "test" | "live", secretKey: string): Promise<CheckResult> {
  return check(
    `Stripe (${mode} master)`,
    async () => {
      const res = await fetch("https://api.stripe.com/v1/balance", {
        headers: { Authorization: `Bearer ${secretKey}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // The webhook_endpoints:write scope can't be cheaply tested with
      // a GET, so /balance is the proxy: it proves the key is live and
      // the account is reachable. A scope-mismatched key still passes
      // /balance — at provision time, POST /v1/webhook_endpoints will
      // surface the scope error inline (and `hatchkit create` already
      // soft-fails to a manual fallback when that happens).
      return "master key valid";
    },
    (detail) => {
      const code = httpCode(detail);
      if (code === 401) {
        return [
          `Stripe ${mode} master key is invalid or was rotated.`,
          `Create a new restricted key (${mode} mode) at https://dashboard.stripe.com/apikeys`,
          "Required scope: Webhook Endpoints — Write",
          "Then re-run: `hatchkit config add stripe`",
        ];
      }
      return undefined;
    },
  );
}

async function checkStripe(): Promise<CheckResult[]> {
  const { getStripeConfig } = await import("./config.js");
  const cfg = await getStripeConfig();
  if (!cfg) return [{ name: "Stripe", status: "skip" }];
  const out: CheckResult[] = [];
  if (cfg.testSecretKey) out.push(await checkStripeMode("test", cfg.testSecretKey));
  if (cfg.liveSecretKey) out.push(await checkStripeMode("live", cfg.liveSecretKey));
  if (out.length === 0) return [{ name: "Stripe", status: "skip" }];
  return out;
}

/** GHCR pull credentials live on each Coolify host in
 *  `~/.docker/config.json` (written by `hatchkit adopt` via SSH +
 *  `docker login`). They're invisible to the Coolify API, so a
 *  rotated `gh auth` token can leave Coolify silently unable to pull
 *  a private image — the only outward signal is a deploy that fails
 *  with `unauthorized` at pull time.
 *
 *  This check walks every Coolify host hatchkit logged into (per the
 *  on-disk ledgers) and:
 *    1. SSH-probes reachability.
 *    2. Greps `~/.docker/config.json` for an entry under `ghcr.io`.
 *    3. When a `github`-recorded private repo is in the same ledger,
 *       does a `docker manifest inspect ghcr.io/<owner>/<repo>` to
 *       distinguish "creds present but stale" (denied) from "creds
 *       present + still authorized" (success or `manifest unknown`).
 *
 *  Returns one row per host. Skipped silently when no ledger contains
 *  a `coolifyGhcrSshLogin` step (i.e. nothing to check yet). */
async function checkCoolifyGhcrSsh(): Promise<CheckResult[]> {
  const ledgers = loadAllLedgers();
  // Aggregate by host: a single host may serve multiple projects.
  type HostEntry = {
    serverUuid: string;
    host: string;
    user: string;
    port: number;
    probeImages: string[];
  };
  const byHost = new Map<string, HostEntry>();
  for (const ledger of ledgers) {
    // Resolve any github repos in the same ledger so we have a known
    // private package to probe. `step.repo` is `owner/name` so the
    // GHCR image is `ghcr.io/<repo>`.
    const repos: string[] = [];
    for (const s of ledger.steps as LedgerStep[]) {
      if (s.kind === "github") repos.push(s.repo);
    }
    for (const s of ledger.steps as LedgerStep[]) {
      if (s.kind !== "coolifyGhcrSshLogin") continue;
      const key = `${s.user}@${s.host}:${s.port}`;
      let entry = byHost.get(key);
      if (!entry) {
        entry = {
          serverUuid: s.serverUuid,
          host: s.host,
          user: s.user,
          port: s.port,
          probeImages: [],
        };
        byHost.set(key, entry);
      }
      for (const r of repos) {
        const image = `ghcr.io/${r.toLowerCase()}:latest`;
        if (!entry.probeImages.includes(image)) entry.probeImages.push(image);
      }
    }
  }

  if (byHost.size === 0) return [];

  const out: CheckResult[] = [];
  for (const entry of byHost.values()) {
    const target = {
      uuid: entry.serverUuid,
      user: entry.user,
      host: entry.host,
      port: entry.port,
    };
    const name = `Coolify GHCR creds (${entry.host})`;

    const probe = await sshProbe(target);
    if (!probe.ok) {
      out.push({
        name,
        status: "fail",
        detail: `ssh unreachable: ${probe.stderr.split("\n")[0] || "no detail"}`,
        hint: [
          `Confirm the host is reachable from this machine:`,
          `  ssh -p ${entry.port} ${entry.user}@${entry.host} true`,
          "If the key auth fails, add your public key to the host's ~/.ssh/authorized_keys.",
          "Then re-run: hatchkit doctor",
        ],
      });
      continue;
    }

    const hasEntry = await dockerLoginAlreadyOk(target, "ghcr.io");
    if (!hasEntry) {
      out.push({
        name,
        status: "fail",
        detail: "no ghcr.io entry in ~/.docker/config.json on the host",
        hint: [
          "Re-install the credential:",
          "  hatchkit config add ghcr",
          "  hatchkit adopt --resume    (per project) — runs the SSH+docker login flow again",
        ],
      });
      continue;
    }

    // Authorisation probe — only when we have a candidate image.
    if (entry.probeImages.length === 0) {
      out.push({
        name,
        status: "ok",
        detail: "ghcr.io entry present (no recorded image to probe pull authorization)",
      });
      continue;
    }

    let inspect: { exitCode: number; stderr: string } | null = null;
    let lastImage = entry.probeImages[0];
    for (const image of entry.probeImages) {
      lastImage = image;
      inspect = await dockerManifestInspectViaSsh(target, image);
      // 0 = creds OK + image exists. Skip the rest — any single
      // success proves auth.
      if (inspect.exitCode === 0) break;
      // `manifest unknown` / `not found` = creds OK + image not yet
      // pushed. Treat as OK for this host.
      if (/manifest unknown|not found|no such manifest/i.test(inspect.stderr)) {
        inspect.exitCode = 0;
        break;
      }
    }
    if (inspect && inspect.exitCode === 0) {
      out.push({
        name,
        status: "ok",
        detail: `ghcr.io login still authorizes pulls (probed ${lastImage})`,
      });
      continue;
    }
    const reason = inspect?.stderr.split("\n").find((l) => l.trim()) || "unknown manifest error";
    const isAuthFail = /denied|unauthor|forbidden|requested access/i.test(reason);
    out.push({
      name,
      status: "fail",
      detail: isAuthFail
        ? `pull denied for ${lastImage}: ${reason}`
        : `manifest probe failed for ${lastImage}: ${reason}`,
      hint: isAuthFail
        ? [
            "The stored credential no longer authorizes ghcr.io pulls (token rotated, revoked, or scopes dropped).",
            "Refresh and re-install:",
            "  gh auth refresh -s read:packages",
            "  hatchkit config add ghcr",
            "  hatchkit adopt --resume   (per project)",
          ]
        : [
            "docker may not be installed on the host, or the user can't reach the docker socket.",
            `Verify manually: ssh -p ${entry.port} ${entry.user}@${entry.host} 'docker info'`,
          ],
    });
  }
  return out;
}

/** Coolify compose apps that can keep serving an old build after a
 *  green deploy.
 *
 *  On 2026-09-28 two apps (hatchkit docs, sprite-tools) were still
 *  serving May builds. Their compose files ran
 *  `ghcr.io/trebeljahr/<x>:latest` without `pull_policy: always`, so
 *  Coolify's `docker compose up` started the image Docker had cached for
 *  the tag. Coolify reported every deployment `finished` and the app
 *  `running:healthy` throughout; nothing on any status surface differed.
 *
 *  The fix is one line in the repo's compose file, and
 *  `hatchkit update` / `regen-infra` carry it for hatchkit projects. This
 *  finds the apps that never got it, across every app on the Coolify
 *  instance rather than just the project in cwd.
 *
 *  Reads `docker_compose_raw` only (see `listComposeSources`) and prints
 *  service names and image refs, never an env value. A `warn`, not a
 *  `fail`: the app works, it just can't be trusted to update. */
export async function checkCoolifyComposePullPolicy(source?: {
  api: Pick<CoolifyApi, "listComposeSources">;
}): Promise<CheckResult[]> {
  let api = source?.api;
  if (!api) {
    const cfg = await getCoolifyConfig();
    if (!cfg) return [];
    api = new CoolifyApi({ url: cfg.url, token: cfg.token });
  }
  const name = "Coolify image pull policy";

  let apps: Awaited<ReturnType<CoolifyApi["listComposeSources"]>>;
  try {
    apps = await api.listComposeSources();
  } catch (err) {
    // The Coolify row above already reports an unreachable instance or a
    // dead token; failing again here would say the same thing twice.
    return [
      {
        name,
        status: "skip",
        detail: `couldn't list applications: ${(err as Error).message.split("\n")[0]}`,
      },
    ];
  }
  const compose = apps.filter((a) => a.buildPack === "dockercompose");
  if (compose.length === 0) return [];
  const readable = compose.filter(
    (a): a is typeof a & { dockerComposeRaw: string } => typeof a.dockerComposeRaw === "string",
  );
  if (readable.length === 0) {
    return [
      {
        name,
        status: "skip",
        detail: `Coolify returned no docker_compose_raw for ${compose.length} compose app(s)`,
      },
    ];
  }

  const { IMAGE_COMPOSE_FILES, composeStalePullRisks } = await import(
    "./scaffold/deploy-verification.js"
  );
  const out: CheckResult[] = [];
  for (const app of readable) {
    const risks = composeStalePullRisks(app.dockerComposeRaw);
    if (risks.length === 0) continue;

    const repo = app.gitRepository ?? "the app's repo";
    const branch = app.gitBranch ? ` (branch ${app.gitBranch})` : "";
    const baseDir = (app.baseDirectory ?? "/").replace(/^\/+|\/+$/g, "");
    const location = (app.dockerComposeLocation ?? "/docker-compose.yml").replace(/^\/+/, "");
    const file = baseDir ? `${baseDir}/${location}` : location;
    const services = risks.map((r) => `\`${r.service}\``).join(", ");
    const explicit = risks.filter((r) => r.pullPolicy !== undefined);
    const retrofittable =
      explicit.length === 0 && (IMAGE_COMPOSE_FILES as readonly string[]).includes(file);

    out.push({
      name: `Coolify app ${app.name} (image pull policy)`,
      status: "warn",
      detail: risks
        .map(
          (r) =>
            `service "${r.service}" runs ${r.ref} with ` +
            (r.pullPolicy === undefined ? "no pull_policy" : `pull_policy: ${r.pullPolicy}`),
        )
        .join("; "),
      hint: [
        `Coolify app ${app.name} (${app.uuid}) deploys ${file} from ${repo}${branch}.`,
        "Docker starts the image it cached for a mutable tag, so a deploy can finish green",
        "and report running:healthy while the previous build keeps serving.",
        `Fix: set \`pull_policy: always\` on ${services} in ${repo}:${file}, commit, and redeploy.`,
        ...explicit.map(
          (r) =>
            `  \`${r.service}\` declares \`pull_policy: ${r.pullPolicy}\` — change it to \`always\`.`,
        ),
        ...(retrofittable
          ? [
              "Or, in a hatchkit project checkout: `hatchkit update` or `hatchkit regen-infra`",
              "  (preview with `--dry-run`) — both add it.",
            ]
          : []),
        "Coolify re-reads the file on the next deploy; this warning clears after it.",
      ],
    });
  }

  if (out.length === 0) {
    const unread = compose.length - readable.length;
    out.push({
      name,
      status: "ok",
      detail:
        `${readable.length} compose app(s) checked, none runs a mutable ghcr tag without pull_policy: always` +
        (unread > 0 ? ` (${unread} never deployed, not checked)` : ""),
    });
  }
  return out;
}

/** True when a manifest's deploymentMode means "there is a Coolify app
 *  behind this domain". Absent = legacy manifest = coolify. */
function isCoolifyManagedMode(mode: string | undefined): boolean {
  return mode === undefined || mode === "coolify";
}

/**
 * Cloudflare Workers (the `cloudflare` deployment mode): the provisioner.
 *
 * Hatchkit's one Cloudflare provisioner token stays in the keychain and
 * mints each Worker repo its own token (deploy/cloudflare-deploy-token.ts).
 * This checks the provisioner can do that. Whether each repo holds its
 * own token is the per-project "credentials are project-scoped" check.
 *
 * Read-only throughout, like every other doctor check:
 *
 *   1. `/user/tokens/verify` — the token is live at all.
 *   2. A permission probe per grant the provisioner needs. The account
 *      ones always run; the zone ones need a zone, which comes from the
 *      DNS provider's token if one is configured.
 *
 * Reports every missing permission at once rather than failing on the
 * first. A user re-editing a Cloudflare token should get the whole list
 * in one pass, not discover a second gap after saving the first fix.
 *
 * Runs only when the mode was set up here (or a deploy token was
 * minted): the provisioner also resolves from the R2 admin token alone,
 * and an R2-only user has no reason to grant it Workers.
 */
async function checkCloudflareWorkers(): Promise<CheckResult> {
  const name = "Cloudflare Workers provisioner";
  const used =
    getCloudflareWorkersMeta()?.status === "configured" ||
    Object.keys(getCloudflareDeployTokenRecords()).length > 0;
  if (!used) return { name, status: "skip" };
  const prov = await getCloudflareProvisioner();
  if (!prov) {
    return {
      name,
      status: "fail",
      detail: "No Cloudflare provisioner in the keychain.",
      hint: ["Re-run: `hatchkit config add cloudflare-workers`"],
    };
  }
  const legacy = await getSecret(SECRET_KEYS.cloudflareWorkersToken);

  return check(
    name,
    async () => {
      const { CloudflareApi } = await import("./utils/cloudflare-api.js");
      const api = new CloudflareApi({
        token: prov.token,
        accountId: prov.accountId,
      });

      if ((await api.verifyToken()) !== "active") throw new Error("Token is not active");

      // The zone-scoped probes need a zone id. Borrow one from the DNS
      // token's zone list — it's the same Cloudflare account, and any
      // zone is representative enough to tell whether the provisioner
      // carries the zone grants at all.
      let zoneId: string | undefined;
      let zoneName: string | undefined;
      const dns = await getDnsConfig();
      if (dns?.apiToken) {
        try {
          const zones = await new CloudflareApi({
            token: dns.apiToken,
            accountId: prov.accountId,
          }).listZones();
          zoneId = zones[0]?.id;
          zoneName = zones[0]?.name;
        } catch {
          // No zone to probe against — handled below.
        }
      }

      const probes = await api.probeProvisionerPermissions({
        accountId: prov.accountId,
        zoneId,
      });
      const missing = probes.filter((p) => !p.ok);
      if (missing.length > 0) {
        throw new Error(`missing permissions: ${missing.map((p) => p.permission).join(", ")}`);
      }
      if (legacy) {
        throw new Error("legacy shared token `cloudflare:workers:token` still in the keychain");
      }
      const scope = zoneName ? `account + zone ${zoneName}` : "account only (no zone to probe)";
      return `${probes.length}/${probes.length} read probes passed (${scope}; from ${prov.source}); write grants unverified`;
    },
    (detail) => {
      const grants = CLOUDFLARE_PROVISIONER_GRANTS.map((g) => `  • ${g}`);
      const code = httpCode(detail);
      if (code === 401) {
        return [
          `The provisioner (${prov.source}) is invalid, expired, or revoked.`,
          "Create a new User API Token: https://dash.cloudflare.com/profile/api-tokens",
          ...grants,
          "Then re-run: `hatchkit config add cloudflare-workers`",
        ];
      }
      if (/missing permissions/.test(detail)) {
        return [
          `The provisioner (${prov.source}) works but is missing the grants listed above:`,
          ...grants,
          "Edit it at https://dash.cloudflare.com/profile/api-tokens, or store a dedicated",
          "one with `hatchkit config add cloudflare-workers`. CI never gets these grants.",
        ];
      }
      if (/legacy shared token/.test(detail)) {
        return [
          "Older hatchkit pushed this ONE token to every Worker repo. Nothing reads it now.",
          "Give each repo its own token (`hatchkit secrets isolate <dir>`), then revoke",
          "the old token in the dashboard. The local legacy keychain copy is unused.",
        ];
      }
      return undefined;
    },
  );
}

/**
 * SES bounce + complaint feedback into Listmonk, account-wide: every
 * Hatchkit project sends through one Listmonk over SES, so this runs
 * wherever SES and Listmonk are configured, not per project.
 *
 * Four rows, each with a `--fix` repair:
 *   · identities   — a verified identity whose Bounce or Complaint
 *                    notifications go to no SNS topic. SES then only
 *                    emails the notice to the sender, and Listmonk never
 *                    blocklists the address.
 *   · subscription — the shared topic is gone, or its subscription to
 *                    Listmonk's SES webhook is missing or unconfirmed.
 *   · suppression  — account suppression doesn't cover BOUNCE + COMPLAINT.
 *   · Listmonk     — `bounce.enabled` / `webhooks_enabled` / `ses_enabled`
 *                    off.
 *
 * Read-only: ListEmailIdentities, GetIdentityNotificationAttributes,
 * ListSubscriptionsByTopic, GetAccount, GET /api/settings. The topic ARN
 * comes from the identities' own notification attributes, because
 * finding it any other way needs `sns:ListTopics` or a CreateTopic
 * write. A read the IAM policy doesn't allow is a `warn` naming the
 * missing action, not a crash.
 */
export async function checkSesBounceFeedback(source?: {
  aws: SesFeedbackAws;
  listmonk: SesFeedbackListmonk;
  listmonkUrl: string;
  webhookCredentials?: WebhookCredentials | null;
}): Promise<CheckResult[]> {
  const feedback = await import("./provision/ses-feedback.js");
  let src = source;
  if (!src) {
    const sesCfg = await getSesConfig();
    if (!sesCfg) return [];
    const listmonkCfg = await getListmonkConfig();
    if (!listmonkCfg) {
      return [
        {
          name: "SES bounce feedback",
          status: "skip",
          detail: "Listmonk not configured — SES bounce feedback goes to Listmonk",
        },
      ];
    }
    src = {
      aws: feedback.createSesFeedbackAws(sesCfg),
      // No reload wait before reads: a Listmonk that is down should
      // fail this row now, not after 30 s.
      listmonk: feedback.createSesFeedbackListmonk(listmonkCfg, { settleBeforeRead: false }),
      listmonkUrl: listmonkCfg.url,
      // Read-only: doctor never generates credentials. Without any, it
      // checks the plain webhook URL.
      webhookCredentials: await feedback.loadWebhookCredentials(),
    };
  }
  const { aws, listmonk } = src;
  const report = await feedback.inspectSesFeedback(src);
  const topicName = report.topicName;
  // Holds the password when there are credentials: SNS only, never output.
  const endpoint = feedback.listmonkSesWebhookUrl(src.listmonkUrl, src.webhookCredentials);
  const out: CheckResult[] = [];

  /** Remove older subscriptions of the webhook, once ours is confirmed. */
  const removeSuperseded = async (subs: SnsSubscription[]): Promise<string> => {
    if (subs.length === 0) return "";
    const r = await feedback.removeSupersededSubscriptions(aws, subs);
    if (r.error) throw r.error;
    return `; removed ${r.removed.map((s) => feedback.redactEndpoint(s.endpoint)).join(", ")}`;
  };

  /** Create (or find) the topic and subscribe the webhook. Listmonk's
   *  bounce settings go first: it confirms the subscription only with
   *  `bounce.ses_enabled` on. */
  const repairSubscription = async (): Promise<string> => {
    const written = await feedback.ensureListmonkBounceSettings(listmonk);
    const arn = await aws.createTopic(topicName);
    const sub = await feedback.ensureFeedbackSubscription(aws, arn, endpoint);
    const settings = written.length > 0 ? `; turned on ${written.join(", ")}` : "";
    if (sub.state !== "confirmed") {
      return `${topicName} → ${report.webhookUrl} subscribed; Listmonk has not confirmed it yet — re-run doctor in a minute${settings}`;
    }
    const removed = await removeSuperseded(
      feedback.supersededSubscriptions(sub.subscriptions, endpoint),
    );
    return `${topicName} → ${report.webhookUrl} subscribed and confirmed${settings}${removed}`;
  };
  const warnRow = (name: string, probe: { error: string; iamGap: boolean }): CheckResult => ({
    name,
    status: "warn",
    detail: `couldn't check: ${probe.error}`,
    hint: probe.iamGap ? feedback.feedbackIamHint() : undefined,
  });

  // Identities.
  {
    const name = "SES bounce feedback (identities)";
    const probe = report.identities;
    if (!probe.ok) {
      out.push(warnRow(name, probe));
    } else if (probe.value.verified.length === 0) {
      out.push({ name, status: "skip", detail: "no verified SES identities" });
    } else if (probe.value.missing.length > 0) {
      const { missing, verified, foreign } = probe.value;
      const list = missing.map((m) => `${m.identity} (${m.types.join(" + ")})`).join(", ");
      out.push({
        name,
        status: "fail",
        detail: `${missing.length} of ${verified.length} verified identities route no bounces/complaints to SNS: ${list}`,
        hint: [
          "SES then only emails the notice to the sender address, so Listmonk never blocklists a bouncing address.",
          `Run \`hatchkit doctor --fix\` to point them at the ${topicName} topic.`,
          ...(foreign.length > 0
            ? [
                `${foreign.length} other notification(s) go to a different topic; doctor leaves those alone.`,
              ]
            : []),
        ],
        repair: {
          prompt: `Send Bounce + Complaint notifications of ${missing.length} identit${missing.length === 1 ? "y" : "ies"} to SNS topic ${topicName}?`,
          run: async () => {
            const arn = await aws.createTopic(topicName);
            let set = 0;
            for (const m of missing) {
              set += (await feedback.ensureIdentityNotificationTopics(aws, m.identity, arn)).set
                .length;
            }
            return `${set} notification topic(s) set to ${topicName} on ${missing.map((m) => m.identity).join(", ")}`;
          },
        },
      });
    } else if (probe.value.foreign.length > 0) {
      const list = probe.value.foreign
        .map((f) => `${f.identity} ${f.type} → ${feedback.topicNameFromArn(f.topicArn)}`)
        .join(", ");
      out.push({
        name,
        status: "warn",
        detail: `every verified identity has topics, but some are not ${topicName}: ${list}`,
        hint: [
          "Those notifications reach Listmonk only if that topic is subscribed to its SES webhook. Doctor leaves them alone.",
        ],
      });
    } else {
      out.push({
        name,
        status: "ok",
        detail: `${probe.value.verified.length} verified identities send Bounce + Complaint to ${topicName}`,
      });
    }
  }

  // Topic + subscription.
  {
    const name = "SES bounce feedback (SNS subscription)";
    const sub = report.subscription;
    const repair = {
      prompt: `Create SNS topic ${topicName} if missing and subscribe ${report.webhookUrl}?`,
      run: repairSubscription,
    };
    if (!report.identities.ok) {
      out.push({ name, status: "skip", detail: "topic unknown: identities couldn't be read" });
    } else if (report.identities.value.verified.length === 0) {
      // Nothing sends yet, so there is nothing to locate the topic by.
    } else if (!sub && report.identities.value.missing.length === 0) {
      // Every identity routes to some other topic on purpose.
      out.push({ name, status: "skip", detail: `no verified identity uses ${topicName}` });
    } else if (!sub) {
      out.push({
        name,
        status: "fail",
        detail: `no verified identity sends to a topic named ${topicName}, so doctor can't locate it read-only`,
        hint: [`Run \`hatchkit doctor --fix\` to create it and subscribe ${report.webhookUrl}.`],
        repair,
      });
    } else if (!sub.ok) {
      out.push(warnRow(name, sub));
    } else if (sub.value === "confirmed" && report.superseded.length > 0) {
      const list = report.superseded.map((s) => s.endpoint).join(", ");
      out.push({
        name,
        status: "warn",
        detail: `${topicName} → ${report.webhookUrl} (confirmed), but SNS also delivers to ${list}, so Listmonk gets each notification twice`,
        hint: [
          "Run `hatchkit doctor --fix` to remove the older subscription, or:",
          ...report.superseded.map((s) => `  ${feedback.unsubscribeCommand(s.subscriptionArn)}`),
        ],
        repair: {
          prompt: `Remove the older SNS subscription${report.superseded.length === 1 ? "" : "s"} ${list}?`,
          run: async () => (await removeSuperseded(report.superseded)).replace(/^; r/, "R"),
        },
      });
    } else if (sub.value === "confirmed") {
      out.push({ name, status: "ok", detail: `${topicName} → ${report.webhookUrl} (confirmed)` });
    } else {
      const detail =
        sub.value === "topic-missing"
          ? `topic ${report.topicArn} no longer exists — identities point at nothing`
          : sub.value === "missing"
            ? `${topicName} has no subscription for ${report.webhookUrl}`
            : `subscription ${topicName} → ${report.webhookUrl} is pending confirmation`;
      out.push({
        name,
        status: "fail",
        detail,
        hint: [
          "Listmonk confirms the subscription by itself once `bounce.ses_enabled` is on and the URL is reachable from AWS.",
          "Run `hatchkit doctor --fix` to (re)subscribe; SNS then sends a fresh confirmation request.",
        ],
        repair,
      });
    }
  }

  // Account suppression.
  {
    const name = "SES bounce feedback (account suppression)";
    const probe = report.suppression;
    if (!probe.ok) {
      out.push(warnRow(name, probe));
    } else if (probe.value.length > 0) {
      out.push({
        name,
        status: "fail",
        detail: `account-level suppression doesn't cover ${probe.value.join(" + ")}`,
        hint: [
          "SES keeps sending to addresses that bounced or complained, which counts against the account's reputation.",
          "Run `hatchkit doctor --fix` to add them.",
        ],
        repair: {
          prompt: `Add ${probe.value.join(" + ")} to the SES account suppression list?`,
          run: async () => {
            const added = await feedback.ensureAccountSuppression(aws);
            return added.length > 0
              ? `SES account suppression now includes ${added.join(" + ")}`
              : "SES account suppression already covered BOUNCE + COMPLAINT";
          },
        },
      });
    } else {
      out.push({ name, status: "ok", detail: "BOUNCE + COMPLAINT suppressed account-wide" });
    }
  }

  // Listmonk settings.
  {
    const name = "SES bounce feedback (Listmonk settings)";
    const probe = report.listmonkSettings;
    if (!probe.ok) {
      out.push({ name, status: "warn", detail: `couldn't check: ${probe.error}` });
    } else if (probe.value.length > 0) {
      out.push({
        name,
        status: "fail",
        detail: `off on ${src.listmonkUrl}: ${probe.value.join(", ")}`,
        hint: [
          "Listmonk ignores SES bounce webhooks until all three are on.",
          "Run `hatchkit doctor --fix` to turn them on (one PUT per key; each reloads Listmonk).",
        ],
        repair: {
          prompt: `Turn on ${probe.value.join(", ")} in Listmonk at ${src.listmonkUrl}?`,
          run: async () => {
            const written = await feedback.ensureListmonkBounceSettings(listmonk);
            return written.length > 0
              ? `Listmonk: turned on ${written.join(", ")}`
              : "Listmonk bounce settings were already on";
          },
        },
      });
    } else {
      out.push({ name, status: "ok", detail: "bounce.enabled, webhooks_enabled, ses_enabled on" });
    }
  }

  return out;
}

/** Every registered backup source must resolve on the backup host, or the
 *  nightly run fails for that project. Runs only when backups are
 *  configured; reads the host over Tailscale and changes nothing. */
async function checkBackupSources(): Promise<CheckResult[]> {
  const { backupProvider } = await import("./backups/provider.js");
  try {
    backupProvider();
  } catch {
    return [];
  }
  const { fetchSourceReport } = await import("./backups/sources.js");
  let report: Awaited<ReturnType<typeof fetchSourceReport>>;
  try {
    report = await fetchSourceReport();
  } catch (err) {
    return [
      {
        name: "Backup sources resolve on the host",
        status: "warn",
        detail: `couldn't read the backup host: ${(err as Error).message.split("\n")[0]}`,
        hint: ["Retry: hatchkit backup sources --json"],
      },
    ];
  }
  if (report.stale.length === 0)
    return [
      {
        name: "Backup sources resolve on the host",
        status: "ok",
        detail: `${report.sources.length} source(s) on ${report.host}`,
      },
    ];
  return report.stale.map((row) => ({
    name: `Backup source ${row.project}/${row.source}`,
    status: "fail" as const,
    detail:
      row.state === "ambiguous"
        ? `selector matches ${row.matches} running containers`
        : row.kind === "files"
          ? `path(s) missing: ${(row.missingPaths ?? []).join(", ")}`
          : `no running container matches ${JSON.stringify(row.selector)}; tonight's ${row.project} backup will fail`,
    hint: row.fix
      ? [
          row.fix.summary,
          `Preview: ${row.fix.preview}`,
          `Apply:   ${row.fix.command}`,
          ...(row.fix.alternatives ?? []).map((alt) => `Or:      ${alt}`),
        ]
      : undefined,
  }));
}

export async function collectDoctorResults(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  results.push(await checkGitHub());
  results.push(await checkCoolify());
  for (const r of await checkCoolifyGithubApp()) results.push(r);
  for (const r of await checkCoolifyGhcrSsh()) results.push(r);
  for (const r of await checkCoolifyComposePullPolicy()) results.push(r);
  results.push(await checkHetzner());
  results.push(await checkDns());
  results.push(await checkCloudflareWorkers());
  for (const p of ["hetzner", "aws", "r2"] as const) results.push(await checkS3(p));
  for (const p of ["modal", "runpod", "hf", "replicate"]) results.push(await checkGpu(p));
  results.push(await checkGlitchtip());
  results.push(await checkPlausible());
  for (const r of await checkListmonk()) results.push(r);
  results.push(await checkGoogleSearchConsole());
  for (const r of await checkStripe()) results.push(r);
  for (const r of await checkSesBounceFeedback()) results.push(r);
  for (const r of await checkBackupSources()) results.push(r);
  // Local-dev (Tailscale-served per-project URLs). Returns [] when the
  // user hasn't run `hatchkit dev-setup init`, so doctor stays quiet for
  // anyone not opted in.
  const { checkLocalDevHost } = await import("./dev-setup.js");
  for (const r of await checkLocalDevHost()) results.push(r);
  // Project-local checks — only run when doctor was invoked inside a
  // hatchkit-managed project (manifest at cwd). Globally they're a
  // no-op, so `hatchkit doctor` from $HOME stays clean.
  const projectChecks = await checkProjectKeyState(process.cwd());
  for (const r of projectChecks) results.push(r);
  const devEnvSecretChecks = await checkProjectDevEnvSecretsState(process.cwd());
  for (const r of devEnvSecretChecks) results.push(r);
  const corsChecks = await checkProjectS3CorsState(process.cwd());
  for (const r of corsChecks) results.push(r);
  const credChecks = await checkProjectR2CredsState(process.cwd());
  for (const r of credChecks) results.push(r);
  const mailFromChecks = await checkProjectSesMailFromState(process.cwd());
  for (const r of mailFromChecks) results.push(r);
  const optinChecks = await checkProjectListmonkOptinState(process.cwd());
  for (const r of optinChecks) results.push(r);
  const txTemplateChecks = await checkProjectListmonkTxTemplateState(process.cwd());
  for (const r of txTemplateChecks) results.push(r);
  const emailRoutingChecks = await checkProjectEmailRoutingState(process.cwd());
  for (const r of emailRoutingChecks) results.push(r);
  const publicSvcChecks = await checkProjectPublicServiceState(process.cwd());
  for (const r of publicSvcChecks) results.push(r);
  const routingChecks = await checkProjectRoutingState(process.cwd());
  for (const r of routingChecks) results.push(r);
  const autoDeployChecks = await checkProjectCoolifyAutoDeployState(process.cwd());
  for (const r of autoDeployChecks) results.push(r);
  const isolationChecks = await checkProjectCredentialIsolationState(process.cwd());
  for (const r of isolationChecks) results.push(r);
  const nginxConfigChecks = await checkProjectNginxConfigState(process.cwd());
  for (const r of nginxConfigChecks) results.push(r);
  const appHealthChecks = await checkProjectCoolifyAppHealthState(process.cwd());
  for (const r of appHealthChecks) results.push(r);
  const rollingChecks = await checkProjectRollingDeployState(process.cwd());
  for (const r of rollingChecks) results.push(r);
  const deployedRefChecks = await checkProjectDeployedRefState(process.cwd());
  for (const r of deployedRefChecks) results.push(r);
  const deployedVersionChecks = await checkProjectDeployedVersionState(process.cwd());
  for (const r of deployedVersionChecks) results.push(r);
  const dnsResolveChecks = await checkProjectDnsResolveState(process.cwd());
  for (const r of dnsResolveChecks) results.push(r);
  const prodEnvChecks = await checkProjectProdEnvState(process.cwd());
  for (const r of prodEnvChecks) results.push(r);
  const deferredChecks = checkProjectDeferredSteps(process.cwd());
  for (const r of deferredChecks) results.push(r);
  const subdirChecks = await checkProjectSubdirState(process.cwd());
  for (const r of subdirChecks) results.push(r);
  const operationalChecks = await checkProjectOperationalState(process.cwd());
  for (const r of operationalChecks) results.push(r);
  return results;
}

/** Verify that a manifest-recorded `projectSubdir` still exists and
 *  looks buildable. Surfaces a hint when the user renamed / moved /
 *  deleted the subdir without updating the manifest — without this,
 *  `hatchkit sync` would happily push a stale base_directory to
 *  Coolify and Coolify would fail the next build with an opaque
 *  "context not found" error. */
export async function checkProjectSubdirState(cwd: string): Promise<CheckResult[]> {
  const { existsSync, readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  let manifestDir: string | undefined;
  let dir = cwd;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, ".hatchkit.json"))) {
      manifestDir = dir;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!manifestDir) return [];
  let manifest: { projectSubdir?: string };
  try {
    manifest = JSON.parse(readFileSync(join(manifestDir, ".hatchkit.json"), "utf-8")) as {
      projectSubdir?: string;
    };
  } catch {
    return [];
  }
  if (!manifest.projectSubdir) return [];
  const subdirAbs = join(manifestDir, manifest.projectSubdir);
  if (!existsSync(subdirAbs)) {
    return [
      {
        name: `Project subdir (${manifest.projectSubdir})`,
        status: "fail",
        detail: `recorded subdir does not exist at ${subdirAbs}`,
        hint: [
          "The manifest's `projectSubdir` points at a folder that's no longer there.",
          "Either rename the folder back, or update the manifest:",
          "  · edit .hatchkit.json and set `projectSubdir` to the new path,",
          "  · then run `hatchkit sync` to push the new base_directory to Coolify.",
        ],
      },
    ];
  }
  const buildable =
    existsSync(join(subdirAbs, "Dockerfile")) ||
    [
      "next.config.ts",
      "next.config.js",
      "next.config.mjs",
      "vite.config.ts",
      "astro.config.mjs",
    ].some((n) => existsSync(join(subdirAbs, n))) ||
    (() => {
      const pkgPath = join(subdirAbs, "package.json");
      if (!existsSync(pkgPath)) return false;
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
          scripts?: Record<string, string>;
        };
        return !!pkg.scripts?.build;
      } catch {
        return false;
      }
    })();
  if (!buildable) {
    return [
      {
        name: `Project subdir (${manifest.projectSubdir})`,
        status: "fail",
        detail: `${subdirAbs} exists but has no build script / framework config / Dockerfile`,
        hint: [
          "Coolify will try to build this folder and fail. Either:",
          "  · add a `build` script or Dockerfile inside the subdir,",
          "  · or update the manifest's `projectSubdir` to the right path.",
        ],
      },
    ];
  }
  return [{ name: `Project subdir (${manifest.projectSubdir})`, status: "ok" }];
}

/**
 * Project-local check that the repo agrees with hatchkit's production
 * env model. Gated on `.hatchkit.json` in the cwd, so it's a no-op
 * outside a hatchkit project.
 *
 * ---------------------------------------------------------------------
 * The model
 * ---------------------------------------------------------------------
 *
 * Runtime configuration comes from the container's environment, which
 * Coolify holds and `hatchkit sync` populates. The dotenvx-encrypted
 * `.env.production` is the AT-REST store that sync reads from — it is
 * versioned in git so the values survive a laptop, and `secrets rotate`
 * writes into it. It is not shipped into the image.
 *
 * ---------------------------------------------------------------------
 * What used to go wrong, silently
 * ---------------------------------------------------------------------
 *
 * Both halves of that model failed quietly at once, which is why this
 * check exists rather than a comment:
 *
 *  1. The widely copy-pasted global git excludes file
 *     (`core.excludesFile`, usually ~/.config/git/ignore) lists
 *     `.env.production`. The starter's .gitignore didn't list the file
 *     at all, and *absence* doesn't beat a global pattern — only an
 *     explicit `!` negation does. So on any machine with that global
 *     ignore the at-rest store was never committed, and nothing said so.
 *
 *  2. Separately, a repo may still carry the older "ship the encrypted
 *     file into the image and decrypt at boot" wiring, where the server
 *     Dockerfile COPYs `.env.production` into the runtime stage. That's
 *     the other model. Mixing them means two sources of truth that
 *     drift, so we flag it rather than let it ride.
 *
 * Both are reported as failures with the exact fix, because either one
 * turns a `hatchkit keys push` into a key that decrypts nothing.
 */
export async function checkProjectProdEnvState(projectDir: string): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const { existsSync, readFileSync } = await import("node:fs");
  const manifestPath = `${projectDir}/.hatchkit.json`;
  if (!existsSync(manifestPath)) return out;

  let projectName: string;
  try {
    const m = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      name?: string;
    };
    if (!m.name) return out;
    projectName = m.name;
  } catch {
    return out;
  }

  const { locateEnvProductionFile } = await import("./deploy/keys.js");
  const prodEnvPath = locateEnvProductionFile(projectDir);
  if (!prodEnvPath) {
    // No `.env.production` anywhere. A project that keeps every value
    // in Coolify directly is a legitimate (if less portable) setup, and
    // a freshly scaffolded project hasn't written one yet. Nothing to
    // verify either way — stay quiet rather than nag.
    return out;
  }

  const { relative } = await import("node:path");
  const relProdEnv = relative(projectDir, prodEnvPath);

  // ── 1. Is the at-rest store actually in git? ──────────────────────
  const tracked = await execOk("git", ["ls-files", "--error-unmatch", relProdEnv], {
    cwd: projectDir,
  });
  if (tracked) {
    out.push({
      name: `Project ${projectName} (.env.production tracked)`,
      status: "ok",
      detail: `${relProdEnv} is committed — the encrypted at-rest store is versioned`,
    });
  } else {
    // Name the culprit when we can. `git check-ignore -v` prints
    // `<source>:<line>:<pattern>` for the pattern that matched, which
    // tells the user whether this is their global ignore or the repo's.
    // `silent` matters: check-ignore exits 1 when no pattern matches,
    // and exec() echoes stderr on a non-zero exit by default — which
    // would splatter noise through the middle of doctor's report for
    // the perfectly ordinary "never added" case.
    let ignoredBy: string | undefined;
    try {
      const { exec } = await import("./utils/exec.js");
      const res = await exec("git", ["check-ignore", "-v", relProdEnv], {
        cwd: projectDir,
        silent: true,
      });
      if (res.exitCode === 0) {
        const line = res.stdout.split("\n").find((l) => l.trim());
        // Format: `<source>:<line>:<pattern>\t<pathname>`. check-ignore
        // also exits 0 when the winning pattern is a NEGATION (`!...`),
        // i.e. when the file is explicitly RE-INCLUDED. Reporting that
        // as "ignored by" would tell someone who already has the fix to
        // apply it again, so only a non-negated pattern counts.
        const pattern = line?.split("\t")[0]?.split(":")[2];
        if (line && pattern && !pattern.trim().startsWith("!")) ignoredBy = line.split("\t")[0];
      }
    } catch {
      // Not a git repo, or no git binary. Fall back to the generic
      // "not tracked" wording rather than failing the whole check.
    }
    out.push({
      name: `Project ${projectName} (.env.production not committed)`,
      status: "fail",
      detail: ignoredBy
        ? `${relProdEnv} exists on disk but is git-ignored by ${ignoredBy}`
        : `${relProdEnv} exists on disk but is not tracked by git`,
      hint: [
        "The dotenvx-encrypted .env.production is hatchkit's at-rest store for production values.",
        "Untracked, it exists only on this machine: a fresh clone (or CI) deploys without it, and",
        "`hatchkit keys push` then pushes a private key that decrypts nothing.",
        ...(ignoredBy
          ? [
              "A global ignore usually causes this. A repo .gitignore only overrides a global pattern",
              "when it has a pattern of its own — omitting the file is not enough, so add a negation:",
              `  echo '!.env.production' >> .gitignore`,
            ]
          : []),
        `  git add -f ${relProdEnv} && git commit -m 'chore: commit encrypted .env.production'`,
        "Values are dotenvx ciphertext, so committing them is safe — but confirm with",
        `  head -3 ${relProdEnv}    # every value should read encrypted:...`,
        "and make sure .env.keys is NOT tracked (see the .env.keys hygiene check).",
      ],
    });
  }

  // ── 2. Does a Dockerfile still ship the file into the image? ──────
  //
  // Only the runtime stage matters. A build stage that COPYs the repo
  // wholesale is fine and extremely common (`COPY packages/server ...`),
  // so match an explicit copy of the env file rather than any COPY.
  for (const rel of ["packages/server/Dockerfile", "Dockerfile"]) {
    const dockerfilePath = `${projectDir}/${rel}`;
    if (!existsSync(dockerfilePath)) continue;
    let content: string;
    try {
      content = readFileSync(dockerfilePath, "utf-8");
    } catch {
      continue;
    }
    // Only the FINAL stage ships. Everything before the last `FROM` is
    // discarded at build time, so a build stage that copies the env file
    // (to run a migration, say) is harmless and must not be flagged.
    // Docker builds the last stage unless `--target` says otherwise;
    // that's the assumption here, and the wrong guess would only cost a
    // false negative.
    const lines = content.split(/\r?\n/).map((l) => l.replace(/#.*$/, ""));
    const lastFrom = lines.reduce((acc, l, i) => (/^\s*FROM\b/i.test(l) ? i : acc), -1);
    const shipsEnv = lines
      .slice(lastFrom + 1)
      .some((l) => /^\s*COPY\b.*\.env\.production/i.test(l));
    if (!shipsEnv) continue;
    out.push({
      name: `Project ${projectName} (env model mismatch)`,
      status: "fail",
      detail: `${rel} copies .env.production into the image, but runtime config comes from Coolify env`,
      hint: [
        "hatchkit's model: Coolify's environment is the runtime source of truth, and the encrypted",
        ".env.production is the at-rest store `hatchkit sync` reads to populate it.",
        `Shipping the file into the image is the other model, and running both means two sources`,
        "of truth that drift — the container keeps serving a stale baked-in value after a rotate.",
        `Remove the COPY of .env.production from the runtime stage of ${rel}, then:`,
        `  hatchkit sync            # pushes the resolved values into Coolify`,
        "(It also puts ciphertext and its decryption key in the same image, which buys little.)",
      ],
    });
    break;
  }

  return out;
}

/**
 * Project-local deferred-step check, gated on `.hatchkit.json` in cwd.
 *
 * Reports one `deferred` row per optional step the user skipped during
 * create / adopt / add, with the exact follow-up command as the hint.
 * These are genuinely unfinished work the user asked to postpone — not
 * broken credentials — so they render distinctly and never make doctor
 * exit non-zero. A `skip` row would be invisible in the summary counts,
 * which is why they get their own status instead.
 *
 * Returns [] outside a Hatchkit project and for projects with nothing
 * deferred, so `hatchkit doctor` from $HOME stays clean.
 */
export function checkProjectDeferredSteps(projectDir: string): CheckResult[] {
  let steps: ReturnType<typeof readDeferredSteps>;
  try {
    steps = readDeferredSteps(projectDir);
  } catch {
    return [];
  }
  return steps.map((step) => ({
    name: `Deferred: ${step.label}`,
    status: "deferred" as const,
    detail: `${step.reason} (deferred ${step.deferredAt.slice(0, 10)})`,
    hint: [`Finish it: ${step.command}`, ...(step.hint ?? []).map((h) => `Prerequisite: ${h}`)],
  }));
}

/**
 * Inbound mail for the project's domain (Cloudflare Email Routing).
 *
 * Two failure modes worth a red row:
 *   · the DNS token lacks the Email Routing scopes — Cloudflare answers
 *     every Email Routing call with a bare `10000: Authentication
 *     error`, which reads like an expired token and isn't one;
 *   · the manifest records forwarding for this domain but the zone no
 *     longer receives (routing off, or its MX gone).
 * A project that never set up forwarding and has no MX is reported as
 * not configured, not failing — plenty of projects send without
 * receiving — but the detail says that mail to it bounces.
 */
export async function checkProjectEmailRoutingState(
  projectDir: string,
  deps: {
    readManifest?: typeof import("./scaffold/manifest.js").readManifest;
    getDnsConfig?: typeof getDnsConfig;
    makeClient?: (
      token: string,
      accountId?: string,
    ) => import("./email/routing-access.js").EmailRoutingReader;
  } = {},
): Promise<CheckResult[]> {
  const { existsSync } = await import("node:fs");
  if (!existsSync(`${projectDir}/.hatchkit.json`)) return [];
  const readManifest = deps.readManifest ?? (await import("./scaffold/manifest.js")).readManifest;
  let manifest: ReturnType<typeof readManifest>;
  try {
    manifest = readManifest(projectDir);
  } catch {
    return [];
  }
  const domain = manifest?.domain?.trim().toLowerCase();
  if (!manifest || !domain) return [];
  const dns = await (deps.getDnsConfig ?? getDnsConfig)();
  if (!dns?.apiToken) return [];

  const { probeEmailRouting, summarizeEmailRoutingProbe } = await import(
    "./email/routing-access.js"
  );
  const cf =
    deps.makeClient?.(dns.apiToken, dns.accountId) ??
    new (await import("./utils/cloudflare-api.js")).CloudflareApi({
      token: dns.apiToken,
      accountId: dns.accountId,
    });
  const name = `Email Routing (${domain})`;
  const recorded = manifest.integrations?.email;
  const recordedHere = recorded?.domain?.trim().toLowerCase() === domain;

  let probe: Awaited<ReturnType<typeof probeEmailRouting>>;
  try {
    probe = await probeEmailRouting(cf, domain, { accountId: dns.accountId });
  } catch (err) {
    return [
      {
        name,
        status: "fail",
        detail: (err as Error).message.split("\n")[0],
        hint: ["Re-run once Cloudflare is reachable: `hatchkit email status`"],
      },
    ];
  }
  if (probe.access === "unauthorized") {
    return [{ name, status: "fail", detail: probe.error.message, hint: probe.error.hint }];
  }
  const facts = summarizeEmailRoutingProbe(probe);
  switch (facts.state) {
    case "no-zone":
      return [];
    case "receiving":
      return [{ name, status: "ok", detail: `receiving via Cloudflare (${facts.zone})` }];
    case "foreign-mx":
      return [{ name, status: "ok", detail: `MX → ${facts.mxHosts.join(", ")} (not Cloudflare)` }];
    case "not-receiving": {
      const why = facts.enabled
        ? `routing is on for ${facts.zone} but ${domain} has no Cloudflare MX`
        : `routing is off for ${facts.zone} and ${domain} has no MX`;
      if (recordedHere) {
        return [
          {
            name,
            status: "fail",
            detail: `${why} — mail to @${domain} bounces`,
            hint: [
              ".hatchkit.json records forwarding for this domain, but the zone doesn't receive.",
              `Repair (idempotent): hatchkit email setup --domain ${domain}`,
            ],
          },
        ];
      }
      return [
        {
          name,
          status: "skip",
          detail: `${why} — mail to @${domain} bounces; \`hatchkit email setup\` to forward it`,
        },
      ];
    }
    default:
      return [];
  }
}

/**
 * Project-local SES Custom MAIL FROM hygiene check, gated on the
 * presence of `.hatchkit.json` in the cwd AND the project using
 * Listmonk + SES for at least one email need.
 *
 * Reports:
 *   · MAIL FROM not configured → suggests `hatchkit email ses-mail-from setup`.
 *   · SES status != SUCCESS    → status + actionable hint based on the value.
 *   · DNS drift (MX missing /
 *     SPF wrong)                → reconcile hint.
 *
 * Non-fatal: every problem here surfaces as a warning, never blocks. A
 * project with a working DKIM pipeline still sends mail without MAIL
 * FROM — it just leaks the AWS hostname into Gmail's "mailed-by" and
 * weakens DMARC SPF alignment.
 */
export async function checkProjectSesMailFromState(projectDir: string): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const { existsSync, readFileSync } = await import("node:fs");
  const manifestPath = `${projectDir}/.hatchkit.json`;
  if (!existsSync(manifestPath)) return out;

  let manifest: {
    name?: string;
    domain?: string;
    email?: { transactional?: string; mailingList?: string };
    ses?: { identity?: string; mailFromDomain?: string };
  };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    return out;
  }
  const usesListmonkSes =
    manifest.email?.transactional === "listmonk-ses" ||
    manifest.email?.mailingList === "listmonk-ses";
  if (!usesListmonkSes || !manifest.name || !manifest.domain) return out;

  const { getSesConfig } = await import("./config.js");
  const sesCfg = await getSesConfig();
  if (!sesCfg) {
    out.push({
      name: `Project ${manifest.name} (SES MAIL FROM)`,
      status: "skip",
      detail: "SES not configured globally — can't probe",
    });
    return out;
  }

  const { sesSendingSubdomain } = await import("./provision/listmonk-ses.js");
  const identity = manifest.ses?.identity ?? sesSendingSubdomain(manifest.domain);

  const { getSesMailFromDomain, sesMailFromMxTarget, SES_MAIL_FROM_SPF } = await import(
    "./provision/ses.js"
  );
  let state: Awaited<ReturnType<typeof getSesMailFromDomain>>;
  try {
    state = await getSesMailFromDomain(identity, {
      region: sesCfg.region,
      accessKeyId: sesCfg.accessKeyId,
      secretAccessKey: sesCfg.secretAccessKey,
    });
  } catch (err) {
    out.push({
      name: `Project ${manifest.name} (SES MAIL FROM)`,
      status: "fail",
      detail: `couldn't read SES MailFromAttributes: ${(err as Error).message.split("\n")[0]}`,
      hint: [
        "The SES IAM user may lack `ses:GetEmailIdentity` on this identity.",
        "Widen the policy and re-run.",
      ],
    });
    return out;
  }

  if (!state.mailFromDomain) {
    out.push({
      name: `Project ${manifest.name} (SES MAIL FROM)`,
      status: "fail",
      detail: `no custom MAIL FROM on ${identity} — Gmail shows mailed-by ${sesCfg.region}.amazonses.com and DMARC SPF alignment is weak`,
      hint: [`Run from the project dir: hatchkit email ses-mail-from setup`],
    });
    return out;
  }

  if (state.status !== "SUCCESS") {
    const statusHint =
      state.status === "PENDING"
        ? "SES is still waiting for DNS to propagate; normally flips to SUCCESS within minutes of the first set. Re-run doctor in a few minutes."
        : state.status === "FAILED"
          ? "SES couldn't find the MX record. Inspect MX + SPF rows in Cloudflare; reconcile via `hatchkit email ses-mail-from setup`."
          : state.status === "TEMPORARY_FAILURE"
            ? "SES had a transient DNS lookup failure. Re-run doctor in a few minutes."
            : "Unknown SES MAIL FROM status — re-run `hatchkit email ses-mail-from status` for live state.";
    out.push({
      name: `Project ${manifest.name} (SES MAIL FROM)`,
      status: "fail",
      detail: `${state.mailFromDomain} status: ${state.status ?? "unknown"}`,
      hint: [statusHint],
    });
    return out;
  }

  // DNS drift check: only runs when CF is configured.
  const dnsCfg = await getDnsConfig();
  if (!dnsCfg?.apiToken) {
    out.push({
      name: `Project ${manifest.name} (SES MAIL FROM)`,
      status: "ok",
      detail: `${state.mailFromDomain} status SUCCESS (DNS drift not verified — Cloudflare not configured)`,
    });
    return out;
  }
  const { CloudflareApi } = await import("./utils/cloudflare-api.js");
  const cf = new CloudflareApi({ token: dnsCfg.apiToken, accountId: dnsCfg.accountId });
  let zone: Awaited<ReturnType<typeof cf.resolveZoneForName>>;
  try {
    zone = await cf.resolveZoneForName(state.mailFromDomain);
  } catch {
    zone = null;
  }
  if (!zone) {
    out.push({
      name: `Project ${manifest.name} (SES MAIL FROM)`,
      status: "ok",
      detail: `${state.mailFromDomain} status SUCCESS (no CF zone — assuming user-managed DNS)`,
    });
    return out;
  }

  const expectedMx = sesMailFromMxTarget(sesCfg.region);
  const mxRows = await cf.findRecordsByName(zone.id, state.mailFromDomain, "MX");
  const txtRows = await cf.findRecordsByName(zone.id, state.mailFromDomain, "TXT");
  const mxOk = mxRows.some((r) => r.content === expectedMx);
  const spfOk = txtRows.some((r) => /v=spf1.*include:amazonses\.com/i.test(r.content));
  if (mxOk && spfOk) {
    out.push({
      name: `Project ${manifest.name} (SES MAIL FROM)`,
      status: "ok",
      detail: `${state.mailFromDomain} status SUCCESS, MX + SPF live`,
    });
    return out;
  }

  const drift: string[] = [];
  if (!mxOk) drift.push(`MX missing or wrong (expected ${expectedMx})`);
  if (!spfOk) drift.push(`SPF TXT missing (expected ${SES_MAIL_FROM_SPF})`);
  out.push({
    name: `Project ${manifest.name} (SES MAIL FROM)`,
    status: "fail",
    detail: `${state.mailFromDomain} DNS drift: ${drift.join("; ")}`,
    hint: [`Reconcile: hatchkit email ses-mail-from setup`],
  });
  return out;
}

/**
 * Project-local Listmonk opt-in check, gated on `.hatchkit.json` in the
 * cwd AND the project using Listmonk + SES for its mailing list.
 *
 * Fails when the project's `<name>` or `<name>-test` list is still
 * `optin: single`: Listmonk sends a campaign on such a list to every
 * member not `unsubscribed`, `unconfirmed` included, so an address
 * typed into the signup form gets every issue without confirming.
 * Hatchkit created lists single before it created them double, so
 * older projects carry this. Read-only: one `GET /api/lists`. Doctor
 * never switches the list; the hint gives the safe order.
 */
export async function checkProjectListmonkOptinState(projectDir: string): Promise<CheckResult[]> {
  const { existsSync, readFileSync } = await import("node:fs");
  const manifestPath = `${projectDir}/.hatchkit.json`;
  if (!existsSync(manifestPath)) return [];

  let manifest: { name?: string; email?: { mailingList?: string } };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    return [];
  }
  if (manifest.email?.mailingList !== "listmonk-ses" || !manifest.name) return [];
  const name = `Project ${manifest.name} (Listmonk opt-in)`;

  const { getListmonkConfig } = await import("./config.js");
  const listmonkCfg = await getListmonkConfig();
  if (!listmonkCfg) {
    return [{ name, status: "skip", detail: "Listmonk not configured globally — can't probe" }];
  }

  const { listListmonkLists } = await import("./provision/listmonk.js");
  const { singleOptinHint, singleOptinLists } = await import("./provision/listmonk-ses.js");
  let lists: Awaited<ReturnType<typeof listListmonkLists>>;
  try {
    lists = await listListmonkLists(listmonkCfg);
  } catch (err) {
    return [
      {
        name,
        status: "fail",
        detail: `couldn't list Listmonk lists: ${(err as Error).message.split("\n")[0]}`,
        hint: ["The API user needs `lists:get_all`. Edit its role in Listmonk → Admin → Users."],
      },
    ];
  }

  const wanted = new Set([manifest.name, `${manifest.name}-test`]);
  const own = lists.filter((l) => wanted.has(l.name));
  if (own.length === 0) {
    return [
      {
        name,
        status: "skip",
        detail: `no list named ${[...wanted].join(" / ")} on ${listmonkCfg.url}`,
      },
    ];
  }
  const single = singleOptinLists(own);
  if (single.length === 0) {
    return [{ name, status: "ok", detail: `${own.map((l) => l.name).join(", ")} double opt-in` }];
  }
  return [
    {
      name,
      status: "fail",
      detail: `${single.map((l) => l.name).join(", ")} single opt-in — campaigns reach unconfirmed members too`,
      hint: singleOptinHint(single),
    },
  ];
}

/**
 * Project-local Listmonk tx template check, gated on `.hatchkit.json` in
 * the cwd AND the project using Listmonk + SES for email.
 *
 * Fails when the project's `<name>-tx` template renders a bare
 * `{{ .Tx.Data.body }}`. Listmonk parses a tx body with Go's
 * `html/template`, so that form HTML-escapes the app's HTML and every
 * confirmation or reset email arrives as visible markup. Hatchkit seeded
 * this body before it piped it through `Safe`. Read-only: one
 * `GET /api/templates`. The repair runs only under `--fix`.
 */
export async function checkProjectListmonkTxTemplateState(
  projectDir: string,
): Promise<CheckResult[]> {
  const { existsSync, readFileSync } = await import("node:fs");
  const manifestPath = `${projectDir}/.hatchkit.json`;
  if (!existsSync(manifestPath)) return [];

  let manifest: {
    name?: string;
    email?: { transactional?: string; mailingList?: string };
  };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    return [];
  }
  const usesListmonkSes =
    manifest.email?.transactional === "listmonk-ses" ||
    manifest.email?.mailingList === "listmonk-ses";
  if (!usesListmonkSes || !manifest.name) return [];
  const name = `Project ${manifest.name} (Listmonk tx template)`;

  const { getListmonkConfig } = await import("./config.js");
  const listmonkCfg = await getListmonkConfig();
  if (!listmonkCfg) {
    return [{ name, status: "skip", detail: "Listmonk not configured globally — can't probe" }];
  }

  const { listListmonkTemplates } = await import("./provision/listmonk.js");
  const { escapedTxTemplateHint, repairEscapedTxTemplate, txBodyRendersEscaped } = await import(
    "./provision/listmonk-ses.js"
  );
  let templates: Awaited<ReturnType<typeof listListmonkTemplates>>;
  try {
    templates = await listListmonkTemplates(listmonkCfg);
  } catch (err) {
    return [
      {
        name,
        status: "fail",
        detail: `couldn't list Listmonk templates: ${(err as Error).message.split("\n")[0]}`,
        hint: ["The API user needs `templates:get`. Edit its role in Listmonk → Admin → Users."],
      },
    ];
  }

  const txName = `${manifest.name}-tx`;
  const template = templates.find((t) => t.name === txName && t.type === "tx");
  if (!template) {
    return [
      { name, status: "skip", detail: `no tx template named ${txName} on ${listmonkCfg.url}` },
    ];
  }
  if (!txBodyRendersEscaped(template.body ?? "")) {
    return [
      { name, status: "ok", detail: `${txName} (id ${template.id}) renders the body as HTML` },
    ];
  }
  return [
    {
      name,
      status: "fail",
      detail: `${txName} (id ${template.id}) HTML-escapes the body — emails arrive as visible markup`,
      hint: escapedTxTemplateHint(template),
      repair: {
        prompt: `Pipe the body of ${txName} (id ${template.id}) through Safe on ${listmonkCfg.url}?`,
        run: async () => {
          const outcome = await repairEscapedTxTemplate(template.id, listmonkCfg);
          return outcome === "repaired"
            ? `${txName} (id ${template.id}) now renders {{ .Tx.Data.body | Safe }}`
            : `${txName} (id ${template.id}) was already safe — left unchanged`;
        },
      },
    },
  ];
}

/** What to do once a dotenvx private key has touched git, in order.
 *  Rotation comes first: every value written before it is encrypted to
 *  a key others may hold, and a history purge alone un-leaks nothing. */
function burnedKeyHint(projectName: string): string[] {
  return [
    "Treat the key as burned: rotate it BEFORE writing any new value, or new values are encrypted to a key others may hold.",
    `  hatchkit keys rotate ${projectName}`,
    "Then rotate every value in .env.production (provider credentials, app secrets):",
    `  hatchkit secrets rotate ${projectName}   # provider credentials hatchkit knows; rotate the rest by hand`,
    "If the repo is or was public, consider purging .env.keys from history and asking GitHub Support to drop cached objects.",
  ];
}

function exposureHint(exposure: {
  count: number;
  first?: string;
  last?: string;
  files: string[];
}): string[] {
  if (exposure.count === 0) return ["No committed env file is encrypted to that key."];
  const range =
    exposure.first === exposure.last ? exposure.first : `${exposure.first} → ${exposure.last}`;
  const noun = exposure.count === 1 ? "version" : "versions";
  return [
    `${exposure.count} committed ${noun} of ${exposure.files.join(", ")} (${range}) are encrypted to it.`,
  ];
}

/** Project-local key hygiene checks, gated on the presence of
 *  `.hatchkit.json` in the cwd:
 *
 *    1. Every `.env.keys` on disk (root and server dir) is untracked
 *       AND ignored by the repo's own `.gitignore`. Untracked but not
 *       ignored, the next `git add -A` commits it — that is how
 *       collection-of-beauty leaked its key. A global ignore alone
 *       doesn't travel to other machines or CI, so it only warns.
 *    2. No dotenvx private key was ever committed on any ref. Untracking
 *       the file doesn't remove it from history. If the committed key is
 *       still in use, everything encrypted since is readable by anyone
 *       with the history; if it's an older key, the ciphertexts committed
 *       while it was active are.
 *    3. The keychain copy of DOTENV_PRIVATE_KEY_PRODUCTION matches
 *       the value in `.env.keys`. After `dotenvx rotate` the file
 *       updates but the keychain doesn't — `keys set` fixes that;
 *       this check surfaces the drift before a deploy goes wrong.
 *
 *  Read-only. No key, and no fingerprint of one, reaches a result.
 *
 *  Exported so tests can invoke it directly with a fixture dir
 *  instead of munging `process.cwd()`. */
export async function checkProjectKeyState(projectDir: string): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const manifestPath = `${projectDir}/.hatchkit.json`;
  const { existsSync, readFileSync, realpathSync } = await import("node:fs");
  if (!existsSync(manifestPath)) return out;

  let projectName: string;
  try {
    const m = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      name?: string;
    };
    if (!m.name) return out;
    projectName = m.name;
  } catch {
    return out;
  }

  const { join, relative } = await import("node:path");
  const { locateEnvKeysFile, parsePrivateKeyValue } = await import("./deploy/keys.js");
  const { envFileCandidates } = await import("./utils/env-files.js");
  const history = await import("./utils/env-keys-history.js");
  const { gitToplevel } = await import("./utils/gitignore.js");

  // Every `.env.keys` the project has: the server dir the env resolver
  // picks (packages/server/ in the split layout) and the root.
  const keyFiles = [
    ...new Set([...envFileCandidates(projectDir, ".env.keys"), join(projectDir, ".env.keys")]),
  ].filter((p) => existsSync(p));

  const repoRoot = gitToplevel(projectDir);
  if (repoRoot) {
    // git reports the real path; compare it with the real projectDir so
    // a symlinked cwd (macOS /var → /private/var) doesn't yield ../../..
    const gitignore =
      relative(realpathSync(projectDir), join(repoRoot, ".gitignore")) || ".gitignore";
    const addIgnore = `  printf '\\n.env.keys\\n' >> ${gitignore}`;
    const globalNote =
      "A global ignore (core.excludesFile) is not enough: it doesn't travel to other machines, CI or a fresh container, where `git add -A` still commits the key.";
    const burned = burnedKeyHint(projectName);

    // Check 1: every on-disk `.env.keys` is untracked and ignored.
    // Paths go to git relative to projectDir so they resolve inside the
    // repo wherever doctor was invoked from. `--error-unmatch` exits 1
    // when the path is untracked, 0 when tracked.
    const ignoredBy: string[] = [];
    for (const file of keyFiles) {
      const rel = relative(projectDir, file);
      const tracked = await execOk("git", ["ls-files", "--error-unmatch", rel], {
        cwd: projectDir,
      });
      if (tracked) {
        out.push({
          name: `Project ${projectName} (.env.keys leak)`,
          status: "fail",
          detail: `${rel} is tracked by git`,
          hint: ["Untrack it and ignore it:", `  git rm --cached ${rel}`, addIgnore, ...burned],
        });
        continue;
      }
      const state = await history.ignoreState(projectDir, rel);
      if (!state.ignored) {
        out.push({
          name: `Project ${projectName} (.env.keys not ignored)`,
          status: "fail",
          detail: `${rel} is not git-ignored — the next \`git add -A\` commits the private key`,
          hint: [
            ...(state.negated
              ? [`${state.source} re-includes it with a \`!\` pattern — remove that line.`]
              : []),
            "Add it to the repo's own .gitignore:",
            addIgnore,
            globalNote,
          ],
        });
      } else if (!state.portable) {
        out.push({
          name: `Project ${projectName} (.env.keys not ignored)`,
          status: "warn",
          detail: `${rel} is ignored only by ${state.source}, not by the repo's .gitignore`,
          hint: ["Add it to the repo's own .gitignore:", addIgnore, globalNote],
        });
      } else {
        ignoredBy.push(state.source ?? ".gitignore");
      }
    }

    // Check 2: was a private key ever committed? The on-disk keys and
    // the public keys the working tree encrypts to are "in use"; with
    // neither on this machine (CI, a fresh clone) the public keys still
    // answer.
    const currentPrivate: string[] = [];
    for (const file of keyFiles) {
      currentPrivate.push(...history.parseCurrentPrivateKeys(readFileSync(file, "utf-8")));
    }
    const currentPublic: string[] = [];
    for (const name of [".env.production", ".env.development", ".env"]) {
      for (const file of envFileCandidates(projectDir, name)) {
        if (existsSync(file))
          currentPublic.push(...history.parsePublicKeys(readFileSync(file, "utf-8")));
      }
    }
    const scan = await history.scanEnvKeysHistory(repoRoot, {
      privateKeys: currentPrivate,
      publicKeys: currentPublic,
    });
    const hit = scan.currentKeyCommit ?? scan.oldKeyCommit;
    const visibility = hit ? await history.originVisibility(repoRoot) : undefined;
    const suffix = visibility ? `; ${visibility}` : "";
    if (scan.currentKeyCommit) {
      const { shortSha, date } = scan.currentKeyCommit;
      out.push({
        name: `Project ${projectName} (.env.keys in git history)`,
        status: "fail",
        detail: `the current dotenvx private key is in git history (${shortSha}, ${date})${suffix}`,
        hint: [...burned, ...exposureHint(scan.currentExposure)],
      });
    } else if (scan.oldKeyCommit) {
      const { shortSha, date } = scan.oldKeyCommit;
      // Nothing here to compare with: no `.env.keys` and no public key in
      // the working tree. The committed key may well be the live one.
      const unknown = currentPrivate.length === 0 && currentPublic.length === 0;
      out.push({
        name: `Project ${projectName} (.env.keys in git history)`,
        status: "warn",
        detail: unknown
          ? `a dotenvx private key is in git history (${shortSha}, ${date}); nothing on this machine shows whether it is still in use${suffix}`
          : `an older dotenvx private key is in git history (${shortSha}, ${date}) — values committed while it was active can be decrypted${suffix}`,
        hint: [
          "Check that those values were rotated after that key was replaced. Rotating the key alone re-encrypts the same values.",
          ...exposureHint(scan.oldExposure),
          `  hatchkit secrets rotate ${projectName}   # provider credentials hatchkit knows; rotate the rest by hand`,
          "If the repo is or was public, consider purging .env.keys from history and asking GitHub Support to drop cached objects.",
        ],
      });
    }

    const allClean = keyFiles.length > 0 && ignoredBy.length === keyFiles.length;
    if (allClean && !hit) {
      const where = [...new Set(ignoredBy)].join(", ");
      const past = !scan.checked
        ? "git history not checked"
        : scan.shallow
          ? "never committed (shallow clone — older history not checked)"
          : scan.truncated
            ? "never committed in the commits checked"
            : "never committed";
      out.push({
        name: `Project ${projectName} (.env.keys hygiene)`,
        status: "ok",
        detail: `.env.keys is ignored by ${where}, not tracked, and ${past}`,
      });
    }
  } else if (keyFiles.length > 0) {
    out.push({
      name: `Project ${projectName} (.env.keys hygiene)`,
      status: "skip",
      detail: "not a git repository — nothing to commit .env.keys into",
    });
  }

  const envKeysPath = locateEnvKeysFile(projectDir);
  if (!envKeysPath) {
    // No `.env.keys` on disk → nothing to compare the keychain with.
    // Common in CI checkouts where dotenvx setup hasn't run.
    return out;
  }

  // Check 3: keychain matches `.env.keys`.
  const fileKey = parsePrivateKeyValue(readFileSync(envKeysPath, "utf-8"));
  if (!fileKey) {
    // .env.keys exists but has no DOTENV_PRIVATE_KEY_PRODUCTION line —
    // unusual but not necessarily wrong (e.g., only dev keys present).
    return out;
  }
  const keychainKey = await getSecret(SECRET_KEYS.dotenvxPrivateKey(projectName));
  if (!keychainKey) {
    out.push({
      name: `Project ${projectName} (keychain drift)`,
      status: "fail",
      detail: "DOTENV_PRIVATE_KEY_PRODUCTION is missing from the OS keychain",
      hint: [
        "The keychain copy was wiped (e.g. by `config reset`) but `.env.keys` still has the value.",
        `Restore it from disk: hatchkit keys set ${projectName}`,
      ],
    });
  } else if (keychainKey !== fileKey) {
    out.push({
      name: `Project ${projectName} (keychain drift)`,
      status: "fail",
      detail: "OS keychain holds a different DOTENV_PRIVATE_KEY_PRODUCTION than .env.keys",
      hint: [
        "Likely cause: `dotenvx rotate` ran but the keychain wasn't updated.",
        `Sync from .env.keys: hatchkit keys set ${projectName}`,
        `(Or, if you want the OLD key: hatchkit keys show ${projectName} > .env.keys.bak)`,
      ],
    });
  } else {
    out.push({
      name: `Project ${projectName} (keychain sync)`,
      status: "ok",
      detail: "OS keychain matches .env.keys",
    });
  }

  return out;
}

/** Provisioned dev credentials in a committable `.env.development`.
 *  Until 2026-09-29 `hatchkit add` wrote them there, and the starter
 *  commits that file. They belong in the gitignored
 *  `.env.development.local`; `hatchkit update` moves them. Also fails
 *  on an `.env.development.local` the repo does not ignore. Read-only,
 *  and hints name keys, never values.
 *
 *  What it says about git comes from `gitFileState`: "is committed"
 *  and "rotate" about a file git never saw send a leak response after
 *  a leak that does not exist (the move warning did that on 2026-09-29). */
export async function checkProjectDevEnvSecretsState(projectDir: string): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const { existsSync, readFileSync, realpathSync } = await import("node:fs");
  const { basename, dirname, join, relative } = await import("node:path");
  if (!existsSync(join(projectDir, ".hatchkit.json"))) return out;
  const { describeGitFileState, gitFileState, gitToplevel, ignoredByRepo } = await import(
    "./utils/gitignore.js"
  );
  const top = gitToplevel(projectDir);
  if (!top) return out;
  const { envFileCandidates } = await import("./utils/env-files.js");
  const { DEV_ENV_FILE, DEV_LOCAL_ENV_FILE, findDevEnvSecrets } = await import(
    "./utils/dev-env-secrets.js"
  );
  // git's toplevel is a real path; resolve the file's directory the same
  // way (macOS tmpdir is /var → /private/var) or `relative` escapes it.
  const repoRel = (p: string): string => relative(top, join(realpathSync(dirname(p)), basename(p)));

  for (const devPath of envFileCandidates(projectDir, DEV_ENV_FILE).filter((p) => existsSync(p))) {
    const path = repoRel(devPath);
    const keys = findDevEnvSecrets(readFileSync(devPath, "utf-8")).map((s) => s.key);
    if (keys.length > 0) {
      const state = gitFileState(devPath);
      const committable =
        state.kind === "tracked" ||
        (state.kind === "never-committed" ? !state.ignoredByRepo : !ignoredByRepo(top, path));
      if (committable) {
        const move = [
          `${DEV_ENV_FILE} is for local defaults only. Provisioned dev credentials belong in the`,
          `gitignored ${DEV_LOCAL_ENV_FILE}:`,
          "  hatchkit update      # moves them there and makes the server load it",
        ];
        const history = "If any of those commits held these values, they are in git history:";
        const rotate =
          "rotate each one (hatchkit secrets rotate <project> covers the supported providers).";
        const facts = describeGitFileState(path, state);
        let where: string;
        let hint: string[];
        switch (state.kind) {
          case "tracked":
            where = "tracked by git";
            hint =
              state.commits > 0
                ? [...facts, ...move, history, rotate]
                : [
                    ...facts,
                    ...move,
                    "Run it before you commit, so the first commit does not record these values.",
                  ];
            break;
          case "in-history":
            where = "in git history, and the repo's .gitignore does not ignore it";
            hint = [...facts, ...move, history, rotate];
            break;
          case "never-committed":
            where = "never committed, but the repo's .gitignore does not ignore it";
            hint = [...facts, ...move];
            break;
          case "unknown":
            where = "the repo's .gitignore does not ignore it";
            hint = [
              ...move,
              "If the file was ever committed with these values, they are in git history:",
              rotate,
            ];
            break;
        }
        out.push({
          name: `Dev env credentials (${path})`,
          status: "fail",
          detail: `${where}; holds provisioned credentials: ${keys.join(", ")}`,
          hint,
        });
      }
    }
    const localPath = join(dirname(devPath), DEV_LOCAL_ENV_FILE);
    const localRel = repoRel(localPath);
    if (existsSync(localPath) && !ignoredByRepo(top, localRel)) {
      out.push({
        name: `Dev env credentials (${localRel})`,
        status: "fail",
        detail: "holds plaintext dev credentials and the repo's .gitignore does not cover it",
        hint: ["  echo '.env.*.local' >> .gitignore"],
      });
    }
  }
  return out;
}

/** Compare the manifest's recorded CORS rule for the assets bucket
 *  against the live policy on Cloudflare. Drifts are common when a
 *  user hand-edits the bucket CORS in the dashboard or when the project
 *  domain changed without re-running provision. The fix hint always
 *  points at `hatchkit provision s3` because that's the single
 *  reconcile path; we don't try to diff at field granularity.
 *
 *  Skipped silently when:
 *    · no manifest at cwd (running outside a hatchkit project)
 *    · manifest has no `s3Buckets.assets` (project never provisioned R2)
 *    · `cors.skipped === true` (user opted out via --no-cors;
 *      they're managing CORS out-of-band)
 *    · admin token / accountId not available (config gap is its own
 *      check above; no need to double-fail) */
export async function checkProjectS3CorsState(projectDir: string): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const { existsSync, readFileSync } = await import("node:fs");
  const manifestPath = `${projectDir}/.hatchkit.json`;
  if (!existsSync(manifestPath)) return out;

  let manifest: {
    name?: string;
    domain?: string;
    s3Buckets?: {
      accountId?: string;
      assets?: {
        name?: string;
        cors?: {
          origins?: string[];
          methods?: string[];
          maxAgeSeconds?: number;
          extraOrigins?: string[];
          skipped?: boolean;
        };
      };
    };
  };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    return out;
  }
  if (!manifest.name || !manifest.s3Buckets?.assets?.name) return out;
  if (manifest.s3Buckets.assets.cors?.skipped === true) return out;

  const accountId = manifest.s3Buckets.accountId;
  if (!accountId) {
    // Pre-CORS-era manifest. Doctor's checkS3("r2") already nags about
    // global config; here we just point at provision to record state.
    out.push({
      name: `Project ${manifest.name} (R2 CORS)`,
      status: "skip",
      detail: "manifest has no recorded accountId; provision s3 hasn't run since CORS landed",
    });
    return out;
  }

  const adminToken = await getSecret(SECRET_KEYS.r2AdminToken);
  if (!adminToken) {
    out.push({
      name: `Project ${manifest.name} (R2 CORS)`,
      status: "skip",
      detail: "R2 admin token not in keychain — can't read bucket CORS",
    });
    return out;
  }

  const { CloudflareApi } = await import("./utils/cloudflare-api.js");
  const cf = new CloudflareApi({ token: adminToken });

  let live: Awaited<ReturnType<typeof cf.getR2BucketCors>>;
  try {
    live = await cf.getR2BucketCors(accountId, manifest.s3Buckets.assets.name);
  } catch (err) {
    out.push({
      name: `Project ${manifest.name} (R2 CORS)`,
      status: "fail",
      detail: `couldn't read bucket CORS: ${(err as Error).message.split("\n")[0]}`,
      hint: [
        "The R2 admin token may be missing `Workers R2 Storage: Edit`.",
        "Edit at https://dash.cloudflare.com/profile/api-tokens, then re-run.",
      ],
    });
    return out;
  }

  const recordedOrigins = manifest.s3Buckets.assets.cors?.origins ?? [];
  const liveOrigins = live?.[0]?.allowed?.origins ?? [];
  const liveSorted = [...liveOrigins].sort();
  const recordedSorted = [...recordedOrigins].sort();

  if (recordedSorted.length === 0) {
    // Manifest pre-dates the cors field. Only flag if there's actually
    // a live policy mismatch worth surfacing — otherwise stay quiet
    // until the user runs provision.
    if (liveSorted.length === 0) {
      out.push({
        name: `Project ${manifest.name} (R2 CORS)`,
        status: "fail",
        detail:
          "no CORS policy on the assets bucket — browser fetch() / crossOrigin will be blocked",
        hint: [
          "Apply hatchkit's default policy:",
          `  hatchkit provision s3       (reconciles CORS using ${manifest.domain ?? "<project domain>"} + localhost)`,
        ],
      });
    } else {
      out.push({
        name: `Project ${manifest.name} (R2 CORS)`,
        status: "skip",
        detail: `live policy has ${liveSorted.length} origin(s) but manifest has no cors record yet`,
      });
    }
    return out;
  }

  const same =
    liveSorted.length === recordedSorted.length &&
    liveSorted.every((o, i) => o === recordedSorted[i]);
  if (same) {
    out.push({
      name: `Project ${manifest.name} (R2 CORS)`,
      status: "ok",
      detail: `bucket CORS matches manifest (${recordedSorted.length} origin(s))`,
    });
  } else {
    out.push({
      name: `Project ${manifest.name} (R2 CORS)`,
      status: "fail",
      detail: `bucket CORS drift — live ${liveSorted.length} origin(s), manifest ${recordedSorted.length}`,
      hint: [
        `manifest: ${recordedSorted.join(", ") || "(empty)"}`,
        `live:     ${liveSorted.join(", ") || "(empty)"}`,
        "Reconcile by re-running:",
        "  hatchkit provision s3",
      ],
    });
  }
  return out;
}

/** Verify the per-project R2 access/secret pair (minted by `provision s3`)
 *  still has the perms it claims. We do a HeadBucket against each bucket
 *  recorded in the manifest — cheapest GET on the S3 protocol, returns
 *  200 when the token is valid AND scoped to that bucket, 403/404/etc
 *  otherwise. The admin token check above doesn't catch this: a user can
 *  revoke a per-project token from the dashboard without touching the
 *  global admin token, leaving CORS / deploys broken at runtime.
 *
 *  Skipped silently when:
 *    · no manifest at cwd
 *    · manifest has no `s3Buckets.assets` (project never provisioned R2)
 *    · per-project access/secret aren't in the keychain (legacy project
 *      still on the deprecated account-wide pair — checkS3('r2') above
 *      already covers that case) */
export async function checkProjectR2CredsState(projectDir: string): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const { existsSync, readFileSync } = await import("node:fs");
  const manifestPath = `${projectDir}/.hatchkit.json`;
  if (!existsSync(manifestPath)) return out;

  let manifest: {
    name?: string;
    s3Buckets?: {
      accountId?: string;
      assets?: { name?: string };
      state?: { name?: string };
    };
  };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    return out;
  }
  if (!manifest.name || !manifest.s3Buckets?.accountId) return out;

  const buckets = [manifest.s3Buckets.assets?.name, manifest.s3Buckets.state?.name].filter(
    (n): n is string => typeof n === "string" && n.length > 0,
  );
  if (buckets.length === 0) return out;

  const accessKey = await getSecret(SECRET_KEYS.s3ProjectAccessKey("r2", manifest.name));
  const secretKey = await getSecret(SECRET_KEYS.s3ProjectSecretKey("r2", manifest.name));
  if (!accessKey || !secretKey) {
    out.push({
      name: `Project ${manifest.name} (R2 per-project creds)`,
      status: "skip",
      detail: "no per-project R2 access/secret in keychain — legacy project on account-wide pair",
    });
    return out;
  }

  const { HeadBucketCommand, S3Client } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${manifest.s3Buckets.accountId}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  });
  try {
    for (const name of buckets) {
      try {
        await client.send(new HeadBucketCommand({ Bucket: name }));
        out.push({
          name: `Project ${manifest.name} (R2 ${name})`,
          status: "ok",
          detail: "per-project token reaches bucket",
        });
      } catch (err) {
        const msg = (err as Error).message.split("\n")[0];
        out.push({
          name: `Project ${manifest.name} (R2 ${name})`,
          status: "fail",
          detail: `per-project token can't reach bucket: ${msg}`,
          hint: [
            "Token was likely revoked in the Cloudflare dashboard.",
            `Re-mint: hatchkit provision s3   (reuses ${manifest.name}'s manifest)`,
          ],
        });
      }
    }
  } finally {
    client.destroy();
  }
  return out;
}

/** Report manifests that predate the `publicService` field.
 *
 *  `publicService` names the compose service that takes the bare
 *  domain. The manifest reader now derives it from `surfaces` on every
 *  read and routing filters the result through the project's actual
 *  compose file, so an absent value is no longer a routing hazard —
 *  which is why this reports `skip` rather than `fail`. What's left is
 *  that the file doesn't SAY what it is, leaving every reader to
 *  re-derive it; `hatchkit update` writes it down.
 *
 *  Skipped silently when:
 *    · no manifest at cwd
 *    · manifest already has `publicService` set
 *    · manifest has no `surfaces` field (legacy v1 / pre-surfaces) */
export async function checkProjectPublicServiceState(projectDir: string): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const { existsSync, readFileSync } = await import("node:fs");
  const manifestPath = `${projectDir}/.hatchkit.json`;
  if (!existsSync(manifestPath)) return out;

  let manifest: {
    name?: string;
    surfaces?: string;
    publicService?: string;
    deploymentMode?: string;
  };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    return out;
  }
  if (!manifest.name) return out;
  // Static-host and scaffold-only projects don't route through
  // Coolify, so publicService is irrelevant to them.
  if (!isCoolifyManagedMode(manifest.deploymentMode)) return out;
  if (!manifest.surfaces) return out;
  if (manifest.publicService) {
    out.push({
      name: `Project ${manifest.name} (publicService)`,
      status: "ok",
      detail: `${manifest.publicService} (surfaces=${manifest.surfaces})`,
    });
    return out;
  }
  const { defaultPublicServiceForSurfaces } = await import("./scaffold/manifest.js");
  const suggested = defaultPublicServiceForSurfaces(
    manifest.surfaces as "fullstack" | "split" | "backend" | "static" | undefined,
  );
  out.push({
    name: `Project ${manifest.name} (publicService)`,
    // Not a `fail`: hatchkit derives the value from `surfaces` on every
    // read, so routing is already correct — the file just doesn't say
    // so, which leaves the next reader to re-derive it.
    status: "skip",
    detail: `manifest has no publicService on disk — derived as "${suggested ?? "client"}" from surfaces=${manifest.surfaces}`,
    hint: [
      `Run: hatchkit update    (persists publicService + the current manifest schema)`,
      `Or set it by hand. Suggested for surfaces=${manifest.surfaces}: "${suggested ?? "client"}".`,
      `Then: hatchkit sync --dry-run    (read-only; shows what routing that produces)`,
    ],
  });
  return out;
}

/** Report the project's deployment topology and the routing it implies,
 *  offline.
 *
 *  Worth its own check because the failure it points at is invisible
 *  from the outside: every pre-0.2.19 hatchkit sent SEVERAL domains for
 *  one compose service, and Coolify — which stores
 *  `docker_compose_domains` as a map keyed by service name — kept only
 *  the last. So `https://<domain>/api` was never routed on any project
 *  hatchkit created, and the only surviving API route pointed at an
 *  `api.<domain>` subdomain that had no DNS record. The front page
 *  worked, so nothing looked wrong until someone called the API.
 *
 *  Deliberately offline: it reads the manifest and the compose file and
 *  names the command that checks the live state (`hatchkit sync
 *  --dry-run`, which is read-only) rather than doing network I/O here.
 *
 *  Skipped silently for gh-pages / scaffold-only projects — they don't
 *  route through Coolify at all. */
export async function checkProjectRoutingState(projectDir: string): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const { existsSync, readFileSync } = await import("node:fs");
  const manifestPath = `${projectDir}/.hatchkit.json`;
  if (!existsSync(manifestPath)) return out;

  let manifest: {
    name?: string;
    domain?: string;
    aliases?: string[];
    surfaces?: string;
    topology?: string;
    publicService?: string;
    ports?: { server?: number; client?: number };
    deploymentMode?: string;
  };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    return out;
  }
  if (!manifest.name || !manifest.domain) return out;
  if (manifest.deploymentMode === "gh-pages" || manifest.deploymentMode === "scaffold-only") {
    return out;
  }

  const { computeRoutingPlan, inferTopology } = await import("./deploy/routing.js");
  const { manifestHostnames } = await import("./scaffold/manifest.js");
  const { readComposeFile } = await import("./utils/compose.js");
  const compose = readComposeFile(projectDir);
  const inference = inferTopology({
    topology: manifest.topology,
    composeServices: compose?.services,
  });
  const plan = computeRoutingPlan({
    name: manifest.name,
    domain: manifest.domain,
    hostnameAliases: manifestHostnames({
      domain: manifest.domain,
      aliases: manifest.aliases,
    }).slice(1),
    topology: inference.topology,
    surfaces: manifest.surfaces as "fullstack" | "split" | "backend" | "static" | undefined,
    ports: manifest.ports,
    publicService: manifest.publicService,
    composeServices: compose?.services,
  });

  const routes = plan.apps
    .flatMap((a) => a.composeDomains.map((d) => `${a.appName}:${d.name} → ${d.domain}`))
    .join("; ");

  // A phantom service name is the one failure Coolify won't report:
  // it answers the PATCH with 200 OK and then emits no traefik labels,
  // so the app 503s every request.
  const missing = plan.apps.flatMap((a) =>
    compose ? a.requiredComposeServices.filter((n) => !compose.services.includes(n)) : [],
  );
  if (missing.length > 0 && compose) {
    out.push({
      name: `Project ${manifest.name} (routing)`,
      status: "fail",
      detail: `routing names compose service(s) ${missing.join(", ")} that ${compose.fileName} does not declare`,
      hint: [
        `${compose.fileName} declares: ${compose.services.join(", ")}.`,
        `Set "publicService" in .hatchkit.json to one of those, or add the missing service.`,
        "Coolify accepts routing for a service that isn't in the compose with a 200 OK and then emits no traefik labels — every request 503s.",
      ],
    });
    return out;
  }

  if (!manifest.topology) {
    out.push({
      name: `Project ${manifest.name} (topology)`,
      // `skip`, not `fail`: the assumed value is what every pre-topology
      // hatchkit actually deployed, so nothing is broken — it's just
      // not written down, and writing it down stops future runs from
      // having to re-derive it.
      status: "skip",
      detail: `no topology in manifest — assuming ${inference.topology}`,
      hint: [
        `Run \`hatchkit update\` to persist it, or add "topology": "${inference.topology}" to .hatchkit.json by hand.`,
        `Assumed routing: ${routes}`,
        "Check the live state (read-only): hatchkit sync --dry-run",
      ],
    });
    return out;
  }

  out.push({
    name: `Project ${manifest.name} (topology)`,
    status: "ok",
    detail: `${inference.topology} — ${routes}`,
    ...(plan.extraDnsHostnames.length > 0
      ? {
          hint: [
            `This topology also needs DNS for: ${plan.extraDnsHostnames.join(", ")}.`,
            `Verify: dig +short ${plan.extraDnsHostnames[0]}`,
          ],
        }
      : {}),
  });
  return out;
}

/** Verify that the commit Coolify clones actually contains the compose
 *  file each application builds from.
 *
 *  This is the cheapest possible read of the most expensive
 *  misdiagnosis in the deploy path: Coolify deploys `origin/<branch>`,
 *  not the working tree, and a compose file that has never been pushed
 *  makes every deploy fail with a git error about credentials that are
 *  perfectly fine. deploy/deployed-ref.ts has the whole story.
 *
 *  Git-only apart from one optional Coolify GET for the app's real
 *  branch — so it still answers on a machine with no Coolify token. */
export async function checkProjectDeployedRefState(projectDir: string): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const { existsSync, readFileSync } = await import("node:fs");
  const manifestPath = `${projectDir}/.hatchkit.json`;
  if (!existsSync(manifestPath)) return out;

  let manifest: {
    name?: string;
    domain?: string;
    aliases?: string[];
    surfaces?: string;
    topology?: string;
    publicService?: string;
    ports?: { server?: number; client?: number };
    projectSubdir?: string;
    deploymentMode?: string;
  };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    return out;
  }
  if (!manifest.name || !manifest.domain) return out;
  // Only Coolify clones a git ref to find a compose file. gh-pages and
  // scaffold-only projects have no such relationship.
  if (manifest.deploymentMode !== "coolify") return out;

  const { computeRoutingPlan, inferTopology } = await import("./deploy/routing.js");
  const {
    checkDeployedRef,
    composePathAtRepoRoot,
    pinnedCommitOf,
    renderDeployedRef,
    summarizeDeployedRef,
  } = await import("./deploy/deployed-ref.js");
  const { manifestHostnames } = await import("./scaffold/manifest.js");
  const { readComposeFile } = await import("./utils/compose.js");
  const compose = readComposeFile(projectDir);
  const inference = inferTopology({
    topology: manifest.topology,
    composeServices: compose?.services,
  });
  const plan = computeRoutingPlan({
    name: manifest.name,
    domain: manifest.domain,
    hostnameAliases: manifestHostnames({
      domain: manifest.domain,
      aliases: manifest.aliases,
    }).slice(1),
    topology: inference.topology,
    surfaces: manifest.surfaces as "fullstack" | "split" | "backend" | "static" | undefined,
    ports: manifest.ports,
    publicService: manifest.publicService,
    composeServices: compose?.services,
  });

  // Prefer the branch / pinned commit the live app actually carries.
  // The ledger records one app uuid per project, which under `split` is
  // whichever half was created first — both halves are configured from
  // the same repo and branch, so either answers this question.
  let branch = "main";
  let pinnedCommit: string | undefined;
  const ledgers = loadAllLedgers();
  const appStep = ledgers
    .find((l) => l.name === manifest.name)
    ?.steps.find((s): s is LedgerStep & { kind: "coolifyApp" } => s.kind === "coolifyApp");
  if (appStep) {
    const cfg = await getCoolifyConfig();
    if (cfg) {
      try {
        const app = await new CoolifyApi({ url: cfg.url, token: cfg.token }).getApplication(
          appStep.uuid,
        );
        branch = app.gitBranch?.trim() || branch;
        pinnedCommit = pinnedCommitOf(app.gitCommitSha);
      } catch {
        // Unreachable Coolify is the auto-deploy check's problem, not
        // this one's — fall back to the branch hatchkit configures.
      }
    }
  }

  const report = await checkDeployedRef({
    projectDir,
    branch,
    ...(pinnedCommit ? { pinnedCommit } : {}),
    paths: plan.apps.map((a) => ({
      appName: a.appName,
      path: composePathAtRepoRoot(a.composeLocation, manifest.projectSubdir),
    })),
  });

  const name = `Project ${manifest.name} (deployed ref)`;
  if (!report.ran) {
    out.push({ name, status: "skip", detail: report.skipped });
    return out;
  }
  out.push({
    name,
    status: report.blocking ? "fail" : "ok",
    detail: summarizeDeployedRef(report),
    ...(report.blocking || report.ahead ? { hint: renderDeployedRef(report) } : {}),
  });
  return out;
}

/** Verify each Coolify app of the project can be deployed by CI's
 *  signed webhook, and ONLY by it (deploy/coolify-deploy-hook.ts):
 *
 *    · its GitHub-slot webhook secret is set and is the one hatchkit
 *      gave the repo (compared in memory with the keychain copy);
 *    · the GitLab/Gitea/Bitbucket slots are set too — a null secret
 *      there accepts a signature made with the empty key;
 *    · `watch_paths` is the hatchkit sentinel, so auto-deploy (which the
 *      webhook needs) never fires for an ordinary push through the
 *      GitHub App before the image exists.
 *
 *  Compose apps get a warning on top: Coolify fetches the payload's
 *  commit with a shallow fetch by default, which also reaches commits
 *  that exist only in a fork. That setting is not readable through the
 *  API, so doctor can only remind. */
export async function checkProjectCoolifyAutoDeployState(
  projectDir: string,
): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const { readManifest } = await import("./scaffold/manifest.js");
  const manifest = readManifest(projectDir);
  if (!manifest?.name) return out;
  if (manifest.deploymentMode !== undefined && manifest.deploymentMode !== "coolify") return out;
  const cfg = await getCoolifyConfig();
  if (!cfg) return out;
  const { findCoolifyAppsForProject } = await import("./deploy/coolify-app.js");
  const { DEPLOY_HOOK_WATCH_PATH, deployHookKeychainKey } = await import(
    "./deploy/coolify-deploy-hook.js"
  );
  const apps = await findCoolifyAppsForProject(manifest.name, manifest.topology).catch(() => []);
  if (apps.length === 0) return out;
  const api = new CoolifyApi({ url: cfg.url, token: cfg.token });
  const title = `Project ${manifest.name} (Coolify deploy hooks)`;
  const problems: string[] = [];
  const composeApps: string[] = [];
  for (const app of apps) {
    const label = app.role ?? "app";
    try {
      const state = await api.getDeployHookState(app.uuid);
      const kept = await getSecret(deployHookKeychainKey(app.uuid));
      if (!state.githubSecret)
        problems.push(`${label}: no webhook secret — anyone can sign for it`);
      else if (kept !== state.githubSecret) {
        problems.push(`${label}: webhook secret differs from the one hatchkit gave the repo`);
      }
      if (!state.otherSlotsLocked) {
        problems.push(
          `${label}: a GitLab/Gitea/Bitbucket webhook secret is null (empty-key signatures pass)`,
        );
      }
      if (state.watchPaths?.trim() !== DEPLOY_HOOK_WATCH_PATH) {
        problems.push(`${label}: watch_paths is not ${DEPLOY_HOOK_WATCH_PATH}`);
      }
      if (state.buildPack === "dockercompose") composeApps.push(label);
    } catch (err) {
      problems.push(`${label}: couldn't read the app — ${(err as Error).message.split("\n")[0]}`);
    }
  }
  if (problems.length > 0) {
    out.push({
      name: title,
      status: "fail",
      detail: `${problems.length} problem(s)`,
      hint: [
        ...problems,
        "",
        "`hatchkit sync` (or `hatchkit secrets isolate`) sets all three and pushes",
        "the matching per-app secrets to the repo.",
      ],
    });
  } else {
    out.push({
      name: title,
      status: "ok",
      detail: `${apps.length} app(s) deploy only via their own signed webhook`,
    });
  }
  if (composeApps.length > 0) {
    out.push({
      name: `Project ${manifest.name} (Coolify shallow clone)`,
      status: "warn",
      detail: `${composeApps.join(", ")} build from git; check "Shallow Clone" is OFF`,
      hint: [
        "With shallow clone on, Coolify fetches the webhook's commit by sha, and",
        "GitHub serves commits that exist only in a fork that way. A leaked deploy",
        "secret could then deploy a fork's compose file. The API can't read the",
        "setting: Coolify → the app → Advanced → Shallow Clone → off.",
        "Moving the app to the image runtime removes the question:",
        "  hatchkit migrate-runtime",
      ],
    });
  }
  return out;
}

/** The project holds no provisioner credential anywhere project-facing:
 *  env files, the plaintext provisioning cache, workflows, the repo's
 *  Actions secret names, its Coolify app envs — and a Worker repo holds
 *  the Cloudflare token hatchkit minted for its Worker, not a shared
 *  one. See secrets/isolation.ts. Runs in a hatchkit project and in any
 *  repo with a wrangler.jsonc (Worker repos migrated by hand have no
 *  manifest). */
export async function checkProjectCredentialIsolationState(
  projectDir: string,
): Promise<CheckResult[]> {
  const { existsSync } = await import("node:fs");
  const { CLOUDFLARE_WRANGLER_REL_PATH } = await import("./scaffold/cloudflare-mode.js");
  if (
    !existsSync(`${projectDir}/.hatchkit.json`) &&
    !existsSync(`${projectDir}/${CLOUDFLARE_WRANGLER_REL_PATH}`)
  ) {
    return [];
  }
  const { auditProjectIsolation, isolationCheckResults } = await import("./secrets/isolation.js");
  try {
    const { name, findings } = await auditProjectIsolation(projectDir);
    return isolationCheckResults(name, findings);
  } catch (err) {
    return [
      {
        name: "Project credentials are project-scoped",
        status: "skip",
        detail: `couldn't audit: ${(err as Error).message.split("\n")[0]}`,
      },
    ];
  }
}

/** One Dockerfile build stage: the image (or earlier stage) it starts
 *  from, its `AS` name, and its instructions with `\` continuations
 *  joined and comment lines dropped. */
interface DockerfileStage {
  from: string;
  alias?: string;
  instructions: string[];
}

function dockerfileStages(content: string): DockerfileStage[] {
  const logical: string[] = [];
  let pending = "";
  for (const raw of content.split(/\r?\n/)) {
    // Docker drops comment lines even inside a continuation.
    if (/^\s*#/.test(raw)) continue;
    const continues = /\\\s*$/.test(raw);
    const part = raw.replace(/\\\s*$/, "").trim();
    pending = pending && part ? `${pending} ${part}` : pending || part;
    if (continues) continue;
    if (pending) logical.push(pending);
    pending = "";
  }
  if (pending) logical.push(pending);

  const stages: DockerfileStage[] = [];
  for (const line of logical) {
    const from = /^FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (from) {
      stages.push({ from: from[1], alias: from[2]?.toLowerCase(), instructions: [] });
    } else {
      stages.at(-1)?.instructions.push(line);
    }
  }
  return stages;
}

/** The official nginx image under any tag or digest, from Docker Hub
 *  (`nginx`, `library/nginx`, `docker.io/library/nginx`) or a mirror
 *  (`public.ecr.aws/nginx/nginx`). Other vendors' nginx images
 *  (`bitnami/nginx`) keep their config elsewhere and don't match. */
function isOfficialNginxImage(ref: string): boolean {
  const name = ref
    .replace(/@.*$/, "")
    .replace(/:[^/]*$/, "")
    .toLowerCase();
  return /^(?:(?:[^/]*[.:][^/]*|localhost)\/)?(?:library\/|nginx\/)?nginx$/.test(name);
}

/** The final stage of a Dockerfile when it runs the official nginx
 *  image, and whether anything in it puts a config under /etc/nginx/.
 *  `undefined` when the final stage is anything else — a Node runtime,
 *  an image named by a build ARG.
 *
 *  Only the final stage ships, so a COPY into /etc/nginx/ in a build
 *  stage doesn't count. A final `FROM <stage>` inherits that stage's
 *  instructions, so those do. Any instruction that names /etc/nginx
 *  counts as configuring it — a COPY or ADD there, a RUN that writes or
 *  edits a config, a VOLUME for one mounted at runtime. Reading it
 *  loosely costs a missed warning at worst; this is a warning, and a
 *  false one would have no way to clear. */
export function dockerfileNginxRuntime(
  content: string,
): { image: string; configured: boolean } | undefined {
  const stages = dockerfileStages(content);
  if (stages.length === 0) return undefined;
  // Walk `FROM <stage>` back to an image. A stage can only name one
  // defined above it, so `at` only goes down.
  let at = stages.length - 1;
  const inherited = [...stages[at].instructions];
  for (let i = at - 1; i >= 0; i--) {
    if (stages[i].alias !== stages[at].from.toLowerCase()) continue;
    at = i;
    inherited.push(...stages[at].instructions);
  }
  const image = stages[at].from;
  if (!isOfficialNginxImage(image)) return undefined;
  return { image, configured: inherited.some((i) => /\/etc\/nginx\b/i.test(i)) };
}

/** True when a compose file mounts something under /etc/nginx/ — a
 *  bind mount of `./nginx.conf`, a long-syntax `target:`, a `configs:`
 *  entry. Comment lines don't count. */
export function composeMountsNginxConfig(content: string): boolean {
  return content
    .split(/\r?\n/)
    .some((l) => !/^\s*#/.test(l) && /\/etc\/nginx\b/.test(l.replace(/\s#.*$/, "")));
}

/** Static-site projects whose Dockerfile serves nginx with its stock
 *  config.
 *
 *  Until bd31421 the adopt Dockerfile for a non-Next static site ended
 *  in `FROM nginx:alpine` + `COPY --from=build /app/dist ...` and
 *  nothing else. The stock default.conf maps a URL straight onto a
 *  file, so a reload on any client-side route of a Vite SPA 404s, and
 *  so does `/about` for a build that wrote `about.html`. The scaffold
 *  now writes nginx.conf next to the Dockerfile and copies it in, but
 *  a project adopted before that still has the old Dockerfile and
 *  nothing tells it.
 *
 *  Reads the Dockerfile in the manifest's `projectSubdir` (where adopt
 *  writes it) and the compose file next to it; never touches Coolify.
 *  A `warn`, not a `fail`: the site serves, only some of its URLs 404. */
export async function checkProjectNginxConfigState(projectDir: string): Promise<CheckResult[]> {
  const { existsSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const manifestPath = join(projectDir, ".hatchkit.json");
  if (!existsSync(manifestPath)) return [];

  let manifest: {
    name?: string;
    deploymentMode?: string;
    projectSubdir?: string;
  };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    return [];
  }
  // adopt writes the nginx Dockerfile for coolify mode only.
  if (!manifest.name || !isCoolifyManagedMode(manifest.deploymentMode)) return [];

  const subdir = (manifest.projectSubdir ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  const buildDir = subdir ? join(projectDir, subdir) : projectDir;
  const rel = (file: string) => (subdir ? `${subdir}/${file}` : file);

  let dockerfile: string;
  try {
    dockerfile = readFileSync(join(buildDir, "Dockerfile"), "utf-8");
  } catch {
    return [];
  }
  const runtime = dockerfileNginxRuntime(dockerfile);
  if (!runtime) return [];

  const name = `Project ${manifest.name} (nginx config)`;
  if (runtime.configured) {
    return [{ name, status: "ok", detail: `${rel("Dockerfile")} puts a config into /etc/nginx/` }];
  }

  const { NGINX_CONF_PATH, detectBuildPipeline, renderNginxConf } = await import(
    "./scaffold/build-pipeline.js"
  );
  const composePath = detectBuildPipeline(buildDir).composePath;
  if (composePath) {
    let compose = "";
    try {
      compose = readFileSync(composePath, "utf-8");
    } catch {
      // Unreadable compose: judge the Dockerfile alone.
    }
    if (composeMountsNginxConfig(compose)) {
      const composeName = composePath.split(/[\\/]/).pop() ?? "docker-compose.yml";
      return [
        { name, status: "ok", detail: `${rel(composeName)} mounts a config into /etc/nginx/` },
      ];
    }
  }

  // A config already next to the Dockerfile that nothing copies in: the
  // fix is the COPY line alone. One with an `http {}` block is a whole
  // nginx.conf, not a server block, and replaces the main config.
  const confRel = rel(NGINX_CONF_PATH);
  let existingConf: string | undefined;
  try {
    existingConf = readFileSync(join(buildDir, NGINX_CONF_PATH), "utf-8");
  } catch {
    existingConf = undefined;
  }
  const target =
    existingConf !== undefined && /^\s*http\s*\{/m.test(existingConf)
      ? "/etc/nginx/nginx.conf"
      : "/etc/nginx/conf.d/default.conf";
  const copyLine = `COPY ${NGINX_CONF_PATH} ${target}`;
  const overwritten = [
    rel("Dockerfile"),
    rel("docker-compose.yml"),
    ...(existingConf !== undefined ? [confRel] : []),
  ];

  let byHand: string[];
  if (existingConf !== undefined) {
    byHand = [
      `  · or by hand: ${confRel} is already there, but nothing copies it in. Add this line to`,
      `    the final (\`FROM ${runtime.image}\`) stage of ${rel("Dockerfile")}:`,
      `      ${copyLine}`,
    ];
  } else {
    let conf: string[] = [];
    try {
      // Comments and blank lines dropped: every hint line prints behind
      // an arrow, and the regenerate route writes the annotated copy.
      conf = renderNginxConf(buildDir, manifest.name)
        .split("\n")
        .filter((l) => l.trim() !== "" && !/^\s*#/.test(l))
        .map((l) => l.trimEnd());
    } catch {
      conf = [];
    }
    byHand = [
      conf.length > 0
        ? `  · or by hand: save this as ${confRel}`
        : `  · or by hand: write a server block for the bundle as ${confRel}`,
      ...conf.map((l) => `      ${l}`),
      `    and add this line to the final (\`FROM ${runtime.image}\`) stage of ${rel("Dockerfile")}:`,
      `      ${copyLine}`,
    ];
  }

  return [
    {
      name,
      status: "warn",
      detail: `${rel("Dockerfile")} runs ${runtime.image} with its stock config — deep links 404 on reload`,
      hint: [
        "nginx's stock default.conf maps a URL straight onto a file. A reload on a client-side",
        "route (`/settings`) or a page URL without `.html` (`/about`) asks for a file that isn't",
        "there and gets a 404. A single-page app's own links still work, so only a reload or a",
        "shared link shows it. Projects adopted before hatchkit wrote nginx.conf have this gap.",
        "Fix, either way:",
        "  · hatchkit adopt --resume --regenerate-pipeline",
        `    It re-renders ${overwritten.join(", ")} and .github/workflows/deploy.yml`,
        "    over your copies; review `git diff` and restore anything you customized.",
        ...byHand,
        "Commit and deploy. This warning clears once the Dockerfile copies a config in.",
      ],
    },
  ];
}

/** Verify a Coolify app can actually reach the Coolify-managed database
 *  its env points at, and lead with the container log whenever the app
 *  isn't healthy.
 *
 *  Emits up to two checks for one app, from a single pair of API reads:
 *
 *    · `(Coolify app health)` — fires for any app Coolify doesn't
 *      report as running, or that is restarting because it CRASHED.
 *      The hint's first line is the log command. That ordering is the
 *      whole point of the check: on tracktime the container log said
 *      `getaddrinfo ENOTFOUND <db-uuid>` from the first deploy onward
 *      and nobody read it for months, because the public symptom was a
 *      `503 no available server` from caddy-docker-proxy — the exact
 *      response an unknown hostname gets — and Coolify's own status
 *      field said `running:healthy` the entire time.
 *
 *    · `(Coolify DB network)` — fires when a `dockercompose` app whose
 *      env names a managed database ALSO shows crash restarts. That
 *      pairing is the signature of a missing
 *      `connect_to_docker_network`: the app sits on a network named
 *      after its own uuid, the database sits on the shared `coolify`
 *      network, and the hostname Coolify handed us cannot resolve.
 *      deploy/coolify-db-network.ts has the full story.
 *
 *  The two conditions are deliberately joined by AND. The setting is
 *  WRITE-ONLY — Coolify never returns it on GET — so there is no way to
 *  ask an app whether it has it. Crash restarts are the only evidence
 *  available, and reporting "might be missing the setting" for every
 *  healthy app that happens to use a managed database would be noise
 *  with no way to clear it. */
/** Does a push to this project take the site down?
 *
 *  Coolify only redeploys without an outage (start the new container,
 *  wait for its health check, then stop the old one) for Docker Image /
 *  Dockerfile / Nixpacks apps with a health check. A Docker Compose app
 *  is stopped before its replacement starts, on every deploy. See
 *  deploy/image-runtime.ts.
 *
 *  Apps are found by NAME, across both runtimes' naming, rather than via
 *  the run ledger: `migrate-runtime` replaces the app the ledger
 *  recorded, and this check matters most right after that happens. */
export async function checkProjectRollingDeployState(
  projectDir: string,
  opts: { api?: Pick<CoolifyApi, "listApplications" | "getApplication"> } = {},
): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const { readManifestWithMigrationInfo } = await import("./scaffold/manifest.js");
  const manifest = readManifestWithMigrationInfo(projectDir)?.manifest;
  if (!manifest?.name || !manifest.domain) return out;
  if (manifest.deploymentMode && manifest.deploymentMode !== "coolify") return out;

  let api = opts.api;
  if (!api) {
    const cfg = await getCoolifyConfig();
    if (!cfg) return out;
    api = new CoolifyApi({ url: cfg.url, token: cfg.token });
  }
  const { computeRoutingPlan } = await import("./deploy/routing.js");
  const {
    COOLIFY_STOP_TIMEOUT_SECONDS,
    healthCheckFor,
    healthCheckToConverge,
    rollingUpdateBlocker,
    rollingUpdateNamingUnknown,
    worstCaseDrainDropSeconds,
  } = await import("./deploy/image-runtime.js");

  const names = new Set<string>();
  for (const runtime of ["compose", "image"] as const) {
    for (const topology of ["single-origin", "split"] as const) {
      for (const routed of computeRoutingPlan({
        name: manifest.name,
        domain: manifest.domain,
        topology,
        surfaces: manifest.surfaces,
        runtime,
      }).apps) {
        names.add(routed.appName);
        for (const alias of routed.aliases) names.add(alias);
      }
    }
  }
  let apps: Array<{ uuid: string; name: string }>;
  try {
    apps = (await api.listApplications()).filter((a) => names.has(a.name));
  } catch {
    return out;
  }
  for (const found of apps) {
    const app = await api.getApplication(found.uuid).catch(() => null);
    if (!app) continue;
    const blocker = rollingUpdateBlocker(app);
    const name = `Project ${manifest.name} (zero-downtime deploys)`;
    if (app.buildPack === "dockerimage" && manifest.coolifyRuntime !== "image") {
      out.push({
        name,
        status: "warn",
        detail: `"${app.name}" is a live Docker Image app, but .hatchkit.json still selects Docker Compose`,
        hint: [
          "Reconcile coolifyRuntime and containerPorts with the live app before running hatchkit sync.",
          "Check the image, port, domains, and deploy target first; do not infer them from the app name alone.",
        ],
      });
    }
    if (!blocker) {
      if (rollingUpdateNamingUnknown(app)) {
        out.push({
          name,
          status: "warn",
          detail: `"${app.name}" has a health check, but Coolify did not expose its container-name settings; rolling updates remain unverified`,
          hint: [
            "Inspect Consistent Container Name and Custom Internal Name in Coolify; both must be disabled/empty, then verify a deployment with live traffic.",
          ],
        });
        continue;
      }
      // A rolling update whose timing can't drain: the old container is
      // still routed when `docker stop` ends it, so the deploy ends in
      // 502s. Timing Coolify didn't return is never reported.
      const { intervalSeconds, retries } = app.healthCheck;
      const lingers =
        intervalSeconds !== undefined && retries !== undefined
          ? worstCaseDrainDropSeconds({ intervalSeconds, retries })
          : 0;
      const timingUnknown =
        intervalSeconds === undefined ||
        retries === undefined ||
        app.healthCheck.timeoutSeconds === undefined ||
        app.healthCheck.startPeriodSeconds === undefined;
      if (timingUnknown) {
        out.push({
          name,
          status: "warn",
          detail: `"${app.name}" has an enabled health check, but Coolify did not return all probe timing fields`,
          hint: ["Inspect the live probe timing before claiming a safe drain or measured rollout."],
        });
        continue;
      }
      if (healthCheckToConverge(app.healthCheck, healthCheckFor("app")) !== undefined) {
        out.push({
          name,
          status: "warn",
          detail:
            `"${app.name}" deploys as a rolling update, but its health check (every ${intervalSeconds}s, ${retries} retries) ` +
            (lingers > COOLIFY_STOP_TIMEOUT_SECONDS
              ? `keeps a stopping container routed for up to ${Math.round(lingers)}s — past the ${COOLIFY_STOP_TIMEOUT_SECONDS}s docker stop, so each deploy ends in 502s`
              : "isn't hatchkit's, which the images' shutdown drain is timed against"),
          hint: [
            "Push hatchkit's health-check timing:",
            "  hatchkit sync --dry-run   # then without --dry-run",
          ],
        });
        continue;
      }
      out.push({
        name,
        status: "ok",
        detail: `"${app.name}" deploys as a rolling update (health check GET ${app.healthCheck.path ?? "/"})`,
      });
      continue;
    }
    out.push({
      name,
      status: "warn",
      detail: `"${app.name}": ${blocker}`,
      hint:
        app.buildPack === "dockercompose"
          ? [
              "Move it to a Docker Image app, side by side, with a verified cutover:",
              `  hatchkit migrate-runtime ${app.name} --dry-run`,
            ]
          : app.healthCheck.enabled !== true
            ? [
                "Turn the health check on (the image needs curl or wget):",
                "  hatchkit sync --dry-run   # then without --dry-run",
              ]
            : ["Remove the setting named above in the app's Coolify configuration."],
    });
  }
  return out;
}

export async function checkProjectCoolifyAppHealthState(
  projectDir: string,
): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const { existsSync, readFileSync } = await import("node:fs");
  const manifestPath = `${projectDir}/.hatchkit.json`;
  if (!existsSync(manifestPath)) return out;

  let manifest: { name?: string; deploymentMode?: string };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    return out;
  }
  if (!manifest.name || manifest.deploymentMode !== "coolify") return out;

  // Same resolution path as the auto-deploy check: the per-project
  // ledger is where adopt/create record the app uuid(s). Split
  // topologies record two, and either half can be the broken one.
  const ledgers = loadAllLedgers();
  const ourLedger = ledgers.find((l) => l.name === manifest.name);
  const appSteps = (ourLedger?.steps ?? []).filter(
    (s): s is LedgerStep & { kind: "coolifyApp" } => s.kind === "coolifyApp",
  );
  if (appSteps.length === 0) return out;

  const cfg = await getCoolifyConfig();
  if (!cfg) return out;
  const api = new CoolifyApi({ url: cfg.url, token: cfg.token });

  const {
    appLooksUnhealthy,
    appShowsCrashSymptoms,
    connectToDockerNetworkRecipe,
    findCoolifyDbReferences,
    needsDockerNetwork,
    readTheLogRecipe,
  } = await import("./deploy/coolify-db-network.js");

  for (const step of appSteps) {
    let app: Awaited<ReturnType<CoolifyApi["getApplication"]>>;
    try {
      app = await api.getApplication(step.uuid);
    } catch (err) {
      out.push({
        name: `Project ${manifest.name} (Coolify app health)`,
        status: "fail",
        detail: `couldn't read app ${step.uuid}: ${(err as Error).message.split("\n")[0]}`,
        hint: ["Confirm the Coolify app still exists and the token is valid:", "  hatchkit doctor"],
      });
      continue;
    }
    const label = app.name || step.uuid;
    const crashing = appShowsCrashSymptoms(app);
    const unhealthy = appLooksUnhealthy(app);

    if (unhealthy) {
      const restarts =
        app.restartCount === undefined
          ? "restart count not reported"
          : `${app.restartCount} restart(s), last type "${app.lastRestartType ?? "unknown"}"`;
      out.push({
        name: `Project ${manifest.name} (Coolify app health)`,
        status: "fail",
        detail:
          `"${label}" reports status "${app.status ?? "unknown"}" with ${restarts}` +
          (crashing
            ? " — Coolify calls a crash-looping container healthy, so read the log, not the status."
            : ""),
        hint: [
          ...readTheLogRecipe(cfg.url, step.uuid),
          "",
          "A container that keeps dying gets no proxy site registered, so the public symptom",
          "is `503 no available server` — identical to an unconfigured hostname. Don't start",
          "with the proxy labels; start with the log above.",
        ],
      });
    } else {
      out.push({
        name: `Project ${manifest.name} (Coolify app health)`,
        status: "ok",
        detail: `"${label}" ${app.status ?? "running"}, ${app.restartCount ?? 0} restart(s)`,
      });
    }

    // Only worth two more API calls when there is a fault to explain.
    if (!crashing) continue;
    const references = await findCoolifyDbReferences(api, step.uuid);
    if (!needsDockerNetwork(app, references)) continue;
    const keys = references.map((r) => r.key).join(", ");
    const dbs = [...new Set(references.map((r) => r.database))].join(", ");
    out.push({
      name: `Project ${manifest.name} (Coolify DB network)`,
      status: "fail",
      detail:
        `"${label}" is a dockercompose app whose ${keys} points at Coolify-managed ${dbs}, ` +
        "and it is crash-restarting — the signature of a missing `connect_to_docker_network`.",
      hint: [
        `Expect \`getaddrinfo ENOTFOUND ${references[0].host}\` in the log:`,
        ...readTheLogRecipe(cfg.url, step.uuid).slice(1),
        "",
        "A dockercompose app runs on a Docker network named after its own uuid; a",
        "Coolify-managed database runs on the shared `coolify` network. They are isolated,",
        "so the app cannot resolve the hostname Coolify itself put in the connection string.",
        "",
        ...connectToDockerNetworkRecipe(cfg.url, step.uuid),
      ],
    });
  }
  return out;
}

/** Compare what is DEPLOYED against what the deployed branch is at.
 *
 *  `checkProjectDeployedRefState` above asks whether the commit Coolify
 *  clones contains the compose file the app builds from. This asks the
 *  question at the other end of the chain: is the artefact answering on
 *  the public domain the thing that commit builds.
 *
 *  Both fail silently and independently. A deploy can be green in the
 *  Actions tab, current on ghcr, and reported as the new commit by the
 *  Coolify dashboard while the container serving traffic is the previous
 *  build — Docker keeps the image it already has for a mutable tag. The
 *  generated pipeline now gates on exactly this after every deploy; this
 *  is the same check outside CI, which is what catches a deploy that
 *  silently never ran at all (no failing run to look at, because no
 *  run).
 *
 *  Read-only: two public HTTP GETs plus git plumbing. */
export async function checkProjectDeployedVersionState(projectDir: string): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const { existsSync, readFileSync } = await import("node:fs");
  const manifestPath = `${projectDir}/.hatchkit.json`;
  if (!existsSync(manifestPath)) return out;

  let manifest: {
    name?: string;
    domain?: string;
    surfaces?: string;
    topology?: string;
    deploymentMode?: string;
  };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    return out;
  }
  if (!manifest.name || !manifest.domain) return out;
  // Coolify only. gh-pages serves whatever the Pages build produced and
  // has its own freshness story; scaffold-only projects aren't deployed.
  if (manifest.deploymentMode !== "coolify") return out;

  const { deployVerifyUrls } = await import("./scaffold/deploy-verification.js");
  const { checkDeployedVersion, renderDeployedVersion, summarizeDeployedVersion } = await import(
    "./deploy/deployed-version.js"
  );

  // Same two URLs the pipeline's post-deploy gate probes, derived the
  // same way — a doctor that checked different endpoints than CI would
  // be a second source of truth for "where does this project live".
  const { webUrl, apiUrl } = deployVerifyUrls(
    manifest.domain,
    manifest.topology === "split" ? "split" : "single-origin",
    (manifest.surfaces as "fullstack" | "split" | "backend" | "static" | undefined) ?? "fullstack",
  );

  // Prefer the branch the live app is actually configured with, the way
  // the deployed-ref check does — a project on a non-`main` default
  // branch would otherwise be compared against a ref nobody deploys.
  let branch = "main";
  const ledgers = loadAllLedgers();
  const appStep = ledgers
    .find((l) => l.name === manifest.name)
    ?.steps.find((s): s is LedgerStep & { kind: "coolifyApp" } => s.kind === "coolifyApp");
  if (appStep) {
    const cfg = await getCoolifyConfig();
    if (cfg) {
      try {
        const app = await new CoolifyApi({ url: cfg.url, token: cfg.token }).getApplication(
          appStep.uuid,
        );
        branch = app.gitBranch?.trim() || branch;
      } catch {
        // Unreachable Coolify is another check's problem — fall back to
        // the branch hatchkit configures.
      }
    }
  }

  const report = await checkDeployedVersion({ projectDir, apiUrl, webUrl, branch });
  const name = `Project ${manifest.name} (deployed version)`;
  if (!report.ran) {
    out.push({ name, status: "skip", detail: report.skipped });
    return out;
  }
  const drifted = report.stale.length > 0;
  // Drift is a failure: something is serving code that is not the
  // deployed branch. An artefact that reports NO commit is a `skip` —
  // it is an image built before COMMIT_SHA was wired up, so the check
  // could not run rather than ran and found a problem. Failing there
  // would turn doctor red on every project that simply hasn't rebuilt
  // yet. The hint rides along either way for `--json` consumers, which
  // is what agents read.
  out.push({
    name,
    status: drifted ? "fail" : report.unknown.length > 0 ? "skip" : "ok",
    detail: drifted
      ? summarizeDeployedVersion(report)
      : report.unknown.length > 0
        ? `${summarizeDeployedVersion(report)} — run \`hatchkit regen-infra\` then push to rebuild`
        : summarizeDeployedVersion(report),
    ...(drifted || report.unknown.length > 0 ? { hint: renderDeployedVersion(report) } : {}),
  });
  return out;
}

/** Verify every adopted project's domain actually resolves in DNS.
 *  Catches the silent failure mode where `hatchkit adopt --resume`
 *  finishes cleanly (because the DNS provider isn't configured) but
 *  the user assumes the record was written. Cross-checks against the
 *  resolved server IP from every ledger (gh-pages, coolify, anything
 *  with a recorded server-side endpoint) so the failing record is
 *  actionable — the hint tells the user the exact A target to set. */
export async function checkProjectDnsResolveState(projectDir: string): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const { existsSync, readFileSync } = await import("node:fs");
  const manifestPath = `${projectDir}/.hatchkit.json`;
  if (!existsSync(manifestPath)) return out;

  let manifest: { name?: string; domain?: string; deploymentMode?: string };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    return out;
  }
  if (!manifest.name || !manifest.domain) return out;
  // Static hosts point at github.io / a Worker, not at a Coolify box.
  if (!isCoolifyManagedMode(manifest.deploymentMode)) return out;

  const { resolve4, resolve6 } = await import("node:dns/promises");
  let resolved: string[];
  try {
    resolved = await resolve4(manifest.domain);
  } catch (err4) {
    try {
      const v6 = await resolve6(manifest.domain);
      resolved = v6;
    } catch {
      const reason = (err4 as Error).message.split("\n")[0];
      out.push({
        name: `Project ${manifest.name} (DNS)`,
        status: "fail",
        detail: `${manifest.domain} doesn't resolve: ${reason}`,
        hint: [
          `No A or AAAA record found for ${manifest.domain}.`,
          `Likely cause: hatchkit adopt skipped DNS provisioning because no DNS provider is configured.`,
          `Fix: hatchkit config add dns         (configure Cloudflare)`,
          `Then: hatchkit adopt --resume       (re-runs the DNS upsert)`,
          `Or set the record manually pointing at the Coolify server's public IP.`,
        ],
      });
      return out;
    }
  }
  out.push({
    name: `Project ${manifest.name} (DNS)`,
    status: "ok",
    detail: `${manifest.domain} → ${resolved.join(", ")}`,
  });
  return out;
}

/** `--fix`: offer each failing check's repair, one confirm apiece
 *  (default No). `yes` skips the confirm; without it and without a
 *  terminal, nothing is applied. Returns the failures still standing. */
async function offerRepairs(failed: CheckResult[], yes: boolean): Promise<number> {
  const repairable = failed.filter((r) => r.repair);
  if (repairable.length === 0) {
    console.log(chalk.dim("  --fix: none of these failures has a repair doctor can apply.\n"));
    return failed.length;
  }
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  const { confirm } = await import("@inquirer/prompts");
  console.log(chalk.bold("  Repairs"));
  let repaired = 0;
  for (const r of repairable) {
    const repair = r.repair as NonNullable<CheckResult["repair"]>;
    if (!yes) {
      if (!interactive) {
        console.log(chalk.yellow(`  · ${repair.prompt} Skipped: not a terminal (pass --yes).`));
        continue;
      }
      if (!(await confirm({ message: repair.prompt, default: false }))) continue;
    }
    try {
      console.log(`  ${chalk.green("✓")} ${await repair.run()}`);
      repaired++;
    } catch (err) {
      console.log(`  ${chalk.red("✗")} ${r.name}: ${(err as Error).message.split("\n")[0]}`);
    }
  }
  console.log();
  return failed.length - repaired;
}

export async function runDoctor(
  opts: { json?: boolean; fix?: boolean; yes?: boolean } = {},
): Promise<void> {
  const results = await collectDoctorResults();
  const okCount = results.filter((r) => r.status === "ok").length;
  const failCount = results.filter((r) => r.status === "fail").length;
  const skipCount = results.filter((r) => r.status === "skip").length;
  const deferredResults = results.filter((r) => r.status === "deferred");
  const warnResults = results.filter((r) => r.status === "warn");

  if (opts.json) {
    const payload = {
      summary: {
        ok: okCount,
        failing: failCount,
        warnings: warnResults.length,
        not_configured: skipCount,
        deferred: deferredResults.length,
      },
      checks: results.map((r) => ({
        name: r.name,
        status: r.status,
        detail: r.detail,
        hint: r.hint,
      })),
    };
    console.log(JSON.stringify(payload, null, 2));
    if (failCount > 0) process.exit(1);
    return;
  }

  console.log(chalk.bold("  hatchkit doctor — checking configured providers\n"));
  for (const r of results) {
    const icon =
      r.status === "ok"
        ? chalk.green("✓")
        : r.status === "fail"
          ? chalk.red("✗")
          : r.status === "warn"
            ? chalk.yellow("!")
            : r.status === "deferred"
              ? chalk.yellow("»")
              : chalk.dim("·");
    const name =
      r.status === "fail"
        ? chalk.red(r.name)
        : r.status === "deferred" || r.status === "warn"
          ? chalk.yellow(r.name)
          : r.name;
    const detail = r.detail ? chalk.dim(` — ${r.detail}`) : "";
    console.log(`  ${icon} ${name}${detail}`);
  }
  console.log(
    `\n  ${chalk.green(`${okCount} ok`)}  ${failCount ? chalk.red(`${failCount} failing`) : chalk.dim("0 failing")}  ${
      warnResults.length
        ? chalk.yellow(`${warnResults.length} warning${warnResults.length === 1 ? "" : "s"}`)
        : chalk.dim("0 warnings")
    }  ${
      deferredResults.length
        ? chalk.yellow(`${deferredResults.length} deferred`)
        : chalk.dim("0 deferred")
    }  ${chalk.dim(`${skipCount} not configured`)}\n`,
  );

  // Deferred steps come before the failure block: they're the user's
  // own to-do list, and printing them first means a run with no real
  // failures still ends on the actionable list.
  if (deferredResults.length > 0) {
    console.log(chalk.bold("  Deferred — finish when you have the credentials"));
    for (const r of deferredResults) {
      console.log(`\n  ${chalk.yellow("»")} ${chalk.bold(r.name)}`);
      for (const line of r.hint ?? []) console.log(`    ${chalk.dim("→")} ${line}`);
    }
    console.log();
  }

  // Warnings don't fail the run, but a warning without its fix is just
  // a yellow line nobody acts on.
  if (warnResults.length > 0) {
    console.log(chalk.bold("  Warnings — working today, worth fixing"));
    for (const r of warnResults) {
      console.log(`\n  ${chalk.yellow("!")} ${chalk.bold(r.name)}`);
      for (const line of r.hint ?? []) console.log(`    ${chalk.dim("→")} ${line}`);
    }
    console.log();
  }

  const failed = results.filter((r) => r.status === "fail");
  if (failed.length > 0) {
    console.log(chalk.bold("  How to fix"));
    for (const r of failed) {
      console.log(`\n  ${chalk.red("✗")} ${chalk.bold(r.name)}`);
      const lines = r.hint ?? [
        "No specific hint — try re-running the relevant `hatchkit config add <provider>` to re-enter credentials.",
      ];
      for (const line of lines) console.log(`    ${chalk.dim("→")} ${line}`);
    }
    console.log();
    const standing = opts.fix ? await offerRepairs(failed, opts.yes ?? false) : failed.length;
    if (standing > 0) process.exit(1);
  }
}

/**
 * The operational layer's read-only checks, run against a project on
 * disk: does everything that carries the API origin carry the same one,
 * does production environment actually reach the container, and is this
 * project's domain layout one its proxy and its certificate can serve?
 *
 * All three are pure functions over files; nothing here talks to a
 * platform, so `hatchkit doctor` stays safe to run anywhere. They return
 * `[]` outside a hatchkit-managed project, so doctor from $HOME is
 * unaffected.
 *
 * Why these are worth a doctor check rather than a scaffold-time one:
 * each fails SILENTLY and each drifts. A domain rename, a new native
 * surface, a value edited on the platform instead of in the repo — all
 * of them can put two places out of step months after the files were
 * written, and every one of those failures looks like a working deploy
 * right up until a person cannot sign in.
 */
export async function checkProjectOperationalState(projectDir: string): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const { readManifest } = await import("./scaffold/manifest.js");
  const manifest = readManifest(projectDir);
  if (!manifest?.name) return out;
  // gh-pages and scaffold-only projects have no server half and no
  // platform to disagree with.
  if (manifest.deploymentMode === "gh-pages" || manifest.deploymentMode === "scaffold-only") {
    return out;
  }

  const { operationalProjectFromManifest } = await import("./features/operational.js");
  const project = operationalProjectFromManifest(manifest);

  // ── everything that carries the default API origin ──────────────────
  const { checkApiOriginAgreement, projectFileReader } = await import(
    "./features/env-agreement/index.js"
  );
  try {
    const agreement = checkApiOriginAgreement({
      project,
      readFile: projectFileReader(projectDir),
    });
    // `enforced` is not a disagreement: a release workflow whose plan job
    // refuses the run when its secret is empty, or one carrying a poison
    // default so a build with no variable fails loudly, has declined to
    // guess an origin. That is the correct behaviour, not a finding.
    const wrong = agreement.sites.filter(
      (s) => s.status === "differs" || s.status === "missing" || s.status === "unreadable",
    );
    out.push({
      name: `Project ${manifest.name} (API origin agreement)`,
      status: wrong.length === 0 ? "ok" : "fail",
      detail:
        wrong.length === 0
          ? `${agreement.expected} — every applicable place agrees`
          : `${wrong.length} of ${agreement.sites.length} disagree with ${agreement.expected}`,
      hint:
        wrong.length === 0
          ? undefined
          : [
              ...wrong.map(
                (s) => `${s.label} (${s.path}): ${s.status}${s.found ? ` — ${s.found}` : ""}`,
              ),
              "",
              "The client bundle inlines its API origin when the IMAGE is built, so a",
              "wrong value there builds green and points the browser at a dead API;",
              "runtime env on the container cannot change it, only a rebuild can.",
              "A native surface's value is baked into a store binary, which needs a",
              "new build and a new review to correct.",
              "",
              "`hatchkit update` rewrites the ones hatchkit owns.",
            ],
    });
  } catch (err) {
    out.push({
      name: `Project ${manifest.name} (API origin agreement)`,
      status: "skip",
      detail: `could not read the project: ${(err as Error).message}`,
    });
  }

  // ── where production environment actually lives ─────────────────────
  const { checkRuntimeEnvSource } = await import("./features/env-agreement/index.js");
  const { existsSync, readFileSync } = await import("node:fs");
  const read = (rel: string): string | undefined => {
    const path = `${projectDir}/${rel}`;
    return existsSync(path) ? readFileSync(path, "utf-8") : undefined;
  };
  const envProd = "packages/server/.env.production";
  const envProdPath = `${projectDir}/${envProd}`;
  const envProdBody = existsSync(envProdPath) ? readFileSync(envProdPath, "utf-8") : undefined;
  const composeFiles = [
    "docker-compose.yml",
    "docker-compose.server.yml",
    "docker-compose.client.yml",
  ]
    .map((path) => ({ path, content: read(path) }))
    .filter((f): f is { path: string; content: string } => f.content !== undefined);

  const envSource = checkRuntimeEnvSource({
    dockerfile: read("packages/server/Dockerfile"),
    gitignore: read(".gitignore"),
    composeFiles,
    expectedKeys: [],
    envFile:
      envProdBody === undefined
        ? undefined
        : {
            path: envProd,
            exists: true,
            // dotenvx ciphertext is what the encrypted-file mechanism
            // produces; a plain file is a local convenience and not the
            // failure this check is about.
            encrypted: envProdBody.includes("encrypted:"),
          },
  });
  if (envSource.findings.length > 0) {
    out.push({
      name: `Project ${manifest.name} (production env source)`,
      status: envSource.ok ? "ok" : "fail",
      detail: envSource.findings.map((f) => f.code).join(", "),
      hint: [
        ...envSource.findings.map((f) => `${f.code}: ${f.message}`),
        "",
        "Production environment lives in the platform's environment fields.",
        "A value written to an encrypted file the runtime image never copies",
        "deploys green and leaves the server on its old values, with nothing",
        "in the diff to point at.",
      ],
    });
  }

  // ── the domain layout the proxy and the certificate can serve ───────
  const { topologyAdvice } = await import("./features/topology-guidance/index.js");
  const advice = topologyAdvice({
    domain: project.domain,
    aliases: project.aliases,
    topology: project.topology,
    surfaces: project.surfaces,
  });
  const actionable = advice.findings.filter((f) => f.severity !== "info");
  if (actionable.length > 0) {
    out.push({
      name: `Project ${manifest.name} (deployment topology)`,
      status: advice.ok ? "ok" : "fail",
      detail: actionable.map((f) => f.code).join(", "),
      hint: actionable.flatMap((f) => [`${f.code}: ${f.message}`, `  → ${f.fix}`]),
    });
  }

  return out;
}
