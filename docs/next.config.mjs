import { createMDX } from "fumadocs-mdx/next";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  output: "export",
  deploymentId: process.env.NEXT_PUBLIC_BUILD_COMMIT,
  images: { unoptimized: true },
  turbopack: {
    root: __dirname,
  },
};

export default withMDX(config);
