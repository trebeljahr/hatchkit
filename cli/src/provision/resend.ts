/*
 * Resend provisioning — creates a restricted API key scoped to a
 * specific verified sending domain. One key per env (dev / prod)
 * keeps blast radius small if either leaks.
 *
 * API: https://resend.com/docs/api-reference/api-keys/create-api-key
 *   POST /api-keys  { name, permission: "sending_access", domain_id }
 */

import { ensureResend } from "../config.js";

export interface ResendClient {
  keyName: string;
  apiKey: string;
  domainId?: string;
  /** The full API key is only returned by Resend once; we print it
   *  inline and also return it so the caller can persist. */
  raw: string;
}

export async function provisionResendClient(
  clientName: string,
  domainId?: string,
): Promise<ResendClient> {
  const cfg = await ensureResend();

  const body: Record<string, unknown> = {
    name: clientName,
    permission: "sending_access",
  };
  if (domainId) body.domain_id = domainId;

  const res = await fetch("https://api.resend.com/api-keys", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Resend create key failed: HTTP ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { id: string; token: string };
  return { keyName: clientName, apiKey: data.token, domainId, raw: data.token };
}

/** List verified Resend domains so the caller can pick one. */
export async function listResendDomains(): Promise<
  Array<{ id: string; name: string; status: string }>
> {
  const cfg = await ensureResend();
  const res = await fetch("https://api.resend.com/domains", {
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
  });
  if (!res.ok) throw new Error(`Resend list domains failed: HTTP ${res.status}`);
  const body = (await res.json()) as { data: Array<{ id: string; name: string; status: string }> };
  return body.data ?? [];
}
