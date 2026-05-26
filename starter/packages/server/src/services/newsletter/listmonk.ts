/**
 * Listmonk HTTP API client.
 *
 * Talks to a self-hosted Listmonk instance (delivering via Amazon SES
 * SMTP) over its REST API:
 *
 *   - Subscribers + list memberships live in Listmonk.
 *   - Transactional sends (double-opt-in confirmation, welcome issue)
 *     go through `POST /api/tx` against a pre-defined passthrough
 *     template.
 *   - Campaign sends (the weekly digest) go through
 *     `POST /api/campaigns` + status toggle, which lets Listmonk fan
 *     out per-recipient with native `{{ UnsubscribeURL }}` substitution.
 *
 * The Hatchkit `listmonk-ses` provisioner wires every env var this
 * file reads — LISTMONK_URL / LISTMONK_API_USER / LISTMONK_API_TOKEN /
 * LISTMONK_LIST_ID / LISTMONK_TEST_LIST_ID / LISTMONK_TX_TEMPLATE_ID /
 * LISTMONK_CAMPAIGN_TEMPLATE_ID / LISTMONK_FROM — so an opt-in newsletter
 * project gets a working list + templates out of the box.
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function baseUrl(): string {
  return required("LISTMONK_URL").replace(/\/$/, "");
}

function authHeader(): string {
  const user = required("LISTMONK_API_USER");
  const token = required("LISTMONK_API_TOKEN");
  return `token ${user}:${token}`;
}

async function listmonkFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`listmonk ${init.method ?? "GET"} ${path}: ${res.status} ${text}`);
  }
  if (!text) return undefined as unknown as T;
  return JSON.parse(text) as T;
}

// ─────────────────────────────────────────────────────────────────────
// Environment helpers — NODE_ENV picks live vs test list. Prod targets
// real subscribers; everything else routes to the test list so a
// rehearsal send from a laptop never lands in real inboxes.
// ─────────────────────────────────────────────────────────────────────

export function isProductionSend(): boolean {
  return process.env.NODE_ENV === "production";
}

export function resolveListId(): number {
  const raw = isProductionSend()
    ? required("LISTMONK_LIST_ID")
    : required("LISTMONK_TEST_LIST_ID");
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid Listmonk list id: ${raw}`);
  }
  return n;
}

export function describeListTarget(): string {
  return isProductionSend()
    ? `LISTMONK_LIST_ID=${process.env.LISTMONK_LIST_ID} (production)`
    : `LISTMONK_TEST_LIST_ID=${process.env.LISTMONK_TEST_LIST_ID} (non-production)`;
}

// ─────────────────────────────────────────────────────────────────────
// Subscriber operations
// ─────────────────────────────────────────────────────────────────────

export type SubscriptionStatus = "unconfirmed" | "confirmed" | "unsubscribed";

export type ListmonkSubscriberList = {
  id: number;
  uuid: string;
  name: string;
  subscription_status: SubscriptionStatus;
};

export type ListmonkSubscriber = {
  id: number;
  uuid: string;
  email: string;
  name: string;
  status: "enabled" | "disabled" | "blocklisted";
  lists?: ListmonkSubscriberList[];
};

type SubscribersQueryResponse = {
  data: { results: ListmonkSubscriber[]; total: number };
};

function escSqlString(s: string): string {
  return s.replace(/'/g, "''");
}

export async function findSubscriber(email: string): Promise<ListmonkSubscriber | null> {
  const q = `subscribers.email = '${escSqlString(email.toLowerCase())}'`;
  const res = await listmonkFetch<SubscribersQueryResponse>(
    `/api/subscribers?query=${encodeURIComponent(q)}&per_page=1`,
  );
  return res.data.results[0] ?? null;
}

/** True when `email` is a confirmed member of the env-resolved list. */
export async function isConfirmedOnList(email: string): Promise<boolean> {
  const listId = resolveListId();
  const sub = await findSubscriber(email);
  if (!sub) return false;
  const entry = sub.lists?.find((l) => l.id === listId);
  return entry?.subscription_status === "confirmed";
}

/** Create the subscriber if missing, otherwise add the configured list
 *  with the given subscription status. Idempotent. */
export async function upsertSubscriber(
  email: string,
  status: SubscriptionStatus,
): Promise<ListmonkSubscriber> {
  const listId = resolveListId();
  const existing = await findSubscriber(email);

  if (existing) {
    await listmonkFetch("/api/subscribers/lists", {
      method: "PUT",
      body: JSON.stringify({
        ids: [existing.id],
        action: "add",
        target_list_ids: [listId],
        status,
      }),
    });
    return (await findSubscriber(email)) ?? existing;
  }

  type CreateResp = { data: ListmonkSubscriber };
  const created = await listmonkFetch<CreateResp>("/api/subscribers", {
    method: "POST",
    body: JSON.stringify({
      email: email.toLowerCase(),
      // Listmonk requires a non-empty name. The address itself is the
      // only thing the form asks for, so reuse it.
      name: email.toLowerCase(),
      status: "enabled",
      lists: [listId],
      // We run our own HMAC-token double opt-in — ask Listmonk not to
      // send its own opt-in email. New list subscriptions land as
      // `unconfirmed` until promoted by `confirmSubscription`.
      preconfirm_subscriptions: status === "confirmed",
    }),
  });
  return created.data;
}

/** Promote an existing subscription from `unconfirmed` to `confirmed`.
 *  Idempotent: if the subscriber is missing entirely, recreates them. */
export async function confirmSubscription(email: string): Promise<void> {
  await upsertSubscriber(email, "confirmed");
}

// ─────────────────────────────────────────────────────────────────────
// Transactional sends — confirmation email + one-off sends
// ─────────────────────────────────────────────────────────────────────

export type SendTransactionalParams = {
  to: string;
  subject: string;
  html: string;
};

/** Send a one-off transactional email through `/api/tx`. Uses the
 *  passthrough template wired by Hatchkit's listmonk-ses provisioner
 *  (LISTMONK_TX_TEMPLATE_ID); the template consumes
 *  `{{ .Tx.Data.subject }}` + `{{ .Tx.Data.body }}` raw (tx templates
 *  use Go `text/template`, which doesn't auto-escape HTML and doesn't
 *  register `safeHTML`). The recipient must exist as a subscriber —
 *  call `upsertSubscriber` first. */
export async function sendTransactional(params: SendTransactionalParams): Promise<void> {
  const templateId = Number(required("LISTMONK_TX_TEMPLATE_ID"));
  await listmonkFetch("/api/tx", {
    method: "POST",
    body: JSON.stringify({
      subscriber_email: params.to.toLowerCase(),
      template_id: templateId,
      data: { subject: params.subject, body: params.html },
      content_type: "html",
      messenger: "email",
    }),
  });
}

// ─────────────────────────────────────────────────────────────────────
// Campaign send — broadcast HTML to the env-resolved list
// ─────────────────────────────────────────────────────────────────────

export type SendCampaignParams = {
  /** Internal name shown in Listmonk admin. */
  name: string;
  subject: string;
  html: string;
  text: string;
  /** When true, create the campaign in `draft` status so the user can
   *  review in the admin UI before manually starting it. Default false
   *  (campaign starts immediately). */
  draft?: boolean;
};

export type CampaignResult = { id: number; url: string; status: "running" | "draft" };

/** Create a campaign targeting the env-resolved list. By default
 *  immediately flips it to `running` so Listmonk starts dispatching;
 *  pass `draft: true` to leave it in `draft` for manual review. */
export async function sendCampaign(params: SendCampaignParams): Promise<CampaignResult> {
  const listId = resolveListId();
  const fromEmail = required("LISTMONK_FROM");
  const templateId = Number(required("LISTMONK_CAMPAIGN_TEMPLATE_ID"));

  type CreateResp = { data: { id: number } };
  const created = await listmonkFetch<CreateResp>("/api/campaigns", {
    method: "POST",
    body: JSON.stringify({
      name: params.name,
      subject: params.subject,
      lists: [listId],
      from_email: fromEmail,
      content_type: "html",
      body: params.html,
      altbody: params.text,
      type: "regular",
      template_id: templateId,
      send_later: false,
    }),
  });

  const id = created.data.id;
  if (!params.draft) {
    await listmonkFetch(`/api/campaigns/${id}/status`, {
      method: "PUT",
      body: JSON.stringify({ status: "running" }),
    });
  }

  return {
    id,
    url: `${baseUrl()}/admin/campaigns/${id}`,
    status: params.draft ? "draft" : "running",
  };
}
