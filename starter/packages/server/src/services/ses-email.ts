/** hatchkit-ses-project-v1: explicit credentials, no default AWS chain and no
 * fallback to shared SMTP/Listmonk credentials. IAM is the sender boundary;
 * these runtime checks additionally prevent configuration mistakes.
 */
import type { EmailParams } from "./email.js";

export interface ProjectSesConfig {
  SES_PROJECT_ACCESS_KEY_ID: string;
  SES_PROJECT_SECRET_ACCESS_KEY: string;
  SES_PROJECT_REGION: string;
  SES_PROJECT_IDENTITY_ARN: string;
  SES_PROJECT_TENANT: string;
  SES_PROJECT_CONFIGURATION_SET: string;
  SES_PROJECT_FROM_EMAIL: string;
  EMAIL_TEST_RECIPIENT: string;
  isProduction: boolean;
  isTest: boolean;
}

export function projectSesReady(source: ProjectSesConfig): boolean {
  return [source.SES_PROJECT_ACCESS_KEY_ID, source.SES_PROJECT_SECRET_ACCESS_KEY, source.SES_PROJECT_REGION,
    source.SES_PROJECT_IDENTITY_ARN, source.SES_PROJECT_TENANT, source.SES_PROJECT_CONFIGURATION_SET,
    source.SES_PROJECT_FROM_EMAIL].every(Boolean);
}

export function projectSesMessage(params: EmailParams, source: ProjectSesConfig) {
  if (!projectSesReady(source)) throw new Error("Per-project SES is incomplete. Run the reviewed Hatchkit SES sender migration; shared credentials are never a fallback.");
  const identity = source.SES_PROJECT_IDENTITY_ARN.match(/^arn:aws:ses:([a-z0-9-]+):\d{12}:identity\/(mail\.[a-z0-9.-]+)$/);
  if (!identity || identity[1] !== source.SES_PROJECT_REGION || source.SES_PROJECT_FROM_EMAIL.split("@")[1] !== identity[2] || !/^[a-z0-9][a-z0-9._+-]*@[a-z0-9.-]+$/.test(source.SES_PROJECT_FROM_EMAIL)) throw new Error("SES sender identity, From address and region do not agree.");
  if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(params.to) || /[\r\n]/.test(params.subject)) throw new Error("Invalid email recipient or subject.");
  if (!source.isProduction && (!source.EMAIL_TEST_RECIPIENT || params.to.toLowerCase() !== source.EMAIL_TEST_RECIPIENT.toLowerCase())) throw new Error("Non-production email may only target EMAIL_TEST_RECIPIENT.");
  if (params.replyTo !== undefined && !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(params.replyTo)) throw new Error("Invalid Reply-To address.");
  const attachments = (params.attachments ?? []).map((a) => {
    // Header values: no line breaks, no path parts in the file name.
    if (!a.filename || /[\r\n/\\"]/.test(a.filename) || a.filename.length > 255) throw new Error("Invalid attachment file name.");
    if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+(\s*;\s*[a-z0-9-]+=[a-z0-9.+-]+)*$/i.test(a.contentType)) throw new Error("Invalid attachment content type.");
    const raw = typeof a.content === "string" ? new TextEncoder().encode(a.content) : a.content;
    return { FileName: a.filename, ContentType: a.contentType, RawContent: raw, ContentDisposition: a.disposition === "inline" ? ("INLINE" as const) : ("ATTACHMENT" as const), ContentTransferEncoding: "BASE64" as const };
  });
  if (attachments.length > 10 || attachments.reduce((n, a) => n + a.RawContent.byteLength, 0) > 10 * 1024 * 1024) throw new Error("Too many or too large attachments (10 files, 10 MB).");
  return {
    FromEmailAddress: source.SES_PROJECT_FROM_EMAIL,
    FromEmailAddressIdentityArn: source.SES_PROJECT_IDENTITY_ARN,
    TenantName: source.SES_PROJECT_TENANT,
    ConfigurationSetName: source.SES_PROJECT_CONFIGURATION_SET,
    Destination: { ToAddresses: [params.to] },
    ...(params.replyTo ? { ReplyToAddresses: [params.replyTo] } : {}),
    Content: { Simple: {
      Subject: { Data: params.subject, Charset: "UTF-8" },
      Body: { Text: { Data: params.text, Charset: "UTF-8" }, ...(params.html ? { Html: { Data: params.html, Charset: "UTF-8" } } : {}) },
      ...(attachments.length ? { Attachments: attachments } : {}),
    } },
  };
}

export async function sendProjectSesEmail(params: EmailParams, source: ProjectSesConfig): Promise<void> {
  const message = projectSesMessage(params, source);
  if (source.isTest) return; // NODE_ENV=test never opens a mail connection.
  const { SESv2Client, SendEmailCommand } = await import("@aws-sdk/client-sesv2");
  const client = new SESv2Client({
    region: source.SES_PROJECT_REGION,
    credentials: { accessKeyId: source.SES_PROJECT_ACCESS_KEY_ID, secretAccessKey: source.SES_PROJECT_SECRET_ACCESS_KEY },
  });
  try {
    await client.send(new SendEmailCommand(message));
  } catch {
    // Provider response bodies can contain addresses/content. Log neither.
    throw new Error("Project SES delivery failed. Check sender policy, tenant status and SES sandbox restrictions; no fallback was attempted.");
  } finally { client.destroy(); }
}
