/*
 * cli/src/features/extension/index.ts — the `extension` feature.
 *
 * It adds an MV3 browser extension (three build targets: a development
 * one, a Chrome one and a Firefox one), the bridge that keeps it signed
 * in with the web app, the server-side rule that lets a browser
 * extension's origin be trusted at all, and a release workflow for the
 * two stores.
 *
 * ============================================================
 * WHAT IS OWNED AND WHAT IS SEEDED
 * ============================================================
 *
 * Two kinds of file, and the difference is who edits them next:
 *
 *  - OWNED: the release workflow and the packaging script. hatchkit
 *    regenerates them, they say so in their own headers, and a later
 *    CLI version can change what they do. `writeIfChanged`.
 *  - SEEDED: everything under `packages/**`. It is the project's own
 *    source from the moment it lands — somebody will add a screen to
 *    that popup — so a second `hatchkit update` must not overwrite it.
 *    Written only when absent, and reported as kept otherwise.
 *
 * The files the STARTER ships are edited, never rewritten: the CORS
 * delegate, the health body, better-auth's plugin list, the layout, the
 * auth client. Each edit is a fixed point (it checks for what it
 * produces, not for where it goes), so a re-run changes nothing, and
 * each one reports a `problem` line when its anchor has moved rather
 * than silently doing nothing.
 *
 * ============================================================
 * THE PREREQUISITE
 * ============================================================
 *
 * The extension is the third client of the shared client core the
 * starter ships — `packages/shared` for the protocol both ends decode
 * with, `packages/client` for the page half of the bridge — talking to
 * `packages/server` for the trust decision and the device flow. All
 * three have to exist, which is why `surfaces` is `fullstack` and
 * `split` only and why the two call sites refuse the others with the
 * reason named.
 *
 * `requires: ["client-core"]` is how the kit half of that is stated.
 * It is enforced and ordered, not documentation: selecting the
 * extension pulls `client-core` into the selection and applies it
 * first, so this `apply` can assume `packages/core` is there. The
 * extension binds the kit's storage seam to the two `chrome.storage`
 * areas and throws the kit's `ApiError`, so a second copy of either
 * would be a second class with the same name — an `instanceof` in core
 * answering false for an error the extension threw.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Topology } from "../../deploy/routing.js";
import type { Surface } from "../../prompts.js";
import { clientBuildArgUrls } from "../../scaffold/client-build-args.js";
import type { ProjectIdentifiers } from "../../scaffold/identifiers.js";
import { clientCoreFeature } from "../client-core/index.js";
import { type FeatureContext, registerFeature } from "../contract.js";
import {
  type TemplateTokens,
  identifierTemplateTokens,
  renderFeatureTemplate,
} from "../templates.js";
import {
  CI_ANCHOR,
  CI_BLOCK_BODY,
  CI_BLOCK_ID,
  CI_COMMENT_PREFIX,
  type PatchResult,
  addClientEnvExample,
  addDeviceClientPlugin,
  addSharedBridgeExport,
  mountExtensionBridge,
  wireAuth,
  wireServerApp,
} from "./patches.js";
import {
  EXTENSION_BRIDGE_VERSION,
  EXTENSION_GECKO_MIN_VERSION,
  EXTENSION_PERMISSIONS,
} from "./types.js";

export * from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Only used to assert the template directory exists in tests; the
 *  renderer resolves its own path. */
export const EXTENSION_TEMPLATE_DIR = join(__dirname, "..", "..", "templates", "extension");

/** The feature's own template directory name under `cli/src/templates/`. */
const TEMPLATES = "extension";

/** What the feature needs, in the words the CLI shows people. */
export const EXTENSION_PREREQUISITE =
  "the shared client core (packages/shared + packages/client) and a server runtime";

/**
 * Null when `surfaces` can carry the extension, otherwise the sentence
 * to show. Shared by the create flow, the non-interactive validator and
 * `hatchkit update`, so the three cannot answer differently.
 */
export function extensionPrerequisiteProblem(surfaces: Surface): string | null {
  if (surfaces === "static") {
    return "The `extension` feature needs a server runtime: the extension's origin has to be in a server's trust list, and its sign-in is the server's device flow. A `static` project has no server. Pick `fullstack` or `split`.";
  }
  if (surfaces === "backend") {
    return "The `extension` feature needs a web app: the bridge is driven by a page, and a device code is approved on one. A `backend` project ships no client. Pick `fullstack` or `split`.";
  }
  return null;
}

/* ================================================================== */
/* The file set                                                       */
/* ================================================================== */

/** Files hatchkit regenerates. Each says so in its own header. */
const OWNED: ReadonlyArray<readonly [string, string]> = [
  ["workflows/extension-release.yml", ".github/workflows/extension-release.yml"],
  ["scripts/extension-package.mjs", "scripts/extension-package.mjs"],
];

/** Files written once and then the project's own. */
const SEEDED: ReadonlyArray<readonly [string, string]> = [
  // The protocol both ends decode with.
  ["shared/extension-bridge.ts", "packages/shared/src/extension-bridge.ts"],

  // The server's half: who may be trusted, and how that is answered.
  ["server/extension-origins.ts", "packages/server/src/auth/extension-origins.ts"],
  ["server/extension-origins.test.ts", "packages/server/src/tests/extension-origins.test.ts"],

  // The web app's half.
  ["client/extension-bridge.ts", "packages/client/src/lib/extension-bridge.ts"],
  ["client/extension-bridge-transport.ts", "packages/client/src/lib/extension-bridge-transport.ts"],
  ["client/device-approve.ts", "packages/client/src/lib/device-approve.ts"],
  ["client/ExtensionBridge.tsx", "packages/client/src/components/ExtensionBridge.tsx"],
  ["client/device-page.tsx", "packages/client/src/app/device/page.tsx"],

  // The extension itself.
  ["extension/package.json", "packages/extension/package.json"],
  ["extension/tsconfig.json", "packages/extension/tsconfig.json"],
  ["extension/vite.config.ts", "packages/extension/vite.config.ts"],
  ["extension/vitest.config.ts", "packages/extension/vitest.config.ts"],
  ["extension/manifest.config.ts", "packages/extension/manifest.config.ts"],
  ["extension/store.config.json", "packages/extension/store.config.json"],
  ["extension/README.md", "packages/extension/README.md"],
  ["extension/public/.gitkeep", "packages/extension/public/.gitkeep"],
  ["extension/src/manifest.test.ts", "packages/extension/src/manifest.test.ts"],
  ["extension/src/lib/chrome-storage.ts", "packages/extension/src/lib/chrome-storage.ts"],
  ["extension/src/lib/config.ts", "packages/extension/src/lib/config.ts"],
  ["extension/src/lib/api.ts", "packages/extension/src/lib/api.ts"],
  ["extension/src/lib/session.ts", "packages/extension/src/lib/session.ts"],
  ["extension/src/lib/device-auth-store.ts", "packages/extension/src/lib/device-auth-store.ts"],
  ["extension/src/lib/sign-out-marker.ts", "packages/extension/src/lib/sign-out-marker.ts"],
  [
    "extension/src/lib/sign-out-marker.test.ts",
    "packages/extension/src/lib/sign-out-marker.test.ts",
  ],
  ["extension/src/background/index.ts", "packages/extension/src/background/index.ts"],
  ["extension/src/background/runtime.ts", "packages/extension/src/background/runtime.ts"],
  [
    "extension/src/background/device-sign-in.ts",
    "packages/extension/src/background/device-sign-in.ts",
  ],
  ["extension/src/background/bridge.ts", "packages/extension/src/background/bridge.ts"],
  ["extension/src/background/bridge.test.ts", "packages/extension/src/background/bridge.test.ts"],
  ["extension/src/popup/index.html", "packages/extension/src/popup/index.html"],
  ["extension/src/popup/main.ts", "packages/extension/src/popup/main.ts"],
];

/** The root scripts the feature adds. Merged add-only, so a script a
 *  project has customised is reported rather than reverted. */
export const EXTENSION_SCRIPTS: Record<string, string> = {
  "build:extension": "pnpm --filter @starter/extension run build",
  "build:extension:prod": "pnpm --filter @starter/extension run build:prod",
  "build:extension:firefox": "pnpm --filter @starter/extension run build:firefox",
  "test:extension": "pnpm --filter @starter/extension run test",
  // Prints the `chrome-extension://<id>` origin a build gets — the
  // value that has to be in the server's TRUSTED_ORIGINS before the
  // extension can make a single request.
  "extension:id": "node scripts/extension-package.mjs id",
};

/* ================================================================== */
/* Tokens                                                             */
/* ================================================================== */

export interface ExtensionUrlFacts {
  /** The project's public domain, from the manifest. */
  domain: string;
  topology: Topology;
  /** The dev server's API port, for the development target's default. */
  serverPort: number;
  nodeVersion?: string;
}

/**
 * The tokens every extension template renders with.
 *
 * The identifier tokens come from the frozen set — this feature derives
 * no name of its own. The Firefox add-on id is composed IN THE TEMPLATE
 * from two of them (`token@orgDomain`), because AMO takes an
 * email-shaped id and the reverse-DNS bundle id is not one; composing
 * it in a template rather than here keeps the value visible in the
 * generated source instead of hidden in a CLI rule.
 *
 * The three URLs come out of `clientBuildArgUrls`, the same function
 * the client's build args come from, so the origin a build BAKES IN and
 * the origin the web app is BUILT against cannot disagree.
 */
export function extensionTokens(
  identifiers: ProjectIdentifiers,
  facts: ExtensionUrlFacts,
): TemplateTokens {
  const { apiUrl } = clientBuildArgUrls(facts.domain, facts.topology);
  return {
    ...identifierTemplateTokens(identifiers),
    DOMAIN: facts.domain,
    API_URL_DEV: `http://localhost:${facts.serverPort}`,
    API_URL_PROD: apiUrl,
    WEB_ORIGIN_PROD: `https://${facts.domain}`,
    DEVICE_CLIENT_ID: identifiers.clientIds.extension,
    PERMISSIONS_JSON: JSON.stringify(EXTENSION_PERMISSIONS),
    GECKO_MIN_VERSION: EXTENSION_GECKO_MIN_VERSION,
    BRIDGE_VERSION: String(EXTENSION_BRIDGE_VERSION),
    NODE_VERSION: facts.nodeVersion ?? "24",
  };
}

/** The URL facts a manifest carries. */
export function urlFactsFrom(manifest: {
  domain: string;
  topology?: Topology;
  ports: { server: number };
}): ExtensionUrlFacts {
  return {
    domain: manifest.domain,
    topology: manifest.topology ?? "single-origin",
    serverPort: manifest.ports.server,
  };
}

/* ================================================================== */
/* The feature                                                        */
/* ================================================================== */

export const extensionFeature = registerFeature({
  id: "extension",
  title: "Browser extension",
  summary:
    "An MV3 extension for Chrome and Firefox, kept signed in with the web app, with a two-store release workflow.",
  // The client kit: the storage seam this binds to `chrome.storage`,
  // and the `ApiError` its requests throw. Referenced through the
  // definition rather than by string, so importing this feature
  // registers the one it needs — an id the registry has never seen
  // reads as "unknown feature", not as a prerequisite.
  requires: [clientCoreFeature.id],
  // The bridge is driven by a page and the device code is approved on
  // one, so a surface with no client cannot carry it; the origin trust
  // and the device flow are a server's, so neither can a static one.
  surfaces: ["fullstack", "split"],
  // Everything it writes is its own or a fixed-point edit, so `update`
  // can add it to a project that has been running for months.
  addableAfterScaffold: true,
  apply(ctx: FeatureContext): void {
    const tokens = extensionTokens(ctx.identifiers, urlFactsFrom(ctx.manifest));
    const { ledger, log } = ctx;

    for (const [template, target] of OWNED) {
      ledger.writeIfChanged(target, renderFeatureTemplate(TEMPLATES, template, tokens));
    }

    const kept: string[] = [];
    for (const [template, target] of SEEDED) {
      if (ledger.exists(target)) {
        // The project's own source from the moment it landed. Reported,
        // not overwritten, and not counted as unchanged either — it may
        // differ wildly from what this CLI version would write.
        kept.push(target);
        continue;
      }
      ledger.writeIfChanged(target, renderFeatureTemplate(TEMPLATES, template, tokens));
    }
    if (kept.length > 0) {
      log(`  Extension: kept ${kept.length} existing file(s) — they are yours now.`);
    }

    // The starter's own files: edited, never rewritten.
    const problems: string[] = [];
    const patch = (target: string, fn: (content: string) => PatchResult): void => {
      const before = ledger.read(target);
      if (before === undefined) {
        problems.push(`${target} is missing: wire the extension bridge into it by hand.`);
        return;
      }
      const result = fn(before);
      if (result.problem !== undefined) problems.push(result.problem);
      // `result.content` is already the fixed point, so this reports
      // `unchanged` on every later run.
      ledger.edit(target, () => renderTokens(result.content, tokens));
    };

    // `packages/server/src/config/env.ts` and `packages/server/.env.example`
    // are deliberately absent: the starter ships TRUST_EXTENSION_ORIGINS and
    // its resolver, and the patches below read `trustsExtensionOrigins()`.
    patch("packages/shared/src/index.ts", addSharedBridgeExport);
    patch("packages/server/src/app.ts", wireServerApp);
    patch("packages/server/src/auth/auth.ts", wireAuth);
    patch("packages/client/src/app/layout.tsx", mountExtensionBridge);
    patch("packages/client/src/lib/auth-client.ts", addDeviceClientPlugin);
    patch("packages/client/.env.example", addClientEnvExample);

    // CI: a managed block, because this file is one a project edits.
    ledger.ensureManagedBlock(
      ".github/workflows/build-and-deploy.yml",
      CI_BLOCK_ID,
      CI_BLOCK_BODY,
      {
        anchor: CI_ANCHOR,
        commentPrefix: CI_COMMENT_PREFIX,
      },
    );

    ledger.mergePackageJson("package.json", { scripts: EXTENSION_SCRIPTS });

    for (const line of problems) log(`  ${line}`);
  },
});

/** Render the `__HATCHKIT_*__` tokens a patch body carries. The patch
 *  bodies are templates too — they name the project's slug, its client
 *  id and its client header — so they go through the same pass. */
function renderTokens(content: string, tokens: TemplateTokens): string {
  let out = content;
  for (const [name, value] of Object.entries(tokens)) {
    if (value === undefined) continue;
    out = out.split(`__HATCHKIT_${name}__`).join(value);
  }
  return out;
}

/** Things only a person can do, for a caller to print after a run. */
export function extensionResidue(): string[] {
  return [
    "The extension's origin has to be in the server's TRUSTED_ORIGINS before it can make a single request: `pnpm run extension:id` prints it.",
    "The Firefox build's origin is a fresh random UUID per install, which no list can hold — that one needs TRUST_EXTENSION_ORIGINS=true on the server.",
    "NEXT_PUBLIC_EXTENSION_IDS in the web app's build env is what lets the page message the extension; empty means the bridge does nothing.",
  ];
}
