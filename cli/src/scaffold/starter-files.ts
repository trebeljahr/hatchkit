/*
 * Per-file customization helpers for scaffoldApp.
 *
 * These edits run after the starter has been copied into the output
 * directory. Each helper is a pure function over one file (or a small
 * group of files), so they're easy to unit-test in isolation.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectConfig } from "../prompts.js";
import type { ProjectPorts } from "../utils/ports.js";
import { readPackageName, readWorkspacePackageNames, setPackageJsonScript } from "./pkg-json.js";

/** Literal string replacement across a file. Safe for any content —
 *  `replaceAll` is literal (no regex interpretation). */
export function replaceInFile(filePath: string, search: string, replace: string): void {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, "utf-8");
  writeFileSync(filePath, content.replaceAll(search, replace), "utf-8");
}

/** Rewrite a file via a pure transform. No-op if the file is missing. */
export function rewriteFile(path: string, fn: (content: string) => string): void {
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf-8");
  writeFileSync(path, fn(content), "utf-8");
}

export function removeIfExists(path: string): void {
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
  }
}

/** Rewrite a server or client .env.example to use production URLs for
 *  the project's domain. Swaps in TRUSTED_ORIGINS for native clients
 *  when desktop or mobile is selected. Idempotent on repeat runs. */
export function updateEnvExample(outputDir: string, relPath: string, config: ProjectConfig): void {
  const path = join(outputDir, relPath);
  if (!existsSync(path)) return;

  const { domain } = config;
  const appUrl = `https://${domain}`;
  const apiUrl = `https://api.${domain}`;
  const wsUrl = `wss://api.${domain}`;

  let content = readFileSync(path, "utf-8");

  // Targeted line-level rewrites. Each regex anchors on `KEY=` so stray
  // "localhost" mentions inside comments / other keys aren't affected.
  const rewrites: Array<[RegExp, string]> = [
    [/^FRONTEND_URL=.*$/m, `FRONTEND_URL=${appUrl}`],
    [/^BETTER_AUTH_URL=.*$/m, `BETTER_AUTH_URL=${apiUrl}`],
    [/^NEXT_PUBLIC_API_URL=.*$/m, `NEXT_PUBLIC_API_URL=${apiUrl}`],
    [/^NEXT_PUBLIC_WS_URL=.*$/m, `NEXT_PUBLIC_WS_URL=${wsUrl}`],
  ];
  for (const [re, replacement] of rewrites) {
    content = content.replace(re, replacement);
  }

  // Pre-populate TRUSTED_ORIGINS for native clients so the commented
  // guidance in the starter's .env.example is replaced with a working
  // default the user only has to uncomment.
  const wantsDesktop = config.features.includes("desktop");
  const wantsMobile = config.features.includes("mobile");
  if ((wantsDesktop || wantsMobile) && /^#\s*TRUSTED_ORIGINS=/m.test(content)) {
    const origins: string[] = [];
    if (wantsMobile) origins.push("capacitor://localhost", "https://localhost");
    if (wantsDesktop) origins.push("app://-");
    content = content.replace(/^#\s*TRUSTED_ORIGINS=.*$/m, `TRUSTED_ORIGINS=${origins.join(",")}`);
  }

  writeFileSync(path, content, "utf-8");
}

/** Strip the MobileBridgeLoader import + mount from the client layout
 *  when mobile isn't selected. Leaves the rest of the layout alone. */
export function stripMobileBridgeFromLayout(outputDir: string): void {
  const path = join(outputDir, "packages/client/src/app/layout.tsx");
  if (!existsSync(path)) return;
  let content = readFileSync(path, "utf-8");
  content = content.replace(
    /import\s*\{\s*MobileBridgeLoader\s*\}\s*from\s*["']@\/mobile\/MobileBridgeLoader["'];\n/,
    "",
  );
  content = content.replace(/\s*<MobileBridgeLoader\s*\/>\n/, "\n");
  writeFileSync(path, content, "utf-8");
}

/** Overwrite `packages/client/next.config.ts` with a known-good
 *  static-export config. `transpilePackages` is populated from the
 *  actual workspace package names so a starter rename doesn't break
 *  the exported client build. */
export function flipNextConfigToStaticExport(outputDir: string): void {
  const path = join(outputDir, "packages/client/next.config.ts");
  if (!existsSync(path)) return;
  const clientName = readPackageName(join(outputDir, "packages/client"));
  const transpile = readWorkspacePackageNames(outputDir).filter((n) => n !== clientName);
  const transpileList = transpile.map((n) => `"${n}"`).join(", ");
  const staticExportConfig = `import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  assetPrefix: "./",
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: [${transpileList}],
};

export default nextConfig;
`;
  writeFileSync(path, staticExportConfig, "utf-8");
}

/** Rewrite every file in the starter that hard-codes the old default
 *  ports (3000/5000) so each scaffolded project has its own coherent
 *  port set. Targets covered:
 *    • packages/server/.env.development       (PORT + URLs)
 *    • packages/server/.env.example           (PORT line added)
 *    • packages/client/.env.development       (PORT + API + WS URLs)
 *    • packages/client/.env.example           (PORT line added)
 *    • packages/server/Dockerfile             (ENV PORT, EXPOSE)
 *    • packages/client/Dockerfile             (ENV PORT, EXPOSE)
 *    • docker-compose.yml                      (server PORT env)
 *    • scripts/dev.mjs                         (fixed-mode defaults)
 *    • electron/main.ts                        (DEV_URL fallback)
 *    • scripts/android-dev.sh + ios-dev.sh    (NEXT_PORT default)
 *    • package.json dev:desktop script        (Next port + wait-on)
 */
export function applyPorts(
  outputDir: string,
  ports: ProjectPorts,
  opts: { wantsDesktop: boolean; wantsMobile: boolean },
): void {
  const { server, client, nativeHmr } = ports;

  // .env.development (server) — set PORT + update URLs pointing at localhost:5000
  rewriteFile(join(outputDir, "packages/server/.env.development"), (c) => {
    let out = c;
    if (/^PORT=/m.test(out)) {
      out = out.replace(/^PORT=.*$/m, `PORT=${server}`);
    } else {
      out = `PORT=${server}\n${out}`;
    }
    out = out.replace(/localhost:5000/g, `localhost:${server}`);
    return out;
  });

  // .env.development (client) — set PORT + API/WS URLs
  rewriteFile(join(outputDir, "packages/client/.env.development"), (c) => {
    let out = c;
    if (/^PORT=/m.test(out)) {
      out = out.replace(/^PORT=.*$/m, `PORT=${client}`);
    } else {
      out = `PORT=${client}\n${out}`;
    }
    out = out.replace(
      /^NEXT_PUBLIC_API_URL=.*$/m,
      `NEXT_PUBLIC_API_URL=http://localhost:${server}`,
    );
    out = out.replace(/^NEXT_PUBLIC_WS_URL=.*$/m, `NEXT_PUBLIC_WS_URL=ws://localhost:${server}`);
    return out;
  });

  // .env.example files: add PORT line if missing, else overwrite.
  for (const [rel, port] of [
    ["packages/server/.env.example", server] as const,
    ["packages/client/.env.example", client] as const,
  ]) {
    rewriteFile(join(outputDir, rel), (c) => {
      if (/^PORT=/m.test(c)) return c.replace(/^PORT=.*$/m, `PORT=${port}`);
      return `PORT=${port}\n${c}`;
    });
  }

  // Server + client Dockerfiles: port-bearing lines.
  rewriteFile(join(outputDir, "packages/server/Dockerfile"), (c) =>
    c
      .replace(/ENV PORT=\d+/g, `ENV PORT=${server}`)
      .replace(/EXPOSE \d+/g, `EXPOSE ${server}`)
      .replace(/\|\|'\d+'\)/g, `||'${server}')`),
  );
  rewriteFile(join(outputDir, "packages/client/Dockerfile"), (c) =>
    c
      .replace(/ENV PORT=\d+/g, `ENV PORT=${client}`)
      .replace(/EXPOSE \d+/g, `EXPOSE ${client}`)
      .replace(/\|\|'\d+'\)/g, `||'${client}')`),
  );

  // docker-compose.yml: server PORT first (appears first in file),
  // then the client PORT if present.
  rewriteFile(join(outputDir, "docker-compose.yml"), (c) => {
    let out = c.replace(/PORT:\s*"3000"/, `PORT: "${server}"`);
    out = out.replace(/PORT:\s*"3000"/, `PORT: "${client}"`);
    return out;
  });

  // scripts/dev.mjs: bump fixed-mode defaults + the comment header
  // that documents the default ports.
  rewriteFile(join(outputDir, "scripts/dev.mjs"), (c) =>
    c
      .replace(/clientPort = 3000/g, `clientPort = ${client}`)
      .replace(/apiPort = 5000/g, `apiPort = ${server}`)
      .replace(
        /client 3000, docs 4000, server 5000/g,
        `client ${client}, docs 4000, server ${server}`,
      ),
  );

  // Native HMR port — only wired when desktop or mobile is selected.
  if (nativeHmr === undefined) return;

  rewriteFile(join(outputDir, "electron/main.ts"), (c) =>
    c.replace(
      /const DEV_URL = process\.env\.ELECTRON_DEV_URL \|\| "http:\/\/localhost:\d+"/,
      `const DEV_URL = process.env.ELECTRON_DEV_URL || "http://localhost:${nativeHmr}"`,
    ),
  );

  for (const script of ["scripts/android-dev.sh", "scripts/ios-dev.sh"]) {
    rewriteFile(join(outputDir, script), (c) =>
      c.replace(/NEXT_PORT="\$\{NEXT_PORT:-\d+\}"/, `NEXT_PORT="\${NEXT_PORT:-${nativeHmr}}"`),
    );
  }

  // Root package.json: dev:desktop needs PORT + wait-on retargeted at
  // nativeHmr so web-dev and desktop-dev don't stomp each other.
  if (opts.wantsDesktop) {
    const clientPkgName = readPackageName(join(outputDir, "packages/client")) ?? "@starter/client";
    setPackageJsonScript(
      outputDir,
      "dev:desktop",
      `concurrently -k -n next,electron -c blue,magenta ` +
        `"PORT=${nativeHmr} pnpm --filter ${clientPkgName} dev" ` +
        `"wait-on http://localhost:${nativeHmr} && pnpm electron:compile && ` +
        `ELECTRON_DEV_URL=http://localhost:${nativeHmr} electron electron/main.js"`,
    );
  }
}
