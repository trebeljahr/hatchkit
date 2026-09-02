/*
 * Shared status collection — what's configured, what's blocked, what's
 * next. Used by the top-level menu, `hatchkit status`, `hatchkit doctor`,
 * and the MCP server.
 *
 * Returns structured data (no chalk, no side-effects). The caller picks
 * a renderer (human/json).
 */

import chalk from "chalk";
import { getConfig, getConfigPath, getMlServices } from "./config.js";
import { type DeferredStep, readDeferredSteps } from "./provision/deferrals.js";
import { readManifest } from "./scaffold/manifest.js";
import { getCliVersion } from "./utils/version.js";

export interface ProviderSnapshot {
  key: string;
  label: string;
  configured: boolean;
  detail?: string;
  /** If not configured, how to configure it. */
  configureCommand?: string;
}

export interface StatusSnapshot {
  version: string;
  configPath: string;
  providers: ProviderSnapshot[];
  mlServiceCount: number;
  mlServices: Array<{ name: string; endpoint: string; platform: string }>;
  /** One-line next-best-step based on what's missing. */
  nextStep: string;
  /** Ordered suggestions for discoverability in the menu. */
  suggestions: Array<{ command: string; why: string }>;
  /** Project whose `.hatchkit.json` supplied `deferredSteps`. Null when
   *  status ran outside a Hatchkit project — the provider rows above
   *  are global, these two fields are not. */
  project: { name: string; dir: string } | null;
  /** Optional steps the user skipped during create / adopt / add, each
   *  with the exact command that finishes it. Always an array (empty
   *  outside a project), so `--json` consumers never have to nullcheck. */
  deferredSteps: DeferredStep[];
}

export function collectStatus(projectDir: string = process.cwd()): StatusSnapshot {
  const config = getConfig();
  const providers: ProviderSnapshot[] = [];
  const googleSearchConsole = config.providers.googleSearchConsole;
  const googleSearchConsoleConfigured =
    !!googleSearchConsole &&
    googleSearchConsole.status === "configured" &&
    (googleSearchConsole.oauthMode !== "hatchkit-pkce" ||
      (!!process.env.HATCHKIT_GOOGLE_SEARCH_CONSOLE_CLIENT_ID &&
        !!process.env.HATCHKIT_GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET));

  providers.push({
    key: "github",
    label: "GitHub (gh CLI)",
    configured: config.providers.github.status === "configured",
    configureCommand: "hatchkit setup",
  });
  providers.push({
    key: "coolify",
    label: "Coolify",
    configured: config.providers.coolify?.status === "configured",
    detail: config.providers.coolify?.url,
    configureCommand: "hatchkit config add coolify",
  });
  providers.push({
    key: "hetzner",
    label: "Hetzner Cloud",
    configured: config.providers.hetzner?.status === "configured",
    configureCommand: "hatchkit config add hetzner",
  });
  providers.push({
    key: "dns",
    label: "DNS",
    configured: config.providers.dns?.status === "configured",
    detail: config.providers.dns?.provider,
    configureCommand: "hatchkit config add dns",
  });

  const s3Providers = Object.keys(config.providers.s3);
  providers.push({
    key: "s3",
    label: "S3",
    configured: s3Providers.length > 0,
    detail: s3Providers.length > 0 ? s3Providers.join(", ") : undefined,
    configureCommand: "hatchkit config add s3",
  });

  const gpuProviders = Object.keys(config.providers.gpu);
  providers.push({
    key: "gpu",
    label: "GPU",
    configured: gpuProviders.length > 0,
    detail: gpuProviders.length > 0 ? gpuProviders.join(", ") : undefined,
    configureCommand: "hatchkit config add gpu",
  });

  providers.push({
    key: "glitchtip",
    label: "GlitchTip (errors)",
    configured: !!config.providers.glitchtip && config.providers.glitchtip.status === "configured",
    configureCommand: "hatchkit config add glitchtip",
  });
  providers.push({
    key: "openpanel",
    label: "OpenPanel (analytics)",
    configured: !!config.providers.openpanel && config.providers.openpanel.status === "configured",
    configureCommand: "hatchkit config add openpanel",
  });
  providers.push({
    key: "plausible",
    label: "Plausible (analytics)",
    configured: !!config.providers.plausible && config.providers.plausible.status === "configured",
    detail: config.providers.plausible?.url,
    configureCommand: "hatchkit config add plausible",
  });
  providers.push({
    key: "search-console",
    label: "Google Search Console",
    configured: googleSearchConsoleConfigured,
    detail: googleSearchConsole
      ? [
          googleSearchConsole.oauthMode === "hatchkit-pkce" ? "Hatchkit OAuth" : "BYO OAuth",
          googleSearchConsole.scopes?.length ? `${googleSearchConsole.scopes.length} scopes` : null,
        ]
          .filter(Boolean)
          .join(", ")
      : undefined,
    configureCommand: "hatchkit config add search-console",
  });
  providers.push({
    key: "stripe",
    label: "Stripe (payments)",
    configured: !!config.providers.stripe && config.providers.stripe.status === "configured",
    detail: stripeDetail(config.providers.stripe),
    configureCommand: "hatchkit config add stripe",
  });

  const services = getMlServices();
  const mlServiceList = Object.entries(services).map(([name, entry]) => ({
    name,
    endpoint: entry.endpoint,
    platform: entry.platform,
  }));

  // Project-local deferrals. Silently empty outside a Hatchkit project
  // so `hatchkit status` from $HOME keeps reporting global state only.
  let project: StatusSnapshot["project"] = null;
  let deferredSteps: DeferredStep[] = [];
  try {
    const manifest = readManifest(projectDir);
    if (manifest) {
      project = { name: manifest.name, dir: projectDir };
      deferredSteps = readDeferredSteps(projectDir);
    }
  } catch {
    // A malformed manifest is doctor's problem, not status'.
  }

  const nextStep = computeNextStep(providers, deferredSteps);
  const suggestions = computeSuggestions(providers, deferredSteps);

  return {
    version: getCliVersion(),
    configPath: getConfigPath(),
    providers,
    mlServiceCount: mlServiceList.length,
    mlServices: mlServiceList,
    nextStep,
    suggestions,
    project,
    deferredSteps,
  };
}

function stripeDetail(
  meta:
    | {
        status?: string;
        hasTestMaster?: boolean;
        hasLiveMaster?: boolean;
        accountId?: string;
      }
    | undefined,
): string | undefined {
  if (!meta || meta.status !== "configured") return undefined;
  const modes = [meta.hasTestMaster && "test", meta.hasLiveMaster && "live"]
    .filter(Boolean)
    .join(" + ");
  if (!modes) return undefined;
  return meta.accountId ? `${modes} · ${meta.accountId}` : modes;
}

function computeNextStep(
  providers: ProviderSnapshot[],
  deferredSteps: readonly DeferredStep[] = [],
): string {
  const required = ["github", "coolify", "hetzner", "dns"];
  const firstMissing = providers.find((p) => required.includes(p.key) && !p.configured);
  if (firstMissing) {
    return `Run \`${firstMissing.configureCommand}\` — ${firstMissing.label} is required for full scaffolds.`;
  }
  // Deferred steps outrank the generic "try create" nudge: the user is
  // already mid-project and asked to finish these later.
  const first = deferredSteps[0];
  if (first) {
    const n = deferredSteps.length;
    return `${n} step${n === 1 ? "" : "s"} deferred — finish the first with \`${first.command}\`.`;
  }
  return "You're set up. Try `hatchkit create` to scaffold a new project.";
}

function computeSuggestions(
  providers: ProviderSnapshot[],
  deferredSteps: readonly DeferredStep[] = [],
): Array<{ command: string; why: string }> {
  const out: Array<{ command: string; why: string }> = [];
  const has = (k: string) => providers.find((p) => p.key === k)?.configured;

  // Deferred follow-ups first — they're the concrete unfinished work.
  for (const step of deferredSteps) {
    out.push({ command: step.command, why: `deferred: ${step.label} — ${step.reason}` });
  }

  if (!has("github") || !has("coolify") || !has("hetzner") || !has("dns")) {
    out.push({
      command: "hatchkit setup",
      why: "first-time onboarding wires up GitHub + Coolify + Hetzner + DNS at once",
    });
  }
  if (has("coolify") && has("hetzner") && has("dns")) {
    out.push({ command: "hatchkit create", why: "scaffold and (optionally) deploy a new project" });
  }
  out.push({
    command: "hatchkit doctor",
    why: "health-check every configured provider with contextual fix hints",
  });
  out.push({
    command: "hatchkit add <project>",
    why: "add per-project GlitchTip / OpenPanel / Plausible / Listmonk + SES / Search Console services",
  });
  out.push({
    command: "hatchkit explain",
    why: "one-page mental model of how the pieces fit together",
  });
  return out;
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

export function renderStatusHuman(s: StatusSnapshot): string {
  const lines: string[] = [];
  lines.push(chalk.bold("  Provider Status:"));
  lines.push("");
  for (const p of s.providers) {
    const icon = p.configured ? chalk.green("✓") : chalk.dim("·");
    const detail = p.detail ? chalk.dim(` (${p.detail})`) : "";
    const hint = p.configured ? "" : chalk.dim(`  — ${p.configureCommand ?? "not configured"}`);
    lines.push(`  ${icon} ${p.label.padEnd(24)}${detail}${hint}`);
  }
  lines.push("");
  lines.push(
    `  ML Services: ${
      s.mlServiceCount > 0 ? chalk.green(`${s.mlServiceCount} registered`) : chalk.dim("none")
    }`,
  );
  for (const m of s.mlServices) {
    lines.push(chalk.dim(`    ${m.name}: ${m.endpoint} (${m.platform})`));
  }
  lines.push("");
  if (s.deferredSteps.length > 0) {
    lines.push(
      `  ${chalk.bold(chalk.yellow(`Deferred steps: ${s.deferredSteps.length}`))}${
        s.project ? chalk.dim(`  (${s.project.name})`) : ""
      }`,
    );
    for (const step of s.deferredSteps) {
      lines.push(`    ${chalk.yellow("»")} ${step.label} ${chalk.dim(`— ${step.reason}`)}`);
      lines.push(`      ${chalk.dim("→")} ${chalk.cyan(step.command)}`);
    }
    lines.push("");
  }
  lines.push(`  ${chalk.bold("Next:")} ${s.nextStep}`);
  lines.push(chalk.dim(`  Config: ${s.configPath}`));
  lines.push("");
  return lines.join("\n");
}

export function renderMenu(s: StatusSnapshot): string {
  const lines: string[] = [];
  const configured = s.providers.filter((p) => p.configured).length;
  const total = s.providers.length;
  lines.push(`  ${chalk.bold("Hatchkit")} — scaffold, deploy, and provision full-stack projects`);
  lines.push(
    `  ${chalk.dim(`${configured}/${total} providers configured`)}  ${chalk.dim("·")}  ${chalk.dim(
      s.version ? `v${s.version}` : "",
    )}`,
  );
  if (s.deferredSteps.length > 0) {
    lines.push(
      `  ${chalk.yellow(`${s.deferredSteps.length} step${s.deferredSteps.length === 1 ? "" : "s"} deferred`)}${
        s.project ? chalk.dim(` in ${s.project.name}`) : ""
      }`,
    );
  }
  lines.push("");
  lines.push(`  ${chalk.bold("Next:")} ${s.nextStep}`);
  lines.push("");
  lines.push(chalk.bold("  Suggested commands:"));
  for (const sug of s.suggestions) {
    lines.push(`    ${chalk.cyan(sug.command.padEnd(28))} ${chalk.dim(sug.why)}`);
  }
  lines.push("");
  lines.push(
    chalk.dim(
      "  Run `hatchkit help <command>` for detail, or `hatchkit explain` for the mental model.",
    ),
  );
  lines.push("");
  return lines.join("\n");
}
