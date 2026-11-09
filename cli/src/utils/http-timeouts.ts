import { Agent, setGlobalDispatcher } from "undici";

/** Default time to open a connection before `fetch` gives up. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/** Parse `HATCHKIT_CONNECT_TIMEOUT_MS`; anything that is not a positive number keeps the default. */
export function connectTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.HATCHKIT_CONNECT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : DEFAULT_CONNECT_TIMEOUT_MS;
}

/**
 * Node's `fetch` gives up opening a connection after 10 s. A Coolify
 * API reached over a relayed tailnet link, or any API on a machine
 * under heavy load, can need longer for TCP + TLS, and every call then
 * failed with a bare "fetch failed" (UND_ERR_CONNECT_TIMEOUT). Raise the
 * connect timeout for every `fetch` hatchkit makes.
 */
export function configureHttpTimeouts(env: NodeJS.ProcessEnv = process.env): number {
  const timeout = connectTimeoutMs(env);
  setGlobalDispatcher(new Agent({ connect: { timeout } }));
  return timeout;
}
