/*
 * cli/src/features/release/config.ts — assembles a {@link ReleaseConfig}
 * and moves it between memory and disk.
 *
 * This is the only place the four derivation modules are composed, and
 * the only place that knows the config lives at
 * {@link RELEASE_CONFIG_FILENAME} in the project root. Everything above
 * it works with a manifest; everything below it works with a config.
 *
 * `derivationInputFromProject` is the seam where the filesystem enters.
 * Above it, derivation is a pure function of a
 * {@link ReleaseDerivationInput}; below it, tests hand in an input built
 * from a plain object and never touch a disk. That split is what lets
 * the channel catalog be tested against forty feature combinations in a
 * few milliseconds.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getCliVersion } from "../../utils/version.js";
import { deriveChannels } from "./channels.js";
import { deriveCredentials } from "./credentials.js";
import { derivePolicy } from "./policy-rules.js";
import {
  type CompatConfig,
  RELEASE_CONFIG_FILENAME,
  RELEASE_CONFIG_VERSION,
  type ReleaseConfig,
  type ReleaseDerivationInput,
} from "./types.js";
import { deriveVersionCopies, deriveVersionReads } from "./version-targets.js";

export { RELEASE_CONFIG_FILENAME, RELEASE_CONFIG_VERSION };

/** Package managers a scaffolded project might use, in the order we
 *  guess them from lockfiles. Hatchkit scaffolds pnpm, but `adopt` takes
 *  repos it did not create. */
const LOCKFILES: ReadonlyArray<[file: string, pm: ReleaseConfig["project"]["packageManager"]]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

/** Test scripts the cut command will run before committing, preferred
 *  narrowest first. A release cut should not be the thing that discovers
 *  a browser test is flaky, so `test:unit` beats `test` when both exist. */
const TEST_SCRIPTS = ["test:unit", "test", "check"] as const;

export interface BuildReleaseConfigOptions {
  /** Overrides the CLI version stamped into the file. Tests pin it so
   *  the generated JSON is byte-stable across releases of Hatchkit. */
  cliVersion?: string;
}

/**
 * The whole derivation, in one call. Every list in the result is derived
 * from `input` alone, so a project with fewer surfaces gets a smaller
 * config rather than a config with empty scaffolding in it.
 */
export function buildReleaseConfig(
  input: ReleaseDerivationInput,
  options: BuildReleaseConfigOptions = {},
): ReleaseConfig {
  const channels = deriveChannels(input);
  const credentials = deriveCredentials(channels);
  return {
    configVersion: RELEASE_CONFIG_VERSION,
    generatedBy: options.cliVersion ?? getCliVersion(),
    project: {
      name: input.name,
      versionFile: "package.json",
      tagPrefix: "v",
      packageManager: detectPackageManager(input),
      testCommand: detectTestCommand(input),
    },
    channels,
    versionCopies: deriveVersionCopies(input),
    versionReads: deriveVersionReads(input),
    credentials,
    policy: derivePolicy(input, channels, credentials),
    compat: deriveCompat(input),
  };
}

/**
 * The compat workflow's parameters, or null when the workflow would test
 * nothing.
 *
 * It is worth running only when an old client and a new server can
 * actually meet: the project must ship a server that someone else hosts
 * (so the server can lag), and a client that ships separately (so the
 * client can lead). A fullstack app deployed as one unit never has a
 * version skew to test, and a static site has no server at all.
 */
export function deriveCompat(input: ReleaseDerivationInput): CompatConfig | null {
  const hasServer =
    input.surfaces === "fullstack" || input.surfaces === "split" || input.surfaces === "backend";
  if (!hasServer) return null;

  // A client that ships on its own schedule: a desktop app, a phone app,
  // or a browser extension. Without one, every client is served by the
  // server it talks to and the two can never disagree.
  const shipsDetachedClient =
    input.features.includes("desktop") ||
    input.features.includes("mobile") ||
    input.exists("packages/extension/manifest.config.ts") ||
    input.exists("packages/extension/manifest.json");
  if (!shipsDetachedClient) return null;

  // Someone other than the project owner runs the server. Without a
  // self-host compose file there is one server, always current.
  const composeFile = ["docker-compose.selfhost.yml", "docker-compose.yml"].find((candidate) =>
    input.exists(candidate),
  );
  if (!composeFile) return null;

  const serverDockerfile = ["packages/server/Dockerfile", "Dockerfile.server", "Dockerfile"].find(
    (candidate) => input.exists(candidate),
  );
  if (!serverDockerfile) return null;

  const suiteEntry = ["packages/shared/src/compat/run.ts", "packages/core/src/compat/run.ts"].find(
    (candidate) => input.exists(candidate),
  );

  const pm = detectPackageManager(input);
  const suitePackage = suiteEntry?.startsWith("packages/shared/") ? "shared" : "core";
  return {
    serverScript: "scripts/compat-server.sh",
    composeFile,
    // The slug is the container image name, from the frozen identifier
    // set. It is in every `docker pull` a self-hoster has written down.
    serverImageRepo: `ghcr.io/OWNER/${input.identifiers.slug}-server`,
    serverDockerfile,
    // Absent on a project that has not written a compat suite yet. The
    // workflow skips that direction with a notice naming this path, so
    // the file to create is in the CI log rather than in a doc.
    suiteEntry: suiteEntry ?? `packages/${suitePackage}/src/compat/run.ts`,
    suiteBuild: `${pm} --filter "./packages/${suitePackage}..." run build`,
    suiteRun: `node packages/${suitePackage}/dist/compat/run.js`,
  };
}

// ---------------------------------------------------------------------------
// The filesystem seam
// ---------------------------------------------------------------------------

export interface ProjectFacts {
  name: string;
  identifiers: ReleaseDerivationInput["identifiers"];
  features: readonly string[];
  surfaces?: ReleaseDerivationInput["surfaces"];
  deploymentMode?: ReleaseDerivationInput["deploymentMode"];
  signing?: ReleaseDerivationInput["signing"];
}

/**
 * Binds the manifest's facts to a real directory. `projectDir` is the
 * deployable root — for a subdir-deployed project that is
 * `<repoRoot>/<projectSubdir>`, which is where the package.json, the
 * native projects and the compose files live.
 */
export function derivationInputFromProject(
  projectDir: string,
  facts: ProjectFacts,
): ReleaseDerivationInput {
  return {
    ...facts,
    exists: (relative) => existsSync(join(projectDir, relative)),
    list: (relative) => {
      try {
        return readdirSync(join(projectDir, relative));
      } catch {
        return [];
      }
    },
    read: (relative) => {
      try {
        return readFileSync(join(projectDir, relative), "utf-8");
      } catch {
        return null;
      }
    },
  };
}

/** Reads the generated config, or null when the project has not opted
 *  in. Never throws on a malformed file — a corrupt config should send
 *  the caller to `hatchkit update`, not crash it. */
export function readReleaseConfig(projectDir: string): ReleaseConfig | null {
  const path = join(projectDir, RELEASE_CONFIG_FILENAME);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as ReleaseConfig;
    return typeof parsed?.configVersion === "number" ? parsed : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------

function detectPackageManager(
  input: ReleaseDerivationInput,
): ReleaseConfig["project"]["packageManager"] {
  for (const [file, pm] of LOCKFILES) if (input.exists(file)) return pm;
  return "pnpm";
}

/** The narrowest test script the project has, or null. Null means the
 *  cut command commits without running anything, and says so. */
function detectTestCommand(input: ReleaseDerivationInput): string | null {
  const raw = input.read("package.json");
  if (!raw) return null;
  let scripts: Record<string, unknown> = {};
  try {
    scripts = (JSON.parse(raw) as { scripts?: Record<string, unknown> }).scripts ?? {};
  } catch {
    return null;
  }
  const pm = detectPackageManager(input);
  const found = TEST_SCRIPTS.find((name) => typeof scripts[name] === "string");
  return found ? `${pm} run ${found}` : null;
}
