/*
 * The Content-Security-Policy every HTML document from the app scheme is
 * served with. A response HEADER set by protocol.ts, not a <meta> in the
 * export, so the web build's HTML stays byte-identical — the same `next build`
 * output ships to the browser, and a desktop-only meta tag would either have
 * to be injected after the fact or weaken the web app too.
 *
 * - `script-src` needs 'unsafe-inline': a Next.js static export inlines its
 *   RSC payload (`self.__next_f.push`) and any pre-paint script. No remote
 *   script host is allowed, so third-party analytics snippets do not run in
 *   the desktop app.
 * - `connect-src` allows any https/wss origin, because the app talks to a
 *   remote API whose host the person may change, plus plain http/ws on
 *   loopback for a local API. img-src allows the same hosts, because avatars
 *   and uploads are served by that API.
 * - Nothing may frame the app or be framed by it, and forms post nowhere.
 */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http://localhost:* http://127.0.0.1:*",
  "font-src 'self' data:",
  "connect-src 'self' https: wss: http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:*",
  "worker-src 'self' blob:",
  "media-src 'self' blob: data:",
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");
