/**
 * Env agreement — the default API origin, and where production
 * environment actually lives.
 *
 * Two failures, both of which shipped green and surfaced days later
 * somewhere else (tracktime, 2026-09):
 *
 *  1. A project moved its API to its own host. The server's base URL and
 *     the client build arg were updated; the mobile release workflow and
 *     the extension manifest were not. The framework inlines the client's
 *     API URL at IMAGE BUILD time, so a wrong value builds perfectly,
 *     starts healthy, and calls a host that does not answer — and runtime
 *     environment on the container cannot fix it, only a rebuild can.
 *     A store binary is worse again: the wrong default sits in the store
 *     until a new review.
 *
 *  2. Production values were set in an encrypted `.env.production` that
 *     is untracked and that the runtime stage never copies. The deploy
 *     went green and the server kept its old values, with nothing in the
 *     diff to point at. The mirror image: a variable set on the platform
 *     against a compose file that never writes `${VAR}` reaches no
 *     container, because those fields are interpolation variables for the
 *     compose file.
 *
 * The properties these pin down:
 *   1. The expected origin is DERIVED from the manifest, never taken from
 *      one of the sites — otherwise a wrong server value reads as
 *      agreement, and single-origin vs split must produce different
 *      expectations.
 *   2. `absent` (this project has no such surface) and `missing` (it has
 *      one and sets no origin) are different answers, and only the second
 *      is a failure.
 *   3. A value that could not be read is reported and does not silently
 *      pass as agreement — nor does it turn a doctor run without platform
 *      credentials into a red.
 *   4. A disagreement is reported as its symptom, not as two strings.
 *   5. An encrypted env file that never reaches the image is flagged; one
 *      that does is not; a private key with nothing to open is flagged.
 *   6. A platform variable no compose file names is flagged, and a compose
 *      `${VAR}` nobody sets is flagged — while one with a default is not,
 *      and a `${VAR}` inside a comment is not.
 *   7. The generated document is derived from ORIGIN_SITES: adding a site
 *      to the list changes the document.
 *   8. A native release workflow that deliberately carries no literal is
 *      `enforced`, not `missing`. Both starter workflows refuse to build
 *      against an origin nobody set — the mobile one because its plan
 *      job fails on an empty secret, the desktop one because its
 *      fallback is a reserved `.invalid` host that cannot resolve — and
 *      colouring a refusal red trains people to ignore the check. What
 *      is still caught is a literal naming the WRONG host.
 *   9. The starter's committed workflows keep the shapes that make (8)
 *      true, so a scaffolded project reports no findings and the step a
 *      person still owes arrives as a note.
 *  10. The two ledger invariants: a second apply writes nothing, and a
 *      dry run leaves the disk untouched while reporting `would-write`.
 *
 * Run: `pnpm exec tsx test-env-agreement.ts`
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FeatureLedger } from "./src/features/contract.js";
import {
  ENV_SOURCES_DOC_REL_PATH,
  NATIVE_API_URL_KEY,
  ORIGIN_SITES,
  applyEnvAgreement,
  checkApiOriginAgreement,
  checkRuntimeEnvSource,
  collectComposeVariables,
  extractOriginLiteral,
  isTripwireOrigin,
  projectFileReader,
  renderApiOriginAgreement,
  renderEnvSourcesDoc,
  renderRuntimeEnvSource,
} from "./src/features/env-agreement/index.js";
import type {
  OriginSite,
  ProjectFileReader,
  SiteResult,
} from "./src/features/env-agreement/index.js";
import type { OperationalContext, OperationalProject } from "./src/features/operational-context.js";

const failures: string[] = [];

function check(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`  ✗ ${label}: ${(err as Error).message}`);
    console.log(`  ✗ ${label}`);
  }
}

// ── fixtures ───────────────────────────────────────────────────────────

function project(overrides: Partial<OperationalProject> = {}): OperationalProject {
  return {
    name: "demo",
    domain: "demo.example",
    topology: "split",
    surfaces: "fullstack",
    features: ["mobile"],
    ...overrides,
  };
}

/** A context rooted at a real directory, with a real ledger — the same
 *  object the CLI hands the module, so the invariants the ledger
 *  guarantees are exercised here rather than simulated. */
function context(
  projectDir: string,
  overrides: Partial<OperationalProject> = {},
  opts: { ledger?: FeatureLedger; force?: boolean } = {},
): OperationalContext {
  return {
    projectDir,
    project: project(overrides),
    mode: "update",
    ledger: opts.ledger ?? new FeatureLedger(projectDir, false),
    log: () => undefined,
    force: opts.force,
  };
}

/** Paths the ledger recorded under one action. */
function filesWith(ledger: FeatureLedger, action: string): string[] {
  return ledger.entries.filter((e) => e.action === action).map((e) => e.file);
}

/** A reader over an in-memory project. Unlisted paths do not exist;
 *  a path mapped to the UNREADABLE sentinel throws, which is how a file
 *  that IS there and cannot be opened is expressed. */
const UNREADABLE = Symbol("unreadable");
function reader(files: Record<string, string | typeof UNREADABLE>): ProjectFileReader {
  return (relPath) => {
    const entry = files[relPath];
    if (entry === undefined) return null;
    if (entry === UNREADABLE) throw new Error("EACCES");
    return entry;
  };
}

function deployWorkflow(apiUrl: string, probeUrl = apiUrl): string {
  return [
    "jobs:",
    "  build-client:",
    "    steps:",
    "      - uses: docker/build-push-action@v6",
    "        with:",
    "          file: packages/client/Dockerfile",
    "          push: true",
    "          build-args: |",
    `            NEXT_PUBLIC_API_URL=${apiUrl}`,
    `            NEXT_PUBLIC_WS_URL=wss://api.demo.example`,
    "  verify:",
    "    env:",
    `      HATCHKIT_API_URL: ${probeUrl}`,
    "",
  ].join("\n");
}

function mobileWorkflow(apiUrl: string): string {
  return [
    "env:",
    `  NEXT_PUBLIC_API_URL: \${{ vars.NEXT_PUBLIC_API_URL || '${apiUrl}' }}`,
    "",
  ].join("\n");
}

function siteById(sites: SiteResult[], id: string): SiteResult {
  const found = sites.find((s) => s.id === id);
  assert.ok(found, `no site result for ${id}`);
  return found;
}

// ── Part 1: the API-origin agreement ───────────────────────────────────

console.log("\nAPI origin agreement\n");

check("every place carrying the same origin agrees", () => {
  const result = checkApiOriginAgreement({
    project: project(),
    platformEnv: { BETTER_AUTH_URL: "https://api.demo.example" },
    readFile: reader({
      ".github/workflows/build-and-deploy.yml": deployWorkflow("https://api.demo.example"),
      ".github/workflows/mobile-release.yml": mobileWorkflow("https://api.demo.example"),
    }),
  });
  assert.equal(result.expected, "https://api.demo.example");
  assert.equal(result.ok, true, JSON.stringify(result.sites));
  assert.equal(siteById(result.sites, "server-base-url").status, "agrees");
  assert.equal(siteById(result.sites, "client-build-arg").status, "agrees");
  assert.equal(siteById(result.sites, "mobile-release").status, "agrees");
});

check("a build arg pointing elsewhere differs, and the report names the symptom", () => {
  const result = checkApiOriginAgreement({
    project: project(),
    platformEnv: { BETTER_AUTH_URL: "https://api.demo.example" },
    readFile: reader({
      // The pre-move value: still a real host, still builds green.
      ".github/workflows/build-and-deploy.yml": deployWorkflow("https://demo.example"),
      ".github/workflows/mobile-release.yml": mobileWorkflow("https://api.demo.example"),
    }),
  });
  assert.equal(result.ok, false);
  const site = siteById(result.sites, "client-build-arg");
  assert.equal(site.status, "differs");
  assert.equal(site.found, "https://demo.example");

  const report = renderApiOriginAgreement(result).join("\n");
  assert.match(report, /image build time/);
  assert.match(report, /dead API/);
  assert.match(report, /rebuilding the image/);
  // The two values still appear — the symptom explains, it does not hide.
  assert.match(report, /https:\/\/demo\.example/);
});

check("a stale native default differs while the web half agrees", () => {
  const result = checkApiOriginAgreement({
    project: project(),
    platformEnv: { BETTER_AUTH_URL: "https://api.demo.example" },
    readFile: reader({
      ".github/workflows/build-and-deploy.yml": deployWorkflow("https://api.demo.example"),
      ".github/workflows/mobile-release.yml": mobileWorkflow("https://api.old-host.example"),
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(siteById(result.sites, "client-build-arg").status, "agrees");
  const mobile = siteById(result.sites, "mobile-release");
  assert.equal(mobile.status, "differs");
  assert.equal(mobile.found, "https://api.old-host.example");
  assert.match(renderApiOriginAgreement(result).join("\n"), /store binary/);
});

check("a project with no mobile surface reports that site absent, not missing", () => {
  const result = checkApiOriginAgreement({
    project: project({ features: [] }),
    platformEnv: { BETTER_AUTH_URL: "https://api.demo.example" },
    readFile: reader({
      ".github/workflows/build-and-deploy.yml": deployWorkflow("https://api.demo.example"),
    }),
  });
  assert.equal(siteById(result.sites, "mobile-release").status, "absent");
  assert.equal(result.ok, true);
  // An absent surface is not worth a line in the report either.
  assert.doesNotMatch(renderApiOriginAgreement(result).join("\n"), /mobile release/);
});

check("a mobile project whose release workflow is gone reports it missing", () => {
  const result = checkApiOriginAgreement({
    project: project(),
    platformEnv: { BETTER_AUTH_URL: "https://api.demo.example" },
    readFile: reader({
      ".github/workflows/build-and-deploy.yml": deployWorkflow("https://api.demo.example"),
    }),
  });
  assert.equal(siteById(result.sites, "mobile-release").status, "missing");
  assert.equal(result.ok, false);
});

check("a build arg that defers entirely to a CI secret is missing, not agreeing", () => {
  const workflow = deployWorkflow("${{ vars.NEXT_PUBLIC_API_URL }}");
  const result = checkApiOriginAgreement({
    project: project({ features: [] }),
    platformEnv: { BETTER_AUTH_URL: "https://api.demo.example" },
    readFile: reader({ ".github/workflows/build-and-deploy.yml": workflow }),
  });
  const site = siteById(result.sites, "client-build-arg");
  assert.equal(site.status, "missing");
  assert.equal(site.found, undefined);
  assert.equal(result.ok, false);
});

check("single-origin and split expect different origins", () => {
  const single = checkApiOriginAgreement({
    project: project({ topology: "single-origin", features: [] }),
    platformEnv: { BETTER_AUTH_URL: "https://demo.example" },
    readFile: reader({
      ".github/workflows/build-and-deploy.yml": deployWorkflow("https://demo.example"),
    }),
  });
  assert.equal(single.expected, "https://demo.example");
  assert.equal(single.ok, true);

  const split = checkApiOriginAgreement({
    project: project({ topology: "split", features: [] }),
    platformEnv: { BETTER_AUTH_URL: "https://demo.example" },
    readFile: reader({
      ".github/workflows/build-and-deploy.yml": deployWorkflow("https://demo.example"),
    }),
  });
  assert.equal(split.expected, "https://api.demo.example");
  assert.equal(split.ok, false, "the same files cannot be correct for both topologies");
});

check("the expected origin is derived, so a wrong server value is reported too", () => {
  const result = checkApiOriginAgreement({
    project: project({ features: [] }),
    platformEnv: { BETTER_AUTH_URL: "https://api.old-host.example" },
    readFile: reader({
      ".github/workflows/build-and-deploy.yml": deployWorkflow("https://api.old-host.example"),
    }),
  });
  // Everything agrees with everything — and all of it is wrong.
  assert.equal(result.ok, false);
  assert.equal(siteById(result.sites, "server-base-url").status, "differs");
});

check("a mount path on the end is a disagreement, not a normalisation", () => {
  const result = checkApiOriginAgreement({
    project: project({ features: [] }),
    platformEnv: { BETTER_AUTH_URL: "https://api.demo.example" },
    readFile: reader({
      ".github/workflows/build-and-deploy.yml": deployWorkflow("https://api.demo.example/api"),
    }),
  });
  assert.equal(siteById(result.sites, "client-build-arg").status, "differs");
});

check("a trailing slash is not a disagreement", () => {
  const result = checkApiOriginAgreement({
    project: project({ features: [] }),
    platformEnv: { BETTER_AUTH_URL: "https://api.demo.example/" },
    readFile: reader({
      ".github/workflows/build-and-deploy.yml": deployWorkflow("https://api.demo.example"),
    }),
  });
  assert.equal(siteById(result.sites, "server-base-url").status, "agrees");
});

check("platform env that was never fetched is unreadable, and does not fail the run", () => {
  const result = checkApiOriginAgreement({
    project: project({ features: [] }),
    readFile: reader({
      ".github/workflows/build-and-deploy.yml": deployWorkflow("https://api.demo.example"),
    }),
  });
  assert.equal(siteById(result.sites, "server-base-url").status, "unreadable");
  assert.equal(result.ok, true);
  assert.match(renderApiOriginAgreement(result).join("\n"), /could not be read/);
});

check("a file that is there and cannot be opened is unreadable, never agreeing", () => {
  const result = checkApiOriginAgreement({
    project: project({ features: [] }),
    platformEnv: { BETTER_AUTH_URL: "https://api.demo.example" },
    readFile: reader({ ".github/workflows/build-and-deploy.yml": UNREADABLE }),
  });
  assert.equal(siteById(result.sites, "client-build-arg").status, "unreadable");
});

check("a static project has no API origin anywhere", () => {
  const result = checkApiOriginAgreement({
    project: project({ surfaces: "static", features: [] }),
    platformEnv: {},
    readFile: reader({}),
  });
  assert.ok(result.sites.every((s) => s.status === "absent"));
  assert.equal(result.ok, true);
});

check("an extension manifest is only reported once the project has one", () => {
  const without = checkApiOriginAgreement({
    project: project({ features: [] }),
    platformEnv: { BETTER_AUTH_URL: "https://api.demo.example" },
    readFile: reader({}),
  });
  assert.equal(siteById(without.sites, "browser-extension").status, "absent");

  const with_ = checkApiOriginAgreement({
    project: project({ features: [] }),
    platformEnv: { BETTER_AUTH_URL: "https://api.demo.example" },
    readFile: reader({
      "packages/extension/manifest.config.ts": `export default { apiUrl: "https://api.old.example" };`,
    }),
  });
  assert.equal(siteById(with_.sites, "browser-extension").status, "differs");
});

check("origin literals survive quotes, expressions and fallbacks", () => {
  assert.equal(extractOriginLiteral("https://a.example/"), "https://a.example");
  assert.equal(extractOriginLiteral(`"https://a.example"`), "https://a.example");
  assert.equal(extractOriginLiteral("${{ vars.X || 'https://a.example' }}"), "https://a.example");
  assert.equal(extractOriginLiteral("${{ secrets.NEXT_PUBLIC_API_URL }}"), null);
  assert.equal(extractOriginLiteral(""), null);
});

// ── Part 2: where production environment lives ─────────────────────────

console.log("\nRuntime env source\n");

const SERVER_DOCKERFILE_NO_ENV = [
  "FROM node:24-alpine AS build",
  "COPY . .",
  "RUN pnpm --filter @starter/server run build",
  "",
  "FROM node:24-alpine AS runtime",
  "COPY --from=build /app/packages/server/dist ./dist",
  "COPY --from=build /app/packages/server/package.json ./package.json",
  "COPY --from=build /app/node_modules ./node_modules",
  'CMD ["node", "dist/index.js"]',
].join("\n");

const SERVER_DOCKERFILE_WITH_ENV = SERVER_DOCKERFILE_NO_ENV.replace(
  'CMD ["node", "dist/index.js"]',
  [
    "COPY --from=build /app/packages/server/.env.production ./.env.production",
    'CMD ["node", "dist/index.js"]',
  ].join("\n"),
);

const COMPOSE = {
  path: "docker-compose.yml",
  content: [
    "# Coolify auto-detects ${VAR_NAME} syntax and creates a field for each.",
    "services:",
    "  server:",
    "    image: ${SERVER_IMAGE:-ghcr.io/owner/repo-server:main}",
    "    environment:",
    "      BETTER_AUTH_URL: ${BETTER_AUTH_URL}",
    "      FRONTEND_URL: ${FRONTEND_URL}",
    "      TRUST_PROXY_HOPS: ${TRUST_PROXY_HOPS:-2}",
    "",
  ].join("\n"),
};

const ENCRYPTED_ENV = {
  path: "packages/server/.env.production",
  exists: true,
  encrypted: true,
};

check("an encrypted env file the runtime stage never copies is flagged", () => {
  const result = checkRuntimeEnvSource({
    dockerfile: SERVER_DOCKERFILE_NO_ENV,
    gitignore: "",
    composeFiles: [COMPOSE],
    expectedKeys: ["BETTER_AUTH_URL", "FRONTEND_URL"],
    trackedFiles: ["packages/server/.env.production"],
    envFile: ENCRYPTED_ENV,
  });
  const finding = result.findings.find((f) => f.code === "encrypted-env-never-reaches-image");
  assert.ok(finding, JSON.stringify(result.findings));
  assert.match(finding.message, /never COPYs it/);
  assert.match(finding.message, /deploy goes green/);
  assert.equal(result.ok, false);
});

check("an encrypted env file the runtime stage DOES copy is not flagged", () => {
  const result = checkRuntimeEnvSource({
    dockerfile: SERVER_DOCKERFILE_WITH_ENV,
    gitignore: "",
    composeFiles: [COMPOSE],
    expectedKeys: ["BETTER_AUTH_URL", "FRONTEND_URL"],
    trackedFiles: ["packages/server/.env.production"],
    envFile: ENCRYPTED_ENV,
  });
  assert.equal(
    result.findings.filter((f) => f.code === "encrypted-env-never-reaches-image").length,
    0,
    JSON.stringify(result.findings),
  );
});

check("a gitignored env file is flagged even when the Dockerfile would copy it", () => {
  const result = checkRuntimeEnvSource({
    dockerfile: SERVER_DOCKERFILE_WITH_ENV,
    gitignore: "node_modules\n.env.production\n",
    composeFiles: [COMPOSE],
    expectedKeys: ["BETTER_AUTH_URL", "FRONTEND_URL"],
    envFile: ENCRYPTED_ENV,
  });
  const finding = result.findings.find((f) => f.code === "encrypted-env-never-reaches-image");
  assert.ok(finding);
  assert.match(finding.message, /\.gitignore rule excludes it/);
});

check("an untracked env file is flagged", () => {
  const result = checkRuntimeEnvSource({
    dockerfile: SERVER_DOCKERFILE_WITH_ENV,
    gitignore: "",
    composeFiles: [COMPOSE],
    expectedKeys: ["BETTER_AUTH_URL", "FRONTEND_URL"],
    trackedFiles: ["packages/server/package.json"],
    envFile: ENCRYPTED_ENV,
  });
  const finding = result.findings.find((f) => f.code === "encrypted-env-never-reaches-image");
  assert.ok(finding);
  assert.match(finding.message, /git does not track it/);
});

check("a private key with nothing to decrypt is flagged", () => {
  const result = checkRuntimeEnvSource({
    dockerfile: SERVER_DOCKERFILE_NO_ENV,
    gitignore: ".env.production\n",
    composeFiles: [COMPOSE],
    expectedKeys: ["BETTER_AUTH_URL", "FRONTEND_URL"],
    envFile: ENCRYPTED_ENV,
    privateKeyPresent: true,
  });
  const finding = result.findings.find((f) => f.code === "private-key-decrypts-nothing");
  assert.ok(finding, JSON.stringify(result.findings));
  assert.match(finding.message, /decrypts nothing/);
});

check("a private key is not flagged when the ciphertext does reach the image", () => {
  const result = checkRuntimeEnvSource({
    dockerfile: SERVER_DOCKERFILE_WITH_ENV,
    gitignore: "",
    composeFiles: [COMPOSE],
    expectedKeys: ["BETTER_AUTH_URL", "FRONTEND_URL"],
    trackedFiles: ["packages/server/.env.production"],
    envFile: ENCRYPTED_ENV,
    privateKeyPresent: true,
  });
  assert.equal(result.findings.filter((f) => f.code === "private-key-decrypts-nothing").length, 0);
});

check("a platform variable no compose file names is flagged", () => {
  const result = checkRuntimeEnvSource({
    composeFiles: [COMPOSE],
    expectedKeys: ["BETTER_AUTH_URL", "FRONTEND_URL", "TRUST_PROXY_HOPS", "MONGODB_URI"],
  });
  const finding = result.findings.find(
    (f) => f.code === "platform-var-not-referenced-by-compose" && f.key === "MONGODB_URI",
  );
  assert.ok(finding, JSON.stringify(result.findings));
  assert.match(finding.message, /reaches no container/);
  // The three the compose file does name are not reported.
  assert.equal(
    result.findings.filter((f) => f.code === "platform-var-not-referenced-by-compose").length,
    1,
  );
});

check("a compose substitution nobody sets is flagged, and one with a default is not", () => {
  const result = checkRuntimeEnvSource({
    composeFiles: [COMPOSE],
    expectedKeys: ["BETTER_AUTH_URL"],
  });
  const never = result.findings.filter((f) => f.code === "compose-var-never-set");
  assert.deepEqual(
    never.map((f) => f.key),
    ["FRONTEND_URL"],
    JSON.stringify(result.findings),
  );
  assert.equal(never[0].path, "docker-compose.yml");
  assert.match(never[0].message, /empty string/);
});

check("a ${VAR} inside a comment is not a variable", () => {
  const vars = collectComposeVariables([COMPOSE]);
  assert.equal(vars.has("VAR_NAME"), false);
  assert.equal(vars.get("SERVER_IMAGE")?.hasDefault, true);
  assert.equal(vars.get("TRUST_PROXY_HOPS")?.hasDefault, true);
  assert.equal(vars.get("BETTER_AUTH_URL")?.hasDefault, false);
});

check("a fully wired project reports nothing", () => {
  const result = checkRuntimeEnvSource({
    dockerfile: SERVER_DOCKERFILE_NO_ENV,
    gitignore: ".env.production\n",
    composeFiles: [COMPOSE],
    expectedKeys: ["BETTER_AUTH_URL", "FRONTEND_URL", "TRUST_PROXY_HOPS", "SERVER_IMAGE"],
  });
  assert.equal(result.ok, true, JSON.stringify(result.findings));
  assert.match(renderRuntimeEnvSource(result).join("\n"), /path to the container/);
});

// ── the generated document ─────────────────────────────────────────────

console.log("\nGenerated guidance\n");

check("the document is derived from ORIGIN_SITES", () => {
  const p = project();
  const before = renderEnvSourcesDoc(p);
  const extra: OriginSite = {
    id: "browser-extension",
    label: "a smart fridge client nobody expected",
    source: "file",
    path: "packages/fridge/config.ts",
    find: () => null,
    required: () => true,
    symptom: "the fridge orders milk from a host that has moved",
  };
  const after = renderEnvSourcesDoc(p, [...ORIGIN_SITES, extra]);
  assert.notEqual(before, after);
  assert.match(after, /smart fridge client/);
  assert.match(after, /packages\/fridge\/config\.ts/);
  assert.doesNotMatch(before, /smart fridge/);
});

check("the document names this deployment's origin and both rules", () => {
  const doc = renderEnvSourcesDoc(project());
  assert.match(doc, /https:\/\/api\.demo\.example/);
  assert.match(doc, /interpolation variables/);
  assert.match(doc, /nothing to open/);
  // Every applicable site is named, so the prose cannot claim a
  // different number of places than the check compares.
  for (const site of ORIGIN_SITES.filter((s) => s.required(project()))) {
    assert.ok(doc.includes(site.label), `missing ${site.id}`);
  }
});

check("the document names the places that hold no default on purpose", () => {
  const doc = renderEnvSourcesDoc(project({ features: ["mobile", "desktop"] }));
  assert.match(doc, /no default on purpose/);
  assert.match(doc, /`enforced`/);
  // The step a person owes sits next to the site, not only in the output
  // of the one command that wrote the page.
  assert.match(doc, /repository SECRET/);
  assert.match(doc, /repository VARIABLE/);
});

check("a static project's document lists no API origin sites", () => {
  const doc = renderEnvSourcesDoc(project({ surfaces: "static", features: [] }));
  assert.match(doc, /carries it \(0\)/);
});

// ── the module's one write, through the ledger ───────────────────

console.log("\nApply\n");

const dir = mkdtempSync(join(tmpdir(), "hatchkit-env-agreement-"));
try {
  check("apply writes the document and reports the manual platform step", () => {
    const ctx = context(dir, { features: [] });
    const outcome = applyEnvAgreement(ctx);
    assert.equal(outcome.skipped, undefined);
    assert.deepEqual(filesWith(ctx.ledger, "written"), [ENV_SOURCES_DOC_REL_PATH]);
    assert.ok(existsSync(join(dir, ENV_SOURCES_DOC_REL_PATH)));
    assert.ok(
      outcome.notes.some((n) => n.includes("BETTER_AUTH_URL=https://api.demo.example")),
      JSON.stringify(outcome.notes),
    );
  });

  check("the document is owned, so a hand-edit is regenerated rather than kept", () => {
    // The page is a pure function of ORIGIN_SITES and the manifest. An
    // edit that survived would be a page claiming a different set of
    // places than the check compares, which is the one thing generating
    // it was meant to rule out.
    writeFileSync(join(dir, ENV_SOURCES_DOC_REL_PATH), "hand-written\n", "utf-8");
    const ctx = context(dir, { features: [] });
    applyEnvAgreement(ctx);
    assert.deepEqual(filesWith(ctx.ledger, "written"), [ENV_SOURCES_DOC_REL_PATH]);
    assert.match(readFileSync(join(dir, ENV_SOURCES_DOC_REL_PATH), "utf-8"), /API origin/);
  });

  check("apply reports a repository site that carries no origin", () => {
    // No workflow in this temp project, so the build-arg site is missing
    // rather than differing — and apply says so instead of staying quiet.
    const outcome = applyEnvAgreement(context(dir, { features: [] }));
    assert.ok(
      outcome.notes.some((n) => n.includes("carries no API origin")),
      JSON.stringify(outcome.notes),
    );
  });

  check("a second apply records nothing written", () => {
    applyEnvAgreement(context(dir, { features: [] }));
    const again = context(dir, { features: [] });
    applyEnvAgreement(again);
    assert.deepEqual(filesWith(again.ledger, "written"), []);
    assert.ok(
      again.ledger.entries.every((e) => e.action === "unchanged" || e.action === "absent"),
      JSON.stringify(again.ledger.entries),
    );
    assert.equal(again.ledger.touched, false);
  });

  check("a static project is skipped and writes nothing", () => {
    const staticDir = mkdtempSync(join(tmpdir(), "hatchkit-env-static-"));
    try {
      const ctx = context(staticDir, { surfaces: "static", features: [] });
      const outcome = applyEnvAgreement(ctx);
      assert.ok(outcome.skipped, "a project with no server half has nothing to agree about");
      assert.deepEqual(ctx.ledger.entries, []);
      assert.equal(existsSync(join(staticDir, ENV_SOURCES_DOC_REL_PATH)), false);
    } finally {
      rmSync(staticDir, { recursive: true, force: true });
    }
  });

  check("a dry run leaves the disk alone and reports would-write", () => {
    const dryDir = mkdtempSync(join(tmpdir(), "hatchkit-env-dry-"));
    try {
      const ledger = new FeatureLedger(dryDir, true);
      applyEnvAgreement(context(dryDir, { features: [] }, { ledger }));
      assert.deepEqual(filesWith(ledger, "would-write"), [ENV_SOURCES_DOC_REL_PATH]);
      assert.deepEqual(filesWith(ledger, "written"), []);
      assert.equal(existsSync(join(dryDir, ENV_SOURCES_DOC_REL_PATH)), false);
      // Not even the directory: a dry run that creates `docs/` has still
      // changed the repository somebody was asking about.
      assert.equal(existsSync(join(dryDir, "docs")), false);
    } finally {
      rmSync(dryDir, { recursive: true, force: true });
    }
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ── Part 3: the native release workflows ──────────────────────────

console.log("\nNative release surfaces\n");

const STARTER = resolve(join(import.meta.dirname, "..", "starter"));

/** The starter is a submodule here, so a checkout without it skips the
 *  checks that read the real templates rather than failing them — the
 *  same tolerance test-scaffold.ts has. */
const starterPresent = existsSync(join(STARTER, ".github", "workflows"));
if (!starterPresent) {
  console.log(`  ! starter not populated at ${STARTER} — skipping the template checks`);
}

const MOBILE_WORKFLOW = ".github/workflows/mobile-release.yml";
const DESKTOP_WORKFLOW = ".github/workflows/desktop-release.yml";

check("a reserved .invalid host is a tripwire; a real host is not", () => {
  assert.equal(isTripwireOrigin("https://example.invalid"), true);
  assert.equal(isTripwireOrigin("https://example.invalid/api"), true);
  assert.equal(isTripwireOrigin("https://api.demo.example"), false);
  // `.invalid` has to be the TLD — a host merely containing the word is
  // somebody's real server.
  assert.equal(isTripwireOrigin("https://invalid.example"), false);
});

check("the starter mobile workflow refuses a run with an empty secret", () => {
  if (!starterPresent) return;
  const content = readFileSync(join(STARTER, MOBILE_WORKFLOW), "utf-8");
  // The plan job probes the secret as a BOOLEAN and fails the run when it
  // is empty. Without that gate an unset secret expands to "" and bakes an
  // empty origin into a store binary — the one artifact a redeploy cannot
  // correct.
  assert.match(
    content,
    new RegExp(`${NATIVE_API_URL_KEY}: \\$\\{\\{ secrets\\.${NATIVE_API_URL_KEY} != ''`),
    "the plan job no longer probes the API URL secret",
  );
  assert.match(
    readFileSync(join(STARTER, "scripts/lib/mobile-release.mjs"), "utf-8"),
    /is not set\. The static export bakes the API URL in at/,
    "the plan module no longer errors on a missing API URL",
  );
});

check("the starter desktop workflow falls back to a name that cannot resolve", () => {
  if (!starterPresent) return;
  const content = readFileSync(join(STARTER, DESKTOP_WORKFLOW), "utf-8");
  const site = ORIGIN_SITES.find((s) => s.id === "desktop-release");
  assert.ok(site && site.source === "file", "no desktop-release site");
  const found = site.find(content);
  assert.ok(found !== null, "the desktop workflow carries no literal at all");
  assert.ok(isTripwireOrigin(found), `${found} is a plausible host, not a tripwire`);
});

const nativeDir = mkdtempSync(join(tmpdir(), "hatchkit-native-surfaces-"));
try {
  /** A project holding the REAL starter release workflows, so the
   *  assertions below break if the starter's design changes under this
   *  check rather than passing against a fixture that agrees with it. */
  function scaffoldLike(relPaths: readonly string[]): string {
    const dir = mkdtempSync(join(nativeDir, "project-"));
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(
      join(dir, ".github/workflows/build-and-deploy.yml"),
      deployWorkflow("https://api.demo.example"),
      "utf-8",
    );
    for (const relPath of relPaths) {
      writeFileSync(join(dir, relPath), readFileSync(join(STARTER, relPath), "utf-8"), "utf-8");
    }
    return dir;
  }

  check("a scaffolded project reports its native surfaces as enforced, not missing", () => {
    if (!starterPresent) return;
    const dir = scaffoldLike([MOBILE_WORKFLOW, DESKTOP_WORKFLOW]);
    const ctx = context(dir, { features: ["mobile", "desktop"] });
    const outcome = applyEnvAgreement(ctx);

    // The module rewrites no workflow. Both starter designs refuse to
    // build against an origin nobody set, which is a better answer than
    // a literal hatchkit stamped in and then let go stale.
    assert.deepEqual(filesWith(ctx.ledger, "written"), [ENV_SOURCES_DOC_REL_PATH]);
    assert.equal(
      readFileSync(join(dir, MOBILE_WORKFLOW), "utf-8"),
      readFileSync(join(STARTER, MOBILE_WORKFLOW), "utf-8"),
    );
    assert.equal(
      readFileSync(join(dir, DESKTOP_WORKFLOW), "utf-8"),
      readFileSync(join(STARTER, DESKTOP_WORKFLOW), "utf-8"),
    );

    const result = checkApiOriginAgreement({
      project: ctx.project,
      platformEnv: { BETTER_AUTH_URL: "https://api.demo.example" },
      readFile: projectFileReader(dir),
    });
    assert.equal(result.ok, true, JSON.stringify(result.sites));
    for (const id of ["mobile-release", "desktop-release"] as const) {
      const site = siteById(result.sites, id);
      assert.equal(site.status, "enforced", `${id}: ${site.status}`);
      assert.ok(site.detail, `${id} does not say what refuses the build`);
    }

    // A refusal is reported, not passed over in silence: a reader who
    // sees no line concludes the origin is already set there.
    const report = renderApiOriginAgreement(result).join("\n");
    assert.match(report, /no default on purpose/);
    assert.match(report, /refuses the run when the secret is empty/);

    // And the value itself is still owed by a person, in the notes.
    assert.ok(
      outcome.notes.some((n) => n.includes("repository SECRET")),
      JSON.stringify(outcome.notes),
    );
    assert.ok(
      outcome.notes.some((n) => n.includes("repository VARIABLE")),
      JSON.stringify(outcome.notes),
    );
  });

  check("a literal naming the wrong host is still caught", () => {
    // The whole point of keeping the check: someone pinned the origin by
    // hand, then moved the API. The value is present and plausible, the
    // build is green, and the installed copies call a dead host.
    const dir = scaffoldLike([]);
    writeFileSync(
      join(dir, DESKTOP_WORKFLOW),
      mobileWorkflow("https://api.old-host.example"),
      "utf-8",
    );
    const result = checkApiOriginAgreement({
      project: project({ features: ["desktop"] }),
      platformEnv: { BETTER_AUTH_URL: "https://api.demo.example" },
      readFile: projectFileReader(dir),
    });
    const site = siteById(result.sites, "desktop-release");
    assert.equal(site.status, "differs");
    assert.equal(site.found, "https://api.old-host.example");
    assert.equal(result.ok, false);
    assert.match(renderApiOriginAgreement(result).join("\n"), /signed desktop build/);
  });

  check("a project without a mobile surface still reports that site absent", () => {
    if (!starterPresent) return;
    const dir = scaffoldLike([DESKTOP_WORKFLOW]);
    const ctx = context(dir, { features: ["desktop"] });
    const outcome = applyEnvAgreement(ctx);
    assert.deepEqual(filesWith(ctx.ledger, "written"), [ENV_SOURCES_DOC_REL_PATH]);

    const result = checkApiOriginAgreement({
      project: ctx.project,
      platformEnv: { BETTER_AUTH_URL: "https://api.demo.example" },
      readFile: projectFileReader(dir),
    });
    assert.equal(siteById(result.sites, "mobile-release").status, "absent");
    assert.equal(siteById(result.sites, "desktop-release").status, "enforced");
    assert.equal(result.ok, true, JSON.stringify(result.sites));
    // No step is owed for a surface this project does not have.
    assert.ok(
      !outcome.notes.some((n) => n.includes("repository SECRET")),
      JSON.stringify(outcome.notes),
    );
  });
} finally {
  rmSync(nativeDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.log(`\n${failures.length} failure(s):`);
  for (const f of failures) console.log(f);
  process.exit(1);
}
console.log("\n  all env-agreement checks passed\n");
