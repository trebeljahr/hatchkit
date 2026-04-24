/*
 * GlitchTip provisioning — creates a project inside an existing
 * self-hosted GlitchTip org and returns the public DSN.
 *
 * GlitchTip exposes a Sentry-compatible API:
 *   POST /api/0/teams/{org}/{team}/projects/     -> create project
 *   GET  /api/0/projects/{org}/{project}/keys/   -> list client keys (DSN)
 *
 * Auth is a personal auth token in `Authorization: Bearer`.
 */

import { ensureGlitchtip } from "../config.js";

export interface GlitchtipClient {
  projectSlug: string;
  dsn: string;
}

export async function provisionGlitchtipClient(clientName: string): Promise<GlitchtipClient> {
  const cfg = await ensureGlitchtip();
  const { url, organizationSlug, teamSlug, token } = cfg;
  if (!organizationSlug || !teamSlug) {
    throw new Error(
      "GlitchTip config is missing organization/team slug. Re-run `hatchkit config add glitchtip`.",
    );
  }

  const createRes = await fetch(`${url}/api/0/teams/${organizationSlug}/${teamSlug}/projects/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: clientName,
      slug: clientName,
      platform: "javascript-node",
    }),
  });

  if (!createRes.ok && createRes.status !== 409) {
    throw new Error(
      `GlitchTip create project failed: HTTP ${createRes.status} ${await createRes.text()}`,
    );
  }

  // If 409, the project already exists — fall through and fetch its key.
  const keysRes = await fetch(`${url}/api/0/projects/${organizationSlug}/${clientName}/keys/`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!keysRes.ok) {
    throw new Error(`GlitchTip fetch keys failed: HTTP ${keysRes.status} ${await keysRes.text()}`);
  }
  const keys = (await keysRes.json()) as Array<{ dsn: { public: string } }>;
  if (keys.length === 0) {
    throw new Error(`GlitchTip project '${clientName}' has no client keys`);
  }
  return { projectSlug: clientName, dsn: keys[0].dsn.public };
}

export type DeleteResult = "deleted" | "not-found";

/** Delete a GlitchTip project. 404 → "not-found" (already gone). */
export async function deleteGlitchtipClient(clientName: string): Promise<DeleteResult> {
  const cfg = await ensureGlitchtip();
  const { url, organizationSlug, token } = cfg;
  if (!organizationSlug) {
    throw new Error(
      "GlitchTip config is missing organization slug. Re-run `hatchkit config add glitchtip`.",
    );
  }

  const res = await fetch(`${url}/api/0/projects/${organizationSlug}/${clientName}/`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 404) return "not-found";
  if (!res.ok) {
    throw new Error(`GlitchTip delete project failed: HTTP ${res.status} ${await res.text()}`);
  }
  return "deleted";
}
