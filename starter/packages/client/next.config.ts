import path from "node:path";
import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";
const isExport = process.env.NEXT_FILE_EXPORT === "1";
// Electron resolves the export through a custom app:// scheme and is happy
// with a relative asset prefix; Capacitor is not (see below).
const isElectronBuild = process.env.ELECTRON_BUILD === "1";

// Each native shell gets its OWN export directory, named by the build
// script that writes it:
//
//   out          web / Playwright (Playwright bakes a throwaway loopback
//                API port into its build)
//   out-desktop  scripts/build-desktop.mjs  (Electron)
//   out-mobile   scripts/build-mobile.mjs   (Capacitor)
//
// A shared directory means a test run can silently be installed as the
// app — `cap run` syncs implicitly, so nothing would say so.
//
// Under `output: "export"` Next treats `distDir` as the OUT directory and
// forces the build directory back to `.next`. That is also why a dev
// server holding `.next` blocks a production export: build-mobile.mjs
// refuses to run while one is live rather than racing it.
const exportDir = process.env.NEXT_EXPORT_DIR || "out";

// Deployable production builds — the web client image (Dockerfile sets
// HATCHKIT_IMAGE_BUILD=1) and native static exports (NEXT_FILE_EXPORT=1)
// — must receive NEXT_PUBLIC_API_URL at build time. Next.js inlines
// NEXT_PUBLIC_* into the bundle during `next build`; supplying them only
// at container runtime silently ships a bundle with no (or a localhost)
// API URL. Fail the build loudly instead.
if (
  !isDev &&
  (isExport || process.env.HATCHKIT_IMAGE_BUILD === "1") &&
  !process.env.NEXT_PUBLIC_API_URL
) {
  throw new Error(
    "NEXT_PUBLIC_API_URL is not set. This is a production build whose output " +
      "ships to users, and Next.js bakes NEXT_PUBLIC_* values in at build time. " +
      "Pass it as a Docker build arg (web image — see " +
      ".github/workflows/build-and-deploy.yml) or as env on the build step " +
      "(desktop/mobile release workflows). Runtime container env cannot fix this.",
  );
}

const nextConfig: NextConfig = {
  ...(isDev
    ? {}
    : isExport
      ? {
          // Static export for the native shells.
          output: "export" as const,
          distDir: exportDir,
          // A relative asset prefix rewrites every `/_next/...` reference
          // to `./_next/...`, which resolves against the CURRENT path. It
          // works for a single-page load and breaks every nested route the
          // moment the WebView is at `/app/settings/`. Electron's app://
          // handler resolves relative paths itself, so it can keep it;
          // Capacitor cannot, and build-mobile.mjs fails the build when it
          // finds `"./_next` in any emitted HTML.
          ...(isElectronBuild ? { assetPrefix: "./" } : {}),
        }
      : {
          // Standalone build for the web server image (Coolify Dockerfile).
          // Trace from the monorepo root so the standalone bundle includes
          // workspace deps (@starter/shared, @starter/server).
          // process.cwd() is `<repo>/packages/client` during `next build`.
          output: "standalone" as const,
          outputFileTracingRoot: path.join(process.cwd(), "..", ".."),
        }),
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: ["@starter/shared", "@starter/server"],
  // Android live reload: Next 16 blocks cross-origin requests for /_next
  // dev resources, and under `pnpm dev:android` the document is served
  // from the emulator's view of the host (http://10.0.2.2:<port>), which
  // is cross-origin to the dev server. Without this the document loads,
  // every chunk is blocked, and the app sits on a splash that
  // `launchAutoHide: false` never hides. scripts/android-dev.sh exports
  // NEXT_DEV_ORIGINS.
  allowedDevOrigins: (process.env.NEXT_DEV_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // Proxy API and WS requests to Express server in development
  async rewrites() {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:5000";
    return [
      { source: "/api/:path*", destination: `${apiUrl}/api/:path*` },
    ];
  },
};

export default nextConfig;
