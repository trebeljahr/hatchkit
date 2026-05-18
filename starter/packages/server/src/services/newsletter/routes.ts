/**
 * Newsletter Express routes — registered by `registerNewsletterRoutes`
 * from `app.ts`. Strip the call (and this file) to disable.
 *
 *   POST /api/newsletter/subscribe   — rate-limited; mints confirm token + emails it
 *   GET  /api/newsletter/confirm     — verifies token + promotes the subscription
 *
 * Both endpoints log JSON lines under `scope: "newsletter.*"` so log
 * aggregators can filter on it.
 */

import type { Express, Request, Response } from "express";
import {
  checkRateLimit,
  confirmSubscription,
  isAlreadySubscribed,
  mintConfirmToken,
  normalizeEmail,
  sendConfirmationEmail,
  verifyConfirmToken,
} from "./subscribe.js";

function clientIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string") return fwd.split(",")[0]?.trim() ?? "unknown";
  if (Array.isArray(fwd)) return fwd[0]?.split(",")[0]?.trim() ?? "unknown";
  const real = req.headers["x-real-ip"];
  if (typeof real === "string") return real;
  return req.ip ?? "unknown";
}

function log(level: "info" | "error", scope: string, event: string, extra: object = {}): void {
  const line = JSON.stringify({ scope: `newsletter.${scope}`, level, event, ...extra });
  if (level === "error") console.error(line);
  else console.info(line);
}

function siteUrl(): string {
  return (process.env.NEWSLETTER_SITE_URL ?? process.env.FRONTEND_URL ?? "").replace(/\/$/, "");
}

function siteName(): string {
  return process.env.NEWSLETTER_SITE_NAME ?? "this newsletter";
}

export function registerNewsletterRoutes(app: Express): void {
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

    const body = (req.body ?? {}) as { email?: string; website?: string };

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

    // Short-circuit confirmed members — no point sending another
    // confirmation email or re-issuing a token that does nothing. The
    // form uses `alreadySubscribed` to swap the success message.
    if (await isAlreadySubscribed(email)) {
      log("info", "subscribe", "already_subscribed", { ip });
      res.json({ ok: true, alreadySubscribed: true });
      return;
    }

    const base = siteUrl();
    if (!base) {
      log("error", "subscribe", "no_site_url");
      res.status(500).json({
        error: "config",
        message: "Newsletter site URL is not configured.",
      });
      return;
    }

    const token = mintConfirmToken(email);
    const confirmUrl = `${base}/api/newsletter/confirm?token=${encodeURIComponent(token)}`;

    try {
      await sendConfirmationEmail({ to: email, confirmUrl, siteName: siteName() });
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

    try {
      await confirmSubscription(result.email);
    } catch (err) {
      log("error", "confirm", "list_add_failed", { message: (err as Error).message });
      res.redirect(303, `${base}/sub/error?reason=list_add_failed`);
      return;
    }

    log("info", "confirm", "confirmed");
    res.redirect(303, `${base}/sub/confirmed`);
  });
}
