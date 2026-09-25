/**
 * Is a mail transport actually configured?
 *
 * Every auth surface that can send mail branches on this: verification is
 * required only where a link would really arrive, and password resets, sign-in
 * codes and magic links log their URL to the server console instead of
 * vanishing when nothing is set up.
 *
 * Branch on THIS, never on one provider's variables. A Listmonk-shaped check
 * would log the reset URL and return on a self-host that has SMTP configured
 * perfectly well, leaving the user waiting for mail that nobody ever tried to
 * send — and no error anywhere, because not sending was the code's own idea.
 */

export type EmailTransportKind = "smtp" | "listmonk" | "console";

/** The subset of the environment that decides the transport. Taken as a
 *  parameter rather than read from `env`, so the rule is unit-testable
 *  without a process environment. */
export interface EmailTransportEnv {
  SMTP_HOST: string;
  LISTMONK_URL: string;
  LISTMONK_API_USER: string;
  LISTMONK_API_TOKEN: string;
  LISTMONK_TX_TEMPLATE_ID: string;
  LISTMONK_FROM_EMAIL: string;
  LISTMONK_FROM: string;
}

/**
 * Which transport a send would use.
 *
 *  1. SMTP whenever `SMTP_HOST` is set, deliberately first: it is the escape
 *     hatch a self-host reaches for, and it should win over a half-filled
 *     managed config.
 *  2. Listmonk only when its WHOLE set is present. A partial Listmonk config
 *     is a misconfiguration, not a transport, and treating it as one would
 *     produce send failures instead of an honest "nothing is configured".
 *  3. `console` — no provider at all, which is the state a fresh self-host
 *     boots in and a supported way to run.
 *
 * `EMAIL_FROM` deliberately does NOT participate. An SMTP host with no From
 * address must still select SMTP and then fail loudly at send time, because
 * falling back to console logging would look like "email is not configured" to
 * an operator who plainly configured it.
 */
export function selectEmailTransport(source: EmailTransportEnv): EmailTransportKind {
  if (source.SMTP_HOST.trim()) return "smtp";
  const listmonkReady =
    source.LISTMONK_URL &&
    source.LISTMONK_API_USER &&
    source.LISTMONK_API_TOKEN &&
    source.LISTMONK_TX_TEMPLATE_ID &&
    (source.LISTMONK_FROM_EMAIL || source.LISTMONK_FROM);
  return listmonkReady ? "listmonk" : "console";
}

/** Read the live environment through {@link selectEmailTransport}.
 *
 *  `SMTP_*` is read straight off `process.env` rather than through the typed
 *  `env` object: the scaffolded `config/env.ts` only grows those keys when a
 *  project opts into SMTP, and this module must compile and behave correctly
 *  either way. */
export function isEmailDeliveryConfigured(): boolean {
  const read = (key: string): string => process.env[key] ?? "";
  return (
    selectEmailTransport({
      SMTP_HOST: read("SMTP_HOST"),
      LISTMONK_URL: read("LISTMONK_URL"),
      LISTMONK_API_USER: read("LISTMONK_API_USER"),
      LISTMONK_API_TOKEN: read("LISTMONK_API_TOKEN"),
      LISTMONK_TX_TEMPLATE_ID: read("LISTMONK_TX_TEMPLATE_ID"),
      LISTMONK_FROM_EMAIL: read("LISTMONK_FROM_EMAIL"),
      LISTMONK_FROM: read("LISTMONK_FROM"),
    }) !== "console"
  );
}
