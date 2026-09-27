/**
 * This build's release, hand-kept, and pinned against the repository's version
 * by `scripts/version.test.mjs`.
 *
 * Every other client reads its version from somewhere: the web app and the
 * browser extension get it from the root manifest at build time, the native
 * shells from their own project files. This one cannot. A Raycast Store
 * submission is THE PACKAGE DIRECTORY ALONE — there is no root manifest beside
 * it to read, `ray build` offers no build-time define to inject one, and the
 * extension manifest itself carries no `version` field. So the number has to be
 * a literal in source, and the only thing that stops a release bump from
 * forgetting it is the drift test.
 *
 * It is sent as the client-version header on every request, which is what the
 * account's device list shows and what the server's compatibility floor reads.
 * A stale value is therefore not cosmetic: it makes a build report itself as an
 * older one, and nothing anywhere fails.
 */
export const EXTENSION_VERSION = "0.1.0";
