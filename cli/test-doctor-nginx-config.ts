/**
 * `hatchkit doctor` — static-site Dockerfiles that serve nginx with its
 * stock config.
 *
 * bd31421 made the adopt scaffold write nginx.conf next to the static
 * Dockerfile and copy it over /etc/nginx/conf.d/default.conf. Without
 * it a Vite SPA 404s on reload of every client-side route, and a build
 * that writes `about.html` 404s on `/about`. Projects adopted before
 * that commit still have the old Dockerfile, and this check is the only
 * thing that tells them.
 *
 * The properties that keep it useful:
 *   1. It flags the pre-bd31421 runner stage and nothing the scaffold
 *      writes today: not the current static Dockerfile, not the Next.js
 *      or server ones.
 *   2. Only the final stage counts, including one it inherits through
 *      `FROM <stage>`. A config copied into a build stage never ships.
 *   3. Any config placed under /etc/nginx/ clears it — COPY, ADD, RUN,
 *      or a compose mount — and a commented-out line doesn't.
 *   4. It reads the Dockerfile in the manifest's `projectSubdir`.
 *   5. It WARNS, and the hint carries both fixes, with the config
 *      rendered for this project's build shape.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  checkProjectNginxConfigState,
  composeMountsNginxConfig,
  dockerfileNginxRuntime,
} from "./src/doctor.js";
import {
  type ScaffoldBuildPipelineInput,
  scaffoldBuildPipeline,
} from "./src/scaffold/build-pipeline.js";

const failures: string[] = [];

async function expect(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}: ${(err as Error).message}`);
    console.log(`  ✗ ${label}: ${(err as Error).message}`);
  }
}

console.log("\n  test-doctor-nginx-config\n");

const VITE_PKG = JSON.stringify({ name: "demo", devDependencies: { vite: "^7" } });
const ASTRO_PKG = JSON.stringify({ name: "demo", dependencies: { astro: "^5" } });
const NEXT_PKG = JSON.stringify({ name: "demo", dependencies: { next: "^16" } });

const COPY_CONF = "COPY nginx.conf /etc/nginx/conf.d/default.conf";

/** The runner stage every static project adopted before bd31421 has. */
const OLD_RUNNER = [
  "FROM node:22-alpine AS build",
  "WORKDIR /app",
  "COPY . .",
  "RUN pnpm build",
  "",
  "FROM nginx:alpine AS runner",
  "COPY --from=build /app/dist /usr/share/nginx/html",
  "EXPOSE 80",
  "",
].join("\n");

const lines = (...l: string[]) => `${l.join("\n")}\n`;

/** Fresh dir holding `files` (paths may have one subdir level), handed
 *  to `check`, then removed. */
async function withProject(
  files: Record<string, string>,
  check: (dir: string) => void | Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "hk-doctor-nginx-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    await check(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** What adopt writes for a coolify project: the build pipeline, then
 *  the manifest at the repo root. */
function adoptInto(
  root: string,
  opts: { subdir?: string; surfaces?: ScaffoldBuildPipelineInput["surfaces"] } = {},
): string {
  const projectDir = opts.subdir ? join(root, opts.subdir) : root;
  scaffoldBuildPipeline({
    projectDir,
    repoRoot: root,
    projectSubdir: opts.subdir,
    projectName: "demo",
    ghOwner: "acme",
    entrypoint: opts.surfaces === "static" || !opts.surfaces ? "" : "dist/index.js",
    port: 3000,
    surfaces: opts.surfaces ?? "static",
    domain: "demo.example.com",
    defaultBranch: "main",
  });
  writeFileSync(
    join(root, ".hatchkit.json"),
    JSON.stringify({
      name: "demo",
      deploymentMode: "coolify",
      ...(opts.subdir ? { projectSubdir: opts.subdir } : {}),
    }),
  );
  return projectDir;
}

/** Turn a freshly scaffolded Dockerfile back into its pre-bd31421 self. */
function dropConfigCopy(dockerfilePath: string): void {
  const before = readFileSync(dockerfilePath, "utf-8");
  const after = before.replace(`${COPY_CONF}\n`, "");
  assert.notEqual(after, before, "the scaffolded Dockerfile no longer has the COPY line");
  writeFileSync(dockerfilePath, after);
}

// ── 1. What gets flagged ────────────────────────────────────────────

await expect("the pre-bd31421 runner stage is nginx without a config", () => {
  assert.deepEqual(dockerfileNginxRuntime(OLD_RUNNER), {
    image: "nginx:alpine",
    configured: false,
  });
});

await expect("any tag, digest, platform flag or registry of the official image counts", () => {
  for (const ref of [
    "nginx",
    "nginx:1.27-alpine",
    "nginx:stable-alpine@sha256:0123abcd",
    "NGINX:alpine",
    "library/nginx:alpine",
    "docker.io/nginx:alpine",
    "docker.io/library/nginx:alpine",
    "public.ecr.aws/nginx/nginx:alpine",
    "localhost:5000/nginx:alpine",
    "nginx:$NGINX_VERSION-alpine",
  ]) {
    const runtime = dockerfileNginxRuntime(lines(`FROM ${ref}`, "COPY dist /usr/share/nginx/html"));
    assert.equal(runtime?.configured, false, ref);
    assert.equal(runtime?.image, ref, ref);
  }
  const flagged = dockerfileNginxRuntime(lines("FROM --platform=$TARGETPLATFORM nginx:alpine"));
  assert.equal(flagged?.image, "nginx:alpine");
});

await expect("other images, and nginx images from other vendors, are left alone", () => {
  for (const ref of [
    "node:22-alpine",
    "caddy:2",
    "bitnami/nginx:latest",
    "nginxinc/nginx-unprivileged:alpine",
    "ghcr.io/acme/nginx:latest",
    "$RUNTIME_IMAGE",
  ]) {
    assert.equal(dockerfileNginxRuntime(lines(`FROM ${ref}`)), undefined, ref);
  }
  assert.equal(dockerfileNginxRuntime(""), undefined);
});

await expect("only the final stage decides, directly or through FROM <stage>", () => {
  // nginx build stage, Node runtime → not an nginx image at all.
  assert.equal(
    dockerfileNginxRuntime(lines("FROM nginx:alpine AS conf", COPY_CONF, "FROM node:22-alpine")),
    undefined,
  );
  // A config copied into an earlier, separate nginx stage never ships.
  assert.equal(
    dockerfileNginxRuntime(
      lines("FROM nginx:alpine AS scratchpad", COPY_CONF, "FROM nginx:alpine AS runner"),
    )?.configured,
    false,
  );
  // A final stage built on a configured stage inherits its config.
  assert.deepEqual(
    dockerfileNginxRuntime(
      lines("FROM nginx:alpine AS base", COPY_CONF, "FROM base AS runner", "EXPOSE 80"),
    ),
    { image: "nginx:alpine", configured: true },
  );
  // Two hops, config nowhere.
  assert.deepEqual(
    dockerfileNginxRuntime(
      lines("FROM nginx:1.27 AS Base", "FROM base AS mid", "FROM mid", "EXPOSE 80"),
    ),
    { image: "nginx:1.27", configured: false },
  );
});

// ── 2. What counts as a config ──────────────────────────────────────

await expect("any COPY, ADD or RUN into /etc/nginx/ configures it", () => {
  for (const line of [
    COPY_CONF,
    "COPY nginx.conf /etc/nginx/nginx.conf",
    "COPY --from=build /app/nginx.conf /etc/nginx/conf.d/default.conf",
    "COPY default.conf.template /etc/nginx/templates/",
    "ADD site.conf /etc/nginx/conf.d/",
    "copy nginx.conf /etc/nginx/conf.d/default.conf",
    `RUN printf 'server { listen 80; }' > /etc/nginx/conf.d/default.conf`,
  ]) {
    const df = lines("FROM nginx:alpine", "COPY dist /usr/share/nginx/html", line);
    assert.equal(dockerfileNginxRuntime(df)?.configured, true, line);
  }
});

await expect("a COPY split over continuation lines still counts", () => {
  const df = lines(
    "FROM nginx:alpine",
    "COPY --chown=nginx:nginx \\",
    "  # a comment line inside the continuation",
    "  nginx.conf \\",
    "  /etc/nginx/conf.d/default.conf",
  );
  assert.equal(dockerfileNginxRuntime(df)?.configured, true);
});

await expect("a commented-out COPY does not count", () => {
  const df = lines("FROM nginx:alpine", `# ${COPY_CONF}`, `   #${COPY_CONF}`);
  assert.equal(dockerfileNginxRuntime(df)?.configured, false);
});

await expect("a compose mount into /etc/nginx/ counts, a commented one doesn't", () => {
  assert.ok(
    composeMountsNginxConfig(
      lines(
        "services:",
        "  web:",
        "    volumes:",
        "      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro",
      ),
    ),
  );
  assert.ok(
    composeMountsNginxConfig(
      lines(
        "services:",
        "  web:",
        "    configs:",
        "      - source: site",
        "        target: /etc/nginx/conf.d/default.conf",
      ),
    ),
  );
  assert.ok(
    !composeMountsNginxConfig(
      lines(
        "services:",
        "  web:",
        "    # volumes:",
        "    #   - ./nginx.conf:/etc/nginx/conf.d/default.conf",
      ),
    ),
  );
  assert.ok(
    !composeMountsNginxConfig(
      lines("services:", "  web:", "    image: ghcr.io/acme/demo:latest  # see /etc/nginx"),
    ),
  );
});

// ── 3. Against what the scaffold writes ─────────────────────────────

await expect("today's static scaffold is ok", async () => {
  await withProject({ "package.json": VITE_PKG }, async (dir) => {
    adoptInto(dir);
    const rows = await checkProjectNginxConfigState(dir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "ok", rows[0].detail);
    assert.equal(rows[0].name, "Project demo (nginx config)");
  });
});

await expect("the scaffold with its COPY line removed warns", async () => {
  await withProject({ "package.json": VITE_PKG }, async (dir) => {
    adoptInto(dir);
    dropConfigCopy(join(dir, "Dockerfile"));
    rmSync(join(dir, "nginx.conf"));
    const [row, ...rest] = await checkProjectNginxConfigState(dir);
    assert.equal(rest.length, 0);
    assert.equal(row.status, "warn");
    assert.match(row.detail ?? "", /^Dockerfile runs nginx:alpine .*404 on reload/);
  });
});

await expect("Next.js and server Dockerfiles are not nginx images", async () => {
  await withProject(
    { "package.json": NEXT_PKG, "next.config.ts": "export default {};\n" },
    async (dir) => {
      adoptInto(dir);
      assert.match(readFileSync(join(dir, "Dockerfile"), "utf-8"), /^FROM node:/m);
      assert.deepEqual(await checkProjectNginxConfigState(dir), []);
    },
  );
  await withProject({ "package.json": VITE_PKG }, async (dir) => {
    adoptInto(dir, { surfaces: "split" });
    assert.deepEqual(await checkProjectNginxConfigState(dir), []);
  });
});

await expect("a compose file that mounts a config clears it", async () => {
  await withProject({ "package.json": VITE_PKG, Dockerfile: OLD_RUNNER }, async (dir) => {
    adoptInto(dir);
    writeFileSync(
      join(dir, "docker-compose.yml"),
      lines(
        "services:",
        "  web:",
        "    image: ghcr.io/acme/demo:latest",
        "    volumes:",
        "      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro",
      ),
    );
    const [row] = await checkProjectNginxConfigState(dir);
    assert.equal(row.status, "ok");
    assert.match(row.detail ?? "", /docker-compose\.yml mounts/);
  });
});

// ── 4. projectSubdir ────────────────────────────────────────────────

await expect("the Dockerfile is read from the manifest's projectSubdir", async () => {
  // Old Dockerfile in the subdir, a Node one at the root: flagged, and
  // every path in the output is subdir-qualified.
  await withProject(
    { "site/package.json": VITE_PKG, Dockerfile: "FROM node:22\n" },
    async (dir) => {
      const siteDir = adoptInto(dir, { subdir: "site" });
      writeFileSync(join(siteDir, "Dockerfile"), OLD_RUNNER);
      rmSync(join(siteDir, "nginx.conf"));
      const [row] = await checkProjectNginxConfigState(dir);
      assert.equal(row.status, "warn");
      assert.match(row.detail ?? "", /^site\/Dockerfile /);
      const hint = (row.hint ?? []).join("\n");
      assert.ok(hint.includes("save this as site/nginx.conf"), hint);
      assert.ok(hint.includes("stage of site/Dockerfile"), hint);
    },
  );
  // The reverse: an old Dockerfile at the root is not the one that ships.
  await withProject({ "site/package.json": VITE_PKG, Dockerfile: OLD_RUNNER }, async (dir) => {
    adoptInto(dir, { subdir: "./site/" });
    const [row] = await checkProjectNginxConfigState(dir);
    assert.equal(row.status, "ok", row.detail);
  });
});

// ── 5. The warning itself ───────────────────────────────────────────

await expect("it warns, and the hint carries both fixes with this project's config", async () => {
  await withProject({ "package.json": VITE_PKG, Dockerfile: OLD_RUNNER }, async (dir) => {
    adoptInto(dir);
    const [row] = await checkProjectNginxConfigState(dir);
    assert.equal(row.status, "warn");
    const hint = (row.hint ?? []).join("\n");
    assert.ok(hint.includes("404"), hint);
    assert.ok(hint.includes("hatchkit adopt --resume --regenerate-pipeline"), hint);
    assert.ok(
      hint.includes("Dockerfile, docker-compose.yml and .github/workflows/deploy.yml"),
      hint,
    );
    assert.ok(hint.includes(`      ${COPY_CONF}`), hint);
    assert.ok(hint.includes("stage of Dockerfile"), hint);
    // The Vite config, rendered, comments dropped.
    assert.ok(hint.includes("try_files $uri $uri.html $uri/index.html /index.html;"), hint);
    assert.ok(hint.includes("location ~ \\.[^/]*$ {"), hint);
    assert.ok(!/^\s*#/m.test(hint), "a template comment leaked into the hint");
  });
});

await expect("an Astro project's hint renders the 404-not-home-page config", async () => {
  await withProject({ "package.json": ASTRO_PKG, Dockerfile: OLD_RUNNER }, async (dir) => {
    adoptInto(dir);
    const hint = ((await checkProjectNginxConfigState(dir))[0].hint ?? []).join("\n");
    assert.ok(hint.includes("try_files $uri $uri.html $uri/index.html =404;"), hint);
    assert.ok(!hint.includes("/index.html;"), hint);
  });
});

await expect("an nginx.conf nothing copies in gets the COPY line alone", async () => {
  const server = "server {\n    listen 80;\n}\n";
  await withProject(
    { "package.json": VITE_PKG, Dockerfile: OLD_RUNNER, "nginx.conf": server },
    async (dir) => {
      adoptInto(dir);
      const hint = ((await checkProjectNginxConfigState(dir))[0].hint ?? []).join("\n");
      assert.ok(hint.includes("nginx.conf is already there"), hint);
      assert.ok(hint.includes(COPY_CONF), hint);
      assert.ok(!hint.includes("save this as"), hint);
      // Regenerating would replace it too — say so.
      assert.ok(hint.includes("docker-compose.yml, nginx.conf and"), hint);
    },
  );
  // A whole nginx.conf (`http {}`) replaces the main config instead.
  const main = "events {}\nhttp {\n    server { listen 80; }\n}\n";
  await withProject(
    { "package.json": VITE_PKG, Dockerfile: OLD_RUNNER, "nginx.conf": main },
    async (dir) => {
      adoptInto(dir);
      const hint = ((await checkProjectNginxConfigState(dir))[0].hint ?? []).join("\n");
      assert.ok(hint.includes("COPY nginx.conf /etc/nginx/nginx.conf"), hint);
    },
  );
});

await expect("no manifest, or a mode adopt writes no Dockerfile for, stays quiet", async () => {
  await withProject({ Dockerfile: OLD_RUNNER }, async (dir) => {
    assert.deepEqual(await checkProjectNginxConfigState(dir), []);
    for (const deploymentMode of ["gh-pages", "cloudflare", "scaffold-only"]) {
      writeFileSync(join(dir, ".hatchkit.json"), JSON.stringify({ name: "demo", deploymentMode }));
      assert.deepEqual(await checkProjectNginxConfigState(dir), [], deploymentMode);
    }
    // Legacy manifest with no mode is coolify.
    writeFileSync(join(dir, ".hatchkit.json"), JSON.stringify({ name: "demo" }));
    assert.equal((await checkProjectNginxConfigState(dir))[0]?.status, "warn");
  });
});

console.log("");
if (failures.length > 0) {
  console.error(`  ${failures.length} test(s) failed:`);
  for (const f of failures) console.error(`    · ${f}`);
  process.exit(1);
} else {
  console.log("  all tests passed");
}
