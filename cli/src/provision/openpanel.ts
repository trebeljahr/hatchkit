/*
 * OpenPanel provisioning — creates a project + a client (write key
 * pair) inside an existing self-hosted OpenPanel instance.
 *
 * OpenPanel's self-hosted API is still evolving, so this uses a
 * best-effort path and falls back to a paste-in flow if the API call
 * fails. Either way the resulting client id/secret are cached in the
 * keychain under `openpanel:<name>:client-secret` so re-runs are idempotent.
 */

import { input, password as passwordPrompt } from "@inquirer/prompts";
import { ensureOpenpanel } from "../config.js";
import { SECRET_KEYS, getSecret, setSecret } from "../utils/secrets.js";

export interface OpenpanelClient {
  projectName: string;
  clientId: string;
  clientSecret: string;
  apiUrl: string;
}

export async function provisionOpenpanelClient(clientName: string): Promise<OpenpanelClient> {
  const cfg = await ensureOpenpanel();
  const { url, organizationSlug, token } = cfg;
  if (!organizationSlug) {
    throw new Error(
      "OpenPanel config is missing organization slug. Re-run `devops-cli config add openpanel`.",
    );
  }

  // Reuse a previously-provisioned client for the same name if one
  // exists — lets you re-run the command without creating duplicates.
  const cachedSecret = await getSecret(SECRET_KEYS.openpanelClientSecret(clientName));
  const cachedIdKey = SECRET_KEYS.openpanelClientSecret(`${clientName}:id`);
  const cachedId = await getSecret(cachedIdKey);
  if (cachedSecret && cachedId) {
    return { projectName: clientName, clientId: cachedId, clientSecret: cachedSecret, apiUrl: url };
  }

  // Try the API first (best-effort). If it fails, prompt the user to
  // paste the values from the OpenPanel dashboard.
  let clientId: string | null = null;
  let clientSecret: string | null = null;
  try {
    const res = await fetch(`${url}/api/client`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        organizationSlug,
        project: { name: clientName },
        client: { name: clientName, type: "write" },
      }),
    });
    if (res.ok) {
      const body = (await res.json()) as { clientId?: string; clientSecret?: string };
      if (body.clientId && body.clientSecret) {
        clientId = body.clientId;
        clientSecret = body.clientSecret;
      }
    }
  } catch {
    // fall through to paste flow
  }

  if (!clientId || !clientSecret) {
    console.log(
      `  OpenPanel API couldn't auto-create the client for '${clientName}'.\n` +
        `  Open ${url}/${organizationSlug} → create a project named "${clientName}" →\n` +
        `  add a write client, then paste the credentials below.`,
    );
    clientId = await input({ message: `OpenPanel clientId for ${clientName}:` });
    clientSecret = await passwordPrompt({ message: `OpenPanel clientSecret for ${clientName}:` });
  }

  await setSecret(SECRET_KEYS.openpanelClientSecret(clientName), clientSecret);
  await setSecret(cachedIdKey, clientId);
  return { projectName: clientName, clientId, clientSecret, apiUrl: url };
}
