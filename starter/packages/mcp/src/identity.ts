/*
 * The three names this server announces, in one file because all three are
 * rewritten when a project is scaffolded and because each one is a contract
 * the moment it has been published.
 *
 *  - {@link SERVER_NAME} is the binary name AND the name announced over the
 *    protocol. It is written into every user's host configuration file, so a
 *    rename orphans every configuration that already carries it.
 *  - {@link PRODUCT_NAME} is display text. It is the only one that is safe to
 *    change later, and it is here because `hatchkit` rewrites the line.
 *  - {@link SERVER_VERSION} is hand-kept and pinned to `package.json` by
 *    `src/tests/identity.test.ts`. A published package directory carries no
 *    build-time define to read a version from, so nothing but that test stops
 *    a release bump from leaving this constant behind — and a host that
 *    reports the wrong version turns a fixed bug into an unreproducible one.
 */

/**
 * Announced over the protocol, and the name of the installed binary.
 *
 * `hatchkit` replaces this literal with the project's own client id for the
 * MCP host slot (`identifiers.clientIds.mcp`), the same value the device-flow
 * allowlist reserves for this surface. It is a literal here rather than a
 * `{{token}}` placeholder because this repository has to be clonable and
 * runnable before it has ever been scaffolded — and a brace in a `bin` key
 * becomes a brace in a symlink name.
 */
export const SERVER_NAME = "starter-mcp";

/** Shown to the model in the instructions. `hatchkit` rewrites this line. */
export const PRODUCT_NAME = "Starter";

/** Hand-kept. `src/tests/identity.test.ts` fails when it leaves `package.json` behind. */
export const SERVER_VERSION = "0.1.0";
