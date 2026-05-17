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
  domainName?: string;
  /** The full API key is only returned by Resend once; we print it
   *  inline and also return it so the caller can persist. */
  raw: string;
}

export async function provisionResendClient(
  clientName: string,
  domainId?: string,
  domainName?: string,
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
  return { keyName: clientName, apiKey: data.token, domainId, domainName, raw: data.token };
}

export async function listResendApiKeys(): Promise<Array<{ id: string; name: string }>> {
  const cfg = await ensureResend();
  const res = await fetch("https://api.resend.com/api-keys", {
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
  });
  if (!res.ok) throw new Error(`Resend list keys failed: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id: string; name: string }> };
  return body.data ?? [];
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

export type DeleteResult = "deleted" | "not-found";

/**
 * Delete the Resend API key named `clientName`.
 *
 * Resend's create response only gives us the token, not the key's id,
 * and we don't persist the id locally. So: list keys, find the one with
 * the matching name, DELETE /api-keys/:id. If zero match, treat as
 * already-gone; if more than one matches (rare — same name re-used),
 * delete them all so the undo is total.
 */
export async function deleteResendClient(clientName: string): Promise<DeleteResult> {
  const cfg = await ensureResend();
  const auth = { Authorization: `Bearer ${cfg.apiKey}` };
  const matches = (await listResendApiKeys()).filter((k) => k.name === clientName);
  if (matches.length === 0) return "not-found";

  for (const key of matches) {
    const delRes = await fetch(`https://api.resend.com/api-keys/${key.id}`, {
      method: "DELETE",
      headers: auth,
    });
    if (delRes.status === 404) continue;
    if (!delRes.ok) {
      throw new Error(
        `Resend delete key ${key.id} failed: HTTP ${delRes.status} ${await delRes.text()}`,
      );
    }
  }
  return "deleted";
}

/** Normalize user-pasted domain input: strip scheme, path, whitespace. */
export function normalizeDomainInput(raw: string): string {
  let s = raw.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "");
  s = s.replace(/\/.*$/, "");
  s = s.replace(/^www\./, "");
  return s;
}

// ────────────────────────────────────────────────────────────────────────────
// Domain DNS records
//
// `GET /domains/:id` returns the DKIM + SPF records Resend needs published
// before a domain can verify. Each record carries the same fields a DNS
// provider needs: name, type ("TXT" | "MX" | "CNAME"), value, plus an MX
// priority for MX rows and a `status` ("pending" | "verified") so the
// caller can skip rows that already match.
// ────────────────────────────────────────────────────────────────────────────

export interface ResendDnsRecord {
  type: "TXT" | "MX" | "CNAME";
  name: string;
  value: string;
  priority?: number;
  status?: string;
  /** Resend's human-readable hint, e.g. "SPF" or "DKIM". */
  record?: string;
  ttl?: string | number;
}

export interface ResendDomain {
  id: string;
  name: string;
  status: string;
  records: ResendDnsRecord[];
}

/** Fetch a single domain with its required DNS records. */
export async function getResendDomain(domainId: string): Promise<ResendDomain> {
  const cfg = await ensureResend();
  const res = await fetch(`https://api.resend.com/domains/${domainId}`, {
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`Resend get domain failed: HTTP ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as {
    id: string;
    name: string;
    status?: string;
    records?: Array<{
      type?: string;
      name?: string;
      value?: string;
      priority?: number;
      status?: string;
      record?: string;
      ttl?: string | number;
    }>;
  };
  const records: ResendDnsRecord[] = (data.records ?? [])
    .filter((r) => r.type && r.name && r.value)
    .map((r) => ({
      type: r.type as "TXT" | "MX" | "CNAME",
      name: r.name as string,
      value: r.value as string,
      priority: r.priority,
      status: r.status,
      record: r.record,
      ttl: r.ttl,
    }));
  return { id: data.id, name: data.name, status: data.status ?? "not_started", records };
}

/** Trigger Resend's verification check after DNS records propagate. */
export async function verifyResendDomain(domainId: string): Promise<{ status: string }> {
  const cfg = await ensureResend();
  const res = await fetch(`https://api.resend.com/domains/${domainId}/verify`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`Resend verify domain failed: HTTP ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { status?: string };
  return { status: data.status ?? "pending" };
}

// ────────────────────────────────────────────────────────────────────────────
// Audiences (mailing lists)
//
// Resend's Audiences API is the equivalent of a Mailgun mailing list:
// a named collection of contacts you broadcast to. Audiences are
// account-scoped (not bound to a sending domain), so callers typically
// want one audience per project + an optional `<project>-test` audience
// holding just the developer's own address for safe rehearsal sends.
// ────────────────────────────────────────────────────────────────────────────

export interface ResendAudience {
  id: string;
  name: string;
}

export async function createResendAudience(name: string): Promise<ResendAudience> {
  const cfg = await ensureResend();
  const res = await fetch("https://api.resend.com/audiences", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    throw new Error(`Resend create audience failed: HTTP ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { id: string; name: string };
  return { id: data.id, name: data.name };
}

export async function listResendAudiences(): Promise<ResendAudience[]> {
  const cfg = await ensureResend();
  const res = await fetch("https://api.resend.com/audiences", {
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
  });
  if (!res.ok) throw new Error(`Resend list audiences failed: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id: string; name: string }> };
  return body.data ?? [];
}

/**
 * Delete every audience whose name matches `audienceName`. Same shape as
 * {@link deleteResendClient}: by-name lookup (Resend's create response
 * gives the id but we don't persist it locally), 0-match → not-found,
 * 1+-match → delete all so undo is total.
 */
export async function deleteResendAudience(audienceName: string): Promise<DeleteResult> {
  const cfg = await ensureResend();
  const auth = { Authorization: `Bearer ${cfg.apiKey}` };
  const matches = (await listResendAudiences()).filter((a) => a.name === audienceName);
  if (matches.length === 0) return "not-found";
  for (const aud of matches) {
    const delRes = await fetch(`https://api.resend.com/audiences/${aud.id}`, {
      method: "DELETE",
      headers: auth,
    });
    if (delRes.status === 404) continue;
    if (!delRes.ok) {
      throw new Error(
        `Resend delete audience ${aud.id} failed: HTTP ${delRes.status} ${await delRes.text()}`,
      );
    }
  }
  return "deleted";
}
