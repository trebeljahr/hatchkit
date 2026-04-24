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

/** List Resend domains so the caller can pick one. */
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

/** Create a new Resend sending domain. `name` must be a bare domain
 *  (no scheme, no path) — e.g. "playtiao.com" or "mail.playtiao.com".
 *  Newly created domains start unverified; DNS records must be added
 *  before keys scoped to it can send. */
export async function createResendDomain(
  name: string,
): Promise<{ id: string; name: string; status: string }> {
  const cfg = await ensureResend();
  const res = await fetch("https://api.resend.com/domains", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    throw new Error(`Resend create domain failed: HTTP ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { id: string; name: string; status?: string };
  return { id: data.id, name: data.name, status: data.status ?? "not_started" };
}

/** Normalize user-pasted domain input: strip scheme, path, whitespace. */
export function normalizeDomainInput(raw: string): string {
  let s = raw.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "");
  s = s.replace(/\/.*$/, "");
  s = s.replace(/^www\./, "");
  return s;
}
