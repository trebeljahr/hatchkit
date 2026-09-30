/** One project per relay. Request fields never choose AWS credentials or scope. */
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function relayConfig(env) {
  const secret = (name) => {
    if (env[name] && env[`${name}_FILE`]) throw new Error(`Ambiguous ${name}`);
    return env[`${name}_FILE`] ? readFileSync(env[`${name}_FILE`], 'utf8').trim() : env[name];
  };
  const required = (name) => {
    const value = secret(name);
    if (!value) throw new Error(`Missing ${name}`);
    return value;
  };
  const config = {
    region: required('SES_PROJECT_REGION'), identity: required('SES_PROJECT_IDENTITY_ARN'),
    tenant: required('SES_PROJECT_TENANT'), configurationSet: required('SES_PROJECT_CONFIGURATION_SET'),
    from: required('SES_PROJECT_FROM_EMAIL'), accessKeyId: required('SES_PROJECT_ACCESS_KEY_ID'),
    secretAccessKey: required('SES_PROJECT_SECRET_ACCESS_KEY'),
    user: required('RELAY_USER'), password: required('RELAY_PASSWORD'),
    publicUrl: required('LISTMONK_PUBLIC_URL'),
    replyTo: env.SES_PROJECT_REPLY_TO || '',
    mode: env.RELAY_MODE || 'staging', recipient: env.EMAIL_TEST_RECIPIENT || '',
  };
  if (config.replyTo && !mailbox(config.replyTo)) throw new Error('Invalid SES_PROJECT_REPLY_TO');
  const identity = config.identity.match(/^arn:aws:ses:([a-z0-9-]+):\d{12}:identity\/(mail\.[a-z0-9.-]+)$/);
  if (!identity || identity[1] !== config.region || !/^[a-z0-9][a-z0-9._+-]*@[a-z0-9.-]+$/.test(config.from) || config.from.split('@')[1] !== identity[2]) throw new Error('Invalid sender scope');
  if (!['staging', 'production'].includes(config.mode) || (config.mode === 'staging' && !mailbox(config.recipient))) throw new Error('Staging requires EMAIL_TEST_RECIPIENT');
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(config.user) || config.password.length < 32) throw new Error('Relay requires a username and at least 32 password characters');
  const url = new URL(config.publicUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('LISTMONK_PUBLIC_URL must be an HTTPS origin');
  config.publicUrl = url.origin;
  return Object.freeze(config);
}
function mailbox(value) { return typeof value === 'string' && value.length <= 254 && /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(value); }
const uuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function authenticated(header, config) {
  const expected = `Basic ${Buffer.from(`${config.user}:${config.password}`).toString('base64')}`;
  const hash = (text) => createHash('sha256').update(text).digest();
  return typeof header === 'string' && timingSafeEqual(hash(header), hash(expected));
}
export function messageForProject(payload, config) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid message');
  if (payload.from_email !== config.from || (payload.campaign && payload.campaign.from_email !== config.from)) throw new Error('Foreign sender');
  if (!Array.isArray(payload.recipients) || payload.recipients.length !== 1 || !mailbox(payload.recipients[0]?.email)) throw new Error('Exactly one recipient required');
  const recipient = payload.recipients[0];
  if (recipient.status !== 'enabled' && (payload.campaign || recipient.status !== '')) throw new Error('Recipient is not enabled');
  if (config.mode !== 'production' && recipient.email.toLowerCase() !== config.recipient.toLowerCase()) throw new Error('Recipient outside staging allowlist');
  if (typeof payload.subject !== 'string' || !payload.subject || payload.subject.length > 900 || /[\r\n]/.test(payload.subject) || typeof payload.body !== 'string' || !payload.body || !['html', 'plain'].includes(payload.content_type)) throw new Error('Invalid message content');
  if (payload.attachments != null && (!Array.isArray(payload.attachments) || payload.attachments.length)) throw new Error('Attachments unsupported; no mail sent');
  // Custom headers can contain From/Bcc/SES overrides or unrendered templates.
  // Do not forward them, and refuse rather than silently losing a requested header.
  if (payload.campaign?.headers != null && (!Array.isArray(payload.campaign.headers) || payload.campaign.headers.length)) throw new Error('Custom campaign headers unsupported');
  const headers = [];
  if (payload.campaign) {
    if (!uuid(payload.campaign.uuid) || !uuid(recipient.uuid)) throw new Error('Invalid campaign/subscriber UUID');
    headers.push({ Name: 'List-Unsubscribe', Value: `<${config.publicUrl}/subscription/${payload.campaign.uuid}/${recipient.uuid}>` },
      { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' });
  }
  return {
    FromEmailAddress: config.from, FromEmailAddressIdentityArn: config.identity,
    TenantName: config.tenant, ConfigurationSetName: config.configurationSet,
    Destination: { ToAddresses: [recipient.email] },
    ...(config.replyTo ? { ReplyToAddresses: [config.replyTo] } : {}),
    Content: { Simple: { Subject: { Data: payload.subject, Charset: 'UTF-8' },
      Body: payload.content_type === 'html' ? { Html: { Data: payload.body, Charset: 'UTF-8' } } : { Text: { Data: payload.body, Charset: 'UTF-8' } },
      ...(headers.length ? { Headers: headers } : {}),
    } },
  };
}
export function createRelayHandler(config, send) {
  return async (req, res) => {
    const respond = (code, message) => { res.writeHead(code, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end(message); };
    if (req.method === 'GET' && req.url === '/health') return respond(200, 'ok');
    if (req.method !== 'POST' || req.url !== '/send') return respond(404, 'not found');
    if (!authenticated(req.headers.authorization, config)) return respond(401, 'unauthorized');
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return respond(415, 'JSON required');
    let message; let payload;
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { respond(413, 'message too large'); req.destroy(); return; }
        chunks.push(chunk);
      }
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      message = messageForProject(payload, config);
    } catch { return respond(400, 'invalid project message'); }
    try { await send(message, payload); respond(200, 'accepted'); }
    catch { respond(502, 'delivery failed; verify outcome before retry'); }
  };
}
