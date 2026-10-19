/*
 * Send one plain-text email through Amazon SES v2 (SendEmail), signed with
 * SigV4 by hand. The audit Worker cannot load the AWS SDK, and hatchkit's
 * own SES helpers use it, so this is the small piece both share.
 *
 * The key it gets is the Worker's own: an IAM user that may only call
 * ses:SendEmail from one address to Rico's address (see the design note),
 * never hatchkit's SES admin key.
 *
 * No imports: uploaded to the Worker as compiled. WebCrypto only.
 */

export interface SesCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

export interface SigV4Request {
  method: string;
  host: string;
  path: string;
  query?: string;
  headers: Record<string, string>;
  body: string;
  service: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** `YYYYMMDDTHHMMSSZ` */
  amzDate: string;
}

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sha256Hex(data: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(data)));
}

async function hmac(
  key: ArrayBuffer | Uint8Array<ArrayBuffer>,
  data: string,
): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

export const amzDateOf = (d: Date): string =>
  d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

/** SigV4 `Authorization` header for a request whose headers include host and x-amz-date. */
export async function sigV4Authorization(req: SigV4Request): Promise<string> {
  const headers = Object.entries(req.headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const signedHeaders = headers.map(([k]) => k).join(";");
  const canonical = [
    req.method,
    req.path,
    req.query ?? "",
    ...headers.map(([k, v]) => `${k}:${v}`),
    "",
    signedHeaders,
    await sha256Hex(req.body),
  ].join("\n");
  const day = req.amzDate.slice(0, 8);
  const scope = `${day}/${req.region}/${req.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", req.amzDate, scope, await sha256Hex(canonical)].join("\n");
  let key = await hmac(enc.encode(`AWS4${req.secretAccessKey}`), day);
  key = await hmac(key, req.region);
  key = await hmac(key, req.service);
  key = await hmac(key, "aws4_request");
  const signature = hex(await hmac(key, toSign));
  return `AWS4-HMAC-SHA256 Credential=${req.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

export async function sendSesTextMail(params: {
  credentials: SesCredentials;
  from: string;
  to: string;
  subject: string;
  text: string;
  now?: Date;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}): Promise<{ messageId?: string }> {
  const { credentials: c } = params;
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(c.region)) throw new Error(`Not an AWS region: ${c.region}`);
  const host = `email.${c.region}.amazonaws.com`;
  const path = "/v2/email/outbound-emails";
  const body = JSON.stringify({
    FromEmailAddress: params.from,
    Destination: { ToAddresses: [params.to] },
    Content: {
      Simple: {
        Subject: { Data: params.subject, Charset: "UTF-8" },
        Body: { Text: { Data: params.text, Charset: "UTF-8" } },
      },
    },
  });
  const amzDate = amzDateOf(params.now ?? new Date());
  const headers: Record<string, string> = {
    "content-type": "application/json",
    host,
    "x-amz-date": amzDate,
  };
  const authorization = await sigV4Authorization({
    method: "POST",
    host,
    path,
    headers,
    body,
    service: "ses",
    region: c.region,
    accessKeyId: c.accessKeyId,
    secretAccessKey: c.secretAccessKey,
    amzDate,
  });
  const { host: _host, ...sendHeaders } = headers;
  const res = await (params.fetch ?? fetch)(`https://${host}${path}`, {
    method: "POST",
    headers: { ...sendHeaders, authorization },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => null)) as {
    MessageId?: string;
    message?: string;
  } | null;
  if (!res.ok) throw new Error(`SES SendEmail: HTTP ${res.status} ${json?.message ?? ""}`.trim());
  return { messageId: json?.MessageId };
}
