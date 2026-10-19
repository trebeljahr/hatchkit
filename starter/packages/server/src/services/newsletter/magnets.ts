/**
 * Lead magnets: a free file emailed to a reader who signs up for it.
 *
 * A form names a magnet by key only (`<SubscribeForm magnet="wallpapers" />`).
 * The key must be in magnets.json next to this file. The server never
 * takes a URL from a request, so the form cannot mail an arbitrary link
 * from the project's sender.
 *
 *   {
 *     "wallpapers": { "title": "Desktop wallpaper pack", "object": "magnets/wallpapers.zip" },
 *     "reading-list": { "title": "Reading list", "url": "https://example.com/reading-list.pdf" }
 *   }
 *
 *   key       lowercase letters, digits and dashes; the form sends it, and
 *             only the signed links carry it. Nothing on the Listmonk
 *             subscriber records it; count deliveries from the
 *             `newsletter.delivery` log lines instead.
 *   title     shown in the email
 *   object    a key in the project's bucket (S3_BUCKET_NAME). The download
 *             route answers with a 10-minute presigned GET, so the bucket
 *             can stay private.
 *   url       an https URL the download route redirects to, for a file
 *             that is public anyway
 *   filename  optional: the name the browser saves an `object` as
 *
 * `hatchkit add <project> lead-magnet` edits the file. Removing an entry
 * stops every download link already sent for it, until an entry with the
 * same key is added again: a token carries only the key.
 *
 * Delivery: the confirm route sends the email after it adds the list
 * membership; an already-confirmed subscriber gets it straight from the
 * subscribe route. The email links to /api/newsletter/download with a
 * signed token (subscribe.ts), never to the file, so the link can expire
 * and a removed magnet stops working.
 */

import magnetsJson from "./magnets.json" with { type: "json" };
import { sendTransactional } from "./listmonk.js";
import { DOWNLOAD_TOKEN_TTL_MS, mintDownloadToken } from "./subscribe.js";

export type Magnet = {
  key: string;
  title: string;
  object?: string;
  url?: string;
  filename?: string;
};

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
// A browser filename: no path separators, quotes or line breaks.
const FILENAME_RE = /^[^/\\"\r\n]{1,200}$/;

/** Validate magnets.json. An invalid entry is left out and reported,
 *  so one typo does not take down every other magnet. */
export function parseMagnets(raw: unknown): { magnets: Map<string, Magnet>; problems: string[] } {
  const magnets = new Map<string, Magnet>();
  const problems: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { magnets, problems: ["magnets.json must be a JSON object keyed by magnet key"] };
  }
  for (const [key, value] of Object.entries(raw)) {
    const entry = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
    const problem = magnetProblem(key, entry);
    if (problem) {
      problems.push(`${key}: ${problem}`);
      continue;
    }
    magnets.set(key, {
      key,
      title: (entry.title as string).trim(),
      ...(typeof entry.object === "string" ? { object: entry.object } : {}),
      ...(typeof entry.url === "string" ? { url: entry.url } : {}),
      ...(typeof entry.filename === "string" ? { filename: entry.filename } : {}),
    });
  }
  return { magnets, problems };
}

function magnetProblem(key: string, entry: Record<string, unknown>): string | null {
  if (!KEY_RE.test(key)) return "key must be lowercase letters, digits and dashes (max 48)";
  if (typeof entry.title !== "string" || entry.title.trim().length === 0) return "needs a title";
  const hasObject = entry.object !== undefined;
  const hasUrl = entry.url !== undefined;
  if (hasObject === hasUrl) return "needs exactly one of `object` or `url`";
  if (hasObject) {
    const object = entry.object;
    if (typeof object !== "string" || object.length === 0 || object.startsWith("/") || object.split("/").includes("..")) {
      return "`object` must be a bucket key such as magnets/file.zip";
    }
  }
  if (hasUrl) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(String(entry.url));
    } catch {
      // reported below
    }
    if (parsed?.protocol !== "https:") return "`url` must be an https URL";
  }
  if (entry.filename !== undefined && (typeof entry.filename !== "string" || !FILENAME_RE.test(entry.filename))) {
    return "`filename` must be a plain file name";
  }
  return null;
}

let cache: Map<string, Magnet> | null = null;

function magnets(): Map<string, Magnet> {
  if (cache) return cache;
  const { magnets: parsed, problems } = parseMagnets(magnetsJson);
  if (problems.length > 0) {
    // Loud, once per process: a skipped entry means a form that offers
    // a download nobody can receive.
    console.error(
      JSON.stringify({ scope: "newsletter.magnets", level: "error", event: "config_invalid", problems }),
    );
  }
  cache = parsed;
  return cache;
}

/** The magnet for a key from a request or token, or undefined. */
export function getMagnet(key: unknown): Magnet | undefined {
  return typeof key === "string" ? magnets().get(key) : undefined;
}

export function listMagnets(): Magnet[] {
  return [...magnets().values()];
}

/** Replace magnets.json for a test; `null` goes back to the file. */
export function _setMagnetsForTests(raw: unknown | null): void {
  cache = raw === null ? null : parseMagnets(raw).magnets;
}

/** Where the download route sends the reader. */
export async function magnetDownloadUrl(magnet: Magnet): Promise<string> {
  if (magnet.url) return magnet.url;
  const object = magnet.object as string;
  // Imported here so a project whose magnets are all `url` never loads
  // the AWS SDK.
  const { getPresignedDownloadUrl } = await import("../storage.js");
  return getPresignedDownloadUrl(object, magnet.filename ?? object.split("/").pop() ?? object);
}

export type SendMagnetEmailParams = { to: string; magnet: Magnet; siteName: string };

/** Email the download link through Listmonk `/api/tx`. The recipient
 *  must be a subscriber already. A resolved promise means Listmonk
 *  queued the email, not that SES accepted it. */
export async function sendMagnetEmail(params: SendMagnetEmailParams): Promise<void> {
  // The download route is on the API's public origin, like the confirm
  // link (see apiUrl() in routes.ts).
  const api = (process.env.BETTER_AUTH_URL ?? "").replace(/\/$/, "");
  if (!api) throw new Error("BETTER_AUTH_URL is not set, so there is no download link to send");
  const token = mintDownloadToken(params.magnet.key);
  const downloadUrl = `${api}/api/newsletter/download?token=${encodeURIComponent(token)}`;
  await sendTransactional({
    to: params.to,
    subject: `Your download: ${params.magnet.title} · ${params.siteName}`,
    html: renderMagnetHtml({ title: params.magnet.title, downloadUrl, siteName: params.siteName }),
  });
}

const LINK_DAYS = Math.round(DOWNLOAD_TOKEN_TTL_MS / (24 * 60 * 60 * 1000));

function renderMagnetHtml(args: { title: string; downloadUrl: string; siteName: string }): string {
  // Plain HTML on purpose, like the confirmation email in subscribe.ts.
  const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"></head>
  <body style="font-family:system-ui,sans-serif;line-height:1.55;color:#1a1a1a;max-width:560px;margin:0 auto;padding:32px 24px;">
    <h1 style="font-size:22px;margin:0 0 16px 0;font-weight:600;">${esc(args.title)}</h1>
    <p style="margin:0 0 24px 0;">Here is the download you asked for from <strong>${esc(args.siteName)}</strong>.</p>
    <p style="margin:24px 0;">
      <a href="${esc(args.downloadUrl)}" style="display:inline-block;padding:12px 22px;background:#111;color:#fff;text-decoration:none;border-radius:6px;font-weight:500;">
        Download
      </a>
    </p>
    <p style="margin:24px 0 8px 0;font-size:13px;color:#555;">Or paste this URL into your browser:</p>
    <p style="margin:0 0 24px 0;font-size:13px;color:#555;word-break:break-all;">${esc(args.downloadUrl)}</p>
    <hr style="border:0;border-top:1px solid #e5e5e5;margin:32px 0;">
    <p style="margin:0;font-size:12px;color:#777;">
      The link works for ${LINK_DAYS} days. To get a new one, enter your address in the signup form again.
    </p>
  </body>
</html>`;
}
