/*
 * OpenPanel provisioning — uses the Management API (authenticated with a
 * root-mode client) to create a project + a write client for <clientName>.
 *
 * Auth model: custom headers `openpanel-client-id` / `openpanel-client-secret`,
 * NOT Authorization: Bearer. See https://openpanel.dev/docs/api/authentication.
 *
 * Endpoint shapes (from the OpenPanel source):
 *   POST  {apiUrl}/manage/projects   body: { name }           ->
 *         { data: { id, ..., client: { id, secret } } }
 *   POST  {apiUrl}/manage/clients    body: { name, projectId, type: "write" } ->
 *         { data: { id, secret, ... } }
 *   DELETE {apiUrl}/manage/projects/{projectId}
 *
 * Per-project ids + secrets are cached in the keychain so re-runs are
 * idempotent and `delete` can target the exact upstream project.
 */

import { ensureOpenpanel } from "../config.js";
import { SECRET_KEYS, deleteSecret, getSecret, setSecret } from "../utils/secrets.js";

export interface OpenpanelClient {
  projectName: string;
  clientId: string;
  clientSecret: string;
  apiUrl: string;
}

/** Extra cache slot for the upstream project id, used by `deleteOpenpanelClient`
 *  — separate from the client id slot so we can target the right row. */
const projectIdKey = (clientName: string) =>
  SECRET_KEYS.openpanelClientSecret(`${clientName}:project-id`);
const clientIdKey = (clientName: string) => SECRET_KEYS.openpanelClientSecret(`${clientName}:id`);

function buildHeaders(rootClientId: string, rootClientSecret: string): Record<string, string> {
  return {
    "openpanel-client-id": rootClientId,
    "openpanel-client-secret": rootClientSecret,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function resolveManageBase(url: string, apiUrl: string | undefined): string {
  return `${(apiUrl ?? url).replace(/\/$/, "")}/manage`;
}

export async function openpanelProjectExists(clientName: string): Promise<boolean> {
  const cfg = await ensureOpenpanel();
  const { url, apiUrl, rootClientId, rootClientSecret } = cfg;
  const cachedSecret = await getSecret(SECRET_KEYS.openpanelClientSecret(clientName));
  const cachedId = await getSecret(clientIdKey(clientName));
  if (cachedSecret && cachedId) return true;

  const manageBase = resolveManageBase(url, apiUrl);
  const res = await fetch(`${manageBase}/projects`, {
    headers: buildHeaders(rootClientId, rootClientSecret),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `OpenPanel preflight failed: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`,
    );
  }
  const raw = (await res.json()) as unknown;
  const projects: Array<{ name?: string; id?: string }> = Array.isArray(raw)
    ? (raw as Array<{ name?: string; id?: string }>)
    : ((raw as { data?: Array<{ name?: string; id?: string }> }).data ?? []);
  return projects.some((project) => project.name === clientName || project.id === clientName);
}

export async function provisionOpenpanelClient(clientName: string): Promise<OpenpanelClient> {
  const cfg = await ensureOpenpanel();
  const { url, apiUrl, rootClientId, rootClientSecret } = cfg;
  const manageBase = resolveManageBase(url, apiUrl);

  // Reuse a previously-provisioned client so re-runs don't mint duplicates.
  const cachedSecret = await getSecret(SECRET_KEYS.openpanelClientSecret(clientName));
  const cachedId = await getSecret(clientIdKey(clientName));
  if (cachedSecret && cachedId) {
    return {
      projectName: clientName,
      clientId: cachedId,
      clientSecret: cachedSecret,
      apiUrl: manageBase,
    };
  }

  const headers = buildHeaders(rootClientId, rootClientSecret);

  // Step 1: create the project. The API authenticates the organization
  // from the root client's auth — don't send organizationSlug.
  const projectRes = await fetch(`${manageBase}/projects`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: clientName }),
  });
  if (!projectRes.ok) {
    const text = await projectRes.text().catch(() => "");
    throw new Error(
      `OpenPanel create project failed: ${projectRes.status} ${projectRes.statusText}${text ? ` — ${text}` : ""}`,
    );
  }
  const projectBody = (await projectRes.json()) as {
    data?: {
      id?: string;
      client?: { id?: string; secret?: string } | null;
    };
  };
  const project = projectBody.data;
  const projectId = project?.id;
  let clientId = project?.client?.id;
  let clientSecret = project?.client?.secret;

  if (!projectId) {
    throw new Error(
      `OpenPanel: project created but response lacked a project id (got ${JSON.stringify(projectBody).slice(0, 300)}).`,
    );
  }

  // Step 2 (fallback): some self-hosted configurations disable the
  // default-client on project creation. Mint one explicitly so the env
  // block always has real credentials.
  if (!clientId || !clientSecret) {
    const clientRes = await fetch(`${manageBase}/clients`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: clientName, type: "write", projectId }),
    });
    if (!clientRes.ok) {
      const text = await clientRes.text().catch(() => "");
      throw new Error(
        `OpenPanel create client failed: ${clientRes.status} ${clientRes.statusText}${text ? ` — ${text}` : ""}`,
      );
    }
    const clientBody = (await clientRes.json()) as {
      data?: { id?: string; secret?: string };
    };
    clientId = clientBody.data?.id;
    clientSecret = clientBody.data?.secret;
  }

  if (!clientId || !clientSecret) {
    throw new Error("OpenPanel: client created but response lacked id/secret.");
  }

  await setSecret(SECRET_KEYS.openpanelClientSecret(clientName), clientSecret);
  await setSecret(clientIdKey(clientName), clientId);
  await setSecret(projectIdKey(clientName), projectId);
  return { projectName: clientName, clientId, clientSecret, apiUrl: manageBase };
}

export type DeleteResult = "deleted" | "not-found";

/**
 * Delete an OpenPanel project created by `provisionOpenpanelClient`.
 * Also wipes the cached id + secret from the keychain so a future
 * provision round won't hand back stale creds.
 */
export async function deleteOpenpanelClient(clientName: string): Promise<DeleteResult> {
  const cfg = await ensureOpenpanel();
  const { url, apiUrl, rootClientId, rootClientSecret } = cfg;

  const cachedProjectId = await getSecret(projectIdKey(clientName));
  const manageBase = resolveManageBase(url, apiUrl);
  const headers = buildHeaders(rootClientId, rootClientSecret);

  // With no cached project id there's nothing to target — OpenPanel
  // projects are keyed by id (not name), so bail out quietly and let
  // the caller move on.
  if (!cachedProjectId) {
    await deleteSecret(SECRET_KEYS.openpanelClientSecret(clientName));
    await deleteSecret(clientIdKey(clientName));
    return "not-found";
  }

  const res = await fetch(`${manageBase}/projects/${cachedProjectId}`, {
    method: "DELETE",
    headers,
  });

  // Always clear cached creds — if the upstream project is gone (or
  // already-gone), the local secrets have no reason to linger.
  await deleteSecret(SECRET_KEYS.openpanelClientSecret(clientName));
  await deleteSecret(clientIdKey(clientName));
  await deleteSecret(projectIdKey(clientName));

  if (res.status === 404) return "not-found";
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `OpenPanel delete project failed: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`,
    );
  }
  return "deleted";
}
