import path from "node:path";
import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";
const isExport = process.env.NEXT_FILE_EXPORT === "1";

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
          // Static export for desktop (Electron) + mobile (Capacitor) shells.
          output: "export" as const,
          assetPrefix: "./",
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
  // Proxy API and WS requests to Express server in development
  async rewrites() {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:5000";
    return [
      { source: "/api/:path*", destination: `${apiUrl}/api/:path*` },
    ];
  },
};

export default nextConfig;
