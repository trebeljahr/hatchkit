import { artifactPatterns, updateFeedFor } from "./scripts/lib/desktop-release.mjs";

/**
 * electron-builder configuration for {{projectName}}.
 *
 * Run it through `scripts/build-desktop.mjs --package …` (`pnpm electron:build`,
 * `pnpm electron:preview`), which builds and verifies what this packs first.
 * Running electron-builder directly packages whatever happens to be on disk.
 *
 * The package contains exactly two things besides package.json: the bundled
 * main/preload (`electron/dist`) and the desktop export
 * (`packages/client/out-desktop`). The main process is one esbuild bundle with
 * no runtime `node_modules`, so none are packed.
 */

/**
 * Which platform build-desktop.mjs is packaging, for the update feed.
 * "local" when electron-builder is run without it, which resolves to no feed.
 */
const target = process.env.DESKTOP_TARGET?.trim() || "local";

/*
 * The artifact names, from the same table the release workflow checks them
 * against (scripts/lib/desktop-release.mjs). They carry `-unsigned` when the
 * target says the build had no certificate, so a test build cannot be mistaken
 * for a release on a download page — and the workflow fails the leg when a name
 * and the signing mode disagree, rather than publishing the wrong file.
 */
const names = artifactPatterns(target);

/** A CI secret that is not set expands to "", which is also unset. */
const env = (name) => {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
};

/*
 * macOS signing is driven by the certificate electron-builder itself reads
 * (CSC_LINK / CSC_NAME). Notarization needs the App Store Connect API key on
 * top; a signed build that is not notarized is still blocked by Gatekeeper,
 * and an unsigned one must not claim to be either.
 */
const macSigned = Boolean(env("CSC_LINK") || env("CSC_NAME"));
const notarizing =
  macSigned && Boolean(env("APPLE_API_KEY") && env("APPLE_API_KEY_ID") && env("APPLE_API_ISSUER"));

/** @type {import("electron-builder").Configuration} */
const config = {
  appId: "{{bundleId}}",
  productName: "{{projectName}}",
  directories: {
    output: "release",
    buildResources: "build",
  },
  extraMetadata: {
    // The root package.json has no "main", and electron-builder packs the
    // root: without this the packaged app fails at launch with "Application
    // entry file index.js was not found in this archive".
    main: "electron/dist/main.js",
    // deb and rpm refuse to build without a homepage, and the root
    // package.json is the monorepo's, not the app's. Replace the placeholder
    // domain with the project's own, as with `appId` above.
    homepage: "https://example.com",
  },
  files: [
    "package.json",
    "electron/dist/**",
    "packages/client/out-desktop/**",
    "!**/*.map",
    "!packages/client/out-desktop/.build-target.json",
    // electron-builder adds the app's production dependencies on its own,
    // whatever `files` lists; this is what keeps them out. Measured in the
    // reference implementation: ten @capacitor/* packages, 1.69 MB, packed
    // into the asar of a desktop app that never loads one of them.
    // scripts/build-desktop.mjs lists the asar afterwards and fails on any.
    "!node_modules/**",
  ],
  // The update feed. Explicitly resolved and explicitly null for a target that
  // has none — left undefined, electron-builder guesses a GitHub feed from
  // GH_TOKEN. build-desktop.mjs always passes --publish never; the release
  // workflow uploads the artifacts itself.
  publish: updateFeedFor(target),
  asar: true,
  // Nothing native is packed, so there is nothing to rebuild.
  npmRebuild: false,
  nodeGypRebuild: false,
  /*
   * Electron fuses, set through electron-builder's own support rather than an
   * afterPack hook: it flips them right before signing, and a flip after
   * signing breaks the signature.
   *
   * RunAsNode, NODE_OPTIONS and the `--inspect` arguments are off, so the
   * shipped binary cannot be re-entered as a plain Node process with the app's
   * privileges. Asar integrity and only-load-from-asar are on, so a modified
   * or added file beside the archive is not loaded.
   *
   * `resetAdHocDarwinSignature` re-signs unsigned arm64 builds, which macOS
   * otherwise refuses to launch after a fuse flip.
   *
   * Consequence to know before debugging a packaged build: with the inspector
   * fuse off, Playwright's `_electron.launch` cannot drive a packaged app — it
   * times out. Drive the unpackaged `electron/dist/main.js` instead.
   */
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    enableCookieEncryption: true,
    grantFileProtocolExtraPrivileges: false,
    resetAdHocDarwinSignature: true,
  },
  // ── macOS (dmg + zip) ──────────────────────────────────────────────
  // Split arm64 and x64 rather than universal: each download is half the size.
  mac: {
    target: ["dmg", "zip"],
    icon: "build/icon.icns",
    category: "public.app-category.utilities",
    // Only with a real identity. An unsigned build is ad-hoc signed, and an
    // ad-hoc signature has no Team ID; the hardened runtime's library
    // validation then refuses Electron Framework at launch ("mapping process
    // and mapped file (non-platform) have different Team IDs") and dyld aborts
    // before any of the app's code runs.
    hardenedRuntime: macSigned,
    gatekeeperAssess: false,
    notarize: notarizing,
    extendInfo: {
      // HTTPS and the OS's own crypto only: exempt from export documentation.
      ITSAppUsesNonExemptEncryption: false,
    },
    // Applies to the zip (dmg has its own below); electron-builder has no
    // top-level `zip` block. `${name}` is the package name, which has no
    // spaces — `${productName}` would put them in every download URL.
    artifactName: names.zip,
  },
  dmg: {
    artifactName: names.dmg,
  },
  // ── Windows (NSIS) ─────────────────────────────────────────────────
  // Signed with a certificate file through electron-builder's own
  // WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD; unset, the installer is unsigned and
  // SmartScreen warns on first run.
  win: {
    target: ["nsis"],
    icon: "build/icon.ico",
  },
  nsis: {
    // One installer carries both architectures when nsis is built for more
    // than one, so no ${arch}.
    artifactName: names.nsis,
    oneClick: true,
    perMachine: false,
  },
  // ── Linux ──────────────────────────────────────────────────────────
  // AppImage for anyone, deb and rpm for the two package families, tar.gz for
  // anything that repackages the app itself.
  linux: {
    target: ["AppImage", "deb", "rpm", "tar.gz"],
    icon: "build/icon.png",
    category: "Utility",
    executableName: "{{projectSlug}}",
    maintainer: "{{projectName}}",
    artifactName: names.linux,
  },
  deb: {
    // electron-builder's default name, which is what apt users expect.
    artifactName: "${name}_${version}_${arch}.${ext}",
  },
  rpm: {
    artifactName: "${name}-${version}.${arch}.${ext}",
  },
};

export default config;
