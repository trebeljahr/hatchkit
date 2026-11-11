/*
 * The GitHub App manifest flow, end to end.
 *
 * 1. A one-shot server on 127.0.0.1 serves a page that POSTs the manifest
 *    to github.com (the manifest flow takes a form POST, not an API call).
 * 2. The operator checks the name and confirms once on github.com. GitHub
 *    creates the App and sends the browser back to the local server with a
 *    temporary `code` and the `state` it was given.
 * 3. `POST /app-manifests/{code}/conversions` (no credential needed; the
 *    code is the proof, valid for about an hour) returns the App, its
 *    client ID and client secret.
 *
 * `plan.ts` explains why a GitHub App's credentials work with better-auth's
 * GitHub provider. `webBase` and `apiBase` exist for the tests, which run a
 * fake GitHub; nothing else changes them.
 */

import { randomBytes } from "node:crypto";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type GithubAppCredentials,
  githubAppManifest,
  githubManifestFormAction,
  githubManifestPage,
  parseManifestConversion,
} from "./plan.js";

export const GITHUB_WEB_BASE = "https://github.com";
export const GITHUB_API_BASE = "https://api.github.com";

/** GitHub allows an hour for the whole flow. */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export interface ManifestFlowOptions {
  domain: string;
  /** The App's name, prefilled on GitHub's form. */
  name: string;
  /** Register under this organization instead of the operator's account. */
  org?: string;
  /** Show the local start URL; the caller opens it in a browser. */
  open(startUrl: string): Promise<void>;
  log(line: string): void;
  webBase?: string;
  apiBase?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** The local half of the flow, separated so a test can drive it. */
export interface ManifestServer {
  startUrl: string;
  redirectUrl: string;
  /** Resolves with the code once GitHub sends the browser back. */
  code: Promise<string>;
  close(): Promise<void>;
}

export async function startManifestServer(opts: {
  domain: string;
  name: string;
  org?: string;
  webBase?: string;
}): Promise<ManifestServer> {
  const state = randomBytes(18).toString("hex");
  const startToken = randomBytes(12).toString("hex");
  let resolveCode: (code: string) => void = () => {};
  let rejectCode: (err: Error) => void = () => {};
  let settled = false;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // A rejection nobody awaits yet (close() before the code arrives) must
  // not crash the process.
  code.catch(() => {});

  let origin = "";
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", origin);
    if (req.method === "GET" && url.pathname === `/start/${startToken}`) {
      const manifest = githubAppManifest({
        name: opts.name,
        domain: opts.domain,
        redirectUrl: `${origin}/created`,
      });
      const action = githubManifestFormAction({
        webBase: opts.webBase ?? GITHUB_WEB_BASE,
        ...(opts.org ? { org: opts.org } : {}),
        state,
      });
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      });
      res.end(githubManifestPage({ action, manifest }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/created") {
      const gotState = url.searchParams.get("state");
      const gotCode = url.searchParams.get("code");
      if (gotState !== state || !gotCode) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("This is not the GitHub App hatchkit started. Return to the terminal.");
        if (!settled) {
          settled = true;
          rejectCode(
            new Error(
              gotState !== state
                ? "GitHub returned a different state: not the flow hatchkit started."
                : "GitHub returned no code.",
            ),
          );
        }
        return;
      }
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("GitHub App created. Return to the terminal; you can close this tab.");
      if (!settled) {
        settled = true;
        resolveCode(gotCode);
      }
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // Port 0: the OS picks a free ephemeral port, never one a dev server
    // already holds.
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;

  return {
    startUrl: `${origin}/start/${startToken}`,
    redirectUrl: `${origin}/created`,
    code,
    close: () =>
      new Promise<void>((resolve) => {
        if (!settled) {
          settled = true;
          rejectCode(new Error("The local GitHub App page was closed."));
        }
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** Trade the temporary code for the App's credentials. */
export async function convertManifestCode(args: {
  code: string;
  apiBase?: string;
  fetch?: typeof fetch;
}): Promise<GithubAppCredentials> {
  const doFetch = args.fetch ?? fetch;
  const base = (args.apiBase ?? GITHUB_API_BASE).replace(/\/+$/, "");
  const res = await doFetch(`${base}/app-manifests/${encodeURIComponent(args.code)}/conversions`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "hatchkit",
      "x-github-api-version": "2022-11-28",
    },
  });
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const message =
      body &&
      typeof body === "object" &&
      typeof (body as { message?: unknown }).message === "string"
        ? (body as { message: string }).message
        : `HTTP ${res.status}`;
    throw new Error(
      res.status === 404
        ? `GitHub did not accept the code (${message}). It is valid for about an hour and only once.`
        : `GitHub refused the manifest conversion: ${message}`,
    );
  }
  const parsed = parseManifestConversion(body);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed;
}

/** Run the whole flow: serve the page, wait for GitHub, convert. */
export async function runGithubManifestFlow(
  opts: ManifestFlowOptions,
): Promise<GithubAppCredentials> {
  const server = await startManifestServer({
    domain: opts.domain,
    name: opts.name,
    ...(opts.org ? { org: opts.org } : {}),
    ...(opts.webBase ? { webBase: opts.webBase } : {}),
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    await opts.open(server.startUrl);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("No answer from GitHub in time. Nothing was stored.")),
        opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
    });
    const code = await Promise.race([server.code, timeout]);
    opts.log("GitHub App created; exchanging the code for its credentials.");
    return await convertManifestCode({
      code,
      ...(opts.apiBase ? { apiBase: opts.apiBase } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  } finally {
    if (timer) clearTimeout(timer);
    await server.close();
  }
}
