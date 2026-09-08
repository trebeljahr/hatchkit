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

import type { OpenpanelConfig } from "../config.js";
import { ensureOpenpanel } from "../config.js";
import { SECRET_KEYS, deleteSecret, getSecret, setSecret } from "../utils/secrets.js";
import type { RemoteProject } from "./project-lookup.js";

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

function buildHeaders(
  rootClientId: string,
  rootClientSecret: string,
  options: { jsonBody?: boolean } = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    "openpanel-client-id": rootClientId,
    "openpanel-client-secret": rootClientSecret,
    Accept: "application/json",
  };
  if (options.jsonBody) headers["Content-Type"] = "application/json";
  return headers;
}

function resolveManageBase(url: string, apiUrl: string | undefined): string {
  return `${(apiUrl ?? url).replace(/\/$/, "")}/manage`;
}

/** Parse the manage API's project list. It returns a bare array in
 *  some versions and `{ data: [...] }` in others; accept either. */
function readProjectList(raw: unknown): RemoteProject[] {
  const rows = Array.isArray(raw) ? raw : ((raw as { data?: unknown }).data ?? []);
  return Array.isArray(rows) ? (rows as RemoteProject[]) : [];
}

/** Every project the root client can see.
 *
 *  Deliberately does NOT consult the keychain first. A cached client
 *  secret proves hatchkit once created a project, not that the project
 *  is still there — short-circuiting on it made `add` refuse to run for
 *  resources that had since been deleted upstream, while `inventory`
 *  (which always asks the API) reported them missing. */
export async function listOpenpanelProjects(cfg: OpenpanelConfig): Promise<RemoteProject[]> {
  const manageBase = resolveManageBase(cfg.url, cfg.apiUrl);
  const res = await fetch(`${manageBase}/projects`, {
    headers: buildHeaders(cfg.rootClientId, cfg.rootClientSecret),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `OpenPanel list projects failed: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`,
    );
  }
  return readProjectList(await res.json());
}

/** Credentials for a project that already exists, without creating one.
 *
 *  Prefers the cached client this machine minted; otherwise mints a
 *  fresh write client against the existing project, because OpenPanel
 *  does not hand back an existing client's secret after creation. */
export async function adoptOpenpanelClient(args: {
  /** Name to file the credentials under locally — the name hatchkit
   *  would have created. */
  clientName: string;
  /** Upstream project id, from the resolver. */
  projectId: string;
}): Promise<OpenpanelClient> {
  const { clientName, projectId } = args;
  const cfg = await ensureOpenpanel();
  const manageBase = resolveManageBase(cfg.url, cfg.apiUrl);

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

  const headers = buildHeaders(cfg.rootClientId, cfg.rootClientSecret, { jsonBody: true });
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
  const body = (await clientRes.json()) as { data?: { id?: string; secret?: string } };
  const clientId = body.data?.id;
  const clientSecret = body.data?.secret;
  if (!clientId || !clientSecret) {
    throw new Error("OpenPanel: client created but response lacked id/secret.");
  }

  await setSecret(SECRET_KEYS.openpanelClientSecret(clientName), clientSecret);
  await setSecret(clientIdKey(clientName), clientId);
  await setSecret(projectIdKey(clientName), projectId);
  return { projectName: clientName, clientId, clientSecret, apiUrl: manageBase };
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

  const headers = buildHeaders(rootClientId, rootClientSecret, { jsonBody: true });

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
