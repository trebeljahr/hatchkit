/*
 * Configuration: two environment variables, and the normalisation that decides
 * what counts as the same origin.
 *
 * The host that launches this binary passes nothing but environment. There is
 * no config file to inspect, no flag to add and, once the process is running
 * under a host, no way to ask a question — so everything this module refuses
 * has to be refused with one sentence that names the variable and says what to
 * put in it. A host shows the user "server exited"; the sentence on stderr is
 * the only diagnosis they will ever get.
 */

/**
 * The versioned base path every request is made under.
 *
 * A constant rather than a literal at each call site because it is also what
 * {@link normaliseOrigin} strips off a pasted value: the two have to be the
 * same string or a user who pastes the base path they were shown gets
 * `/api/v1/api/v1/items`, which answers 404 and reads as "the tool is broken".
 */
export const API_BASE_PATH = "/api/v1";

/** The credential. Scoped, minted per integration, revocable on its own. */
export const TOKEN_VAR = "STARTER_API_TOKEN";

/** The origin to talk to. Optional — {@link DEFAULT_API_ORIGIN} is the default. */
export const ORIGIN_VAR = "STARTER_API_URL";

/**
 * Where this build talks when nothing says otherwise.
 *
 * The pinned development API port (`DEV_API_PORT` in `scripts/dev.mjs`), so a
 * clone of this repository works with `pnpm dev` and no environment at all.
 * `hatchkit` rewrites this line to the project's deployed API origin when it
 * scaffolds the package, because the common case for a scaffolded project is a
 * host configuration carrying one pasted credential and nothing else.
 */
export const DEFAULT_API_ORIGIN = "http://localhost:5000";

/** A configuration problem the user has to fix before the process can start. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type McpConfig = {
  /** Scheme, host, port and any path prefix — no trailing slash, no base path. */
  origin: string;
  /** `origin` + {@link API_BASE_PATH}. Every request is built from this. */
  baseUrl: string;
  token: string;
};

/**
 * The three spellings of one origin, reduced to one.
 *
 * Forgiving in exactly one direction. A trailing slash, a pasted `/api/v1`
 * base path and a plain origin are all the same deployment, and refusing two
 * of the three would make the docs' own copy-pasteable block a coin flip. A
 * value that is not http(s) is REFUSED rather than repaired: prepending a
 * scheme to `example.com` guesses which one, and guessing `http` on a
 * production host sends a bearer credential in clear text.
 *
 * Query strings, fragments and embedded credentials are dropped rather than
 * refused — they cannot mean anything on a base URL, and `URL.origin` never
 * carries userinfo, so a pasted `https://user:pw@host/` cannot leak that
 * password into every request header set.
 */
export function normaliseOrigin(raw: string): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ConfigError(
      `${ORIGIN_VAR} is not a URL: ${JSON.stringify(trimmed)}. Set it to the API origin, e.g. https://api.example.com.`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(
      `${ORIGIN_VAR} must be an http or https URL, not ${JSON.stringify(url.protocol.replace(":", ""))}. Set it to the API origin, e.g. https://api.example.com.`,
    );
  }

  let path = url.pathname.replace(/\/+$/, "");
  if (path === API_BASE_PATH || path.endsWith(API_BASE_PATH)) {
    path = path.slice(0, path.length - API_BASE_PATH.length);
  }
  return `${url.origin}${path}`;
}

/**
 * Read the configuration, or throw the one sentence the user needs.
 *
 * `env` is a parameter rather than a read of `process.env` so the tests drive
 * the same function the binary does. A test that built a config object by hand
 * would not be testing this.
 */
export function readConfig(env: Record<string, string | undefined>): McpConfig {
  const token = (env[TOKEN_VAR] ?? "").trim();
  if (token === "") {
    throw new ConfigError(
      `${TOKEN_VAR} is not set. Mint a scoped API token from the web app's typed API — ` +
        "`trpc.apiTokens.create.mutate({ label, scopes })` — and put the returned plaintext in " +
        `${TOKEN_VAR} in your MCP host's configuration file.`,
    );
  }

  const rawOrigin = (env[ORIGIN_VAR] ?? "").trim();
  const origin = normaliseOrigin(rawOrigin === "" ? DEFAULT_API_ORIGIN : rawOrigin);
  return { origin, baseUrl: `${origin}${API_BASE_PATH}`, token };
}
