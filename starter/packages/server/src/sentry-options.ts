// Options for the server's Sentry/GlitchTip client. Kept out of
// instrument.ts so tests can check them without starting the SDK.
//
// By default @sentry/node puts the request headers (Cookie included), the
// parsed cookies (the better-auth session token) and up to 10 KB of the
// request body on every event. Leaving `sendDefaultPii` unset does not
// stop that, so the body is never read and the hooks strip the rest.

import * as Sentry from "@sentry/node";

// `sec-websocket-protocol` carries the session token of a client with no
// cookie jar as a `bearer.<token>` subprotocol (client-core's sync socket).
const CREDENTIAL_HEADERS = new Set([
  "cookie",
  "set-cookie",
  "authorization",
  "proxy-authorization",
  "sec-websocket-protocol",
]);

// The HTTP instrumentation also copies request headers onto spans as
// `http.request.header.<name>` (cookies as `….cookie.<cookie name>`). Its
// own filter misses `sec-websocket-protocol`.
const HEADER_ATTRIBUTE = "http.request.header.";

function scrubSpanData(data: Record<string, unknown> | undefined): void {
  if (!data) return;
  for (const key of Object.keys(data)) {
    if (!key.startsWith(HEADER_ATTRIBUTE)) continue;
    const header = key.slice(HEADER_ATTRIBUTE.length).split(".")[0].replace(/_/g, "-");
    if (CREDENTIAL_HEADERS.has(header)) delete data[key];
  }
}

/** Removes cookies, credential headers and the body from an event's request and spans. */
export function scrubRequest<T extends Sentry.Event>(event: T): T {
  scrubSpanData(event.contexts?.trace?.data);
  for (const span of event.spans ?? []) scrubSpanData(span.data);
  const request = event.request;
  if (!request) return event;
  delete request.cookies;
  delete request.data;
  if (request.headers) {
    for (const name of Object.keys(request.headers)) {
      if (CREDENTIAL_HEADERS.has(name.toLowerCase())) delete request.headers[name];
    }
  }
  return event;
}

export function sentryOptions(dsn: string): Sentry.NodeOptions {
  return {
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.2 : 1.0,
    integrations: [
      Sentry.httpIntegration({ maxIncomingRequestBodySize: "none" }),
      Sentry.requestDataIntegration({ include: { cookies: false, data: false } }),
    ],
    beforeSend: scrubRequest,
    beforeSendTransaction: scrubRequest,
  };
}
