/*
 * Thin wrappers around the `gh` CLI for token-related lookups.
 *
 * Hatchkit relies on `gh` everywhere else (repo creation, secrets,
 * workflows), so reusing its token for GHCR pulls keeps the onboarding
 * surface to "log in once via gh" instead of pasting a second PAT. The
 * helpers here are intentionally tiny and dependency-free so both the
 * GHCR config path and the visibility-flip path in `deploy/ghcr.ts` can
 * share one implementation.
 */

import { exec, execOk } from "./exec.js";

/** Returns true when `gh` is installed *and* has an authenticated user
 *  for github.com. Distinguishes "no gh on PATH" from "gh present but
 *  not logged in" only by both paths returning false — callers don't
 *  care which it was. */
export async function ghAvailable(): Promise<boolean> {
  return execOk("gh", ["auth", "status", "-h", "github.com"]);
}

/** Read the active gh token's OAuth scopes. Returns null when gh isn't
 *  authenticated (auth missing, gh not installed, etc.) so callers can
 *  distinguish "no token" from "token but empty scope list". An empty
 *  array means the API returned no `X-Oauth-Scopes` header — treat as
 *  "unknown scopes, attempt and let the API call fail clearly". */
export async function ghTokenScopes(): Promise<string[] | null> {
  // `gh api -i /` prints response headers; the `X-Oauth-Scopes` line
  // lists the scopes the active token carries. Cheaper than parsing
  // `gh auth status` output (which varies by gh version).
  const r = await exec("gh", ["api", "-i", "/"], { silent: true });
  if (r.exitCode !== 0) return null;
  const m = r.stdout.match(/^X-Oauth-Scopes:\s*(.*)$/im);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Add `scope` to the active gh token via `gh auth refresh`. Opens the
 *  user's browser once. Refuses to run in non-TTY environments (CI)
 *  because the command otherwise hangs forever waiting on stdin —
 *  caller treats false as "couldn't refresh, fall through to manual
 *  flow". Returns true only when the refresh exits 0 (i.e. the new
 *  scope is in effect). */
export async function refreshGhScope(scope: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const { execStream } = await import("./exec.js");
  const code = await execStream("gh", ["auth", "refresh", "-h", "github.com", "-s", scope]);
  return code === 0;
}

/** Pull the active gh token. Returns null on failure so callers can
 *  branch instead of catching. */
export async function ghAuthToken(): Promise<string | null> {
  const r = await exec("gh", ["auth", "token"], { silent: true });
  if (r.exitCode !== 0) return null;
  const v = r.stdout.trim();
  return v || null;
}

/** Resolve the active gh user's login (`gh api /user --jq .login`).
 *  Used to name the credentials when persisting them — the GHCR
 *  registry login is the *token owner's* login, not necessarily the
 *  repo owner. */
export async function ghUserLogin(): Promise<string | null> {
  const r = await exec("gh", ["api", "/user", "--jq", ".login"], { silent: true });
  if (r.exitCode !== 0) return null;
  const v = r.stdout.trim();
  return v || null;
}
