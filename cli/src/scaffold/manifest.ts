/*
 * Project manifest — .hatchkit.json at the root of a scaffolded project.
 *
 * Purpose: capture just enough about how this project was scaffolded
 * that `hatchkit update` can diff the current feature set against a
 * desired new one and apply only the delta.
 *
 * ============================================================
 * SECURITY: WHAT GOES IN — AND WHAT ABSOLUTELY DOES NOT
 * ============================================================
 *
 * The manifest file gets committed to the project's git repo. Treat
 * every field as eventually public. The included fields below are all
 * already public in one way or another (package.json `name`, the
 * domain is in DNS + .env.example, feature flags are inferable from
 * dependency lists, ports are in .env.* and docker-compose.yml).
 *
 * Fields that MUST NEVER be written here:
 *   - tokens, passwords, API keys (any credential)
 *   - serverIp, serverId (Coolify server coordinates)
 *   - s3ExistingAccessKey / SecretKey / Endpoint / Bucket  (user creds)
 *   - serverSize / serverLocation (infrastructure cost signal)
 *
 * ProjectConfig has those fields; the `toManifest` function below is
 * the single choke point that picks out the safe subset. Any time a
 * new field is added to ProjectConfig, it must be triaged here — the
 * default is to NOT include it.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Feature, GpuPlatform, MlService, ProjectConfig, S3Provider } from "../prompts.js";
import type { ProjectPorts } from "../utils/ports.js";

export const MANIFEST_FILENAME = ".hatchkit.json";
export const MANIFEST_VERSION = 1;

export interface ProjectManifest {
  /** Schema version. Increment when the shape changes incompatibly. */
  version: typeof MANIFEST_VERSION;
  /** CLI version that produced this manifest (diagnostic only). */
  cliVersion: string;
  /** ISO timestamp of the scaffold. */
  scaffoldedAt: string;
  /** Project name — duplicated from package.json for convenience. */
  name: string;
  /** Production domain — already public in DNS + .env.example. */
  domain: string;
  /** Feature flags selected at scaffold. */
  features: Feature[];
  /** ML services wired into the backend. */
  mlServices: MlService[];
  /** S3 provider name (`hetzner` / `aws` / `r2` / `existing` / `none`).
   *  Credentials are NOT stored here — only the choice. */
  s3Provider: S3Provider;
  /** Where the app deploys. `existing` vs `new` is public-safe; the
   *  actual serverId/IP is not in the manifest. */
  deployTarget: "existing" | "new";
  /** GPU platforms each ML service was deployed to. First entry is
   *  the runtime default (`ML_BACKEND`); change `ML_BACKEND` on the
   *  deploy to flip which one serves traffic. */
  gpuPlatforms?: GpuPlatform[];
  /** HF model ID for custom-hf, if selected. HF models are public. */
  customHfModelId?: string;
  /** GPU tier (T4/A10G/A100/H100) — public product names. */
  customHfGpuType?: string;
  /** Ports assigned to this project. They're already public in the
   *  scaffolded .env.development files and docker-compose.yml. */
  ports: { server: number; client: number; nativeHmr?: number };
  /** What kind of project this is — server-only / client-only /
   *  both. Captured by `hatchkit adopt` so subsequent re-runs (and
   *  any future tooling that needs to know whether to look for a
   *  server bundle) don't have to re-infer from disk layout.
   *  Optional for back-compat with manifests written before this
   *  field existed; readers should fall back to detection. */
  surfaces?: "server-only" | "client-only" | "both";
}

/** Build a manifest from the internal ProjectConfig, explicitly
 *  whitelisting only the safe fields. Any new field on ProjectConfig
 *  will NOT leak into the manifest unless added here on purpose. */
export function toManifest(
  config: ProjectConfig,
  ports: ProjectPorts,
  cliVersion: string,
): ProjectManifest {
  return {
    version: MANIFEST_VERSION,
    cliVersion,
    scaffoldedAt: new Date().toISOString(),
    name: config.name,
    domain: config.domain,
    features: [...config.features],
    mlServices: [...config.mlServices],
    s3Provider: config.s3Provider,
    deployTarget: config.deployTarget,
    gpuPlatforms: config.gpuPlatforms,
    customHfModelId: config.customHfModelId,
    customHfGpuType: config.customHfGpuType,
    ports: {
      server: ports.server,
      client: ports.client,
      nativeHmr: ports.nativeHmr,
    },
  };
}

export function writeManifest(outputDir: string, manifest: ProjectManifest): void {
  const path = join(outputDir, MANIFEST_FILENAME);
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}

/** Read + validate a manifest from a scaffolded project directory.
 *  Returns null if the file doesn't exist. Throws on malformed JSON
 *  or an unknown schema version so downstream code doesn't silently
 *  operate on a wrong shape. */
export function readManifest(projectDir: string): ProjectManifest | null {
  const path = join(projectDir, MANIFEST_FILENAME);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(`Manifest at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { version?: unknown }).version !== MANIFEST_VERSION
  ) {
    throw new Error(`Manifest at ${path} has unknown version. Expected ${MANIFEST_VERSION}.`);
  }
  return parsed as ProjectManifest;
}
