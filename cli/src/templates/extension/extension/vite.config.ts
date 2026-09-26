import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { BUILD_TARGETS, RELEASE_VERSION, buildManifest, type BuildMode } from "./manifest.config";

const fromHere = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

/**
 * Vite's own mode string is free-form; the build targets are not.
 * Anything other than the three known modes is a typo worth failing on
 * rather than silently building a development bundle and calling it
 * production.
 */
const resolveMode = (mode: string): BuildMode => {
  if (mode === "development" || mode === "production" || mode === "firefox") return mode;
  throw new Error(
    `Unknown build mode "${mode}". Use --mode development, --mode production or --mode firefox.`,
  );
};

/**
 * Writes the manifest for the target being built.
 *
 * Generated rather than copied, because the name, the
 * `externally_connectable` list, the background entry and the pinned
 * key all differ per target — a static public/manifest.json could only
 * ever describe one of them.
 */
const manifestPlugin = (mode: BuildMode): Plugin => ({
  name: "__HATCHKIT_PROJECT_SLUG__:manifest",
  generateBundle() {
    this.emitFile({
      type: "asset",
      fileName: "manifest.json",
      source: `${JSON.stringify(buildManifest(mode), null, 2)}\n`,
    });
  },
});

export default defineConfig(({ mode }) => {
  const buildMode = resolveMode(mode);
  const target = BUILD_TARGETS[buildMode];

  return {
    plugins: [manifestPlugin(buildMode)],
    // The popup HTML is emitted at dist/src/popup/index.html but its JS
    // lands at the dist root. Vite's default base ("/") would point at
    // chrome-extension://<id>/popup.js, which only resolves because the
    // extension root happens to be the URL root — a relative base emits
    // ../../popup.js instead, so the bundle is self-contained.
    base: "./",
    publicDir: "public",
    define: {
      // Baked in as the DEFAULT API origin, overridable at runtime from
      // the popup's server picker. A define rather than a .env file
      // because `.env.*` is commonly gitignored, which would leave a
      // fresh clone with no URL in the bundle and no error to say so.
      "import.meta.env.VITE_API_URL": JSON.stringify(process.env.VITE_API_URL ?? target.apiUrl),
      // The release this bundle is. From the root package.json via
      // manifest.config.ts, so the manifest and the bundle cannot name
      // two different versions.
      "import.meta.env.VITE_APP_VERSION": JSON.stringify(RELEASE_VERSION),
      // Which web origins the bridge accepts messages from — the same
      // target the manifest's `externally_connectable` was generated
      // from, so a manifest typo cannot widen what the worker accepts.
      "import.meta.env.VITE_BRIDGE_TARGET": JSON.stringify(target.bridgeTarget),
    },
    build: {
      outDir: target.outDir,
      emptyOutDir: true,
      // An MV3 service worker is loaded as a real ES module.
      target: "esnext",
      rollupOptions: {
        input: {
          popup: fromHere("src/popup/index.html"),
          background: fromHere("src/background/index.ts"),
        },
        output: {
          // Every filename here is referenced by a literal string in
          // manifest.json, which cannot read a build manifest. Hashes
          // would break the background registration on every rebuild.
          entryFileNames: "[name].js",
          // Only ENTRY names are pinned by the manifest. Shared chunks
          // are named by rollup from whatever module landed in them
          // first, which can collide with a future entry name.
          chunkFileNames: "chunks/[name]-[hash].js",
          assetFileNames: "[name][extname]",
        },
      },
    },
  };
});
