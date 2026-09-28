/**
 * Listmonk HTTP API client.
 *
 * Talks to a self-hosted Listmonk instance (delivering via Amazon SES
 * SMTP) over its REST API:
 *
 *   - Subscribers + list memberships live in Listmonk. An address
 *     joins the list only once it confirms (see `confirmSubscription`).
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

/** Quote regex metacharacters so `s` matches only itself. */
function escRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function findSubscriber(email: string): Promise<ListmonkSubscriber | null> {
  const normalized = email.toLowerCase();
  // `search` needs only the `subscribers:get*` permissions. The `query`
  // param would need `subscribers:sql_query`, which Listmonk's role
  // form leaves out by default. Listmonk matches `search` as a
  // Postgres regex against name and email (`email ~* $search`), so
  // anchor and quote it: unquoted, the `+` in `a+b@x.com` is a
  // quantifier and a plus-address never finds itself.
  const params = new URLSearchParams({
    search: `^${escRegex(normalized)}$`,
    per_page: "all",
  });
  const res = await listmonkFetch<SubscribersQueryResponse>(`/api/subscribers?${params}`);
  // `search` also matches the name column, so keep only the exact email.
  return res.data.results.find((sub) => sub.email.toLowerCase() === normalized) ?? null;
}

/** True when `email` is a confirmed member of the env-resolved list. */
export async function isConfirmedOnList(email: string): Promise<boolean> {
  const listId = resolveListId();
  const sub = await findSubscriber(email);
  if (!sub) return false;
  const entry = sub.lists?.find((l) => l.id === listId);
  return entry?.subscription_status === "confirmed";
}

// ─────────────────────────────────────────────────────────────────────
// Double opt-in and list membership
//
// An address goes on the list only after the HMAC link in our
// confirmation email is clicked, and then as `confirmed`. Until then
// it exists as a subscriber with no lists, which is all `/api/tx`
// needs to deliver the confirmation email.
//
// Hatchkit creates the lists `optin: double`, so campaigns reach
// `confirmed` members only. Adding the membership late is what makes
// that work without a second email: Listmonk sends its own opt-in
// email for any `unconfirmed` membership on a double list that is
// created or updated without `preconfirm_subscriptions` (when
// `app.send_optin_confirmation` is on), next to ours. And on a
// single-opt-in list Listmonk mails every member not `unsubscribed`,
// `unconfirmed` included, so an early membership would get every
// campaign without a confirm click.
// ─────────────────────────────────────────────────────────────────────

async function createSubscriber(email: string, listIds: number[]): Promise<ListmonkSubscriber> {
  type CreateResp = { data: ListmonkSubscriber };
  const created = await listmonkFetch<CreateResp>("/api/subscribers", {
    method: "POST",
    body: JSON.stringify({
      email: email.toLowerCase(),
      // Listmonk requires a non-empty name. The address itself is the
      // only thing the form asks for, so reuse it.
      name: email.toLowerCase(),
      status: "enabled",
      lists: listIds,
      // Marks any list in `listIds` as `confirmed` and stops Listmonk's
      // own opt-in email. With `false`, Listmonk would mail its
      // confirmation for every double-opt-in list in `listIds`.
      preconfirm_subscriptions: true,
    }),
  });
  return created.data;
}

/** Make sure `email` exists as a Listmonk subscriber, without adding it
 *  to any list. Call this before sending the confirmation email.
 *
 *  An existing subscriber is returned untouched. It may belong to
 *  other projects' lists on a shared instance, or be `unsubscribed`
 *  from ours, and submitting the form again must not put it on our
 *  list before the confirm click. */
export async function ensureSubscriber(email: string): Promise<ListmonkSubscriber> {
  return (await findSubscriber(email)) ?? (await createSubscriber(email, []));
}

/** Add `email` to the env-resolved list as `confirmed`. Only the
 *  confirm route calls this, after the token has proven the reader owns
 *  the address (and `newsletter:verify`, for your own inbox). Idempotent:
 *  an existing membership, whatever its status, becomes `confirmed`.
 *  A subscriber that has gone missing since the token was issued is
 *  recreated on the list. The `PUT /api/subscribers/lists` path sends
 *  no Listmonk opt-in email. */
export async function confirmSubscription(email: string): Promise<void> {
  const listId = resolveListId();
  const existing = await findSubscriber(email);
  if (!existing) {
    await createSubscriber(email, [listId]);
    return;
  }
  await listmonkFetch("/api/subscribers/lists", {
    method: "PUT",
    body: JSON.stringify({
      ids: [existing.id],
      action: "add",
      target_list_ids: [listId],
      status: "confirmed",
    }),
  });
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
 *  call `ensureSubscriber` first. */
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
