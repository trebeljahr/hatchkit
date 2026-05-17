import chalk from "chalk";
import type { AdoptPlan, DetectedState } from "../adopt.js";
import type {
  AnalyticsProvider,
  DeployTarget,
  DeploymentMode,
  Feature,
  GitHubRepoVisibility,
  ProjectConfig,
  Surface,
} from "../prompts.js";
import type { ProvisionService } from "../provision/index.js";
import { parseDomain } from "../utils/validate.js";

const ANALYTICS_PROVISION_SERVICES: readonly AnalyticsProvider[] = [
  "glitchtip",
  "openpanel",
  "plausible",
];

function isAnalyticsProvisionService(service: ProvisionService): service is AnalyticsProvider {
  return (ANALYTICS_PROVISION_SERVICES as readonly ProvisionService[]).includes(service);
}

export type OnboardingSource =
  | { kind: "starter"; outputDir: string }
  | { kind: "existing"; projectDir: string };

export interface ProjectOnboardingPlan {
  source: OnboardingSource;
  identity: {
    name: string;
    domain: string;
    description?: string;
  };
  layout: {
    surfaces: Surface;
    serverDir?: string;
    clientDir?: string;
  };
  deployment: {
    mode: DeploymentMode;
    target?: DeployTarget;
    runNow: boolean;
    isPrivate?: boolean;
    appPort?: string;
  };
  repo: {
    writeProject: boolean;
    setupGitHub: boolean;
    createGithubRepo?: boolean;
    githubRepoVisibility?: GitHubRepoVisibility;
    installDeps?: boolean;
  };
  env: {
    bootstrapDotenvx: boolean;
  };
  provisioning: {
    features: Feature[];
    analyticsProviders?: AnalyticsProvider[];
    services: ProvisionService[];
  };
}

export function projectConfigToOnboardingPlan(config: ProjectConfig): ProjectOnboardingPlan {
  return {
    source: { kind: "starter", outputDir: config.name },
    identity: {
      name: config.name,
      domain: config.domain,
      description: config.description,
    },
    layout: {
      surfaces: config.surfaces,
      serverDir: config.surfaces === "static" ? undefined : "packages/server",
      clientDir: config.surfaces === "backend" ? undefined : "packages/client",
    },
    deployment: {
      mode: config.deploymentMode,
      target: config.deployTarget,
      runNow: config.runDeployment,
    },
    repo: {
      writeProject: config.scaffoldRepo,
      setupGitHub: config.createGithubRepo,
      createGithubRepo: config.createGithubRepo,
      githubRepoVisibility: config.githubRepoVisibility,
      installDeps: config.installDeps,
    },
    env: {
      bootstrapDotenvx: config.scaffoldRepo,
    },
    provisioning: {
      features: config.features,
      analyticsProviders: config.analyticsProviders,
      services: config.provisionServices,
    },
  };
}

export function onboardingPlanToProjectConfig(
  plan: ProjectOnboardingPlan,
  previousConfig: ProjectConfig,
): ProjectConfig {
  const parsed = parseDomain(plan.identity.domain);
  return {
    ...previousConfig,
    name: plan.identity.name,
    description: plan.identity.description,
    domain: plan.identity.domain,
    baseDomain: parsed.baseDomain,
    subdomain: parsed.subdomain,
    surfaces: plan.layout.surfaces,
    deployTarget: plan.deployment.target ?? previousConfig.deployTarget,
    deploymentMode: plan.deployment.mode,
    runDeployment: plan.deployment.runNow,
    scaffoldRepo: plan.repo.writeProject,
    createGithubRepo: plan.repo.createGithubRepo ?? plan.repo.setupGitHub,
    githubRepoVisibility: plan.repo.githubRepoVisibility ?? previousConfig.githubRepoVisibility,
    installDeps: plan.repo.installDeps ?? previousConfig.installDeps,
    features: plan.provisioning.features,
    analyticsProviders:
      plan.provisioning.analyticsProviders ??
      plan.provisioning.services.filter(isAnalyticsProvisionService),
    provisionServices: plan.provisioning.services,
  };
}

export function adoptPlanToOnboardingPlan(
  plan: AdoptPlan,
  state: DetectedState,
): ProjectOnboardingPlan {
  return {
    source: { kind: "existing", projectDir: state.projectDir },
    identity: {
      name: plan.name,
      domain: plan.domain,
      description: plan.description || undefined,
    },
    layout: {
      surfaces: plan.surfaces,
      serverDir: plan.serverDir,
      clientDir: plan.clientDir,
    },
    deployment: {
      mode: plan.deploymentMode,
      target: state.coolifyAppMatch ? "existing" : "new",
      runNow: plan.deploymentMode !== "scaffold-only",
      isPrivate: plan.isPrivate,
      appPort: plan.appPort,
    },
    repo: {
      writeProject: false,
      setupGitHub: plan.setupGitHub,
      createGithubRepo: plan.setupGitHub,
    },
    env: {
      bootstrapDotenvx: plan.bootstrapDotenvx,
    },
    provisioning: {
      features: plan.features,
      services: plan.services,
    },
  };
}

export function onboardingPlanToAdoptPlan(
  plan: ProjectOnboardingPlan,
  previousPlan: AdoptPlan,
  _state: DetectedState,
): AdoptPlan {
  return {
    ...previousPlan,
    name: plan.identity.name,
    domain: plan.identity.domain,
    description: plan.identity.description ?? "",
    features: plan.provisioning.features,
    surfaces: plan.layout.surfaces,
    serverDir: plan.layout.surfaces === "static" ? undefined : plan.layout.serverDir,
    clientDir: plan.layout.surfaces === "backend" ? undefined : plan.layout.clientDir,
    deploymentMode: plan.deployment.mode,
    setupGitHub: plan.repo.setupGitHub,
    isPrivate: plan.deployment.isPrivate ?? previousPlan.isPrivate,
    appPort: plan.deployment.appPort ?? previousPlan.appPort,
    bootstrapDotenvx: plan.env.bootstrapDotenvx,
    services: plan.provisioning.services,
    wireCoolify: previousPlan.wireCoolify,
    pushKey: previousPlan.pushKey,
  };
}

export function summarizeOnboardingDomain(plan: ProjectOnboardingPlan): string {
  return plan.identity.domain
    ? `${plan.identity.domain}  ${chalk.dim("→")}  https://${plan.identity.domain}`
    : "(unset)";
}

export function summarizeOnboardingFeatures(features: Feature[]): string {
  return features.length > 0 ? features.join(", ") : chalk.dim("none");
}

export function renderOnboardingDeploymentModeSummary(
  mode: DeploymentMode,
  surfaces?: Surface,
): string {
  switch (mode) {
    case "coolify":
      return "Coolify (full-stack)";
    case "gh-pages":
      return surfaces && surfaces !== "static"
        ? chalk.yellow("GitHub Pages — needs static")
        : "GitHub Pages (static)";
    case "scaffold-only":
      return "Scaffold only (no deploy)";
  }
}

export function renderOnboardingSurfaceSummary(surface: Surface): string {
  switch (surface) {
    case "fullstack":
      return "full-stack (single package, server runtime)";
    case "split":
      return "split server + client packages (server runtime)";
    case "backend":
      return "backend only (API / worker, no UI bundle)";
    case "static":
      return "static (gh-pages / SPA — no server runtime)";
  }
}
