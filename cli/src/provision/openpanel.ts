/*
 * OpenPanel provisioning — uses the Management API (authenticated with a
 * root-mode client) to create a project + a write client for <clientName>.
 *
 * Auth model: custom headers `openpanel-client-id` / `openpanel-client-secret`,
 * NOT Authorization: Bearer. See https://openpanel.dev/docs/api/authentication.
 *
 * Per-project secrets are cached in the keychain so re-runs are idempotent.
 */

import { ensureOpenpanel } from "../config.js";
import { SECRET_KEYS, deleteSecret, getSecret, setSecret } from "../utils/secrets.js";

export interface OpenpanelClient {
  projectName: string;
  clientId: string;
  clientSecret: string;
  apiUrl: string;
}

export async function provisionOpenpanelClient(clientName: string): Promise<OpenpanelClient> {
  const cfg = await ensureOpenpanel();
  const { url, organizationSlug, rootClientId, rootClientSecret } = cfg;
  if (!organizationSlug) {
    throw new Error(
      "OpenPanel config is missing organization slug. Re-run `hatchkit config add openpanel`.",
    );
  }

  // Reuse a previously-provisioned client so re-runs don't mint duplicates.
  const cachedSecret = await getSecret(SECRET_KEYS.openpanelClientSecret(clientName));
  const cachedIdKey = SECRET_KEYS.openpanelClientSecret(`${clientName}:id`);
  const cachedId = await getSecret(cachedIdKey);
  if (cachedSecret && cachedId) {
    return { projectName: clientName, clientId: cachedId, clientSecret: cachedSecret, apiUrl: url };
  }

  const manageBase = `${url}/api/manage`;
  const headers = {
    "openpanel-client-id": rootClientId,
    "openpanel-client-secret": rootClientSecret,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  // Step 1: create the project. The response includes a default write client,
  // which is exactly what we want to emit as GLITCHTIP_/OPENPANEL_* env.
  const projectRes = await fetch(`${manageBase}/projects`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: clientName, organizationSlug }),
  });
  if (!projectRes.ok) {
    const text = await projectRes.text().catch(() => "");
    throw new Error(
      `OpenPanel create project failed: ${projectRes.status} ${projectRes.statusText}${text ? ` — ${text}` : ""}`,
    );
  }
  const project = (await projectRes.json()) as {
    id?: string;
    projectId?: string;
    client?: { clientId?: string; clientSecret?: string };
    defaultClient?: { clientId?: string; clientSecret?: string };
  };
  const defaultClient = project.client ?? project.defaultClient;
  let clientId = defaultClient?.clientId;
  let clientSecret = defaultClient?.clientSecret;

  // Step 2 (fallback): if the project response didn't return credentials,
  // create a dedicated write client attached to the new project.
  if (!clientId || !clientSecret) {
    const projectId = project.id ?? project.projectId;
    if (!projectId) {
      throw new Error(
        "OpenPanel: project created but no projectId returned; can't attach a client.",
      );
    }
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
    const client = (await clientRes.json()) as { clientId?: string; clientSecret?: string };
    clientId = client.clientId;
    clientSecret = client.clientSecret;
  }

  if (!clientId || !clientSecret) {
    throw new Error("OpenPanel: client created but response lacked clientId/clientSecret.");
  }

  await setSecret(SECRET_KEYS.openpanelClientSecret(clientName), clientSecret);
  await setSecret(cachedIdKey, clientId);
  return { projectName: clientName, clientId, clientSecret, apiUrl: url };
}

export type DeleteResult = "deleted" | "not-found";

/**
 * Delete an OpenPanel project created by `provisionOpenpanelClient`.
 * Also wipes the cached id + secret from the keychain so a future
 * provision round won't hand back stale creds.
 *
 * Tries the cached project id first (set when the project was created);
 * falls back to the slug (clientName) if there's no cached id — covers
 * the case where the keychain was cleared but the upstream project is
 * still hanging around.
 */
export async function deleteOpenpanelClient(clientName: string): Promise<DeleteResult> {
  const cfg = await ensureOpenpanel();
  const { url, rootClientId, rootClientSecret } = cfg;

  const cachedIdKey = SECRET_KEYS.openpanelClientSecret(`${clientName}:id`);
  const cachedId = await getSecret(cachedIdKey);

  const manageBase = `${url}/api/manage`;
  const headers = {
    "openpanel-client-id": rootClientId,
    "openpanel-client-secret": rootClientSecret,
    Accept: "application/json",
  };

  const target = cachedId ?? clientName;
  const res = await fetch(`${manageBase}/projects/${target}`, {
    method: "DELETE",
    headers,
  });

  // Always clear cached creds — if the upstream project is gone (or
  // already-gone), the local secrets have no reason to linger.
  await deleteSecret(SECRET_KEYS.openpanelClientSecret(clientName));
  await deleteSecret(cachedIdKey);

  if (res.status === 404) return "not-found";
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `OpenPanel delete project failed: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`,
    );
  }
  return "deleted";
}
