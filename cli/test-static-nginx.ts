/**
 * Tests for the nginx config `scaffoldBuildPipeline` writes next to the
 * static-site Dockerfile (`Dockerfile.client.hbs`).
 *
 * The stock nginx:alpine config maps a URL straight onto a file. A Vite
 * SPA then 404s on a reload of any client-side route, and a build that
 * writes `about.html` 404s on `/about`. hatchkit's own docs image hit the
 * same gap on 2026-09-28 (see docs/nginx.conf).
 *
 * Covers:
 *   · The Dockerfile copies the config over the stock default.conf.
 *   · A Vite build falls back to index.html, but never for a path that
 *     names a file — a missing hashed chunk stays a 404.
 *   · An Astro build 404s unknown paths instead of answering with the
 *     home page.
 *   · The config is written only alongside the nginx Dockerfile, and a
 *     user's existing nginx.conf is kept unless `force` is set.
 *   · It still listens on the port the compose healthcheck probes, and
 *     deploy-recovery can insert its no-cache rule into it.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILD_INFO_PATH } from "./src/features/deploy-recovery/index.js";
import { upgradeNginxConf } from "./src/features/deploy-recovery/serving.js";
import {
  detectSpaFallback,
  type ScaffoldBuildPipelineInput,
  type ScaffoldBuildPipelineResult,
  scaffoldBuildPipeline,
  servesWithNginx,
} from "./src/scaffold/build-pipeline.js";

const failures: string[] = [];

function expect(label: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}: ${(err as Error).message}`);
    console.log(`  ✗ ${label}: ${(err as Error).message}`);
  }
}

console.log("\n  test-static-nginx\n");

const VITE_PKG = { name: "demo", devDependencies: { vite: "^7" } };
const ASTRO_PKG = { name: "demo", dependencies: { astro: "^5" } };

/** Scaffold into a fresh dir holding `files`, hand the dir and the
 *  result to `check`, clean up. */
function scaffold(
  files: Record<string, string>,
  overrides: Partial<ScaffoldBuildPipelineInput>,
  check: (dir: string, result: ScaffoldBuildPipelineResult) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), "hk-static-nginx-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      writeFileSync(join(dir, rel), content);
    }
    const result = scaffoldBuildPipeline({
      projectDir: dir,
      projectName: "demo",
      ghOwner: "acme",
      entrypoint: "",
      port: 3000,
      surfaces: "static",
      domain: "demo.example.com",
      defaultBranch: "main",
      ...overrides,
    });
    check(dir, result);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const pkg = (json: object) => ({ "package.json": JSON.stringify(json) });
const read = (dir: string, rel: string) => readFileSync(join(dir, rel), "utf-8");

expect("the static Dockerfile copies nginx.conf over the stock default.conf", () => {
  scaffold(pkg(VITE_PKG), {}, (dir, result) => {
    const df = read(dir, "Dockerfile");
    const runner = df.slice(df.indexOf("FROM nginx:alpine AS runner"));
    assert.ok(runner.startsWith("FROM nginx:alpine"), "runner stage missing");
    // In the runner stage, from the build context — the config never
    // passes through the build stage's `COPY . .`.
    assert.ok(runner.includes("\nCOPY nginx.conf /etc/nginx/conf.d/default.conf\n"), runner);
    assert.ok(runner.includes("COPY --from=build /app/dist /usr/share/nginx/html"));
    assert.ok(existsSync(join(dir, "nginx.conf")));
    // Recorded as created, so the adopt ledger can roll it back.
    assert.ok(result.created.includes("nginx.conf"), result.created.join(", "));
    assert.ok(result.createdAbs.includes(join(dir, "nginx.conf")));
  });
});

expect("a Vite build falls back to index.html for client-side routes", () => {
  scaffold(pkg(VITE_PKG), {}, (dir) => {
    const conf = read(dir, "nginx.conf");
    assert.ok(conf.includes("try_files $uri $uri.html $uri/index.html /index.html;"), conf);
    assert.ok(!conf.includes("{{"), "unrendered Handlebars left in the config");
    assert.ok(conf.includes("nginx config for demo's static image"));
  });
});

expect("a Vite build never answers a missing file with index.html", () => {
  scaffold(pkg(VITE_PKG), {}, (dir) => {
    const conf = read(dir, "nginx.conf");
    // A regex location, so it wins over `location /` for any path whose
    // last segment has a dot — a stale `/assets/index-3f2a.js` is a 404,
    // not a 200 of HTML the CDN then caches under a .js URL.
    const m = conf.match(/location ~ (\S+) \{\s*try_files \$uri =404;\s*\}/);
    assert.ok(m, `no file-only location:\n${conf}`);
    const re = new RegExp(m[1]);
    for (const file of ["/assets/index-3f2a.js", "/favicon.ico", "/index.html", "/a/b.c.css"]) {
      assert.ok(re.test(file), `${file} should be treated as a file`);
    }
    for (const route of ["/", "/settings", "/users/42/", "/.well-known/thing", "/v.1/users"]) {
      assert.ok(!re.test(route), `${route} should reach the SPA fallback`);
    }
  });
});

expect("an Astro build 404s unknown paths instead of serving the home page", () => {
  scaffold(pkg(ASTRO_PKG), {}, (dir) => {
    const conf = read(dir, "nginx.conf");
    assert.ok(conf.includes("try_files $uri $uri.html $uri/index.html =404;"), conf);
    assert.ok(!conf.includes("/index.html;"), "Astro build must not fall back to index.html");
    assert.ok(conf.includes("error_page 404 /404.html;"));
  });
  // A config file alone is enough — the dep can live in a parent workspace.
  scaffold({ "astro.config.mjs": "export default {};" }, {}, (dir) => {
    assert.ok(read(dir, "nginx.conf").includes("$uri/index.html =404;"));
  });
});

expect("spa fallback detection", () => {
  const dir = mkdtempSync(join(tmpdir(), "hk-spa-detect-"));
  try {
    assert.equal(detectSpaFallback(dir), true, "no package.json");
    writeFileSync(join(dir, "package.json"), JSON.stringify(VITE_PKG));
    assert.equal(detectSpaFallback(dir), true, "vite");
    writeFileSync(join(dir, "package.json"), JSON.stringify(ASTRO_PKG));
    assert.equal(detectSpaFallback(dir), false, "astro dep");
    writeFileSync(join(dir, "package.json"), "{ not json");
    assert.equal(detectSpaFallback(dir), true, "malformed package.json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

expect("nginx listens on the port the compose healthcheck probes", () => {
  scaffold(pkg(VITE_PKG), {}, (dir) => {
    const conf = read(dir, "nginx.conf");
    const compose = read(dir, "docker-compose.yml");
    assert.ok(/^\s*listen\s+80;$/m.test(conf), conf);
    assert.ok(conf.includes("root         /usr/share/nginx/html;"));
    assert.ok(compose.includes('- "80"'), "compose should expose 80");
    assert.ok(compose.includes("wget --quiet --tries=1 --spider http://127.0.0.1:80/"), compose);
  });
});

expect("no nginx.conf for a Next.js static site or a server surface", () => {
  scaffold(pkg({ name: "demo", dependencies: { next: "^15" } }), {}, (dir, result) => {
    assert.ok(!existsSync(join(dir, "nginx.conf")), "Next.js runs `next start`, not nginx");
    assert.ok(!result.written.includes("nginx.conf"));
  });
  scaffold(pkg(VITE_PKG), { surfaces: "fullstack" }, (dir, result) => {
    assert.ok(!existsSync(join(dir, "nginx.conf")));
    assert.ok(!result.skipped.includes("nginx.conf"));
  });
  const dir = mkdtempSync(join(tmpdir(), "hk-serves-nginx-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify(VITE_PKG));
    assert.equal(servesWithNginx(dir, "static"), true);
    assert.equal(servesWithNginx(dir, "split"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

expect("a kept user Dockerfile gets no nginx.conf it would never read", () => {
  const files = { ...pkg(VITE_PKG), Dockerfile: "FROM nginx\n" };
  scaffold(files, {}, (dir, result) => {
    assert.equal(read(dir, "Dockerfile"), "FROM nginx\n");
    assert.ok(!existsSync(join(dir, "nginx.conf")));
    assert.ok(!result.written.includes("nginx.conf"));
  });
});

expect("an existing nginx.conf is kept, and replaced only with force", () => {
  const mine = "server {\n    listen 80;\n}\n";
  const files = { ...pkg(VITE_PKG), "nginx.conf": mine };
  scaffold(files, {}, (dir, result) => {
    assert.equal(read(dir, "nginx.conf"), mine);
    assert.ok(result.skipped.includes("nginx.conf"), result.skipped.join(", "));
    // The Dockerfile it writes still reads it.
    assert.ok(read(dir, "Dockerfile").includes("COPY nginx.conf "));
  });
  scaffold(files, { force: true }, (dir, result) => {
    assert.ok(read(dir, "nginx.conf").includes("/index.html;"));
    // The file was the user's: overwritten, never recorded as created.
    assert.ok(result.overwritten.includes("nginx.conf"));
    assert.ok(!result.created.includes("nginx.conf"));
  });
});

expect("deploy-recovery can add its no-cache rule to the written config", () => {
  for (const json of [VITE_PKG, ASTRO_PKG]) {
    scaffold(pkg(json), {}, (dir) => {
      const conf = read(dir, "nginx.conf");
      // upgradeNginxConf treats any mention of the path as "already
      // there", so the template must not name it, not even in a comment.
      assert.ok(!conf.includes(BUILD_INFO_PATH), `config already names ${BUILD_INFO_PATH}`);
      const upgrade = upgradeNginxConf(conf, BUILD_INFO_PATH);
      assert.ok(upgrade.changed, upgrade.notes.join("; "));
      assert.ok(upgrade.content.includes(`location = ${BUILD_INFO_PATH} {`));
    });
  }
});

console.log("");
if (failures.length > 0) {
  console.error(`  ${failures.length} test(s) failed:`);
  for (const f of failures) console.error(`    · ${f}`);
  process.exit(1);
} else {
  console.log("  all tests passed");
}
