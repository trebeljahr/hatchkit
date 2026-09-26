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
import { expandFeatureSelection } from "../features/all.js";
import { extensionPrerequisiteProblem } from "../features/extension/index.js";
import {
  applyServerFeatures,
  isServerFeature,
  printServerFeatureResults,
} from "../features/server-platform/index.js";
import type { Feature, MlService, ProjectConfig } from "../prompts.js";
import { explainFsError } from "../utils/errors.js";
import { type ProjectPorts, pickProjectPorts } from "../utils/ports.js";
import { getCliVersion } from "../utils/version.js";
import { applyClaudeMd } from "./claude-md.js";
import { applyWorkflowClientBuildArgUrls } from "./client-build-args.js";
import {
  applyWorkflowDeployVerifyUrls,
  applyWorkflowNativeOrigins,
} from "./deploy-verification.js";
import {
  DESKTOP_DEV_DEPS,
  DESKTOP_FILES,
  DESKTOP_SCRIPTS_TO_STRIP,
  substituteDesktopFiles,
} from "./desktop.js";
import { type DotenvxSeedResult, seedDotenvxProduction } from "./dotenvx.js";
import { applyE2eS3Gate } from "./e2e-s3.js";
import { collectIdentifierMismatches, formatIdentifierMismatches } from "./identifier-agreement.js";
import {
  type ProjectIdentifiers,
  assertIdentifiers,
  resolveIdentifiers,
  substituteIdentifierTokens,
} from "./identifiers.js";
import { MANIFEST_FILENAME, toManifest, writeManifest } from "./manifest.js";
import {
  MOBILE_DEPS,
  MOBILE_IDENTIFIER_RENAME_PATHS,
  MOBILE_PATHS,
  MOBILE_SCRIPTS,
} from "./mobile-feature.js";
import { inferGhOwner, substituteComposeImageRefs } from "./owner.js";
import {
  setPackageJsonDescription,
  stripPackageJsonBuildBlock,
  stripPackageJsonDeps,
  stripPackageJsonScripts,
  unchainScriptSegment,
  unchainTypecheckScript,
} from "./pkg-json.js";
import { writeSplitComposeFiles } from "./split-compose.js";
import {
  applyPorts,
  applyProjectName,
  flipNextConfigToStaticExport,
  removeIfExists,
  replaceInFile,
  rewriteFile,
  stripMobileBridgeFromLayout,
  stripNativeStylesFromGlobals,
  updateEnvExample,
} from "./starter-files.js";
import {
  pruneToSurface,
  stripRedisFromCompose,
  surfaceHasClient,
  surfaceHasServer,
} from "./surfaces.js";

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
  rawConfig: ProjectConfig,
  outputDir: string,
): Promise<ScaffoldResult> {
  // Close the selection over prerequisites BEFORE anything reads it.
  // `create` works by subtraction, so a feature that requires another
  // one and does not get it is not a missing addition — it is a strip
  // that deleted the package its dependant imports, and the failure is
  // a TS2307 in the user's first build rather than anything here.
  const config = withRequiredFeatures(rawConfig);
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

/**
 * `config` with every prerequisite of a selected feature added.
 *
 * The registry is the one place that knows what a feature needs
 * (`cli/src/features/contract.ts`), and its expansion is ordered and
 * deterministic. Selection errors — an unknown id, a cycle — are
 * reported rather than thrown: the scaffold that follows is the user's
 * project, and refusing to write it over a feature-list problem the
 * caller can still fix is worse than saying so and carrying on with
 * what resolved.
 */
function withRequiredFeatures(config: ProjectConfig): ProjectConfig {
  const { ordered, implied, errors } = expandFeatureSelection(config.features);
  for (const error of errors) console.log(chalk.yellow(`  ${error}`));
  if (implied.length === 0) return config;
  console.log(chalk.dim(`  Also adding ${implied.join(", ")}: required by what you selected.`));
  // `ordered` holds only registered features; anything not registered
  // yet (most of the older feature ids) stays exactly as selected.
  const expanded = new Set<Feature>([...config.features, ...ordered]);
  return { ...config, features: [...expanded] };
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

  // Resolve the project's permanent identifiers ONCE, before anything is
  // written. Every name that ends up in a bundle id, a storage key, a
  // header, a client id, a database or an env var comes from here — see
  // `cli/src/scaffold/identifiers.ts` for why re-deriving them at each
  // use site is the bug this replaced.
  const identifiers: ProjectIdentifiers =
    config.identifiers ??
    resolveIdentifiers({
      name: config.name,
      productName: config.productName,
      shortName: config.shortName,
      orgDomain: config.orgDomain,
    });
  for (const warning of assertIdentifiers(identifiers)) {
    modifications.push(`identifiers: ${warning.field} — ${warning.message}`);
  }

  // The web app manifest carries the two display names the browser and
  // the "add to home screen" flow read. It is also one of the four
  // places the launcher label lives (with the Capacitor config and the
  // two native trees), which is why the agreement check below reads it
  // back rather than trusting this write.
  rewriteFile(join(outputDir, "packages/client/public/manifest.json"), (c) =>
    substituteIdentifierTokens(c, identifiers),
  );
  modifications.push("packages/client/public/manifest.json (display names)");

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
    // `ws/auth.ts` authenticates an upgrade from the session cookie and
    // does nothing else, and the client-core sync feed authenticates
    // its own upgrade with it (`sync/handler.ts`). Deleting the whole
    // directory while that feature is on leaves that import pointing at
    // a file that is gone — a TS2307 on the user's first build, in a
    // file neither feature's author touched.
    if (config.features.includes("client-core")) {
      for (const name of readdirSync(join(outputDir, "packages/server/src/ws"))) {
        if (name === "auth.ts") continue;
        removeIfExists(join(outputDir, "packages/server/src/ws", name));
      }
      modifications.push(
        "removed: ws/ except auth.ts (WebSocket not selected; sync feed keeps it)",
      );
    } else {
      removeIfExists(join(outputDir, "packages/server/src/ws"));
      modifications.push("removed: ws/ (WebSocket not selected)");
    }
    // Deleting ws/ alone leaves `index.ts` importing ./ws/handler.js —
    // a hard TS2307 on the first `pnpm run build`. Strip the call sites too.
    stripWebSocketFromServerIndex(outputDir);
    // …and the Redis service that exists only to back the room socket.
    // Leaving it declared made the server wait on a container nothing
    // talks to, and contradicted infra.ts, which derives `redisEnabled`
    // from this same feature. Only the `static` prune removed it, so
    // every other scaffold without `websocket` shipped it.
    for (const rel of ["docker-compose.yml", "docker-compose.dev.yml"]) {
      const composePath = join(outputDir, rel);
      if (existsSync(composePath)) rewriteFile(composePath, stripRedisFromCompose);
    }
    modifications.push("removed: the redis compose service (WebSocket not selected)");
  }
  if (!config.features.includes("stripe")) {
    removeIfExists(join(outputDir, "packages/server/src/services/stripe.ts"));
    // Same class of bug as ws/: `app.ts` (webhook mount) and `index.ts`
    // (startup warning) both import ./services/stripe.js unconditionally.
    stripStripeFromServer(outputDir);
    modifications.push("removed: stripe service (Stripe not selected)");
  }

  // client-core adds a workspace PACKAGE (packages/core) that three other
  // manifests reference, so the strip has to take the references with it —
  // a dangling `workspace:*` fails the very first `pnpm install` with
  // ERR_PNPM_WORKSPACE_PKG_NOT_FOUND, before anything is compiled. It also
  // removes the marked handshake blocks from the files the starter always
  // ships (see features/client-core/markers.ts).
  if (!config.features.includes("client-core")) {
    const { stripClientCore } = await import("../features/client-core/index.js");
    modifications.push(...stripClientCore(outputDir));
  } else {
    // Selected: put the project's own names into the kit's storage keys and the
    // handshake's headers. They are literals in the starter rather than `{{…}}`
    // tokens — a brace in an HTTP header name makes `new Headers()` throw, and
    // the starter has to be runnable before it is ever scaffolded — so they get
    // their own rename pass. See features/client-core/rename.ts.
    const { renameClientCoreIdentifiers } = await import("../features/client-core/index.js");
    modifications.push(...renameClientCoreIdentifiers(outputDir, identifiers));
  }

  const wantsDesktop = config.features.includes("desktop");
  const wantsMobile = config.features.includes("mobile");

  // Port assignment — tested-free via isPortFree + persisted into the
  // CLI registry so subsequent scaffolds can't collide.
  const ports = await pickProjectPorts(getUsedPorts(), {
    nativeHmr: wantsDesktop || wantsMobile,
  });
  const claimed = [ports.server, ports.client, ports.nativeHmr].filter(
    (p): p is number => p !== undefined,
  );
  addUsedPorts(claimed);
  reservedPorts.push(...claimed);
  applyPorts(outputDir, ports, { wantsDesktop, wantsMobile });
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
    // Every path the feature owns, from scaffold/desktop.ts — the same list
    // `hatchkit update` copies in, so the strip and the add cannot disagree.
    for (const rel of DESKTOP_FILES) removeIfExists(join(outputDir, rel));
    // build/icon.png is the icon source `icons:desktop` reads; Electron is the
    // only wrapper that uses it.
    removeIfExists(join(outputDir, "build"));
    stripPackageJsonScripts(outputDir, [...DESKTOP_SCRIPTS_TO_STRIP]);
    unchainTypecheckScript(outputDir);
    // `test:unit` chains the two desktop suites, which have just been deleted.
    // `pnpm run test:electron` against a script that no longer exists exits
    // non-zero, so leaving the chain turns `pnpm test` red on a project that
    // has no desktop at all.
    for (const segment of ["test:electron", "test:desktop:release"]) {
      unchainScriptSegment(outputDir, "test:unit", segment);
    }
    stripPackageJsonBuildBlock(outputDir);
    stripPackageJsonDeps(outputDir, [...DESKTOP_DEV_DEPS]);
    modifications.push("removed: desktop (Electron) scaffolding");
  } else {
    rewriteFile(join(outputDir, "package.json"), (c) => substituteIdentifierTokens(c, identifiers));
    // The shell itself carries the frozen names in a dozen files — the profile
    // directory, the env-var prefix, the bundle id, the client header. A token
    // that survives into a generated project is not cosmetic: `{{envPrefix}}`
    // becomes an environment variable name no shell can set, so the headless
    // contract never engages and a test run opens windows on the person's
    // screen.
    substituteDesktopFiles(outputDir, identifiers);
    const origin = `${identifiers.desktopOrigin.scheme}://${identifiers.desktopOrigin.host}`;
    modifications.push(
      `desktop: origin ${origin}, profile "${identifiers.slug}", env ${identifiers.envPrefix}_* (permanent once released)`,
    );
  }

  // Mobile (Capacitor) strip / substitute
  if (!wantsMobile) {
    for (const rel of MOBILE_PATHS) removeIfExists(join(outputDir, rel));
    stripMobileBridgeFromLayout(outputDir);
    // globals.css imports native.css + standalone.css, and both ship with
    // the feature. Left behind, the very first `next build` fails on a
    // missing module.
    stripNativeStylesFromGlobals(outputDir);
    stripPackageJsonScripts(outputDir, [...MOBILE_SCRIPTS]);
    stripPackageJsonDeps(outputDir, [...MOBILE_DEPS]);
    modifications.push("removed: mobile (Capacitor) scaffolding");
  } else {
    rewriteFile(join(outputDir, "capacitor.config.ts"), (c) =>
      substituteIdentifierTokens(c, identifiers),
    );
    // The client runtime's storage keys. Same reasoning as the client-core pass
    // above — they are `"starter.…"` literals rather than `{{storagePrefix}}`
    // tokens so the starter runs unscaffolded — but they need their own call:
    // mobile can be selected without client-core, and these files are not on
    // client-core's path list.
    const { renameStarterIdentifiersAcross } = await import("../features/client-core/index.js");
    const renamed = renameStarterIdentifiersAcross(
      outputDir,
      identifiers,
      MOBILE_IDENTIFIER_RENAME_PATHS,
    );
    if (renamed > 0) {
      modifications.push(
        `mobile: project identifiers written into ${renamed} file(s) (storage keys)`,
      );
    }
  }

  if (wantsDesktop || wantsMobile) {
    flipNextConfigToStaticExport(outputDir, { wantsMobile });
    modifications.push("next.config.ts: output 'standalone' → 'export'");
  }

  // Workspaces — tenants, members, roles and invitations.
  //
  // Purely ADDITIVE, so this is an `if selected -> write` rather than
  // the `if !selected -> remove` shape every feature above uses:
  // nothing in the starter imports it, so an unselected project has
  // nothing to strip and cannot be left with a dangling import.
  //
  // It runs through the feature contract's ledger, which is the same
  // path `hatchkit update` takes, so create and update produce
  // byte-identical files.
  if (config.features.includes("workspaces")) {
    const { FeatureLedger, applyFeatures } = await import("../features/contract.js");
    await import("../features/workspaces/index.js");
    const ledger = new FeatureLedger(outputDir, false);
    await applyFeatures(["workspaces"], {
      projectDir: outputDir,
      manifestDir: outputDir,
      manifest: toManifest({ ...config, identifiers }, ports, getCliVersion()),
      identifiers,
      mode: "create",
      ledger,
      log: (message) => modifications.push(message.trim()),
    });
    const summary = ledger.summary();
    modifications.push(
      `workspaces: ${summary.written.length} file(s) written, ${summary.unchanged.length} unchanged`,
    );
    for (const conflict of ledger.conflicts()) {
      modifications.push(`workspaces conflict: ${conflict.file} — ${conflict.detail ?? ""}`);
    }
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

  // E2E local S3: only projects with code that talks to S3 get the
  // SeaweedFS container (CI step, start-server.sh, playwright env).
  applyE2eS3Gate(outputDir, config, modifications);

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

  // Server platform features. These are the only additive features —
  // nothing of theirs ships in `starter/`, so there is nothing to strip
  // and the writer that runs here is byte-for-byte the one
  // `hatchkit update` runs later. Placed after the prune so a `static`
  // surface (no server package) makes every one of them report
  // `skipped` rather than writing into a directory the prune removed,
  // and before applyClaudeMd so the generated agent memory describes
  // the files that are actually on disk.
  const serverFeatures = config.features.filter(isServerFeature);
  if (serverFeatures.length > 0) {
    const results = applyServerFeatures(serverFeatures, {
      projectDir: outputDir,
      projectName: config.name,
    });
    printServerFeatureResults(results);
    for (const result of results) {
      modifications.push(
        result.skipped
          ? `${result.id}: skipped (${result.skipped})`
          : `${result.id}: ${result.written.length} file(s) written`,
      );
    }
  }

  // i18n. Runs AFTER the prune so the generator sees the surfaces this
  // project actually kept (no packages/server means no per-document
  // catalogs), and BEFORE applyClaudeMd so the agent memory it prunes
  // describes a project that already has the i18n tree on disk.
  //
  // Unlike every feature above, this one ADDS: the starter is
  // single-language, so there is nothing to strip and the generator
  // writes its own files plus a handful of idempotent edits to files the
  // starter ships (root layout, globals.css, the profile schema/model/
  // router, the shared barrel).
  if (config.features.includes("i18n")) {
    await applyI18n(config, outputDir, modifications);
  }

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

  // Account security. Applied here rather than as a strip, because the
  // starter's better-auth instance registers no plugins at all — there is
  // nothing to remove, only things to add. Same entrypoint `hatchkit
  // update` uses, so a project that takes it now and a project that takes
  // it in six months end up with the same files.
  let authSecurityOptions: string[] | undefined;
  if (config.features.includes("auth-account-security")) {
    const { AUTH_SECURITY_DEFAULT_OPTIONS, applyAuthAccountSecurity } = await import(
      "../features/auth-account-security/index.js"
    );
    const audit = await applyAuthAccountSecurity({
      projectDir: outputDir,
      // The frozen identifier set, never a name derived here: this ends up
      // as the TOTP issuer, which is the label an authenticator app shows
      // forever after somebody enrols.
      projectName: identifiers.productName,
      options: config.authSecurityOptions ?? [...AUTH_SECURITY_DEFAULT_OPTIONS],
      hasNativeClient: wantsDesktop || wantsMobile,
      hasEmailTransport:
        config.email?.transactional === "listmonk-ses" ||
        config.email?.mailingList === "listmonk-ses",
      domain: config.domain,
    });
    authSecurityOptions = audit.options;
    modifications.push(`account security: ${audit.options.join(", ")}`);
    for (const warning of audit.warnings) modifications.push(`account security: ${warning}`);
  }

  const manifest = toManifest({ ...config, identifiers }, ports, getCliVersion());
  writeManifest(
    manifestDir,
    authSecurityOptions
      ? { ...manifest, authSecurity: { options: authSecurityOptions } }
      : manifest,
  );
  modifications.push(".hatchkit.json (project manifest)");

  // Features whose files are NOT in the starter have to be applied here.
  // `create` works by copying the starter and subtracting, which covers
  // every feature that ships source; `release` ships none — it generates
  // a picture of the surfaces this project ended up with, which cannot
  // exist in a template because it depends on the answers given above.
  //
  // It runs last on purpose: by this point the strip phase has settled
  // which surfaces are really present, so what it derives matches the
  // tree that was actually written.
  // The extension ships no starter source either — it is a whole
  // package, off by default, so there would be nothing to subtract from
  // a project that did not ask for it. It runs BEFORE `release`, whose
  // channel derivation asks the disk whether
  // `packages/extension/manifest.config.ts` exists.
  if (config.features.includes("extension")) {
    const problem = extensionPrerequisiteProblem(config.surfaces);
    if (problem !== null) {
      // Reported, never silently dropped: a project that asked for the
      // extension and got none would only find out at release time.
      console.log(chalk.yellow(`\n  Skipping the browser extension. ${problem}`));
      modifications.push(`skipped: browser extension (${config.surfaces} surface)`);
    } else {
      const { FeatureLedger } = await import("../features/contract.js");
      const { extensionFeature } = await import("../features/extension/index.js");
      const ledger = new FeatureLedger(outputDir, false);
      ledger.scopeTo("extension");
      await extensionFeature.apply({
        projectDir: outputDir,
        manifestDir,
        manifest,
        identifiers,
        mode: "create",
        ledger,
        log: (message: string) => console.log(chalk.dim(message)),
      });
      for (const file of ledger.summary().written) modifications.push(file);
      for (const conflict of ledger.conflicts()) {
        modifications.push(
          `extension: not applied — ${conflict.file}: ${conflict.detail ?? "conflict"}`,
        );
      }
    }
  }

  if (config.features.includes("release")) {
    const { FeatureLedger } = await import("../features/contract.js");
    const { releaseFeature } = await import("../features/release/index.js");
    const ledger = new FeatureLedger(outputDir, false);
    ledger.scopeTo("release");
    await releaseFeature.apply({
      projectDir: outputDir,
      manifestDir,
      manifest,
      identifiers,
      mode: "create",
      ledger,
      log: () => {},
    });
    for (const file of ledger.summary().written) modifications.push(file);
    for (const conflict of ledger.conflicts()) {
      modifications.push(
        `release: not applied — ${conflict.file}: ${conflict.detail ?? "conflict"}`,
      );
    }
  }

  // Read every identifier copy back off disk and check it agrees with
  // the manifest. The bundle id and the launcher label each live in up
  // to four files; a strip or a rewrite that misses one produces a
  // project that builds and then fails at store-upload time with a
  // message that does not name the file. Reported, not thrown: the
  // scaffold is already on disk and a warning the user can act on beats
  // rolling back a working tree.
  const agreement = collectIdentifierMismatches(outputDir, identifiers);
  if (agreement.mismatches.length > 0) {
    for (const line of formatIdentifierMismatches(agreement.mismatches)) {
      modifications.push(`identifier mismatch: ${line}`);
    }
  }

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

/** Generate the i18n tree during `hatchkit create`.
 *
 *  Headless by construction: a spinner owns the terminal for the whole
 *  of `runScaffoldSteps`, so every answer is supplied as a preset and
 *  nothing here may prompt. The language pair is the worked example the
 *  templates ship (source English, target German) — the target catalogs
 *  contain real German, so any other pair would land German strings
 *  under the wrong language code. Re-run `hatchkit add i18n` in the
 *  project to pick a different set; it is idempotent and additive.
 *
 *  Never throws: a create that already wrote 60 files must not roll the
 *  whole scaffold back over a language. A refusal is recorded as a
 *  modification note and the project ships single-language. */
async function applyI18n(
  config: ProjectConfig,
  outputDir: string,
  modifications: string[],
): Promise<void> {
  // The `backend` surface has no packages/client, and every surface the
  // feature localises (the store, the pre-paint gate, the public pages)
  // lives there. Recorded rather than silent: the user ticked a box.
  if (!surfaceHasClient(config.surfaces)) {
    modifications.push(
      `i18n: skipped — surface \`${config.surfaces}\` has no client package to localise`,
    );
    return;
  }
  try {
    const { DEFAULT_NAMESPACES, runI18nSetup } = await import("../features/i18n/index.js");
    const audit = await runI18nSetup({
      projectDir: outputDir,
      mode: "create",
      presets: {
        sourceLocale: "en",
        targetLocales: ["de"],
        namespaces: [...DEFAULT_NAMESPACES],
        gateFailsafeMs: 4000,
        publicPages: true,
        // Per-document catalogs (email, PDFs) need a server to issue
        // the document in the first place.
        serverCatalogs: surfaceHasServer(config.surfaces),
        pseudoLocale: true,
        confirm: true,
      },
    });
    if (!audit.ok) {
      modifications.push("i18n: generator declined — project ships single-language");
      return;
    }
    modifications.push(
      `i18n: en → de (${audit.written.length} files written, ${audit.rewritten.length} existing files edited)`,
    );
    for (const note of audit.manualResidue) modifications.push(`i18n (manual): ${note}`);
  } catch (err) {
    modifications.push(`i18n: skipped — ${(err as Error).message}`);
  }
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
  if (!config.features.includes("mobile")) actions.push("Remove mobile (Capacitor) scaffolding");
  // docs/feature-authoring.md says not to add to this list and to use the
  // ledger instead. It cannot serve here: a create-time dry run returns before
  // the starter is copied, so there is no tree for a ledger to record against
  // and nothing would mention the feature at all. The `update` path, where a
  // tree exists, does go through the ledger.
  if (!config.features.includes("client-core")) {
    actions.push("Remove client-core (shared client kit + version handshake)");
  }
  // The only ADD in this list — the starter is single-language, so the
  // dry-run cannot describe it as a strip.
  if (config.features.includes("i18n")) {
    actions.push(
      surfaceHasClient(config.surfaces)
        ? "Generate i18n: en → de catalogs, first-paint gate, per-language public pages"
        : `Skip i18n (surface \`${config.surfaces}\` has no client package)`,
    );
  }
  if (config.features.includes("desktop") || config.features.includes("mobile")) {
    actions.push("Flip next.config.ts to output: 'export' (static)");
  }
  // One line rather than the twelve files the feature writes: this list
  // is the hand-maintained parallel the feature contract warns about, so
  // it says that the feature runs and leaves the file-by-file account to
  // the ledger, which is derived from the real apply.
  if (config.features.includes("extension")) {
    actions.push(
      extensionPrerequisiteProblem(config.surfaces) === null
        ? "Add browser extension (MV3: dev + Chrome + Firefox targets, web-app bridge, release workflow)"
        : `Skip browser extension (${config.surfaces} surface)`,
    );
  }
  if (config.features.includes("release")) {
    actions.push(
      "Apply release coordination (release config, scripts, summary + compat workflows, docs)",
    );
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
