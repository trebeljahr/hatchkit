import { env } from "../config/env.js";

export interface EmailParams {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Send a transactional email via Listmonk's /api/tx endpoint (which
 * relays through the SES SMTP identity configured at provision time).
 * Falls back to console logging when Listmonk isn't configured yet.
 *
 * The transactional template seeded by `hatchkit add <project>
 * listmonk-ses` renders `{{ .Tx.Data.subject }}` for the subject and
 * `{{ .Tx.Data.body | Safe }}` in the body. Listmonk parses a tx body
 * with Go html/template, so without `Safe` the HTML would arrive
 * escaped, as visible markup. When `html` is supplied we send that,
 * otherwise the plaintext body is escaped and wrapped in a `<pre>` so
 * the template still receives HTML.
 */
// hatchkit-ses-project-v1: activation is explicit, including for existing apps.
export function isEmailConfigured(): boolean {
  if (env.EMAIL_TRANSPORT === "ses") return true; // incomplete SES must fail, never log-and-drop
  return !!(env.LISTMONK_URL && env.LISTMONK_TX_TEMPLATE_ID);
}

export async function sendEmail(params: EmailParams): Promise<void> {
  if (env.EMAIL_TRANSPORT === "ses") {
    const { sendProjectSesEmail } = await import("./ses-email.js");
    await sendProjectSesEmail(params, env);
    return;
  }
  if (env.EMAIL_TRANSPORT && env.EMAIL_TRANSPORT !== "listmonk") throw new Error("Unknown EMAIL_TRANSPORT");
  const ready =
    env.LISTMONK_URL &&
    env.LISTMONK_API_USER &&
    env.LISTMONK_API_TOKEN &&
    env.LISTMONK_TX_TEMPLATE_ID &&
    (env.LISTMONK_FROM_EMAIL || env.LISTMONK_FROM);
  if (!ready) {
    console.log(`[email] Would send to ${params.to}: ${params.subject}`);
    return;
  }

  const baseUrl = env.LISTMONK_URL.replace(/\/$/, "");
  const auth = Buffer.from(
    `${env.LISTMONK_API_USER}:${env.LISTMONK_API_TOKEN}`,
  ).toString("base64");

  const response = await fetch(`${baseUrl}/api/tx`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(listmonkTxBody(params, env)),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Listmonk /api/tx error (${response.status}): ${text}`);
  }
}

/**
 * The `/api/tx` body for one account email.
 *
 * `subscriber_mode: "external"` is what lets it reach anybody at all. Without
 * it Listmonk uses its `default` mode, where the recipient must already be a
 * subscriber, and answers 400 for everyone else — which is every person who
 * signs up, resets a password or is invited, since none of them joined the
 * newsletter. `external` also skips the subscriber lookup, so nothing about a
 * person's newsletter state decides whether their reset arrives.
 * `subscriber_email` stays singular; Listmonk folds it into `subscriber_emails`
 * (`validateTxMessage`, checked in v6.0.0).
 */
export function listmonkTxBody(
  params: EmailParams,
  source: Pick<
    typeof env,
    "LISTMONK_FROM" | "LISTMONK_FROM_EMAIL" | "LISTMONK_TX_TEMPLATE_ID"
  >,
): Record<string, unknown> {
  return {
    subscriber_email: params.to,
    subscriber_mode: "external",
    template_id: Number(source.LISTMONK_TX_TEMPLATE_ID),
    from_email: source.LISTMONK_FROM || source.LISTMONK_FROM_EMAIL,
    data: {
      subject: params.subject,
      body: params.html ?? `<pre>${escapeHtml(params.text)}</pre>`,
    },
    content_type: "html",
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
