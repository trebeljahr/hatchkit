/*
 * scaffoldApp orchestrator.
 *
 * Responsibilities in order:
 *   1. Validate preconditions (starter submodule present, target empty).
 *   2. Copy the starter template to `outputDir` (fs cpSync with filter).
 *   3. Customize the copy: project name, env files, feature flag strip,
 *      bundle IDs, port assignment + propagation, ML playground prune,
 *      next.config for static export when native is selected.
 *   4. Roll back (rm output dir + unregister reserved ports) if any
 *      step after the copy throws.
 *
 * The actual file-rewriting logic lives in starter-files.ts and
 * pkg-json.ts; this file is the control flow.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import chalk from "chalk";
import ora from "ora";
import { addUsedPorts, getUsedPorts, removeUsedPorts } from "../config.js";
import type { MlService, ProjectConfig } from "../prompts.js";
import { explainFsError } from "../utils/errors.js";
import { type ProjectPorts, pickProjectPorts } from "../utils/ports.js";
import { getCliVersion } from "../utils/version.js";
import { applyClaudeMd } from "./claude-md.js";
import { applyWorkflowClientBuildArgUrls } from "./client-build-args.js";
import {
  applyWorkflowDeployVerifyUrls,
  applyWorkflowNativeOrigins,
} from "./deploy-verification.js";
import { type DotenvxSeedResult, seedDotenvxProduction } from "./dotenvx.js";
import { MANIFEST_FILENAME, toManifest, writeManifest } from "./manifest.js";
import { inferGhOwner, substituteComposeImageRefs } from "./owner.js";
import {
  setPackageJsonDescription,
  stripPackageJsonBuildBlock,
  stripPackageJsonDeps,
  stripPackageJsonScripts,
  unchainTypecheckScript,
} from "./pkg-json.js";
import { writeSplitComposeFiles } from "./split-compose.js";
import {
  applyPorts,
  applyProjectName,
  flipNextConfigToStaticExport,
  removeIfExists,
  replaceInFile,
  stripMobileBridgeFromLayout,
  updateEnvExample,
} from "./starter-files.js";
import { pruneToSurface } from "./surfaces.js";

// Monorepo root → starter submodule
const MONOREPO_ROOT = resolve(join(import.meta.dirname, "..", "..", ".."));
const STARTER_ROOT = join(MONOREPO_ROOT, "starter");

export interface ScaffoldResult {
  modifications: string[];
  ports: ProjectPorts;
  /** Populated by seedDotenvxProduction on real (non-dry-run) scaffolds.
   *  The private key is also mirrored into the OS keychain. */
  dotenvx?: DotenvxSeedResult;
  /** Populated when the project opted into Tailscale-served local-dev
   *  (config.localDev was set). The caller uses `slug` to record the
   *  ledger step so `hatchkit destroy` cleans up the Caddy fragment. */
  localDev?: { slug: string; domain?: string };
}

/** Scaffold a new app by copying the starter template and customizing it. */
export async function scaffoldApp(
  config: ProjectConfig,
  outputDir: string,
): Promise<ScaffoldResult> {
  if (config.dryRun) {
    return {
      modifications: scaffoldDryRun(config, outputDir),
      // Dry-run still picks ports so the summary is accurate, but
      // doesn't persist them.
      ports: await pickProjectPorts(getUsedPorts(), {
        nativeHmr: config.features.includes("desktop") || config.features.includes("mobile"),
      }),
    };
  }

  if (!existsSync(STARTER_ROOT)) {
    throw new Error(
      `Starter template not found at ${STARTER_ROOT}. Your hatchkit checkout looks incomplete — re-clone or pull the latest main.`,
    );
  }

  // Bail if the target already exists — without this, cpSync silently
  // merges new files into whatever is there, mixing old and new state.
  if (existsSync(outputDir)) {
    const entries = readdirSync(outputDir);
    if (entries.length > 0) {
      // If the target looks like a previously-scaffolded project,
      // nudge the user toward `update` instead of a hard fail.
      const hasManifest = entries.includes(MANIFEST_FILENAME);
      const hint = hasManifest
        ? ` This looks like a previously-scaffolded project (${MANIFEST_FILENAME} is present). Try \`hatchkit update\` from inside it to add features.`
        : "";
      throw new Error(
        `Output directory ${outputDir} already exists and is not empty. Move or remove it first.${hint}`,
      );
    }
  }

  // Resolve symlinks — if the submodule path is itself a symlink (tests,
  // local dev linking to a sibling checkout), cpSync would otherwise try
  // to recreate the symlink at outputDir and fail with EEXIST.
  const resolvedStarter = realpathSync(STARTER_ROOT);

  // Track claimed resources so a mid-scaffold failure can be rolled
  // back: filesystem + port registrations.
  const reservedPorts: number[] = [];
  const rollback = (): void => {
    if (existsSync(outputDir)) {
      try {
        rmSync(outputDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    if (reservedPorts.length > 0) {
      try {
        removeUsedPorts(reservedPorts);
      } catch {
        /* ignore */
      }
    }
  };

  const copyStart = Date.now();
  const copySpinner = ora(`Copying starter from ${resolvedStarter}`).start();
  try {
    cpSync(resolvedStarter, outputDir, {
      recursive: true,
      filter: (src) => {
        const rel = src.replace(resolvedStarter, "");
        if (rel === "/.git" || rel.startsWith("/.git/")) return false;
        if (rel.includes("/node_modules")) return false;
        if (rel.includes("/.next")) return false;
        if (rel.includes("/dist/")) return false;
        return true;
      },
    });
    copySpinner.succeed(`Starter copied (${elapsed(copyStart)})`);
  } catch (err) {
    copySpinner.fail("Starter copy failed");
    rollback();
    throw new Error(explainFsError(err, "Failed to copy starter template"));
  }

  const customizeStart = Date.now();
  const customizeSpinner = ora("Customizing for your project").start();
  try {
    const result = await runScaffoldSteps(config, outputDir, reservedPorts);
    customizeSpinner.succeed(
      `Scaffolded ${result.modifications.length} modifications (${elapsed(customizeStart)})`,
    );
    return result;
  } catch (err) {
    customizeSpinner.fail("Customization failed");
    rollback();
    throw err;
  }
}

/** Format ms-since-start as a compact "123ms" or "1.4s". */
function elapsed(startMs: number): string {
  const ms = Date.now() - startMs;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Customize the starter copy. Mutates `reservedPorts` in place so the
 *  outer orchestrator can unregister them on failure. */
async function runScaffoldSteps(
  config: ProjectConfig,
  outputDir: string,
  reservedPorts: number[],
): Promise<ScaffoldResult> {
  const modifications: string[] = [];

  // Rename the project in package.json
  replaceInFile(join(outputDir, "package.json"), "node-realtime-starter", config.name);
  modifications.push("package.json (renamed project)");

  // Stamp the user-supplied description onto package.json. Empty/unset
  // input deletes the field (the starter's package.json doesn't have
  // one to begin with) so we don't ship an empty string through to
  // any future `npm publish`.
  if (config.description !== undefined) {
    setPackageJsonDescription(outputDir, config.description);
    if (config.description.trim()) {
      modifications.push("package.json (set description)");
    }
  }

  // Project-name substitution for local-infra identifiers — gives each
  // scaffolded project its own dev Mongo DB / local S3 bucket / E2E
  // isolation. Without this, two projects on one machine collide on
  // the same `starter-dev` bucket and `starter-dev` Mongo database.
  applyProjectName(outputDir, config.name);
  modifications.push("renamed local-infra identifiers (Mongo DB / local S3 bucket / E2E names)");

  // docker-compose.yml: substitute `OWNER/REPO` placeholders so the
  // first Coolify deploy can pull `ghcr.io/<owner>/<repo>-{server,client}:main`
  // without the user hand-editing the file. The CI workflow already
  // tags images by `${{ github.repository }}`, so this aligns the
  // compose default with what GHCR actually receives.
  const ghOwner = await inferGhOwner({
    configOwner: config.githubOwner,
    projectDir: outputDir,
  });
  const composeSub = substituteComposeImageRefs(outputDir, ghOwner, config.name);
  if (composeSub.written) {
    modifications.push(
      ghOwner
        ? `docker-compose.yml: image refs → ghcr.io/${ghOwner}/${config.name}-{server,client}:main`
        : `docker-compose.yml: substituted REPO=${config.name} (owner unresolved; left literal OWNER)`,
    );
    if (!ghOwner) {
      console.log(
        chalk.yellow(
          "  ⚠ Couldn't infer GitHub owner — edit `image: ghcr.io/OWNER/...`\n" +
            "    in docker-compose.yml before pushing.",
        ),
      );
    }
  }

  // .env.example files: production URLs for this project's domain.
  // .env.development is left alone (local dev defaults should stay pointing at localhost).
  updateEnvExample(outputDir, "packages/server/.env.example", config);
  updateEnvExample(outputDir, "packages/client/.env.example", config);
  modifications.push("updated .env.example files with production URLs");

  // CI workflow: bake the literal production URLs into the client
  // image's build-args. Next.js inlines NEXT_PUBLIC_* at build time, so
  // these MUST be present when CI builds the image — runtime env on the
  // deployed container can't reach browser code.
  if (applyWorkflowClientBuildArgUrls(outputDir, config.domain, config.topology)) {
    modifications.push(
      `build-and-deploy.yml: client build-args → https://${config.domain} (NEXT_PUBLIC_* baked at image build)`,
    );
  }

  // CI workflow: point the post-deploy gate at the same URLs. The gate
  // polls both artefacts until they report the commit CI just pushed —
  // without a URL it has nothing to poll and fails the run rather than
  // reporting green having checked nothing.
  if (applyWorkflowDeployVerifyUrls(outputDir, config.domain, config.topology, config.surfaces)) {
    modifications.push("build-and-deploy.yml: post-deploy verification URLs set (web + api)");
  }
  // …and the native-client sign-in probe at the origins the selected
  // features ship (empty → the step reports nothing to check).
  if (applyWorkflowNativeOrigins(outputDir, config.features)) {
    modifications.push("build-and-deploy.yml: native-client sign-in check origins set");
  }

  // Feature-flag removal
  if (!config.features.includes("websocket")) {
    removeIfExists(join(outputDir, "packages/server/src/ws"));
    // Deleting ws/ alone leaves `index.ts` importing ./ws/handler.js —
    // a hard TS2307 on the first `pnpm run build`. Strip the call sites too.
    stripWebSocketFromServerIndex(outputDir);
    modifications.push("removed: ws/ (WebSocket not selected)");
  }
  if (!config.features.includes("stripe")) {
    removeIfExists(join(outputDir, "packages/server/src/services/stripe.ts"));
    // Same class of bug as ws/: `app.ts` (webhook mount) and `index.ts`
    // (startup warning) both import ./services/stripe.js unconditionally.
    stripStripeFromServer(outputDir);
    modifications.push("removed: stripe service (Stripe not selected)");
  }

  const wantsDesktop = config.features.includes("desktop");
  const wantsTauri = config.features.includes("desktop-tauri");
  const wantsMobile = config.features.includes("mobile");
  const bundleId = config.name.replace(/[^a-z0-9]/gi, "").toLowerCase();

  // Port assignment — tested-free via isPortFree + persisted into the
  // CLI registry so subsequent scaffolds can't collide.
  const ports = await pickProjectPorts(getUsedPorts(), {
    nativeHmr: wantsDesktop || wantsTauri || wantsMobile,
  });
  const claimed = [ports.server, ports.client, ports.nativeHmr].filter(
    (p): p is number => p !== undefined,
  );
  addUsedPorts(claimed);
  reservedPorts.push(...claimed);
  applyPorts(outputDir, ports, { wantsDesktop, wantsTauri, wantsMobile });
  modifications.push(
    `assigned ports: server=${ports.server} client=${ports.client}` +
      (ports.nativeHmr ? ` native=${ports.nativeHmr}` : ""),
  );

  // split topology: each Coolify app builds from its own single-service
  // compose. Pointing both at the root file would run the whole stack
  // twice (two clients, two servers, two mongos on one volume).
  if (config.topology === "split") {
    const stem = ghOwner ? `ghcr.io/${ghOwner}/${config.name}` : `ghcr.io/OWNER/${config.name}`;
    const split = writeSplitComposeFiles({
      projectDir: outputDir,
      imageStem: stem,
      ports: { server: ports.server, client: ports.client },
      surfaces: config.surfaces,
    });
    if (split.written.length > 0) {
      modifications.push(`split topology: wrote ${split.written.join(", ")}`);
    }
    console.log(
      chalk.dim(
        "  · split topology: mongo/redis are provisioned as Coolify databases, not compose\n" +
          "    services — the two apps sit on separate Docker networks, so an in-stack\n" +
          "    datastore would only be reachable from one half.",
      ),
    );
  }

  // Desktop (Electron) strip / substitute
  if (!wantsDesktop) {
    removeIfExists(join(outputDir, "electron"));
    removeIfExists(join(outputDir, ".github/workflows/desktop-release.yml"));
    // build/icon.png is the shared icon source: Electron's `icons:desktop` and
    // Tauri's `icons:tauri` both read it, so it only goes when neither wrapper
    // is selected.
    if (!wantsTauri) {
      removeIfExists(join(outputDir, "build"));
    }
    removeIfExists(join(outputDir, "packages/client/src/types/electron.d.ts"));
    // The icon generator is only wired to `icons:desktop` (Electron);
    // Tauri regenerates from build/icon.png via its own CLI.
    removeIfExists(join(outputDir, "scripts/icons-desktop.mjs"));
    stripPackageJsonScripts(outputDir, [
      "dev:desktop",
      "dev:electron",
      "build:desktop",
      "electron:compile",
      "electron:build",
      "electron:preview",
      "typecheck:electron",
      "icons:desktop",
      "itch:push:mac",
      "itch:push:win",
      "itch:push:linux",
    ]);
    unchainTypecheckScript(outputDir);
    stripPackageJsonBuildBlock(outputDir);
    stripPackageJsonDeps(outputDir, ["electron", "electron-builder", "icon-gen", "wait-on"]);
    modifications.push("removed: desktop (Electron) scaffolding");
  } else {
    replaceInFile(join(outputDir, "package.json"), "{{projectName}}", config.name);
    replaceInFile(join(outputDir, "package.json"), "{{bundleId}}", bundleId);
  }

  // Desktop (Tauri) strip / substitute
  if (!wantsTauri) {
    removeIfExists(join(outputDir, "src-tauri"));
    removeIfExists(join(outputDir, ".github/workflows/tauri-release.yml"));
    stripPackageJsonScripts(outputDir, ["tauri", "dev:tauri", "build:tauri", "icons:tauri"]);
    stripPackageJsonDeps(outputDir, ["@tauri-apps/cli"]);
    modifications.push("removed: desktop (Tauri) scaffolding");
  } else {
    for (const rel of ["src-tauri/tauri.conf.json", "src-tauri/Cargo.toml"]) {
      replaceInFile(join(outputDir, rel), "{{projectName}}", config.name);
      replaceInFile(join(outputDir, rel), "{{bundleId}}", bundleId);
    }
  }

  // Mobile (Capacitor) strip / substitute
  if (!wantsMobile) {
    removeIfExists(join(outputDir, "ios"));
    removeIfExists(join(outputDir, "android"));
    removeIfExists(join(outputDir, "capacitor.config.ts"));
    removeIfExists(join(outputDir, "packages/client/src/mobile"));
    removeIfExists(join(outputDir, "scripts/android-dev.sh"));
    removeIfExists(join(outputDir, "scripts/android-env.sh"));
    removeIfExists(join(outputDir, "scripts/ios-dev.sh"));
    removeIfExists(join(outputDir, ".github/workflows/mobile-release.yml"));
    removeIfExists(join(outputDir, "resources"));
    stripMobileBridgeFromLayout(outputDir);
    stripPackageJsonScripts(outputDir, [
      "dev:android",
      "dev:ios",
      "build:mobile",
      "cap:add:ios",
      "cap:add:android",
      "cap:sync",
      "cap:run:ios",
      "cap:run:android",
      "build:ios:release",
      "build:android:release",
      "build:android:apk",
      "mobile:assets",
    ]);
    stripPackageJsonDeps(outputDir, [
      "@capacitor/core",
      "@capacitor/cli",
      "@capacitor/ios",
      "@capacitor/android",
      "@capacitor/splash-screen",
      "@capacitor/status-bar",
      "@capacitor/screen-orientation",
      "@capacitor/preferences",
      "@capacitor/app",
      "@capacitor/assets",
    ]);
    modifications.push("removed: mobile (Capacitor) scaffolding");
  } else {
    replaceInFile(join(outputDir, "capacitor.config.ts"), "{{projectName}}", config.name);
    replaceInFile(join(outputDir, "capacitor.config.ts"), "{{bundleId}}", bundleId);
  }

  if (wantsDesktop || wantsTauri || wantsMobile) {
    flipNextConfigToStaticExport(outputDir);
    modifications.push("next.config.ts: output 'standalone' → 'export'");
  }

  // Newsletter scaffolding — Listmonk+SES subscribe/confirm pipeline,
  // /sub pages, and CLI sender scripts. Kept by default; stripped
  // when the user didn't opt into the mailing-list intent.
  const wantsNewsletter =
    config.email?.mailingList === "listmonk-ses" && config.surfaces !== "static";
  if (!wantsNewsletter) {
    removeIfExists(join(outputDir, "packages/server/src/services/newsletter"));
    removeIfExists(join(outputDir, "packages/client/src/components/subscribe-form.tsx"));
    removeIfExists(join(outputDir, "packages/client/src/app/sub"));
    for (const script of [
      "newsletter-send",
      "newsletter-draft",
      "newsletter-test-tx",
      "newsletter-verify",
      "newsletter-welcome",
    ]) {
      removeIfExists(join(outputDir, `scripts/${script}.ts`));
    }
    // emails/ only holds the Listmonk broadcast templates the scripts
    // above send (welcome.html, digest-sample.html).
    removeIfExists(join(outputDir, "emails"));
    stripPackageJsonScripts(outputDir, [
      "newsletter:send",
      "newsletter:draft",
      "newsletter:test-tx",
      "newsletter:welcome",
      "newsletter:verify",
    ]);
    stripNewsletterFromServerApp(outputDir);
    modifications.push("removed: newsletter (Listmonk + SES) scaffolding");
  }

  // Runs after every strip that can delete a numbered block out of the two
  // server entrypoints (ws/, stripe, newsletter). Each strip takes its
  // comment banner with it, which left the survivors reading 0,1,3,4,5…
  // — a scaffold that looks half-edited. Renumbering is purely cosmetic,
  // so it is deliberately generic (see renumberStepComments) rather than a
  // per-feature mapping that would need touching for every future strip.
  renumberStepComments(outputDir, "packages/server/src/app.ts");
  renumberStepComments(outputDir, "packages/server/src/index.ts");

  // ML playground prune — remove unselected service pages.
  const allMlServices: MlService[] = [
    "background-removal",
    "subtitles",
    "image-recognition",
    "3d-extraction",
    "3d-sam-objects",
    "3d-sam-body",
    "3d-hunyuan",
    "3d-trellis",
  ];
  for (const service of allMlServices) {
    if (!config.mlServices.includes(service)) {
      removeIfExists(join(outputDir, `packages/client/src/app/(protected)/playground/${service}`));
      modifications.push(`removed: playground/${service} (not selected)`);
    }
  }

  // No ML services at all → remove the entire playground + infrastructure.
  if (config.mlServices.length === 0) {
    removeIfExists(join(outputDir, "packages/client/src/app/(protected)/playground"));
    removeIfExists(join(outputDir, "packages/client/src/components/ml"));
    removeIfExists(join(outputDir, "packages/server/src/trpc/routers/ml.ts"));
    removeIfExists(join(outputDir, "packages/server/src/services/ml.ts"));
    removeIfExists(join(outputDir, "packages/shared/src/ml-types.ts"));

    // Strip ml router from the tRPC router registration.
    const routerPath = join(outputDir, "packages/server/src/trpc/router.ts");
    if (existsSync(routerPath)) {
      let content = readFileSync(routerPath, "utf-8");
      content = content.replace('import { mlRouter } from "./routers/ml.js";\n', "");
      content = content.replace("  ml: mlRouter,\n", "");
      writeFileSync(routerPath, content, "utf-8");
    }

    // Strip ml-types export from shared barrel.
    const sharedIndexPath = join(outputDir, "packages/shared/src/index.ts");
    if (existsSync(sharedIndexPath)) {
      let content = readFileSync(sharedIndexPath, "utf-8");
      content = content.replace('export * from "./ml-types.js";\n', "");
      writeFileSync(sharedIndexPath, content, "utf-8");
    }

    // Strip Playground from protected navbar.
    const layoutPath = join(outputDir, "packages/client/src/app/(protected)/layout.tsx");
    if (existsSync(layoutPath)) {
      let content = readFileSync(layoutPath, "utf-8");
      content = content.replace(/\s*<Link\s+href="\/playground"[^>]*>[^<]*<\/Link>/, "");
      writeFileSync(layoutPath, content, "utf-8");
    }

    modifications.push("removed: ML playground, ML router, ML types, ML navbar link");
  }

  // Postgres overlay. Runs AFTER feature-flag strips and applyProjectName
  // (so the dev DB name is already substituted) but BEFORE pruneToSurface
  // (so the surface prune sees the rewritten compose service names).
  // Static surfaces skip — they have no server, so no DB engine to swap.
  if (config.dbEngine === "postgres" && config.surfaces !== "static") {
    const { applyPostgresOverlay } = await import("./postgres-overlay.js");
    const overlayResult = applyPostgresOverlay(outputDir);
    modifications.push(...overlayResult.modifications.map((m) => `postgres: ${m}`));
  }

  // Surface-aware prune. Runs LAST among the file-mutation steps so the
  // feature-flag work above (which uses `removeIfExists`) doesn't fight
  // it — anything the prune wipes was either already gone or was a
  // safe no-op write. See scaffold/surfaces.ts for the per-surface
  // semantics.
  pruneToSurface(config, outputDir, modifications);

  // CLAUDE.md last: it documents what's left on disk, so it has to see
  // the post-prune, post-overlay world. Otherwise every scaffold ships
  // agent memory describing the full starter.
  applyClaudeMd(config, outputDir, modifications);

  // Write the sanitized manifest so `hatchkit update` can diff
  // against this scaffold's choices later. See manifest.ts for the
  // strict list of fields that are safe to persist.
  //
  // For projects scaffolded into a sub-folder of an existing repo
  // (config.projectSubdir set), the manifest lives at the ENCLOSING
  // REPO ROOT, not the scaffolded subdir — so a fresh checkout's git
  // toplevel always carries the manifest, and downstream tooling
  // (sync, keys push, regen-infra) finds it without knowing about
  // the subdir. For the historical single-package-at-root layout the
  // two dirs are the same, so this is a no-op for existing projects.
  const manifestDir = config.projectSubdir
    ? resolve(outputDir, ...config.projectSubdir.split("/").map(() => ".."))
    : outputDir;
  writeManifest(manifestDir, toManifest(config, ports, getCliVersion()));
  modifications.push(".hatchkit.json (project manifest)");

  // Subdir-deployed scaffold: relocate the starter's GitHub Actions
  // workflows from inside the subdir up to the enclosing repo's
  // .github/workflows/. Actions only reads workflows from the repo-
  // root location, so a workflow that lands at
  // `/repo/<name>/.github/workflows/build-and-deploy.yml` is silently
  // ignored. Move + patch the `context: .` lines (used by
  // docker/build-push-action) to point at the subdir instead. No-op
  // for single-package-at-root (outputDir === manifestDir).
  if (config.projectSubdir && manifestDir !== outputDir) {
    relocateWorkflowsForSubdir(outputDir, manifestDir, config.projectSubdir, modifications);
  }

  // Seed .env.production via dotenvx: encrypt supplied values, mint a
  // keypair, mirror the private key into the OS keychain. Unsupplied
  // keys land as plaintext CHANGE_ME_<KEY> placeholders.
  //
  // Static scaffolds skip this step — dotenvx targets
  // packages/server/.env.production, which doesn't exist post-prune,
  // and the server-side auth/Mongo keys don't apply. A keypair may
  // still get minted later if the user provisions a service that
  // writes encrypted vars into packages/client/.env.production (e.g.
  // Plausible's NEXT_PUBLIC_* tracker config); `runProvision` then
  // mirrors that key into the keychain via `mirrorEnvKeysIfAbsent`.
  let dotenvx: DotenvxSeedResult | undefined;
  if (config.surfaces !== "static") {
    dotenvx = await seedDotenvxProduction(outputDir, config, config.envValues ?? {});
    modifications.push(
      `dotenvx: ${dotenvx.encryptedKeys.length} encrypted, ${dotenvx.placeholderKeys.length} placeholders`,
    );
  } else {
    modifications.push("static: skipped server-side dotenvx seed (provisioners may mint later)");
  }

  // Tailscale-served local-dev opt-in. The host plumbing is the user's
  // own one-time setup (`hatchkit dev-setup init`); here we just write
  // the per-project pieces: the Caddy fragment at the client dev port
  // (or server port for backend surfaces), docs/dev-setup.md, the
  // next.config wrapper, and the @hatchkit/dev-plugin-next dep. None of
  // this is required for the project to function — the dev plugin
  // gracefully no-ops when the host bridge isn't active.
  let localDev: { slug: string; domain?: string } | undefined;
  if (config.localDev) {
    const devPort = config.surfaces === "backend" ? ports.server : ports.client;
    const { enableProjectLocalDev } = await import("../dev-setup.js");
    const { localDevDomainFromProjectDomain } = await import("@hatchkit/dev-shared");
    const localDevDomain =
      config.localDev.domain ?? localDevDomainFromProjectDomain(config.domain) ?? undefined;
    const result = await enableProjectLocalDev({
      projectDir: outputDir,
      slug: config.localDev.slug,
      localDevDomain,
      devPort,
    });
    localDev = { slug: config.localDev.slug, domain: localDevDomain };
    modifications.push(
      `local-dev: framework ${result.framework}, fragment ${result.wroteFragment}, docs ${result.wroteDocs ? "wrote" : "unchanged"}, config ${result.patchedConfig}, package.json ${result.patchedPackageJson}`,
    );
  }

  return { modifications, ports, dotenvx, localDev };
}

/** Edit packages/server/src/app.ts to drop the newsletter route import +
 *  registration, so a project that opted out doesn't carry a dangling
 *  import to a deleted file. Safe to call on a starter copy that
 *  doesn't have the lines (no-op). */
function stripNewsletterFromServerApp(outputDir: string): void {
  const path = join(outputDir, "packages/server/src/app.ts");
  if (!existsSync(path)) return;
  let content = readFileSync(path, "utf-8");
  content = content.replace(
    /import\s+{\s*registerNewsletterRoutes\s*}\s+from\s+"\.\/services\/newsletter\/routes\.js";\n/,
    "",
  );
  content = content.replace(
    /\n\s*\/\/[^\n]*Newsletter[^\n]*\n\s*registerNewsletterRoutes\(app\);\n/,
    "\n",
  );
  // Defensive fallback for the bare line if the comment shape ever drifts.
  content = content.replace(/\n\s*registerNewsletterRoutes\(app\);\n/, "\n");
  writeFileSync(path, content, "utf-8");
}

/** Move the starter's `.github/workflows/*.yml` from the scaffolded
 *  subdir up to the enclosing repo's `.github/workflows/`, patching
 *  any `context: .` line on docker/build-push-action steps to point
 *  at the subdir so the build still sees the right files.
 *
 *  Conflict policy: if the repo root already has a workflow with the
 *  same name, leave it alone (the user's), drop the starter's, and
 *  surface a hint in the modifications list. No merge — workflow YAML
 *  semantics are too varied to merge safely. */
function relocateWorkflowsForSubdir(
  outputDir: string,
  manifestDir: string,
  projectSubdir: string,
  modifications: string[],
): void {
  const srcDir = join(outputDir, ".github/workflows");
  if (!existsSync(srcDir)) return;
  const destDir = join(manifestDir, ".github/workflows");
  let entries: string[];
  try {
    entries = readdirSync(srcDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!/\.ya?ml$/i.test(name)) continue;
    const srcPath = join(srcDir, name);
    const destPath = join(destDir, name);
    if (existsSync(destPath)) {
      modifications.push(
        `workflow ${name} already at repo root — left existing file untouched, dropped starter copy`,
      );
      try {
        rmSync(srcPath, { force: true });
      } catch {
        /* best effort */
      }
      continue;
    }
    let body: string;
    try {
      body = readFileSync(srcPath, "utf-8");
    } catch {
      continue;
    }
    // Patch `context: .` (docker/build-push-action) to point at the
    // subdir. The starter's workflow assumes single-package-at-root.
    const patched = body.replace(/^(\s*context:\s*)\.\s*$/gm, `$1${projectSubdir}`);
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
    writeFileSync(destPath, patched, "utf-8");
    try {
      rmSync(srcPath, { force: true });
    } catch {
      /* best effort */
    }
    modifications.push(
      `relocated ${name}: ${join(".github/workflows", name)} (now at repo root, context → ${projectSubdir})`,
    );
  }
  try {
    if (readdirSync(srcDir).length === 0) rmSync(srcDir, { recursive: true, force: true });
    const subdirGithub = join(outputDir, ".github");
    if (existsSync(subdirGithub) && readdirSync(subdirGithub).length === 0) {
      rmSync(subdirGithub, { recursive: true, force: true });
    }
  } catch {
    /* best effort */
  }
}

/** Edit packages/server/src/{app,index}.ts to drop everything that reaches
 *  into `./services/stripe.js`, which `removeIfExists` just deleted:
 *
 *    app.ts    — the `handleStripeWebhook` import + the raw-body webhook
 *                mount at POST /api/stripe/webhook.
 *    index.ts  — the `warnStripeStatus` import + the startup call.
 *
 *  Only the Stripe step disappears; every other middleware keeps its
 *  relative position, so the load-bearing ordering documented in
 *  starter/CLAUDE.md ("Critical Middleware Ordering" — better-auth first,
 *  then express.json(), then helmet/cors/morgan/tRPC, error handlers last)
 *  still holds. The tRPC billing router is deliberately left in place: it
 *  duplicates the `CHANGE_ME_` sentinel check locally instead of importing
 *  the service, precisely so it survives this strip.
 *
 *  Every replace is a no-op when the text isn't there, so this is safe to
 *  call on an already-stripped copy (idempotent) and is never called at all
 *  when Stripe IS selected. */
function stripStripeFromServer(outputDir: string): void {
  const appPath = join(outputDir, "packages/server/src/app.ts");
  if (existsSync(appPath)) {
    let content = readFileSync(appPath, "utf-8");
    content = content.replace(
      /import\s+{\s*handleStripeWebhook\s*}\s+from\s+"\.\/services\/stripe\.js";\n/,
      "",
    );
    // Swallow the blank line ahead of the block plus any comment banner
    // directly above it, so the surrounding sections stay one blank line
    // apart instead of collecting a stray gap.
    content = content.replace(
      /\n[ \t]*\n(?:[ \t]*\/\/[^\n]*\n)*[ \t]*app\.post\([\s\S]*?"\/api\/stripe\/webhook"[\s\S]*?\n[ \t]*\);\n/,
      "\n",
    );
    // Defensive fallback for the bare mount if the comment shape drifts.
    content = content.replace(
      /\n\s*app\.post\([\s\S]*?"\/api\/stripe\/webhook"[\s\S]*?\n[ \t]*\);\n/,
      "\n",
    );
    writeFileSync(appPath, content, "utf-8");
  }

  const indexPath = join(outputDir, "packages/server/src/index.ts");
  if (existsSync(indexPath)) {
    let content = readFileSync(indexPath, "utf-8");
    content = content.replace(
      /import\s+{\s*warnStripeStatus\s*}\s+from\s+"\.\/services\/stripe\.js";\n/,
      "",
    );
    content = content.replace(
      /\n[ \t]*\n(?:[ \t]*\/\/[^\n]*\n)*[ \t]*warnStripeStatus\(\);\n/,
      "\n",
    );
    // Defensive fallback for the bare call if the comment shape drifts.
    content = content.replace(/\n\s*warnStripeStatus\(\);\n/, "\n");
    writeFileSync(indexPath, content, "utf-8");
  }
}

/** Edit packages/server/src/index.ts to drop the WebSocket wiring after
 *  `removeIfExists` deleted packages/server/src/ws/. Three sites:
 *  the `setupWebSocket` import, the `const wss = setupWebSocket(server)`
 *  binding, and the "close all clients" loop in `shutdown()` (which is the
 *  only other reference to `wss`, so leaving it would trade TS2307 for
 *  TS2304). Idempotent, and only called when websocket is unselected. */
function stripWebSocketFromServerIndex(outputDir: string): void {
  const path = join(outputDir, "packages/server/src/index.ts");
  if (!existsSync(path)) return;
  let content = readFileSync(path, "utf-8");
  content = content.replace(
    /import\s+{\s*setupWebSocket\s*}\s+from\s+"\.\/ws\/handler\.js";\n/,
    "",
  );
  content = content.replace(/[ \t]*const\s+wss\s*=\s*setupWebSocket\(server\);\n/, "");
  content = content.replace(
    /\n[ \t]*\n(?:[ \t]*\/\/[^\n]*\n)*[ \t]*for\s*\(const client of wss\.clients\)\s*{[\s\S]*?\n[ \t]*}\n/,
    "\n",
  );
  writeFileSync(path, content, "utf-8");
}

// ─────────────────────────────────────────────────────────────────────────
// Generated-CLAUDE.md upkeep
//
// starter/CLAUDE.md is copied verbatim into every scaffold and is the file
// a coding agent reads first to learn the project's invariants. When a
// feature strip deletes the code a section describes, the prose has to go
// with it — otherwise the agent's ground truth documents a subsystem that
// isn't there, and it will try to preserve (or worse, restore) it.
//
// Precedent: applyPostgresOverlay does the same thing for the Mongo→PG
// swap (scaffold/postgres-overlay.ts). Same rules apply here:
//   - conditional — only runs on the strip path, never when the feature
//     is selected;
//   - text-absent-safe — every edit is a no-op when the phrase isn't
//     there, so a hand-edited or future CLAUDE.md just doesn't match;
//   - idempotent — re-running finds nothing left to remove;
//   - scoped — targeted phrases and one named section, never a blanket
//     rewrite of unrelated prose.
// ─────────────────────────────────────────────────────────────────────────

/** Renumber the "N." step comments in a generated server file so the
 *  sequence stays contiguous after a strip deleted one of the numbered
 *  blocks along with its comment (stripping Stripe left app.ts reading
 *  0,1,3,4,5… and index.ts's start() reading 1,2,4).
 *
 *  Deliberately generic — it renumbers whatever numbered comments are
 *  still in the file instead of mapping known section titles, so a future
 *  strip needs no change here. Details:
 *
 *  - Two shapes are recognised: the banner form `// ── 2. Title ────` used
 *    in app.ts and the plain form `// 2. Title` used inside index.ts's
 *    start(). The captured prefix (indentation + slashes + optional rule)
 *    is the sequence key, so the two shapes are renumbered independently
 *    and an unrelated numbered comment at a different indent can't be
 *    folded into a section list.
 *  - The first comment of a sequence keeps its original number, so a
 *    0-based file stays 0-based and a 1-based one stays 1-based.
 *  - A lettered step ("5b." — the newsletter sub-step) is a sub-step of
 *    the step above it: it inherits that step's new number and does not
 *    consume one of its own.
 *  - The trailing "─" rule is trimmed/padded by the digit-count delta so
 *    the banners stay aligned on the same column.
 *
 *  No-op when the file is missing or has no numbered comments, and a fixed
 *  point on an already-contiguous file — so it is safe to run
 *  unconditionally, including on scaffolds where nothing was stripped. */
function renumberStepComments(outputDir: string, rel: string): void {
  const path = join(outputDir, rel);
  if (!existsSync(path)) return;

  const stepComment = /^([ \t]*\/\/ (?:── )?)(\d+)([a-z]*)(\. .*?)(─*)$/;
  const content = readFileSync(path, "utf-8");
  const nextNumber = new Map<string, number>();
  const lastMajor = new Map<string, number>();

  const rewritten = content
    .split("\n")
    .map((line) => {
      const match = stepComment.exec(line);
      if (!match) return line;
      const [, prefix = "", digits = "", suffix = "", title = "", rule = ""] = match;

      if (!nextNumber.has(prefix)) nextNumber.set(prefix, Number(digits));
      const next = nextNumber.get(prefix) ?? Number(digits);

      let assigned: number;
      if (suffix) {
        assigned = lastMajor.get(prefix) ?? next;
      } else {
        assigned = next;
        lastMajor.set(prefix, next);
        nextNumber.set(prefix, next + 1);
      }

      const label = `${assigned}${suffix}`;
      const delta = label.length - (digits.length + suffix.length);
      const padded = delta >= 0 ? rule.slice(delta) : rule + "─".repeat(-delta);
      return `${prefix}${label}${title}${padded}`;
    })
    .join("\n");

  if (rewritten !== content) writeFileSync(path, rewritten, "utf-8");
}

/** Dry run — list what would happen without touching disk. */
function scaffoldDryRun(config: ProjectConfig, outputDir: string): string[] {
  console.log(chalk.bold("\n  [dry-run] Would scaffold from starter template:\n"));
  console.log(chalk.dim(`    Source: ${STARTER_ROOT}`));
  console.log(chalk.dim(`    Target: ${outputDir}`));
  console.log();

  const actions: string[] = [];
  actions.push("Copy starter template");
  actions.push(`Rename project to "${config.name}"`);
  if (config.description?.trim()) {
    actions.push(`Set package.json description to "${config.description.trim()}"`);
  }
  actions.push(`Set domain to "${config.domain}"`);
  if (config.surfaces === "backend") {
    actions.push(
      "Prune to backend (remove packages/client, native scaffolds, client compose service)",
    );
  } else if (config.surfaces === "static") {
    actions.push(
      "Prune to static (remove packages/server, auth/tRPC routes, server/mongo/redis compose services)",
    );
  }

  if (!config.features.includes("websocket")) actions.push("Remove WebSocket support");
  if (!config.features.includes("stripe")) actions.push("Remove Stripe integration");
  if (!config.features.includes("desktop")) actions.push("Remove desktop (Electron) scaffolding");
  if (!config.features.includes("desktop-tauri")) {
    actions.push("Remove desktop (Tauri) scaffolding");
  }
  if (!config.features.includes("mobile")) actions.push("Remove mobile (Capacitor) scaffolding");
  if (
    config.features.includes("desktop") ||
    config.features.includes("desktop-tauri") ||
    config.features.includes("mobile")
  ) {
    actions.push("Flip next.config.ts to output: 'export' (static)");
  }
  if (config.mlServices.length === 0) {
    actions.push("Remove ML playground, router, types");
  } else {
    const removed = [
      "background-removal",
      "subtitles",
      "image-recognition",
      "3d-extraction",
      "3d-sam-objects",
      "3d-sam-body",
      "3d-hunyuan",
      "3d-trellis",
    ].filter((s) => !config.mlServices.includes(s as MlService));
    if (removed.length > 0) {
      actions.push(`Remove unused ML pages: ${removed.join(", ")}`);
    }
  }

  for (const action of actions) {
    console.log(chalk.dim(`    - ${action}`));
  }

  return actions;
}
