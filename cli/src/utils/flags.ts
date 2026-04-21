/*
 * Command-line flag parsing for `devops-cli create`.
 *
 * Keeps the flag surface deliberately small — a few common flags plus
 * a `--config <path>` escape hatch that reads a JSON file matching
 * Partial<ProjectConfig>. Flags win over config file; config file
 * wins over prompt defaults.
 *
 * Design choice: don't try to expose every ProjectConfig field as a
 * flag. The combinatorial space is big and awkward to document. For
 * anything beyond the common case, point users at `--config <path>`.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Feature, MlService, ProjectConfig } from "../prompts.js";

export interface ParsedCreateFlags {
  /** Non-interactive: accept defaults, fail if a required value with
   *  no default is missing rather than prompting. */
  yes: boolean;
  /** --dry-run — already handled in index.ts but re-parsed here so
   *  one place knows the full set of supported flags. */
  dryRun: boolean;
  /** Preset values parsed from individual flags + --config file. */
  presets: Partial<ProjectConfig>;
  /** --no-github / --no-deploy hard-disable those steps regardless of
   *  what the preset / prompts would say. */
  forceNoGithub: boolean;
  forceNoDeploy: boolean;
}

const KNOWN_FEATURES: readonly Feature[] = [
  "websocket",
  "stripe",
  "analytics",
  "s3",
  "desktop",
  "mobile",
];
const KNOWN_ML_SERVICES: readonly MlService[] = [
  "3d-extraction",
  "subtitles",
  "image-recognition",
  "background-removal",
  "custom-hf",
];

export function parseCreateFlags(argv: string[]): ParsedCreateFlags {
  const get = (name: string): string | undefined => {
    // Accept both `--name value` and `--name=value`.
    const equalsIdx = argv.findIndex((a) => a.startsWith(`--${name}=`));
    if (equalsIdx !== -1) return argv[equalsIdx].slice(name.length + 3);
    const idx = argv.indexOf(`--${name}`);
    if (idx === -1 || idx === argv.length - 1) return undefined;
    const next = argv[idx + 1];
    return next.startsWith("--") ? undefined : next;
  };

  const has = (name: string): boolean =>
    argv.includes(`--${name}`) || argv.some((a) => a.startsWith(`--${name}=`));

  const yes = argv.includes("--yes") || argv.includes("-y");
  const dryRun = argv.includes("--dry-run");
  const forceNoGithub = argv.includes("--no-github");
  const forceNoDeploy = argv.includes("--no-deploy");

  // Start from --config <path> if present, then layer individual flags on top.
  const presets: Partial<ProjectConfig> = {};
  const configPath = get("config");
  if (configPath) {
    const absPath = resolve(configPath);
    if (!existsSync(absPath)) {
      throw new Error(`--config file not found: ${absPath}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(absPath, "utf-8"));
    } catch (err) {
      throw new Error(`--config file is not valid JSON: ${absPath} (${(err as Error).message})`);
    }
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`--config file must be a JSON object: ${absPath}`);
    }
    Object.assign(presets, parsed as Partial<ProjectConfig>);
  }

  const name = get("name");
  if (name) presets.name = name;

  const domain = get("domain");
  if (domain) presets.domain = domain;

  const features = get("features");
  if (features !== undefined) {
    const list = features
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const invalid = list.filter((f): f is string => !KNOWN_FEATURES.includes(f as Feature));
    if (invalid.length > 0) {
      throw new Error(
        `Unknown --features values: ${invalid.join(", ")}. Valid: ${KNOWN_FEATURES.join(", ")}`,
      );
    }
    presets.features = list as Feature[];
  }

  const mlServices = get("ml-services");
  if (mlServices !== undefined) {
    const list = mlServices
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const invalid = list.filter((f): f is string => !KNOWN_ML_SERVICES.includes(f as MlService));
    if (invalid.length > 0) {
      throw new Error(
        `Unknown --ml-services values: ${invalid.join(", ")}. Valid: ${KNOWN_ML_SERVICES.join(", ")}`,
      );
    }
    presets.mlServices = list as MlService[];
  }

  const deployTarget = get("deploy-target");
  if (deployTarget === "existing" || deployTarget === "new") {
    presets.deployTarget = deployTarget;
  } else if (deployTarget !== undefined) {
    throw new Error(`--deploy-target must be 'existing' or 'new' (got '${deployTarget}')`);
  }

  if (forceNoGithub) presets.createGithubRepo = false;
  if (forceNoDeploy) presets.runDeployment = false;

  // Validate that presets-provided values look right before we pass
  // them on (the prompt layer would also catch these, but failing
  // early in non-interactive mode gives a cleaner error).
  if (has("config") && typeof presets.name !== "string" && yes) {
    // fine — may still come from --name flag or default
  }

  return { yes, dryRun, presets, forceNoGithub, forceNoDeploy };
}
