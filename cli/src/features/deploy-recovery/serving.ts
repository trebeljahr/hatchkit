/*
 * cli/src/features/deploy-recovery/serving.ts — the server half of the
 * agreement: the build-info file must never be cached.
 *
 * The tab fetches it with `cache: "no-store"`, which stops the tab's own
 * HTTP cache from answering. That is only half the problem. The file is
 * served by the client image like any other static asset, and every
 * layer between — the framework's own static handler, a CDN, a reverse
 * proxy — is free to hold on to it. A cached build-info file is the
 * worst possible failure of this feature: it does not error, it reports
 * the commit the tab already has, and the offer that would have fixed
 * the stale tab never appears. Everything else the image serves is
 * hashed and may be cached forever; this one file is the exception.
 *
 * Two shapes are covered, and both transforms are idempotent and return
 * their input UNCHANGED when the anchor is missing — a hand-rolled
 * config is safer left alone than half-rewritten.
 *
 * The self-host proxy config is deliberately NOT touched here.
 */

/** Cache-Control the build-info file is served with. `no-store` rather
 *  than `no-cache`, because `no-cache` still lets an intermediary keep
 *  a copy and revalidate it, and a revalidation that a proxy answers
 *  from its own store is exactly the failure above. */
export const BUILD_INFO_CACHE_CONTROL = "no-store, must-revalidate";

/** What changed in a config, so the caller can report it honestly. */
export interface ServingUpgrade {
  content: string;
  /** The content differs from the input. */
  changed: boolean;
  /** The no-cache rule is present now — whether this call added it or
   *  found it already there. */
  noCacheRule: boolean;
  /** The built commit reaches browser code now. */
  commitInlined: boolean;
  /** Anything the caller has to finish by hand. */
  notes: string[];
}

/** Anchor: the config object literal every generated and almost every
 *  hand-written Next config declares. */
const NEXT_CONFIG_ANCHOR = /^(const\s+nextConfig\s*(?::\s*NextConfig\s*)?=\s*\{)[ \t]*\r?\n/m;

/** A `headers()` of any spelling already in the config. */
const EXISTING_HEADERS = /^\s*(async\s+)?headers\s*[(:]/m;

/** An `env` key already in the config. */
const EXISTING_ENV = /^\s*env\s*:/m;

export interface NextConfigOptions {
  /** Path the build-info file is served at. */
  buildInfoPath: string;
  /** The `NEXT_PUBLIC_*` name the bundle reads its own commit from. */
  commitEnvVar: string;
  /** The build arg the image already carries the commit in. */
  commitSourceVar?: string;
}

/**
 * Add the two things the browser half needs from the Next config: the
 * built commit inlined into the bundle, and the no-cache rule on the
 * build-info file.
 *
 * The commit has to travel through the config because a bundler inlines
 * `NEXT_PUBLIC_*` at BUILD time — runtime container env never reaches
 * browser code, so the `COMMIT_SHA` the image already carries is
 * invisible to a tab unless something republishes it under a name the
 * bundler will inline. Doing it here costs no change to the Dockerfile
 * or the workflow, both of which already set `COMMIT_SHA`.
 *
 * An existing `headers()` or `env` key is left alone and reported: those
 * are hand-written, merging into them blind is how a config ends up with
 * two `headers` keys and the second one silently winning.
 */
export function upgradeNextConfig(content: string, opts: NextConfigOptions): ServingUpgrade {
  const commitSourceVar = opts.commitSourceVar ?? "COMMIT_SHA";
  const hasCommit = content.includes(opts.commitEnvVar);
  const hasNoCache = content.includes(opts.buildInfoPath) && content.includes("Cache-Control");
  const notes: string[] = [];

  const match = content.match(NEXT_CONFIG_ANCHOR);
  if (!match || match.index === undefined) {
    return {
      content,
      changed: false,
      noCacheRule: hasNoCache,
      commitInlined: hasCommit,
      notes: [
        `No \`const nextConfig = {\` in the client config — add the ${opts.commitEnvVar} inlining and the no-cache header on ${opts.buildInfoPath} by hand`,
      ],
    };
  }

  let block = "";
  if (!hasCommit) {
    if (EXISTING_ENV.test(content)) {
      notes.push(
        `The client config already has an \`env\` key — add ${opts.commitEnvVar}: process.env.${commitSourceVar} ?? "" to it by hand`,
      );
    } else {
      block +=
        `  // The commit this bundle was built from, inlined so an open tab\n` +
        `  // can compare itself with the deployed build info. The image build\n` +
        `  // already sets ${commitSourceVar}; this is the step that gets it into\n` +
        `  // BROWSER code, because NEXT_PUBLIC_* values are inlined at build\n` +
        `  // time and runtime container env never reaches the bundle. Empty\n` +
        `  // outside an image build, which disables the check — which is what\n` +
        `  // a local build should do.\n` +
        `  env: { ${opts.commitEnvVar}: process.env.${commitSourceVar} ?? "" },\n`;
    }
  }
  if (!hasNoCache) {
    if (EXISTING_HEADERS.test(content)) {
      notes.push(
        `The client config already defines headers() — add a ${opts.buildInfoPath} entry with Cache-Control: ${BUILD_INFO_CACHE_CONTROL} to it by hand`,
      );
    } else {
      block +=
        `  // ${opts.buildInfoPath} must never be cached. A tab that outlived a\n` +
        `  // deploy fetches it to find out, and a cached copy answers with the\n` +
        `  // commit that tab already has: no error, no offer, and the stale tab\n` +
        `  // stays stale. Every other asset is hashed and may be cached for\n` +
        `  // ever. (A static export serves files directly and ignores this —\n` +
        `  // set the rule on the file server there instead.)\n` +
        `  async headers() {\n` +
        `    return [\n` +
        `      {\n` +
        `        source: "${opts.buildInfoPath}",\n` +
        `        headers: [{ key: "Cache-Control", value: "${BUILD_INFO_CACHE_CONTROL}" }],\n` +
        `      },\n` +
        `    ];\n` +
        `  },\n`;
    }
  }

  if (block === "") {
    return { content, changed: false, noCacheRule: hasNoCache, commitInlined: hasCommit, notes };
  }

  const head = content.slice(0, match.index + match[0].length);
  const tail = content.slice(match.index + match[0].length);
  return {
    content: `${head}${block}${tail}`,
    changed: true,
    noCacheRule: true,
    commitInlined: true,
    notes,
  };
}

/** The nginx rule, for a project whose client image serves the bundle
 *  with nginx. Exported so it can be printed as a note for a project
 *  that has no nginx.conf to retrofit. */
export function nginxNoCacheLocation(buildInfoPath: string): string {
  return (
    `    # The build-info file an open tab compares itself against. Never\n` +
    `    # cached: a cached copy reports the commit that tab already has,\n` +
    `    # so the offer that would fix the stale tab never appears.\n` +
    `    location = ${buildInfoPath} {\n` +
    `        add_header Cache-Control "${BUILD_INFO_CACHE_CONTROL}" always;\n` +
    `    }\n`
  );
}

/** Anchor: the opening of a server block. */
const NGINX_SERVER_ANCHOR = /^([ \t]*)server\s*\{[ \t]*\r?\n/m;

/**
 * Insert the no-cache rule into an existing nginx config.
 *
 * Only ever applied to a config the project already has: writing a whole
 * nginx.conf where none existed would replace the image's default server
 * block, and getting that wrong takes the site down rather than
 * degrading it. Unchanged when there is no `server {` to insert into.
 */
export function upgradeNginxConf(content: string, buildInfoPath: string): ServingUpgrade {
  if (content.includes(buildInfoPath)) {
    return { content, changed: false, noCacheRule: true, commitInlined: false, notes: [] };
  }
  const match = content.match(NGINX_SERVER_ANCHOR);
  if (!match || match.index === undefined) {
    return {
      content,
      changed: false,
      noCacheRule: false,
      commitInlined: false,
      notes: [
        `No \`server {\` block in the client nginx config — add the no-cache rule for ${buildInfoPath} by hand`,
      ],
    };
  }
  const at = match.index + match[0].length;
  return {
    content: `${content.slice(0, at)}${nginxNoCacheLocation(buildInfoPath)}${content.slice(at)}`,
    changed: true,
    noCacheRule: true,
    commitInlined: false,
    notes: [],
  };
}
