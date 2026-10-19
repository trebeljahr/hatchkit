/**
 * Newsletter Express routes — registered by `registerNewsletterRoutes`
 * from `app.ts`. Strip the call (and this file) to disable.
 *
 *   POST /api/newsletter/subscribe   — rate-limited; mints confirm token + emails it
 *   GET  /api/newsletter/confirm     — verifies token + adds the address to the list
 *   GET  /api/newsletter/download    — verifies a lead-magnet token + redirects to the file
 *
 * Registering the routes also schedules the daily cleanup of
 * never-confirmed subscribers in production (prune.ts).
 *
 * Every endpoint logs JSON lines under `scope: "newsletter.*"` so log
 * aggregators can filter on it. A lead-magnet email that could not be
 * sent logs `newsletter.delivery` / `delivery_failed` at error level.
 */

import type { Express, Request, Response } from "express";
import { createNewsletterClientIp } from "./client-ip.js";
import { getMagnet, type Magnet, magnetDownloadUrl, sendMagnetEmail } from "./magnets.js";
import { scheduleUnconfirmedCleanup } from "./prune.js";
import {
  checkDeliveryCooldown,
  checkRateLimit,
  confirmSubscription,
  isAlreadySubscribed,
  mintConfirmToken,
  normalizeEmail,
  normalizeSource,
  sendConfirmationEmail,
  verifyConfirmToken,
  verifyDownloadToken,
} from "./subscribe.js";

function log(level: "info" | "error", scope: string, event: string, extra: object = {}): void {
  const line = JSON.stringify({ scope: `newsletter.${scope}`, level, event, ...extra });
  if (level === "error") console.error(line);
  else console.info(line);
}

/** Origin of the client app. The `/sub/confirmed` and `/sub/error`
 *  pages live here, so the confirm route redirects to it. */
function siteUrl(): string {
  return (process.env.NEWSLETTER_SITE_URL ?? process.env.FRONTEND_URL ?? "").replace(/\/$/, "");
}

/** Public origin of this API server. The confirm link in the email must
 *  land here: the client host has no route to `/api/newsletter/confirm`
 *  when client and API are served from different hosts. */
function apiUrl(): string {
  return (process.env.BETTER_AUTH_URL ?? "").replace(/\/$/, "");
}

function siteName(): string {
  return process.env.NEWSLETTER_SITE_NAME ?? "this newsletter";
}

/** Send the lead-magnet email and log the outcome. Never throws: the
 *  caller decides what a failure means for the reader.
 *
 *  `/api/tx` answers 200 once Listmonk has queued the email, before SMTP
 *  runs, so `delivery_sent` means "queued". An SES rejection after that
 *  shows only in Listmonk → Settings → Logs. */
async function deliverMagnet(to: string, magnet: Magnet, via: "confirm" | "subscribe"): Promise<boolean> {
  try {
    await sendMagnetEmail({ to, magnet, siteName: siteName() });
  } catch (err) {
    log("error", "delivery", "delivery_failed", {
      magnet: magnet.key,
      via,
      message: (err as Error).message,
    });
    return false;
  }
  log("info", "delivery", "delivery_sent", { magnet: magnet.key, via });
  return true;
}

export function registerNewsletterRoutes(app: Express): void {
  const clientIp = createNewsletterClientIp();
  scheduleUnconfirmedCleanup();

  // POST /api/newsletter/subscribe
  app.post("/api/newsletter/subscribe", async (req: Request, res: Response) => {
    const ip = clientIp(req);
    if (!checkRateLimit(ip)) {
      log("info", "subscribe", "rate_limited", { ip });
      res
        .status(429)
        .json({ error: "rate_limited", message: "Too many requests. Please wait a minute." });
      return;
    }

    const body = (req.body ?? {}) as {
      email?: string;
      website?: string;
      magnet?: unknown;
      source?: unknown;
    };

    // Honeypot — real users never fill this. Return a 200-shaped
    // success so bots get no signal about what tripped them.
    if (typeof body.website === "string" && body.website.trim().length > 0) {
      log("info", "subscribe", "honeypot_triggered", { ip });
      res.json({ ok: true });
      return;
    }

    const email = normalizeEmail(body.email);
    if (!email) {
      res.status(400).json({
        error: "invalid_email",
        message: "Please enter a valid email address.",
      });
      return;
    }

    // A magnet is named by its key in magnets.json, never by a URL. An
    // unknown key is a form that offers a download the server does not
    // have, so say so instead of subscribing without it.
    let magnet: Magnet | undefined;
    if (body.magnet !== undefined && body.magnet !== null && body.magnet !== "") {
      magnet = getMagnet(body.magnet);
      if (!magnet) {
        log("error", "subscribe", "unknown_magnet", {
          magnet: typeof body.magnet === "string" ? body.magnet.slice(0, 64) : typeof body.magnet,
        });
        res.status(400).json({
          error: "unknown_magnet",
          message: "That download is not available.",
        });
        return;
      }
    }
    const source = normalizeSource(body.source);

    // Short-circuit confirmed members — no point sending another
    // confirmation email or re-issuing a token that does nothing. The
    // form uses `alreadySubscribed` to swap the success message. A
    // confirmed member who asks for a download gets it straight away:
    // the address is already proven, and the form stays the way to get
    // a fresh link once an old one expires.
    if (await isAlreadySubscribed(email)) {
      log("info", "subscribe", "already_subscribed", { ip });
      if (magnet) {
        // Sent within the last 15 minutes: say so, send nothing new.
        if (!checkDeliveryCooldown(email, magnet.key)) {
          log("info", "delivery", "cooldown", { magnet: magnet.key });
          res.json({ ok: true, alreadySubscribed: true, delivered: true });
          return;
        }
        if (!(await deliverMagnet(email, magnet, "subscribe"))) {
          res.status(502).json({
            error: "send_failed",
            message: "Could not send the download email. Please try again.",
          });
          return;
        }
        res.json({ ok: true, alreadySubscribed: true, delivered: true });
        return;
      }
      res.json({ ok: true, alreadySubscribed: true });
      return;
    }

    const api = apiUrl();
    if (!api) {
      log("error", "subscribe", "no_api_url");
      res.status(500).json({
        error: "config",
        message: "Newsletter API URL is not configured.",
      });
      return;
    }

    const signup = { source, magnet: magnet?.key };
    const token = mintConfirmToken(email, signup);
    const confirmUrl = `${api}/api/newsletter/confirm?token=${encodeURIComponent(token)}`;

    try {
      await sendConfirmationEmail({ to: email, confirmUrl, siteName: siteName(), signup });
    } catch (err) {
      log("error", "subscribe", "send_confirmation_failed", {
        ip,
        message: (err as Error).message,
      });
      res.status(502).json({
        error: "send_failed",
        message: "Could not send confirmation email. Please try again.",
      });
      return;
    }

    log("info", "subscribe", "confirmation_sent", { ip });
    res.json({ ok: true });
  });

  // GET /api/newsletter/confirm
  app.get("/api/newsletter/confirm", async (req: Request, res: Response) => {
    const base = siteUrl();
    const tokenParam = req.query.token;
    const token = typeof tokenParam === "string" ? tokenParam : "";

    if (!base) {
      log("error", "confirm", "no_site_url");
      res.status(500).send("Newsletter site URL is not configured.");
      return;
    }
    if (!token) {
      res.redirect(303, `${base}/sub/error?reason=missing`);
      return;
    }

    const result = verifyConfirmToken(token);
    if (!result.ok) {
      log("info", "confirm", "verify_failed", { reason: result.reason });
      res.redirect(303, `${base}/sub/error?reason=${result.reason}`);
      return;
    }

    let alreadyConfirmed: boolean;
    try {
      ({ alreadyConfirmed } = await confirmSubscription(result.email, {
        source: result.source,
        magnet: result.magnet,
      }));
    } catch (err) {
      log("error", "confirm", "list_add_failed", { message: (err as Error).message });
      res.redirect(303, `${base}/sub/error?reason=list_add_failed`);
      return;
    }

    // The membership is live whatever happens next, so a failed send
    // never bounces the reader to the error page. Only the first click
    // sends the download: mail scanners often open the link before the
    // reader, and the reader's own click must not send a second copy.
    // The form sends a fresh link.
    let delivery: "sent" | "failed" | undefined;
    if (result.magnet && !alreadyConfirmed) {
      const magnet = getMagnet(result.magnet);
      if (magnet) {
        delivery = (await deliverMagnet(result.email, magnet, "confirm")) ? "sent" : "failed";
      } else {
        log("error", "delivery", "delivery_failed", {
          magnet: result.magnet,
          via: "confirm",
          message: "magnet is no longer in magnets.json",
        });
        delivery = "failed";
      }
    }

    log("info", "confirm", "confirmed", delivery ? { delivery } : {});
    const confirmed = `${base}/sub/confirmed`;
    res.redirect(303, delivery ? `${confirmed}?delivery=${delivery}` : confirmed);
  });

  // GET /api/newsletter/download
  app.get("/api/newsletter/download", async (req: Request, res: Response) => {
    const base = siteUrl();
    const tokenParam = req.query.token;
    const token = typeof tokenParam === "string" ? tokenParam : "";

    if (!base) {
      log("error", "download", "no_site_url");
      res.status(500).send("Newsletter site URL is not configured.");
      return;
    }

    const result = verifyDownloadToken(token);
    if (!result.ok) {
      log("info", "download", "verify_failed", { reason: result.reason });
      const reason = result.reason === "expired" ? "download_expired" : "download_invalid";
      res.redirect(303, `${base}/sub/error?reason=${reason}`);
      return;
    }

    const magnet = getMagnet(result.magnet);
    let target: string;
    try {
      if (!magnet) throw new Error("magnet is no longer in magnets.json");
      target = await magnetDownloadUrl(magnet);
    } catch (err) {
      log("error", "download", "unavailable", {
        magnet: result.magnet,
        message: (err as Error).message,
      });
      res.redirect(303, `${base}/sub/error?reason=download_unavailable`);
      return;
    }

    log("info", "download", "served", { magnet: magnet.key });
    // A presigned URL is a short-lived credential: no caching, and no
    // Referer carrying it on to wherever the file links.
    res.set("Cache-Control", "no-store");
    res.set("Referrer-Policy", "no-referrer");
    res.redirect(302, target);
  });
}
