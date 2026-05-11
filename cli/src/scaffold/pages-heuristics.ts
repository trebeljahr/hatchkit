// Static-site sanity checks for projects targeting GitHub Pages.
//
// Run BEFORE pushing a project at `hatchkit gh-pages` so users with
// a Next.js server, a docker-compose backend, or a `packages/server`
// don't end up with a successful CI run and a 404 in production.
//
// Surfaces three severity levels:
//   · block — almost certainly won't work; refuse to proceed unless
//             the user explicitly overrides.
//   · warn  — likely won't function as designed; show + confirm.
//   · info  — nothing's broken but the user should know (e.g.
//             `next/image` needs `unoptimized: true` on static export).

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export type WarningLevel = "block" | "warn" | "info";

export interface PagesWarning {
  level: WarningLevel;
  /** Short headline (single line). */
  title: string;
  /** Longer explanation of WHY this is a problem on Pages. */
  detail: string;
  /** Paths that triggered the finding, relative to the project root.
   *  Empty when the finding is config- rather than file-based. */
  evidence: string[];
}

interface ScanFiles {
  /** All `package.json` files (excluding node_modules / build output). */
  packageJsons: Array<{ path: string; content: PackageJson }>;
  /** Files / directories matched by path-pattern probes. */
  matches: Map<string, string[]>;
}

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: unknown;
}

const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "out",
  ".turbo",
  ".cache",
  "coverage",
  ".vercel",
]);

// How deep we walk. Most repos that fit a Pages deploy are shallow
// (<= 4 levels); deeper than that is almost always vendored code we
// don't want to surface heuristics about.
const MAX_DEPTH = 5;

/** Walk a project directory and collect the inputs the per-rule
 *  checks need. One disk pass per repo — every rule reads from the
 *  same {@link ScanFiles} struct. */
function scan(projectDir: string): ScanFiles {
  const packageJsons: ScanFiles["packageJsons"] = [];
  const matches = new Map<string, string[]>();

  const probeDirNames = new Set([
    "packages",
    "apps",
    "services",
    "api",
  ]);
  // File names + suffixes we want to record sightings of.
  const fileProbes: Array<{ key: string; match: (filename: string) => boolean }> = [
    { key: "nextConfig", match: (n) => /^next\.config\.(?:ts|js|mjs|cjs)$/.test(n) },
    { key: "middleware", match: (n) => /^middleware\.(?:ts|js)$/.test(n) },
    { key: "dockerfile", match: (n) => n === "Dockerfile" },
    { key: "dockerCompose", match: (n) => /^docker-compose(\..+)?\.ya?ml$/.test(n) },
  ];

  const visit = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (EXCLUDED_DIRS.has(name)) continue;
      const fullPath = join(dir, name);
      let s: ReturnType<typeof statSync>;
      try {
        s = statSync(fullPath);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        if (probeDirNames.has(name)) {
          const arr = matches.get(`dir:${name}`) ?? [];
          arr.push(relative(fullPath, projectDir));
          matches.set(`dir:${name}`, arr);
        }
        if (name === "api") {
          const parent = basename(dir);
          if (parent === "app" || parent === "pages") {
            const arr = matches.get(`nextApiRoutes`) ?? [];
            arr.push(relative(fullPath, projectDir));
            matches.set("nextApiRoutes", arr);
          }
        }
        visit(fullPath, depth + 1);
        continue;
      }
      if (!s.isFile()) continue;

      if (name === "package.json") {
        try {
          const content = JSON.parse(readFileSync(fullPath, "utf8")) as PackageJson;
          packageJsons.push({ path: fullPath, content });
        } catch {
          // unreadable / invalid — skip
        }
        continue;
      }
      for (const probe of fileProbes) {
        if (probe.match(name)) {
          const arr = matches.get(probe.key) ?? [];
          arr.push(relative(fullPath, projectDir));
          matches.set(probe.key, arr);
        }
      }
    }
  };

  if (existsSync(projectDir) && statSync(projectDir).isDirectory()) {
    visit(projectDir, 0);
  }

  return { packageJsons, matches };
}

function relative(p: string, root: string): string {
  if (p.startsWith(root)) return p.slice(root.length + 1);
  return p;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

/** Detect a Next.js project. Returns the paths of every `next.config.*`
 *  found AND a flag for whether each one declares `output: "export"`.
 *  Anything else (`output: "standalone"`, missing key, etc.) blocks
 *  Pages — Next without static export produces a Node server bundle,
 *  not the flat `out/` Pages can serve. */
function checkNextStaticExport(files: ScanFiles, projectDir: string): PagesWarning | null {
  const configs = files.matches.get("nextConfig") ?? [];
  if (configs.length === 0) return null;

  const bad: string[] = [];
  for (const rel of configs) {
    let content: string;
    try {
      content = readFileSync(join(projectDir, rel), "utf8");
    } catch {
      continue;
    }
    // `output: "export"` — accept both single and double quotes,
    // and the `output:'export'` (no space) form. We don't try to
    // statically evaluate the file — a simple regex is right 99% of
    // the time and false-positives are user-fixable.
    const hasExport = /output\s*:\s*['"]export['"]/.test(content);
    if (!hasExport) bad.push(rel);
  }
  if (bad.length === 0) return null;

  return {
    level: "block",
    title: "Next.js without `output: \"export\"`",
    detail:
      "GitHub Pages serves static files only. Without `output: \"export\"` in your next.config, Next builds a Node server bundle that Pages can't host. Either set `output: \"export\"` (and remove any server-only features) or deploy somewhere with a runtime (Vercel / Coolify).",
    evidence: bad,
  };
}

/** Next's `middleware.ts` runs server-side per request — incompatible
 *  with static export. Different from regular page rendering. */
function checkNextMiddleware(files: ScanFiles): PagesWarning | null {
  const middleware = files.matches.get("middleware") ?? [];
  // Only treat as a problem when there's also a Next config — `middleware.ts`
  // in a non-Next project is just a file.
  if (middleware.length === 0) return null;
  const hasNext = (files.matches.get("nextConfig") ?? []).length > 0;
  if (!hasNext) return null;
  return {
    level: "block",
    title: "Next.js middleware present",
    detail:
      "Next's `middleware.ts` runs per request and isn't available on static export. Pages can't execute it. Remove the middleware or deploy to a runtime that supports it.",
    evidence: middleware,
  };
}

/** API routes (`app/api/*` or `pages/api/*`) are server-only on Next.
 *  Static export drops them silently — the user gets a successful
 *  build and broken endpoints in prod. */
function checkNextApiRoutes(files: ScanFiles): PagesWarning | null {
  const routes = files.matches.get("nextApiRoutes") ?? [];
  if (routes.length === 0) return null;
  return {
    level: "warn",
    title: "Next.js API routes present",
    detail:
      "`app/api/*` and `pages/api/*` are server-only — static export silently drops them. Anything that fetches `/api/...` from the client will 404 on Pages. Move the API to a separate backend (Coolify / a different host) or remove these routes.",
    evidence: routes,
  };
}

/** A second package or workspace dir that looks like a backend
 *  (packages/server, apps/server, apps/api, services/*). Static
 *  Pages can't run these. */
function checkServerPackages(files: ScanFiles): PagesWarning | null {
  const evidence: string[] = [];
  const packagesDirs = files.matches.get("dir:packages") ?? [];
  const appsDirs = files.matches.get("dir:apps") ?? [];
  const servicesDirs = files.matches.get("dir:services") ?? [];

  // Common backend folder names under packages/ or apps/. We can't
  // walk into them again here (visit already did), so trust naming.
  // Find package.jsons whose directory name screams "backend".
  for (const pkg of files.packageJsons) {
    const dirName = basename(pkg.path.replace(/\/package\.json$/, ""));
    if (/^(server|api|backend|worker)$/i.test(dirName)) {
      evidence.push(pkg.path.replace(/^.*\/packages\//, "packages/").replace(/^.*\/apps\//, "apps/"));
    }
  }

  // services/<thing>/Dockerfile typically signals a deployable service.
  const dockerfiles = files.matches.get("dockerfile") ?? [];
  for (const df of dockerfiles) {
    if (df.startsWith("services/") || df.startsWith("apps/server/") || df.startsWith("packages/server/")) {
      evidence.push(df);
    }
  }

  // Dedup against signal noise from packagesDirs / appsDirs / servicesDirs.
  if (evidence.length === 0 && servicesDirs.length === 0 && packagesDirs.length === 0 && appsDirs.length === 0) {
    return null;
  }
  if (evidence.length === 0) return null;

  const unique = Array.from(new Set(evidence));
  return {
    level: "warn",
    title: "Backend / server packages detected",
    detail:
      "These directories look like they ship a server (Dockerfile, server/api/worker package). GitHub Pages can't host them. If your client calls these from the browser, the calls will fail in production unless the backend lives somewhere else. Consider Coolify for the full-stack deploy.",
    evidence: unique,
  };
}

/** Server-only deps in any package.json (mongodb, postgres, redis,
 *  prisma, etc.). Catches projects where someone imported a DB driver
 *  intending to use it server-side. */
function checkServerDeps(files: ScanFiles): PagesWarning | null {
  const serverDeps = new Map<string, string>([
    ["mongoose", "MongoDB driver"],
    ["mongodb", "MongoDB driver"],
    ["pg", "Postgres driver"],
    ["postgres", "Postgres driver"],
    ["mysql2", "MySQL driver"],
    ["redis", "Redis client"],
    ["ioredis", "Redis client"],
    ["@prisma/client", "Prisma ORM"],
    ["prisma", "Prisma ORM"],
    ["drizzle-orm", "Drizzle ORM"],
    ["better-auth", "server-side auth"],
    ["next-auth", "server-side auth"],
    ["socket.io", "WebSocket server"],
    ["ws", "WebSocket server"],
    ["express", "HTTP server framework"],
    ["hono", "HTTP server framework"],
    ["fastify", "HTTP server framework"],
    ["koa", "HTTP server framework"],
    ["@trpc/server", "tRPC server"],
  ]);
  const findings: string[] = [];
  for (const pkg of files.packageJsons) {
    const allDeps = { ...(pkg.content.dependencies ?? {}), ...(pkg.content.devDependencies ?? {}) };
    for (const dep of Object.keys(allDeps)) {
      const reason = serverDeps.get(dep);
      if (reason) {
        const rel = pkg.path.replace(/.*\//, "");
        const dirHint = pkg.path
          .replace(/\/package\.json$/, "")
          .split("/")
          .slice(-2)
          .join("/");
        findings.push(`${dep} (${reason}) — ${dirHint}/${rel}`);
      }
    }
  }
  if (findings.length === 0) return null;
  return {
    level: "warn",
    title: "Server-side dependencies in package.json",
    detail:
      "These packages only do useful work on a server. On Pages they'll either be dead weight in the client bundle or import-fail at build. Make sure they're tree-shaken out of any client entrypoint, or migrate to a deploy target that runs Node.",
    evidence: findings,
  };
}

/** docker-compose typically describes a multi-service runtime —
 *  Pages can't host that. Soft warn rather than block: some projects
 *  keep compose around for local dev only. */
function checkDockerCompose(files: ScanFiles): PagesWarning | null {
  const composes = files.matches.get("dockerCompose") ?? [];
  if (composes.length === 0) return null;
  return {
    level: "info",
    title: "docker-compose.yml present",
    detail:
      "Compose describes services hatchkit can't deploy to Pages. If it's local-dev-only, you can leave it; otherwise, anything it spins up won't exist in production.",
    evidence: composes,
  };
}

/** Static export drops `next/image` optimization — needs `unoptimized:
 *  true` or use a third-party loader. Info-level: the build won't fail,
 *  but images will be unoptimized at runtime. */
function checkNextImageUnoptimized(files: ScanFiles, projectDir: string): PagesWarning | null {
  const configs = files.matches.get("nextConfig") ?? [];
  if (configs.length === 0) return null;
  const missing: string[] = [];
  for (const rel of configs) {
    try {
      const content = readFileSync(join(projectDir, rel), "utf8");
      if (!/images\s*:\s*\{[^}]*unoptimized\s*:\s*true/s.test(content)) {
        missing.push(rel);
      }
    } catch {
      // skip
    }
  }
  if (missing.length === 0) return null;
  return {
    level: "info",
    title: "`images.unoptimized: true` not set",
    detail:
      "Static export can't run the Next image optimizer. Set `images: { unoptimized: true }` in next.config or images will fail to load (especially with `<Image>`). hatchkit's scaffold path can apply this automatically.",
    evidence: missing,
  };
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/** Run every check against `projectDir` and return the union of
 *  findings, ordered block > warn > info. Returns an empty array
 *  when nothing's wrong. */
export function detectPagesIncompatibilities(projectDir: string): PagesWarning[] {
  const files = scan(projectDir);
  const checks: Array<PagesWarning | null> = [
    checkNextStaticExport(files, projectDir),
    checkNextMiddleware(files),
    checkNextApiRoutes(files),
    checkServerPackages(files),
    checkServerDeps(files),
    checkDockerCompose(files),
    checkNextImageUnoptimized(files, projectDir),
  ];

  const order: Record<WarningLevel, number> = { block: 0, warn: 1, info: 2 };
  return checks
    .filter((w): w is PagesWarning => w !== null)
    .sort((a, b) => order[a.level] - order[b.level]);
}

export function hasBlockingFinding(warnings: PagesWarning[]): boolean {
  return warnings.some((w) => w.level === "block");
}
