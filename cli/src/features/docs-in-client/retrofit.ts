/*
 * cli/src/features/docs-in-client/retrofit.ts — the three files this feature
 * edits rather than writes.
 *
 * The docs build has to happen in exactly two places: inside the web image,
 * after the client build, so the deployed artefact carries them; and on a
 * pull request, so a broken docs link fails the change rather than the image
 * build after merge. And the docs site itself has to be told the one address
 * it is published at, because everything the audit checks — the canonical
 * link on every page, every entry of the sitemap — is written from it.
 *
 * All three files already exist in a scaffolded project, and all three may
 * have been edited by hand. So every transform here follows the rule the
 * rest of the codebase follows: it is idempotent, and it returns its input
 * UNCHANGED when the anchor it needs is missing. A Dockerfile that
 * half-builds the docs is worse than one that does not build them at all —
 * the first fails every image build, the second fails nothing and is
 * reported as a note the user can act on.
 */

import {
  CLIENT_PACKAGE_DIR,
  DEFAULT_DOCS_PACKAGE,
  DOCS_SCRIPT_REL_PATH,
  type DocsLayout,
} from "./paths.js";
import { docsVerifyWorkflowStep } from "./render.js";

/** The directory holding the copy step, as the Dockerfile has to copy it. */
const DOCS_SCRIPT_DIR = DOCS_SCRIPT_REL_PATH.slice(0, DOCS_SCRIPT_REL_PATH.lastIndexOf("/"));

/** The Dockerfile block that builds the docs into the image.
 *
 *  The comment is as long as it is on purpose. Every line of it is a reason
 *  somebody would otherwise have to rediscover, and the first thing a reader
 *  in a hurry does with a build step they do not understand is move it into
 *  the client package's own build script — which is the one thing this must
 *  never do. */
function docsBuildBlock(layout: DocsLayout): string {
  return `# The docs, published at ${layout.publishedPrefix}. Built HERE, in the web
# image, and NEVER added to the client package's own build script: that
# script also produces the export the end-to-end suite serves and the bundle
# the native shells ship, and none of those should carry the docs. Only the
# web image wants them.
#
# This runs after the client build because it copies into the client's build
# output. It exits non-zero if any page would ship a noindex directive, if a
# canonical link or a sitemap entry points outside ${layout.publishedPrefix},
# or if the docs bring a robots file of their own — the failures that look
# exactly like a successful build.
#
# There is no git in this stage and no repository in the build context, so
# the docs sitemap carries no last-modified dates. The docs config must not
# reach for a git binary: one with no repository around it fails outright.
RUN node ${DOCS_SCRIPT_REL_PATH}
`;
}

/** True once the Dockerfile carries the docs step. */
export function dockerfileHasDocsStep(content: string): boolean {
  return content.includes(DOCS_SCRIPT_REL_PATH);
}

/**
 * Build the docs into the web client's image, after the client build.
 *
 * Three edits, because the step needs its inputs in the image: the docs
 * package's manifest in the dependency stage, its sources and the copy step
 * in the build stage, and the `RUN` itself after the last workspace build.
 *
 * All three or none. A Dockerfile that copies the docs sources but never
 * builds them is dead weight; one that runs the step without the sources
 * fails every image build. When any anchor is missing — a hand-rolled
 * Dockerfile, a layout that is not `packages/client` — the content comes
 * back untouched and the caller reports it.
 */
export function upgradeClientDockerfileDocs(content: string, layout: DocsLayout): string {
  if (dockerfileHasDocsStep(content)) return content;
  if (!content.includes(CLIENT_PACKAGE_DIR)) return content;
  const docsPackage = layout.docsPackage || DEFAULT_DOCS_PACKAGE;

  // The dependency stage copies one manifest per workspace package; the docs
  // package's belongs beside them, so `pnpm install` resolves it.
  const manifestCopies = [...content.matchAll(/^COPY \S+\/package\.json \S+\/$/gm)];
  // The build stage copies each package's sources. `COPY <pkg>/package.json`
  // is excluded by the pattern above requiring no `package.json` here.
  const sourceCopies = [...content.matchAll(/^COPY packages\/(?!\S*package\.json)\S+ \S+$/gm)];
  // The client build. The docs are copied into its output, so they come after.
  const builds = [...content.matchAll(/^RUN pnpm --filter \S+ run build(?=\r?$)/gm)];

  const lastManifest = manifestCopies[manifestCopies.length - 1];
  const lastSource = sourceCopies[sourceCopies.length - 1];
  const lastBuild = builds[builds.length - 1];
  if (!lastManifest || !lastSource || !lastBuild) return content;
  if (
    lastManifest.index === undefined ||
    lastSource.index === undefined ||
    lastBuild.index === undefined
  ) {
    return content;
  }

  // Bottom-up, so each splice leaves the earlier offsets valid.
  let out = content;
  const afterBuild = lastBuild.index + lastBuild[0].length;
  out = `${out.slice(0, afterBuild)}\n\n${docsBuildBlock(layout).replace(/\n$/, "")}${out.slice(afterBuild)}`;

  const afterSource = lastSource.index + lastSource[0].length;
  out = `${out.slice(0, afterSource)}\n# The docs site and the step that builds it into the client's output.\nCOPY ${docsPackage} ${docsPackage}\nCOPY ${DOCS_SCRIPT_DIR} ${DOCS_SCRIPT_DIR}${out.slice(afterSource)}`;

  const afterManifest = lastManifest.index + lastManifest[0].length;
  out = `${out.slice(0, afterManifest)}\nCOPY ${docsPackage}/package.json ${docsPackage}/${out.slice(afterManifest)}`;

  return out;
}

/** True once the workflow runs the docs check. */
export function workflowHasDocsCheck(content: string): boolean {
  return content.includes(`${DOCS_SCRIPT_REL_PATH} --check`);
}

/**
 * Add the docs check to the deploy workflow's `verify` job.
 *
 * The verify job is where it belongs: it already runs on pull requests, it
 * already installs the workspace, and the check needs nothing else. A
 * separate job would pay for a second checkout and a second install to run a
 * single command.
 *
 * Anchored on the job named `verify` under `jobs:`, and on its `steps:`
 * list. Returns the content unchanged when either is missing — the caller
 * then writes the standalone workflow instead, which is the honest answer
 * for a project whose pipeline does not look like the generated one.
 */
export function upgradeWorkflowDocsCheck(content: string): string {
  if (workflowHasDocsCheck(content)) return content;
  const job = findWorkflowJob(content, "verify");
  if (!job) return content;
  return `${content.slice(0, job.end)}${reindentStep(docsVerifyWorkflowStep(), job.stepIndent)}${content.slice(job.end)}`;
}

/** Where a job's steps live, and where a new one goes. */
interface WorkflowJobSpan {
  /** Offset just past the job's last non-blank line. */
  end: number;
  /** Column its `- name:` / `- uses:` entries start at. */
  stepIndent: number;
}

/** Locate one job of a workflow by name.
 *
 *  Deliberately strict: the name has to be a key under a top-level `jobs:`,
 *  and the job has to declare a `steps:` list with at least one entry. A
 *  `verify:` key somewhere else in the file, or a job built out of a
 *  reusable workflow (`uses:` with no steps of its own), is not something a
 *  step can be appended to. */
function findWorkflowJob(content: string, name: string): WorkflowJobSpan | undefined {
  const lines = content.split("\n");
  const jobsIdx = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (jobsIdx === -1) return undefined;

  const header = new RegExp(`^(\\s+)${name}:\\s*$`);
  const start = lines.findIndex((l, i) => i > jobsIdx && header.test(l));
  if (start === -1) return undefined;
  const jobIndent = lines[start].length - lines[start].trimStart().length;

  let last = start;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    if (lines[i].length - lines[i].trimStart().length <= jobIndent) {
      end = i;
      break;
    }
    last = i;
  }

  const body = lines.slice(start, end);
  const stepsRel = body.findIndex((l) => /^\s+steps:\s*$/.test(l));
  if (stepsRel === -1) return undefined;
  const firstStep = body.slice(stepsRel + 1).find((l) => /^\s+- /.test(l));
  if (!firstStep) return undefined;

  let offset = 0;
  for (let i = 0; i <= last; i++) offset += lines[i].length + 1;
  return {
    end: Math.min(offset, content.length),
    stepIndent: firstStep.length - firstStep.trimStart().length,
  };
}

/** Re-indent a rendered step, which is written for a six-column steps list,
 *  to whatever column this workflow uses. */
function reindentStep(step: string, indent: number): string {
  if (indent === 6) return step;
  const shift = indent - 6;
  return step
    .split("\n")
    .map((line) => {
      if (!line.trim()) return line;
      return shift > 0
        ? `${" ".repeat(shift)}${line}`
        : line.slice(Math.min(-shift, line.length - line.trimStart().length));
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// The docs site's own configuration
// ---------------------------------------------------------------------------

/** The `const siteUrl = "…";` line of a generated docs config, with the
 *  address itself as the second group — one pattern for both reading the
 *  value back and replacing it, so the reader cannot come to recognise a
 *  shape the writer no longer produces. */
const SITE_URL_ANCHOR = /^(const siteUrl = ")([^"\n]*)(";)$/m;

/** The `const baseUrl = "…";` line, same shape. */
const BASE_URL_ANCHOR = /^(const baseUrl = ")([^"\n]*)(";)$/m;

/** The address a docs config declares, as far as it can be read back. */
export interface DocsSiteConfigAddress {
  /** `https://example.com` — the origin, without a trailing slash. */
  url?: string;
  /** `/docs/` — the base path. */
  baseUrl?: string;
}

/**
 * Read the address out of a docs config.
 *
 * Anchored on the same two declarations {@link upgradeDocsSiteConfig}
 * writes, and deliberately nothing else: the question this answers is "did
 * the address hatchkit is responsible for end up in the file", and a config
 * that spells its address some other way is one hatchkit did not write and
 * must not claim to have set. Such a file comes back as an empty address,
 * which is what makes the caller say what to set by hand rather than
 * reporting a rewrite that never happened.
 *
 * A literal is all this reads. An expression — `process.env.DOCS_SITE_URL ??
 * "https://docs.example.com"` — does not match, and rightly so: that shape
 * is the bug the whole feature exists to prevent, not an address.
 */
export function docsSiteConfigAddress(content: string): DocsSiteConfigAddress {
  return {
    url: content.match(SITE_URL_ANCHOR)?.[2],
    baseUrl: content.match(BASE_URL_ANCHOR)?.[2],
  };
}

/**
 * Point a docs config at this project's own literal address.
 *
 * The docs site is the one thing that decides what the audit will see: it
 * writes the canonical link on every page and every `<loc>` of the sitemap
 * from its own `url` + `baseUrl`. A site built for one address and published
 * at another produces a tree where every page is fine to read and every
 * canonical link hands its ranking to a host that does not exist — so the
 * copy step fails the build, correctly, and the user is left to work out
 * which of two addresses was the wrong one. Setting it here means the
 * question never arises.
 *
 * Two literal `const` declarations are substituted, never an expression.
 * That is the whole point of the shape: a config that reads its address from
 * a variable falls back to a placeholder, and a placeholder pairs with
 * `noIndex`, no sitemap and a `Disallow: /` robots file. One build
 * environment without the variable — the image build — then ships all three
 * with nothing failing anywhere.
 *
 * Idempotent, because it rewrites the value rather than looking for a
 * particular one. Returns its input unchanged when the anchors are missing,
 * which is a hand-rolled config: rewriting a file whose shape is unknown is
 * how a working docs build is broken by an upgrade.
 */
export function upgradeDocsSiteConfig(content: string, layout: DocsLayout): string {
  return content
    .replace(SITE_URL_ANCHOR, `$1${layout.origin}$3`)
    .replace(BASE_URL_ANCHOR, `$1${layout.basePath}$3`);
}
