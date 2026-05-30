import assert from "node:assert/strict";
import type { AdoptPlan, DetectedState } from "./src/adopt.js";
import {
  adoptPlanToOnboardingPlan,
  onboardingPlanToAdoptPlan,
  onboardingPlanToProjectConfig,
  projectConfigToOnboardingPlan,
} from "./src/onboarding/plan.js";
import type { ProjectConfig } from "./src/prompts.js";

function projectConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name: "launch-pad",
    description: "Ship fast",
    domain: "launch.example.com",
    baseDomain: "example.com",
    subdomain: "launch",
    surfaces: "fullstack",
    deployTarget: "existing",
    serverId: 1,
    serverIp: "192.0.2.10",
    serverIpv4: "192.0.2.10",
    features: ["analytics"],
    analyticsProviders: ["glitchtip", "plausible"],
    provisionServices: ["glitchtip", "plausible", "listmonk-ses"],
    s3Provider: "none",
    mlServices: [],
    forceRedeployMl: [],
    scaffoldRepo: true,
    createGithubRepo: true,
    githubRepoVisibility: "public",
    installDeps: true,
    deploymentMode: "coolify",
    runDeployment: true,
    dryRun: false,
    ...overrides,
  };
}

function detectedState(overrides: Partial<DetectedState> = {}): DetectedState {
  return {
    projectDir: "/tmp/existing-app",
    packageName: "existing-app",
    packageDescription: "Already here",
    hasManifest: false,
    serverDir: "/tmp/existing-app/packages/server",
    clientDir: "/tmp/existing-app/packages/client",
    unknownWorkspaceLayout: false,
    standaloneBuildCandidates: [],
    features: ["websocket"],
    prodEnvIsEncrypted: false,
    hasEnvKeys: false,
    coolifyConfigured: true,
    coolifyGithubSourceCount: 1,
    isGitRepo: true,
    gitRemoteUrl: "git@github.com:acme/existing-app.git",
    gitRemoteIsPrivate: true,
    ...overrides,
  };
}

function adoptPlan(overrides: Partial<AdoptPlan> = {}): AdoptPlan {
  return {
    name: "existing-app",
    domain: "existing.example.com",
    description: "Already here",
    features: ["websocket"],
    surfaces: "fullstack",
    deploymentMode: "coolify",
    serverDir: "/tmp/existing-app/packages/server",
    clientDir: "/tmp/existing-app/packages/client",
    bootstrapDotenvx: true,
    setupGitHub: false,
    wireCoolify: true,
    isPrivate: true,
    appPort: "3000",
    scaffoldBuildPipeline: true,
    services: ["glitchtip", "plausible"],
    pushKey: true,
    email: { transactional: "none", mailingList: "none" },
    ...overrides,
  };
}

{
  const cfg = projectConfig();
  const plan = projectConfigToOnboardingPlan(cfg);
  assert.deepEqual(plan.source, { kind: "starter", outputDir: "launch-pad" });
  assert.equal(plan.identity.name, cfg.name);
  assert.equal(plan.layout.surfaces, "fullstack");
  assert.equal(plan.deployment.mode, "coolify");
  assert.equal(plan.deployment.target, "existing");
  assert.equal(plan.repo.writeProject, true);
  assert.equal(plan.repo.githubRepoVisibility, "public");
  assert.deepEqual(plan.provisioning.features, ["analytics"]);
  assert.deepEqual(plan.provisioning.analyticsProviders, ["glitchtip", "plausible"]);
  assert.deepEqual(plan.provisioning.services, ["glitchtip", "plausible", "listmonk-ses"]);

  const edited = onboardingPlanToProjectConfig(
    {
      ...plan,
      identity: { ...plan.identity, name: "renamed", domain: "renamed.example.com" },
      layout: { ...plan.layout, surfaces: "static" },
      deployment: { ...plan.deployment, mode: "gh-pages", target: "new", runNow: true },
      repo: {
        ...plan.repo,
        createGithubRepo: false,
        githubRepoVisibility: "private",
        installDeps: false,
      },
      provisioning: {
        ...plan.provisioning,
        features: [],
        analyticsProviders: ["openpanel"],
        services: ["openpanel", "search-console"],
      },
    },
    cfg,
  );
  assert.equal(edited.name, "renamed");
  assert.equal(edited.domain, "renamed.example.com");
  assert.equal(edited.baseDomain, "example.com");
  assert.equal(edited.subdomain, "renamed");
  assert.equal(edited.surfaces, "static");
  assert.equal(edited.deploymentMode, "gh-pages");
  assert.equal(edited.runDeployment, true);
  assert.equal(edited.createGithubRepo, false);
  assert.equal(edited.githubRepoVisibility, "private");
  assert.equal(edited.installDeps, false);
  assert.deepEqual(edited.features, []);
  assert.deepEqual(edited.analyticsProviders, ["openpanel"]);
  assert.deepEqual(edited.provisionServices, ["openpanel", "search-console"]);
}

{
  const state = detectedState();
  const adopted = adoptPlan();
  const plan = adoptPlanToOnboardingPlan(adopted, state);
  assert.deepEqual(plan.source, { kind: "existing", projectDir: state.projectDir });
  assert.equal(plan.identity.name, adopted.name);
  assert.equal(plan.layout.serverDir, adopted.serverDir);
  assert.equal(plan.deployment.isPrivate, true);
  assert.equal(plan.env.bootstrapDotenvx, true);
  assert.deepEqual(plan.provisioning.services, ["glitchtip", "plausible"]);

  const roundTripped = onboardingPlanToAdoptPlan(
    {
      ...plan,
      identity: { ...plan.identity, domain: "new.example.com", description: undefined },
      layout: { ...plan.layout, surfaces: "backend", clientDir: "/tmp/should-drop" },
      deployment: { ...plan.deployment, mode: "scaffold-only", isPrivate: false },
      repo: { ...plan.repo, setupGitHub: true },
      env: { bootstrapDotenvx: false },
      provisioning: { features: ["s3"], services: ["listmonk-ses"] },
    },
    adopted,
    state,
  );
  assert.equal(roundTripped.domain, "new.example.com");
  assert.equal(roundTripped.description, "");
  assert.equal(roundTripped.surfaces, "backend");
  assert.equal(roundTripped.clientDir, undefined);
  assert.equal(roundTripped.deploymentMode, "scaffold-only");
  assert.equal(roundTripped.setupGitHub, true);
  assert.equal(roundTripped.isPrivate, false);
  assert.equal(roundTripped.bootstrapDotenvx, false);
  assert.deepEqual(roundTripped.features, ["s3"]);
  assert.deepEqual(roundTripped.services, ["listmonk-ses"]);
  assert.equal(roundTripped.wireCoolify, true);
  assert.equal(roundTripped.pushKey, true);
}

console.log("onboarding plan adapters ok");
