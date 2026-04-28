import { env } from "../config/env.js";

interface EmailParams {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Send a transactional email via Mailgun HTTP API.
 * Falls back to console logging if Mailgun is not configured.
 */
export async function sendEmail(params: EmailParams): Promise<void> {
  if (!env.MAILGUN_API_KEY || !env.MAILGUN_DOMAIN) {
    console.log(`[email] Would send to ${params.to}: ${params.subject}`);
    return;
  }

  const form = new URLSearchParams();
  form.append("from", `App <noreply@${env.MAILGUN_DOMAIN}>`);
  form.append("to", params.to);
  form.append("subject", params.subject);
  form.append("text", params.text);
  if (params.html) {
    form.append("html", params.html);
  }

  const response = await fetch(
    `https://api.mailgun.net/v3/${env.MAILGUN_DOMAIN}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`api:${env.MAILGUN_API_KEY}`).toString("base64")}`,
      },
      body: form,
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Mailgun API error (${response.status}): ${body}`);
  }
}
