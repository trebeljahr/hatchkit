/**
 * Docs served from a path of the main domain, built into the client image.
 *
 * The bug these encode: a documentation site that search engines are told to
 * ignore is indistinguishable from one they are not. It builds, it deploys,
 * every page opens, and the only symptom is an absence months later. The
 * configuration that produces it is the ordinary one — read the docs address
 * from an environment variable, fall back to a placeholder, and turn
 * indexing off for the placeholder, which also disables the sitemap and
 * writes a `Disallow: /` robots file. One unset variable in the image build
 * ships all three.
 *
 * The properties that keep it from coming back:
 *   1. Every one of the four defects is caught, on realistic page and
 *      sitemap contents, and a clean tree passes. A check that fires on
 *      everything is no better than none.
 *   2. The prefix pages are checked against is the project's OWN domain,
 *      taken from the operational context — not a variable, not a fallback.
 *   3. The generated script and `audit.ts` agree: same rule codes, and the
 *      same verdict on a worked example of each rule. They cannot share
 *      code (one is JavaScript inside a Docker build), so this is the only
 *      thing keeping them from drifting into a script that passes anything.
 *   4. The domain has exactly ONE robots file, the web app's, and it names
 *      both sitemaps. A second one under the docs path is never requested.
 *   5. The Dockerfile retrofit runs the step after the client build, is
 *      idempotent, and leaves a Dockerfile it does not recognise alone.
 *   6. The same check runs on a pull request: inserted into the existing
 *      verify job, idempotently, with the standalone workflow written only
 *      when that could not be done.
 *   7. A backend-only project is skipped with a reason — there is no client
 *      image to build the docs into.
 *   8. The starter's own committed docs config satisfies the rules instead
 *      of tripping them. It is read from `starter/` rather than restated
 *      here, because a copy of it in this file is a copy that drifts — and
 *      the config it replaced, which read its address from a variable, is
 *      still caught by every rule.
 *   9. The config transform writes the project's own literals, is
 *      idempotent, and leaves a config it does not recognise alone; running
 *      the module over a project that has a docs site rewrites it.
 *  10. The two ledger invariants, which `update` re-applying the whole
 *      operational layer on every run makes load-bearing: a second apply
 *      records nothing written, and a dry run leaves the disk byte for byte
 *      as it found it while still saying what it would have written.
 *  11. An existing robots route is left alone. It is the one file here a
 *      person reasonably edits, and replacing somebody's crawler rules to
 *      add a sitemap entry could drop a disallow rule with no symptom.
 *
 * Nothing here runs a real docs build. The audit takes a file map, the
 * generated script is imported and handed a temporary directory, and a docs
 * config is turned into the tree it would produce by reading the handful of
 * decisions that tree depends on (see `simulateDocsBuild`).
 *
 * Run: `pnpm exec tsx test-docs-in-client.ts`
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { OperationalContext } from "./src/features/operational-context.js";
import type { Surface } from "./src/prompts.js";

process.env.HATCHKIT_CONF_DIR = mkdtempSync(join(tmpdir(), "docs-in-client-conf-"));

const { auditDocsOutput, formatDocsViolations } = await import(
  "./src/features/docs-in-client/audit.js"
);
const { DOCS_AUDIT_RULES, DOCS_VIOLATION_CODES, cleanDocsTree, EXAMPLE_PREFIX } = await import(
  "./src/features/docs-in-client/rules.js"
);
const { docsLayout, normalizeDocsBasePath } = await import(
  "./src/features/docs-in-client/paths.js"
);
const { renderDocsBuildScript, renderRobotsRoute, sitemapsInRobotsRoute } = await import(
  "./src/features/docs-in-client/render.js"
);
const {
  docsSiteConfigAddress,
  upgradeClientDockerfileDocs,
  upgradeDocsSiteConfig,
  upgradeWorkflowDocsCheck,
} = await import("./src/features/docs-in-client/retrofit.js");
const { applyDocsInClient, applyDocsInClientAt } = await import(
  "./src/features/docs-in-client/index.js"
);
const { FeatureLedger } = await import("./src/features/contract.js");

type DocsViolation = { code: string; path: string; detail: string };
type DocsAuditInput = { files: Record<string, string>; publishedPrefix: string };

const failures: string[] = [];
function check(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`  ✗ ${label}: ${(err as Error).message}`);
  }
}

async function checkAsync(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`  ✗ ${label}: ${(err as Error).message}`);
  }
}

/** Violations as comparable `code path` pairs, sorted — the two
 *  implementations walk their inputs in different orders, and the order is
 *  not what is being pinned down. */
function pairs(violations: readonly DocsViolation[]): string[] {
  return violations.map((v) => `${v.code} ${v.path}`).sort();
}

/** Write a file map into a fresh directory, creating parents. */
function materialize(files: Record<string, string>, dir: string): void {
  for (const [rel, contents] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, "utf-8");
  }
}

const tmp = mkdtempSync(join(tmpdir(), "docs-in-client-"));

// ---------------------------------------------------------------------------
// 1. The rules
// ---------------------------------------------------------------------------

console.log("\nthe audit");

check("a clean docs tree ships", () => {
  const result = auditDocsOutput(cleanDocsTree());
  assert.equal(
    result.ok,
    true,
    `expected no violations, got:\n${formatDocsViolations(result.violations)}`,
  );
});

check("a noindex meta tag on one page fails the tree", () => {
  const tree = cleanDocsTree();
  tree.files["guide/index.html"] = tree.files["guide/index.html"].replace(
    '<meta name="robots" content="index, follow">',
    '<meta name="robots" content="noindex, nofollow">',
  );
  const { ok, violations } = auditDocsOutput(tree);
  assert.equal(ok, false);
  assert.deepEqual(pairs(violations), ["noindex guide/index.html"]);
});

check("a googlebot-specific noindex counts too", () => {
  const tree = cleanDocsTree();
  tree.files["index.html"] = tree.files["index.html"].replace(
    '<meta name="robots" content="index, follow">',
    "<meta name='googlebot' content='noindex'>",
  );
  assert.deepEqual(pairs(auditDocsOutput(tree).violations), ["noindex index.html"]);
});

check("an X-Robots-Tag noindex in a headers file counts as a noindex", () => {
  const tree = cleanDocsTree();
  tree.files._headers = "/*\n  X-Robots-Tag: noindex, nofollow\n";
  assert.deepEqual(pairs(auditDocsOutput(tree).violations), ["noindex _headers"]);
});

check('`content="index, follow"` is not read as a noindex', () => {
  // The word `index` is a substring of `noindex`; a rule that greps for it
  // fails every correctly configured page.
  assert.equal(auditDocsOutput(cleanDocsTree()).ok, true);
});

check("a canonical link on another host fails the tree", () => {
  const tree = cleanDocsTree();
  tree.files["guide/index.html"] = tree.files["guide/index.html"].replace(
    `${EXAMPLE_PREFIX}guide/`,
    "https://docs.example.test/guide/",
  );
  const { violations } = auditDocsOutput(tree);
  assert.deepEqual(pairs(violations), ["canonical-outside-prefix guide/index.html"]);
  assert.match(violations[0].detail, /https:\/\/docs\.example\.test\/guide\//);
});

check("a canonical that drops the docs prefix fails the tree", () => {
  // The exact output of a docs build given the right host and no base path.
  const tree = cleanDocsTree();
  tree.files["guide/index.html"] = tree.files["guide/index.html"].replace(
    `${EXAMPLE_PREFIX}guide/`,
    "https://example.test/guide/",
  );
  assert.deepEqual(pairs(auditDocsOutput(tree).violations), [
    "canonical-outside-prefix guide/index.html",
  ]);
});

check("a page with no canonical at all fails the tree", () => {
  const tree = cleanDocsTree();
  tree.files["guide/index.html"] = tree.files["guide/index.html"].replace(
    /<link rel="canonical"[^>]*>\n/,
    "",
  );
  assert.deepEqual(pairs(auditDocsOutput(tree).violations), [
    "canonical-outside-prefix guide/index.html",
  ]);
});

check("the 404 page is exempt from the canonical rule", () => {
  // It is only ever served with a 404 status, which nothing indexes.
  const tree = cleanDocsTree();
  assert.ok(tree.files["404.html"].includes("<html"));
  assert.ok(!tree.files["404.html"].includes("canonical"));
  assert.equal(auditDocsOutput(tree).ok, true);
});

check("a sitemap entry outside the prefix fails the tree", () => {
  const tree = cleanDocsTree();
  tree.files["sitemap.xml"] = tree.files["sitemap.xml"].replace(
    `${EXAMPLE_PREFIX}guide/`,
    "https://example.test/guide/",
  );
  const { violations } = auditDocsOutput(tree);
  assert.deepEqual(pairs(violations), ["sitemap-entry-outside-prefix sitemap.xml"]);
  assert.match(violations[0].detail, /https:\/\/example\.test\/guide\//);
});

check("a missing sitemap fails the tree, because robots.txt points at one", () => {
  const tree = cleanDocsTree();
  delete tree.files["sitemap.xml"];
  assert.deepEqual(pairs(auditDocsOutput(tree).violations), [
    "sitemap-entry-outside-prefix sitemap.xml",
  ]);
});

check("an empty sitemap fails the tree", () => {
  const tree = cleanDocsTree();
  tree.files["sitemap.xml"] = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset>\n</urlset>\n';
  assert.deepEqual(pairs(auditDocsOutput(tree).violations), [
    "sitemap-entry-outside-prefix sitemap.xml",
  ]);
});

check("a numbered sitemap counts as the sitemap", () => {
  const tree = cleanDocsTree();
  tree.files["sitemap-0.xml"] = tree.files["sitemap.xml"];
  delete tree.files["sitemap.xml"];
  assert.equal(auditDocsOutput(tree).ok, true);
});

check("a robots file under the docs prefix fails the tree", () => {
  const tree = cleanDocsTree();
  tree.files["robots.txt"] = "User-agent: *\nDisallow: /\n";
  assert.deepEqual(pairs(auditDocsOutput(tree).violations), [
    "robots-under-docs-prefix robots.txt",
  ]);
});

check("the placeholder-address build fails on all three of its symptoms", () => {
  // What a docs config ships when its address variable was never set: every
  // page noindexed, no sitemap, and a Disallow-everything robots file.
  const tree = cleanDocsTree();
  delete tree.files["sitemap.xml"];
  tree.files["robots.txt"] = "User-agent: *\nDisallow: /\n";
  for (const page of ["index.html", "guide/index.html"]) {
    tree.files[page] = tree.files[page].replace(
      'content="index, follow"',
      'content="noindex, nofollow"',
    );
  }
  const codes = new Set(auditDocsOutput(tree).violations.map((v) => v.code));
  assert.deepEqual(
    [...codes].sort(),
    ["noindex", "robots-under-docs-prefix", "sitemap-entry-outside-prefix"],
    "one misconfiguration produces several defects, and the report must name them all",
  );
});

check("every declared code has a rule, and every rule a worked example", () => {
  assert.deepEqual(
    DOCS_AUDIT_RULES.map((r) => r.code),
    [...DOCS_VIOLATION_CODES],
  );
  for (const rule of DOCS_AUDIT_RULES) {
    const violations = auditDocsOutput(rule.example).violations;
    assert.deepEqual(
      pairs(violations),
      rule.expectedPaths.map((p) => `${rule.code} ${p}`).sort(),
      `${rule.code}'s example must trip ${rule.code} and nothing else`,
    );
    assert.ok(rule.why.length > 40, `${rule.code} must say why it exists`);
    for (const v of violations)
      assert.ok(v.detail.length > 10, `${rule.code} must say what is wrong`);
  }
});

// ---------------------------------------------------------------------------
// 2. The generated script carries the same rules
// ---------------------------------------------------------------------------

console.log("\nthe generated copy step");

const layout = docsLayout({ domain: "example.test" });
const script = renderDocsBuildScript(layout);

check("the published prefix is a literal in the script, not a variable", () => {
  assert.match(script, /export const PUBLISHED_PREFIX = "https:\/\/example\.test\/docs\/";/);
  assert.ok(!/process\.env/.test(script), "no environment lookup may decide where the docs live");
});

check("the script says why the address is a literal", () => {
  assert.match(script, /LITERAL/);
  assert.match(script, /placeholder/);
});

check("the script carries every rule code", () => {
  for (const code of DOCS_VIOLATION_CODES) {
    assert.ok(script.includes(`code: "${code}"`), `the script is missing the ${code} rule`);
  }
  const declared = [...script.matchAll(/^ {4}code: "([^"]+)",$/gm)].map((m) => m[1]);
  assert.deepEqual(declared, [...DOCS_VIOLATION_CODES], "the script's rules must be audit.ts's");
});

const scriptPath = join(tmp, "script", "build-into-client.mjs");
mkdirSync(dirname(scriptPath), { recursive: true });
writeFileSync(scriptPath, script, "utf-8");
const generated = (await import(pathToFileURL(scriptPath).href)) as {
  PUBLISHED_PREFIX: string;
  auditDocsTree: (dir: string, prefix?: string) => { ok: boolean; violations: DocsViolation[] };
};

/** Run one tree through the generated script, from a real directory. */
function auditWithScript(input: DocsAuditInput, name: string) {
  const dir = join(tmp, "trees", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  materialize(input.files, dir);
  return generated.auditDocsTree(dir, input.publishedPrefix);
}

await checkAsync("the script and audit.ts agree that a clean tree ships", async () => {
  const result = auditWithScript(cleanDocsTree(), "clean");
  assert.equal(
    result.ok,
    true,
    `script rejected a clean tree: ${JSON.stringify(result.violations)}`,
  );
});

await checkAsync("the script and audit.ts agree on a worked example of every rule", async () => {
  for (const rule of DOCS_AUDIT_RULES) {
    const fromScript = auditWithScript(rule.example, rule.code);
    const fromAudit = auditDocsOutput(rule.example);
    assert.deepEqual(
      pairs(fromScript.violations),
      pairs(fromAudit.violations),
      `the two implementations disagree about ${rule.code}`,
    );
    assert.equal(fromScript.ok, false);
  }
});

await checkAsync("the script reads the prefix from its own literal by default", async () => {
  assert.equal(generated.PUBLISHED_PREFIX, "https://example.test/docs/");
  const dir = join(tmp, "trees", "default-prefix");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  materialize(cleanDocsTree("https://example.test/docs/").files, dir);
  assert.equal(generated.auditDocsTree(dir).ok, true);
});

await checkAsync("the script skips files that are not text", async () => {
  // A tree carries fonts and images; reading them would be waste, and a
  // binary that happens to contain the word noindex would fail the build.
  const dir = join(tmp, "trees", "binary");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "assets"), { recursive: true });
  materialize(cleanDocsTree().files, dir);
  writeFileSync(join(dir, "assets", "logo.png"), "\u0000noindex\u0000", "utf-8");
  assert.equal(generated.auditDocsTree(dir, EXAMPLE_PREFIX).ok, true);
});

// ---------------------------------------------------------------------------
// 3. The prefix comes from the project's own domain
// ---------------------------------------------------------------------------

console.log("\nthe published prefix");

check("the prefix is the project's domain plus the base path", () => {
  assert.equal(
    docsLayout({ domain: "app.example.com" }).publishedPrefix,
    "https://app.example.com/docs/",
  );
  assert.equal(
    docsLayout({ domain: "example.com", basePath: "handbook" }).publishedPrefix,
    "https://example.com/handbook/",
  );
});

check("a base path is normalised to one shape", () => {
  for (const given of ["docs", "/docs", "docs/", "/docs/"]) {
    assert.equal(normalizeDocsBasePath(given), "/docs/");
  }
  assert.equal(normalizeDocsBasePath(""), "/docs/");
  assert.equal(normalizeDocsBasePath("/"), "/docs/");
});

// ---------------------------------------------------------------------------
// 4. One robots file for the domain, naming both sitemaps
// ---------------------------------------------------------------------------

console.log("\nthe domain's robots file");

check("the generated robots route lists both sitemaps", () => {
  const listed = sitemapsInRobotsRoute(renderRobotsRoute(layout));
  assert.deepEqual(listed, [
    "https://example.test/sitemap.xml",
    "https://example.test/docs/sitemap.xml",
  ]);
});

check("the robots route explains the missing lastmod and the git binary", () => {
  const source = renderRobotsRoute(layout);
  assert.match(source, /last-modified/);
  assert.match(source, /git/);
});

check("a hand-rolled robots file is not parsed into false confidence", () => {
  assert.deepEqual(sitemapsInRobotsRoute("export default function robots() { return {}; }"), []);
});

// ---------------------------------------------------------------------------
// 5. The Dockerfile retrofit
// ---------------------------------------------------------------------------

console.log("\nthe client image");

const CLIENT_DOCKERFILE = `FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/client/package.json packages/client/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY packages/shared packages/shared
COPY packages/client packages/client
RUN pnpm --filter @starter/shared run build
RUN pnpm --filter @starter/client run build
RUN printf '{"commit":"%s"}\\n' "$COMMIT_SHA" > packages/client/public/version.json

FROM node:24-bookworm-slim AS runtime
COPY --from=build /app/packages/client/public ./packages/client/public
CMD ["node", "packages/client/server.js"]
`;

const retrofitted = upgradeClientDockerfileDocs(CLIENT_DOCKERFILE, layout);

check("the copy step runs after the client build", () => {
  const lines = retrofitted.split("\n");
  const build = lines.findIndex((l) => l === "RUN pnpm --filter @starter/client run build");
  const docs = lines.findIndex((l) => l.startsWith("RUN node scripts/docs/build-into-client.mjs"));
  assert.ok(build !== -1 && docs !== -1, "both steps must be present");
  assert.ok(docs > build, "the docs are copied into the client's output, so they come after it");
});

check("the docs sources and the copy step are in the image", () => {
  assert.match(retrofitted, /^COPY docs-site\/package\.json docs-site\/$/m);
  assert.match(retrofitted, /^COPY docs-site docs-site$/m);
  assert.match(retrofitted, /^COPY scripts\/docs scripts\/docs$/m);
});

check("the Dockerfile says never to move the step into the client's build script", () => {
  assert.match(retrofitted, /NEVER added to the client package's own build script/);
  assert.match(retrofitted, /end-to-end suite/);
  assert.match(retrofitted, /native shells/);
});

check("the Dockerfile retrofit is idempotent", () => {
  assert.equal(upgradeClientDockerfileDocs(retrofitted, layout), retrofitted);
});

check("a Dockerfile without the anchors is returned untouched", () => {
  const handRolled =
    'FROM node:24\nWORKDIR /app\nCOPY . .\nRUN npm run build\nCMD ["node", "server.js"]\n';
  assert.equal(upgradeClientDockerfileDocs(handRolled, layout), handRolled);
});

check("a Dockerfile with sources but no workspace build is returned untouched", () => {
  // Half a retrofit fails every image build; none fails nothing and is
  // reported as a note instead.
  const partial = `FROM node:24 AS build
COPY packages/client/package.json packages/client/
COPY packages/client packages/client
RUN npm run build
`;
  assert.equal(upgradeClientDockerfileDocs(partial, layout), partial);
});

// ---------------------------------------------------------------------------
// 6. The pull-request check
// ---------------------------------------------------------------------------

console.log("\nthe pull-request check");

const DEPLOY_WORKFLOW = `name: build-and-deploy

on:
  push:
    branches: [main]
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm run build
      - run: pnpm run test:unit

  e2e:
    runs-on: ubuntu-latest
    needs: [verify]
    steps:
      - uses: actions/checkout@v4
      - run: pnpm run test:e2e
`;

const withCheck = upgradeWorkflowDocsCheck(DEPLOY_WORKFLOW);

check("the check lands at the end of the verify job", () => {
  const lines = withCheck.split("\n");
  const step = lines.findIndex((l) => l.includes("Verify the docs build"));
  const e2e = lines.findIndex((l) => l === "  e2e:");
  const verify = lines.findIndex((l) => l === "  verify:");
  assert.ok(step !== -1, "the step must be inserted");
  assert.ok(step > verify && step < e2e, "it belongs to the verify job, not the next one");
  assert.match(withCheck, /run: node scripts\/docs\/build-into-client\.mjs --check$/m);
  assert.ok(
    withCheck.includes("      - name: Verify the docs build"),
    "indented for this steps list",
  );
});

check("the CI step says it catches broken links before merge", () => {
  assert.match(withCheck, /broken internal link/);
  assert.match(withCheck, /pull request/);
});

check("the workflow retrofit is idempotent", () => {
  assert.equal(upgradeWorkflowDocsCheck(withCheck), withCheck);
});

check("a workflow with no verify job is returned untouched", () => {
  const other = DEPLOY_WORKFLOW.replace("  verify:", "  build:").replace(
    "needs: [verify]",
    "needs: [build]",
  );
  assert.equal(upgradeWorkflowDocsCheck(other), other);
});

check("a verify job built from a reusable workflow is returned untouched", () => {
  const reusable = `name: ci

jobs:
  verify:
    uses: ./.github/workflows/shared.yml
`;
  assert.equal(upgradeWorkflowDocsCheck(reusable), reusable);
});

// ---------------------------------------------------------------------------
// 7. The docs site's own configuration
// ---------------------------------------------------------------------------

console.log("\nthe docs site's configuration");

/** Strip comments before reading anything out of a config.
 *
 *  Not fussiness: the rewritten starter config explains, at length, why it
 *  does not read `process.env.DOCS_SITE_URL`, does not set `noIndex` and
 *  ships no `robots.txt`. A reader that looks at raw source finds all three
 *  words and concludes the opposite of what the file says. Line comments are
 *  only stripped when they start a line, so the `//` of a URL survives. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** The handful of decisions a docs config makes that the built tree, and
 *  therefore the audit, depends on. */
interface DocsConfigFacts {
  /** Where the pages say they live, as the IMAGE BUILD would resolve it —
   *  with no `DOCS_SITE_URL` in the environment, because there is none. */
  publishedPrefix: string;
  /** True when the address is written down rather than computed. */
  addressIsLiteral: boolean;
  /** True when the pages would carry a noindex directive. */
  noIndex: boolean;
  /** True when a sitemap would be written at all. */
  sitemap: boolean;
  /** True when the site writes a `robots.txt` of its own. */
  ownRobotsFile: boolean;
}

/** Read those decisions off a Docusaurus config's source.
 *
 *  Source reading rather than importing the config: the config imports
 *  `@docusaurus/types` and a plugin or two, none of which the CLI's test run
 *  has installed, and evaluating it would answer for THIS environment rather
 *  than for the image build that has no variables set. What is being pinned
 *  down is a property of the file, so the file is what is read. */
function docsConfigFacts(source: string): DocsConfigFacts {
  const code = stripComments(source);
  const literalUrl = code.match(/^const siteUrl = "([^"\n]*)";$/m)?.[1];
  const literalBase = code.match(/^const baseUrl = "([^"\n]*)";$/m)?.[1];
  // What an address computed from the environment collapses to when the
  // variable is unset: the fallback beside the `??`, which is the whole bug.
  const fallbackUrl = code.match(/\?\?\s*"([^"]+)"/)?.[1] ?? "https://unknown.invalid";
  const inlineBase = code.match(/^\s*baseUrl: "([^"\n]*)",?$/m)?.[1] ?? "/";
  const noIndexValue = code.match(/^\s*noIndex:\s*([^,\n]+),?$/m)?.[1]?.trim();
  const sitemapAt = code.indexOf("sitemap:");
  const sitemapValue = sitemapAt === -1 ? "false" : code.slice(sitemapAt, sitemapAt + 120);
  return {
    publishedPrefix: `${(literalUrl ?? fallbackUrl).replace(/\/+$/, "")}${literalBase ?? inlineBase}`,
    addressIsLiteral: literalUrl !== undefined && literalBase !== undefined,
    noIndex: noIndexValue !== undefined && noIndexValue !== "false",
    sitemap: sitemapAt !== -1 && !/\bfalse\b/.test(sitemapValue),
    ownRobotsFile: /robots\.txt/.test(code),
  };
}

/** The tree a config would produce, as a file map the real audit can run
 *  over. Two pages and a 404, which is every shape the rules distinguish. */
function simulateDocsBuild(source: string): DocsAuditInput {
  const facts = docsConfigFacts(source);
  const prefix = facts.publishedPrefix;
  const robotsMeta = facts.noIndex
    ? '<meta name="robots" content="noindex, nofollow">'
    : '<meta name="robots" content="index, follow">';
  const page = (canonical: string): string =>
    `<!doctype html>\n<html lang="en"><head>\n${robotsMeta}\n` +
    `<link rel="canonical" href="${canonical}">\n<title>Docs</title>\n` +
    "</head><body><main>Docs</main></body></html>\n";
  const files: Record<string, string> = {
    "index.html": page(prefix),
    "guide/index.html": page(`${prefix}guide/`),
    "404.html": '<!doctype html><html lang="en"><head><title>Not found</title></head></html>\n',
  };
  if (facts.sitemap) {
    const locs = [prefix, `${prefix}guide/`].map((loc) => `  <url><loc>${loc}</loc></url>`);
    files["sitemap.xml"] = `<?xml version="1.0"?>\n<urlset>\n${locs.join("\n")}\n</urlset>\n`;
  }
  if (facts.ownRobotsFile) files["robots.txt"] = "User-agent: *\nDisallow: /\n";
  return { files, publishedPrefix: prefix };
}

/** The starter's committed config, read from `starter/` rather than copied
 *  here. A copy is what let the template and the rule that judges it drift
 *  apart in the first place. */
const STARTER_DOCS_CONFIG = readFileSync(
  fileURLToPath(new URL("../starter/docs-site/docusaurus.config.ts", import.meta.url)),
  "utf-8",
);

check("the starter's docs config would ship a tree that passes every rule", () => {
  const result = auditDocsOutput(simulateDocsBuild(STARTER_DOCS_CONFIG));
  assert.equal(
    result.ok,
    true,
    `the scaffolded project's first docs build must not fail:\n${formatDocsViolations(result.violations)}`,
  );
});

check("the starter's docs address is two literals, not an environment lookup", () => {
  assert.deepEqual(docsSiteConfigAddress(STARTER_DOCS_CONFIG), {
    url: "https://example.com",
    baseUrl: "/docs/",
  });
  assert.ok(
    !stripComments(STARTER_DOCS_CONFIG).includes("process.env"),
    "a config that computes its address is the failure this feature exists to prevent",
  );
});

check("the starter's sitemap carries no last-modified dates", () => {
  // No rule can see this one: it is about the BUILD, which has no git
  // repository around it and fails outright on a generator that wants one.
  assert.match(STARTER_DOCS_CONFIG, /lastmod: null/);
  assert.match(STARTER_DOCS_CONFIG, /git/);
});

/** What the starter shipped before: an address from the environment, a
 *  placeholder fallback, and the three defects that travel with it. */
const CONFIG_WITH_A_VARIABLE_ADDRESS = `import type { Config, Plugin } from "@docusaurus/types";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const docsUrl = process.env.DOCS_SITE_URL ?? "https://docs.example.com";
const usesPlaceholderUrl = docsUrl === "https://docs.example.com";

function generatedRobotsPlugin(): Plugin<void> {
  return {
    name: "generated-robots",
    postBuild({ outDir }) {
      writeFileSync(join(outDir, "robots.txt"), "User-agent: *\\nDisallow: /\\n");
    },
  };
}

const config: Config = {
  url: docsUrl,
  baseUrl: "/",
  noIndex: usesPlaceholderUrl,
  presets: [
    [
      "classic",
      {
        docs: { routeBasePath: "/", sidebarPath: "./sidebars.ts" },
        blog: false,
        sitemap: usesPlaceholderUrl
          ? false
          : { lastmod: "date", changefreq: "weekly", priority: 0.7 },
      },
    ],
  ],
  plugins: [generatedRobotsPlugin],
};

export default config;
`;

check("a config that still reads its address from a variable trips every rule", () => {
  // Published where this project actually publishes, which is the state a
  // real deploy is in: one unset variable, and all four defects at once.
  const built = simulateDocsBuild(CONFIG_WITH_A_VARIABLE_ADDRESS);
  const { ok, violations } = auditDocsOutput({
    files: built.files,
    publishedPrefix: layout.publishedPrefix,
  });
  assert.equal(ok, false, "the old starter config must not be reported as shippable");
  assert.deepEqual(
    [...new Set(violations.map((v) => v.code))].sort(),
    [...DOCS_VIOLATION_CODES].sort(),
  );
});

check("the transform sets the project's own literals", () => {
  const upgraded = upgradeDocsSiteConfig(STARTER_DOCS_CONFIG, layout);
  assert.deepEqual(docsSiteConfigAddress(upgraded), {
    url: "https://example.test",
    baseUrl: "/docs/",
  });
  const result = auditDocsOutput({
    files: simulateDocsBuild(upgraded).files,
    publishedPrefix: layout.publishedPrefix,
  });
  assert.equal(
    result.ok,
    true,
    `published at ${layout.publishedPrefix}:\n${formatDocsViolations(result.violations)}`,
  );
});

check("a custom base path reaches the config too", () => {
  const handbook = docsLayout({ domain: "example.test", basePath: "handbook" });
  const upgraded = upgradeDocsSiteConfig(STARTER_DOCS_CONFIG, handbook);
  assert.deepEqual(docsSiteConfigAddress(upgraded), {
    url: "https://example.test",
    baseUrl: "/handbook/",
  });
  assert.equal(
    auditDocsOutput({
      files: simulateDocsBuild(upgraded).files,
      publishedPrefix: handbook.publishedPrefix,
    }).ok,
    true,
  );
});

check("the config transform is idempotent", () => {
  const once = upgradeDocsSiteConfig(STARTER_DOCS_CONFIG, layout);
  assert.equal(upgradeDocsSiteConfig(once, layout), once);
});

check("a config without the anchors is returned untouched", () => {
  // Including the one this feature exists to reject: a config whose address
  // is an expression is not a config whose address can be substituted, and
  // half-rewriting it would leave a site nobody can reason about.
  assert.equal(
    upgradeDocsSiteConfig(CONFIG_WITH_A_VARIABLE_ADDRESS, layout),
    CONFIG_WITH_A_VARIABLE_ADDRESS,
  );
  const handRolled = 'export default { url: "https://mine.test", baseUrl: "/" };\n';
  assert.equal(upgradeDocsSiteConfig(handRolled, layout), handRolled);
});

check("an unreadable address is reported as absent rather than guessed", () => {
  assert.deepEqual(docsSiteConfigAddress(CONFIG_WITH_A_VARIABLE_ADDRESS), {
    url: undefined,
    baseUrl: undefined,
  });
});

// ---------------------------------------------------------------------------
// 8. applyDocsInClient, through the real ledger
// ---------------------------------------------------------------------------

console.log("\napplying the module");

/** A project directory with the files the retrofits anchor on. */
function makeProject(name: string, withWorkflow: boolean): string {
  const dir = join(tmp, "projects", name);
  mkdirSync(join(dir, "packages", "client"), { recursive: true });
  writeFileSync(join(dir, "packages", "client", "Dockerfile"), CLIENT_DOCKERFILE, "utf-8");
  if (withWorkflow) {
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(
      join(dir, ".github", "workflows", "build-and-deploy.yml"),
      DEPLOY_WORKFLOW,
      "utf-8",
    );
  }
  return dir;
}

/** The context the operational layer hands a module, with a REAL ledger.
 *
 *  A real one rather than a stub, because the ledger is what makes the two
 *  properties below cheap to state: it compares before it writes, so a second
 *  apply reports `unchanged`, and it is the only thing that knows about a dry
 *  run, so a stub would test a code path the CLI never takes. */
function makeContext(
  dir: string,
  opts: { surfaces?: Surface; dryRun?: boolean; force?: boolean } = {},
): OperationalContext {
  return {
    projectDir: dir,
    project: {
      name: "demo",
      domain: "example.test",
      topology: "single-origin",
      surfaces: opts.surfaces ?? "fullstack",
      features: [],
    },
    mode: "update",
    ledger: new FeatureLedger(dir, opts.dryRun === true),
    log: () => undefined,
    force: opts.force,
  };
}

/** What the ledger recorded as written, in this run. */
function written(ctx: OperationalContext): string[] {
  return ctx.ledger.summary().written;
}

const base = makeContext(makeProject("fullstack", true));
const outcome = applyDocsInClient(base);

check("the copy step, the robots route and the links module are written", () => {
  for (const path of [
    "scripts/docs/build-into-client.mjs",
    "packages/client/src/app/robots.ts",
    "packages/client/src/lib/docs-links.ts",
  ]) {
    assert.ok(written(base).includes(path), `${path} was not written`);
    assert.ok(existsSync(join(base.projectDir, path)), `${path} is not on disk`);
  }
});

check("the written script is built against the project's own domain", () => {
  const script = readFileSync(join(base.projectDir, "scripts/docs/build-into-client.mjs"), "utf-8");
  assert.match(script, /export const PUBLISHED_PREFIX = "https:\/\/example\.test\/docs\/";/);
});

check("the domain gets exactly one robots file", () => {
  const robots = written(base).filter((p) => p.includes("robots"));
  assert.deepEqual(robots, ["packages/client/src/app/robots.ts"]);
  const listed = sitemapsInRobotsRoute(
    readFileSync(join(base.projectDir, "packages/client/src/app/robots.ts"), "utf-8"),
  );
  assert.deepEqual(listed, [
    "https://example.test/sitemap.xml",
    "https://example.test/docs/sitemap.xml",
  ]);
});

check("the marketing links are absolute and say why", () => {
  const links = readFileSync(
    join(base.projectDir, "packages/client/src/lib/docs-links.ts"),
    "utf-8",
  );
  assert.match(links, /export const DOCS_URL = "https:\/\/example\.test\/docs\/";/);
  assert.match(links, /plain <a>/);
  assert.match(links, /not a route this app has/);
});

check("both retrofits are applied, and no standalone workflow is written", () => {
  assert.ok(written(base).includes("packages/client/Dockerfile"));
  assert.ok(written(base).includes(".github/workflows/build-and-deploy.yml"));
  assert.ok(
    !existsSync(join(base.projectDir, ".github/workflows/docs-verify.yml")),
    "the standalone workflow is the fallback, not the default",
  );
});

check("the docs config requirement is reported as a note", () => {
  assert.ok(
    outcome.notes.some((n) => n.includes("literals") && n.includes("https://example.test")),
    `expected a note about the literal address, got: ${outcome.notes.join(" | ")}`,
  );
});

check("a project that has a docs site gets the address written into it", () => {
  const dir = makeProject("with-docs", true);
  mkdirSync(join(dir, "docs-site"), { recursive: true });
  writeFileSync(join(dir, "docs-site/docusaurus.config.ts"), STARTER_DOCS_CONFIG, "utf-8");
  const ctx = makeContext(dir);
  const result = applyDocsInClient(ctx);

  assert.ok(
    written(ctx).includes("docs-site/docusaurus.config.ts"),
    "the docs config is the one file whose address is a fact, not a preference",
  );
  const config = readFileSync(join(dir, "docs-site/docusaurus.config.ts"), "utf-8");
  assert.deepEqual(docsSiteConfigAddress(config), {
    url: "https://example.test",
    baseUrl: "/docs/",
  });
  const audit = auditDocsOutput({
    files: simulateDocsBuild(config).files,
    publishedPrefix: "https://example.test/docs/",
  });
  assert.equal(audit.ok, true, formatDocsViolations(audit.violations));

  // Nothing is SAID about it, in either run: the ledger already reports the
  // rewrite, and a note that restates a file hatchkit just wrote is how a
  // generated report stops being read.
  assert.ok(
    !result.notes.some((n) => n.includes("docusaurus.config.ts")),
    `expected no note about the rewritten config, got: ${result.notes.join(" | ")}`,
  );
  const second = makeContext(dir);
  const again = applyDocsInClient(second);
  assert.deepEqual(written(second), []);
  assert.ok(
    !again.notes.some((n) => n.includes("docusaurus.config.ts")),
    `expected no further note, got: ${again.notes.join(" | ")}`,
  );
});

check("a hand-rolled docs config is left alone, and the note says what to set", () => {
  const dir = makeProject("hand-rolled-docs", true);
  mkdirSync(join(dir, "docs-site"), { recursive: true });
  const handRolled = 'export default { url: process.env.DOCS_SITE_URL, baseUrl: "/" };\n';
  writeFileSync(join(dir, "docs-site/docusaurus.config.ts"), handRolled, "utf-8");
  const ctx = makeContext(dir);
  const result = applyDocsInClient(ctx);

  assert.equal(readFileSync(join(dir, "docs-site/docusaurus.config.ts"), "utf-8"), handRolled);
  assert.ok(!written(ctx).includes("docs-site/docusaurus.config.ts"));
  assert.ok(
    result.notes.some(
      (n) => n.includes("docs-site/docusaurus.config.ts") && n.includes("https://example.test"),
    ),
    `expected the note to name the file and the address, got: ${result.notes.join(" | ")}`,
  );
});

check("applying twice records nothing written", () => {
  // The invariant the whole ledger exists for: `update` re-applies the layer
  // on every run, so a second apply that writes anything corrupts the project
  // a little more each time.
  const second = makeContext(base.projectDir);
  applyDocsInClient(second);
  assert.deepEqual(written(second), [], `second run rewrote: ${written(second).join(", ")}`);
  const unexpected = second.ledger.entries.filter(
    (e) => e.action !== "unchanged" && e.action !== "absent",
  );
  assert.deepEqual(
    unexpected.map((e) => `${e.action} ${e.file}`),
    [],
    "every entry of a second apply must be unchanged or absent",
  );
  assert.ok(
    second.ledger.entries.some((e) => e.action === "unchanged"),
    "and the second apply must actually have looked at the files",
  );
});

check("a dry run touches nothing and says what it would have written", () => {
  const dir = makeProject("dry-run", true);
  const dockerfileBefore = readFileSync(join(dir, "packages/client/Dockerfile"), "utf-8");
  const workflowBefore = readFileSync(join(dir, ".github/workflows/build-and-deploy.yml"), "utf-8");

  const ctx = makeContext(dir, { dryRun: true });
  applyDocsInClient(ctx);

  const wouldWrite = ctx.ledger.summary()["would-write"];
  for (const path of [
    "scripts/docs/build-into-client.mjs",
    "packages/client/src/app/robots.ts",
    "packages/client/src/lib/docs-links.ts",
    "packages/client/Dockerfile",
    ".github/workflows/build-and-deploy.yml",
  ]) {
    assert.ok(wouldWrite.includes(path), `${path} is missing from the dry run's account`);
  }
  assert.deepEqual(written(ctx), [], "a dry run writes nothing");
  for (const path of [
    "scripts/docs/build-into-client.mjs",
    "packages/client/src/app/robots.ts",
    "packages/client/src/lib/docs-links.ts",
  ]) {
    assert.ok(!existsSync(join(dir, path)), `${path} was created by a dry run`);
  }
  assert.equal(readFileSync(join(dir, "packages/client/Dockerfile"), "utf-8"), dockerfileBefore);
  assert.equal(
    readFileSync(join(dir, ".github/workflows/build-and-deploy.yml"), "utf-8"),
    workflowBefore,
  );
});

check("the standalone workflow is written when the verify job cannot be found", () => {
  const dir = makeProject("no-workflow", false);
  const ctx = makeContext(dir);
  applyDocsInClient(ctx);
  assert.ok(written(ctx).includes(".github/workflows/docs-verify.yml"));
  const workflow = readFileSync(join(dir, ".github/workflows/docs-verify.yml"), "utf-8");
  assert.match(workflow, /run: node scripts\/docs\/build-into-client\.mjs --check$/m);
  assert.match(workflow, /pull_request/);
});

check("an existing robots route is left alone, and the note names the missing line", () => {
  // Somebody's crawler rules. Replacing them to add a sitemap entry would
  // drop a disallow rule nobody would notice was gone.
  const dir = makeProject("existing", true);
  mkdirSync(join(dir, "packages/client/src/app"), { recursive: true });
  writeFileSync(join(dir, "packages/client/src/app/robots.ts"), "// mine\n", "utf-8");
  const ctx = makeContext(dir);
  const result = applyDocsInClient(ctx);
  assert.equal(readFileSync(join(dir, "packages/client/src/app/robots.ts"), "utf-8"), "// mine\n");
  assert.ok(
    !written(ctx).includes("packages/client/src/app/robots.ts"),
    "the existing robots route must not be rewritten",
  );
  assert.ok(
    result.notes.some((n) => n.includes("https://example.test/docs/sitemap.xml")),
    "and the note must say which sitemap line is missing from it",
  );
});

check("force overwrites the robots route", () => {
  const dir = makeProject("forced", true);
  mkdirSync(join(dir, "packages/client/src/app"), { recursive: true });
  writeFileSync(join(dir, "packages/client/src/app/robots.ts"), "// mine\n", "utf-8");
  applyDocsInClient(makeContext(dir, { force: true }));
  assert.match(
    readFileSync(join(dir, "packages/client/src/app/robots.ts"), "utf-8"),
    /MetadataRoute/,
  );
});

check("a backend-only project is skipped with a reason", () => {
  const dir = makeProject("backend", true);
  const ctx = makeContext(dir, { surfaces: "backend" });
  const result = applyDocsInClient(ctx);
  assert.deepEqual(ctx.ledger.entries, [], "a skipped module touches nothing at all");
  assert.match(result.skipped ?? "", /no client image/);
  assert.ok(!existsSync(join(dir, "scripts/docs/build-into-client.mjs")));
});

check("a static project still gets the docs", () => {
  // No server half is no reason to have no documentation.
  const dir = makeProject("static", true);
  const ctx = makeContext(dir, { surfaces: "static" });
  const result = applyDocsInClient(ctx);
  assert.equal(result.skipped, undefined);
  assert.ok(written(ctx).includes("scripts/docs/build-into-client.mjs"));
});

check("a custom base path reaches every artefact", () => {
  const dir = makeProject("handbook", true);
  applyDocsInClientAt(makeContext(dir), { basePath: "handbook" });
  const script = readFileSync(join(dir, "scripts/docs/build-into-client.mjs"), "utf-8");
  assert.match(script, /export const PUBLISHED_PREFIX = "https:\/\/example\.test\/handbook\/";/);
  assert.match(script, /export const DOCS_BASE_PATH = "\/handbook\/";/);
  const robots = sitemapsInRobotsRoute(
    readFileSync(join(dir, "packages/client/src/app/robots.ts"), "utf-8"),
  );
  assert.ok(robots.includes("https://example.test/handbook/sitemap.xml"));
  const links = readFileSync(join(dir, "packages/client/src/lib/docs-links.ts"), "utf-8");
  assert.match(links, /https:\/\/example\.test\/handbook\//);
});

rmSync(tmp, { recursive: true, force: true });
rmSync(process.env.HATCHKIT_CONF_DIR, { recursive: true, force: true });

if (failures.length > 0) {
  console.log(`\n${failures.length} failure(s):`);
  for (const f of failures) console.log(f);
  process.exit(1);
}
console.log("\n  all docs-in-client checks passed\n");
