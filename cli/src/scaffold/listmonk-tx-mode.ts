/*
 * Listmonk `/api/tx` recipient mode — retrofitted onto the account-email
 * service of a project scaffolded before 2026-09-29.
 *
 * Why this exists: the starter's `packages/server/src/services/email.ts`
 * posted verification, password-reset and invitation mail to `/api/tx` with
 * a `subscriber_email` and no `subscriber_mode`. Listmonk then uses its
 * `default` mode (`validateTxMessage`, checked in v6.0.0), where the
 * recipient must already be a subscriber, and answers 400 for everyone
 * else. Nobody signing up, resetting a password or accepting an invitation
 * is one. `sendEmail`'s callers only log the error, so nothing fails
 * visibly — and with `auth-account-security` switching
 * `requireEmailVerification` on as soon as mail is configured, every new
 * account is locked out.
 *
 * The fix is one property, `subscriber_mode: "external"`, which sends to
 * any address without a subscriber lookup. The newsletter sender
 * (`services/newsletter/listmonk.ts`) is deliberately NOT touched: it
 * creates the subscriber first, which is correct there.
 */

import type { FeatureLedger, FileAction } from "../features/contract.js";

export const EMAIL_SERVICE_REL_PATH = "packages/server/src/services/email.ts";

export type TxModeOutcome =
  /** `subscriber_mode: "external"` was inserted. */
  | "patched"
  /** The body already names a `subscriber_mode`, whatever its value. */
  | "already"
  /** The file sends through something other than Listmonk (Resend, SMTP). */
  | "not-listmonk"
  /** The file posts to `/api/tx`, but no `subscriber_email` property line
   *  was found to anchor on. Reported as a manual step, never forced. */
  | "no-anchor";

export interface TxModeRewrite {
  source: string;
  outcome: TxModeOutcome;
}

/** A `subscriber_mode:` property at the start of a line — a code line,
 *  not the doc comment above `listmonkTxBody`, whose lines open with `*`. */
const MODE_PROPERTY = /^[ \t]*subscriber_mode\s*:/m;

/** A single-line `subscriber_email(s): …,` property. Anchoring on the
 *  trailing comma is what lets the new line go straight after it. */
const RECIPIENT_PROPERTY = /^([ \t]*)subscriber_emails?\s*:[^\n]*,[ \t]*$/gm;

/**
 * Insert `subscriber_mode: "external"` after the `/api/tx` body's
 * recipient.
 *
 * A pure fixed point: once a `subscriber_mode` property exists the source
 * comes back unchanged, so a second `update` reports nothing. A body that
 * already names a mode is left alone even if it is not `external` — that is
 * somebody's decision, not a scaffold default.
 */
export function upgradeListmonkTxSubscriberMode(source: string): TxModeRewrite {
  if (!source.includes("/api/tx")) return { source, outcome: "not-listmonk" };
  if (MODE_PROPERTY.test(source)) return { source, outcome: "already" };
  let patched = false;
  const next = source.replace(RECIPIENT_PROPERTY, (line: string, indent: string) => {
    patched = true;
    return [
      line,
      `${indent}// Without it Listmonk answers 400 for anyone not already a subscriber,`,
      `${indent}// which is everyone signing up, resetting a password or being invited.`,
      `${indent}subscriber_mode: "external",`,
    ].join("\n");
  });
  return patched ? { source: next, outcome: "patched" } : { source, outcome: "no-anchor" };
}

export interface TxModeRetrofit {
  outcome: TxModeOutcome | "absent";
  /** What the ledger did with the file; `would-write` in a dry run. */
  action: FileAction;
}

/**
 * Apply {@link upgradeListmonkTxSubscriberMode} to the project's email
 * service, if it has one. A project without the file (a server-less
 * scaffold) is `absent`, not an error. A file the transform cannot anchor
 * in is recorded as a ledger conflict carrying the manual fix.
 */
export function retrofitListmonkTxMode(ledger: FeatureLedger): TxModeRetrofit {
  const source = ledger.read(EMAIL_SERVICE_REL_PATH);
  if (source === undefined) return { outcome: "absent", action: "absent" };
  const { outcome, source: next } = upgradeListmonkTxSubscriberMode(source);
  if (outcome === "no-anchor") {
    return {
      outcome,
      action: ledger.conflict(
        EMAIL_SERVICE_REL_PATH,
        'add `subscriber_mode: "external"` to the /api/tx request body by hand',
      ),
    };
  }
  return { outcome, action: ledger.edit(EMAIL_SERVICE_REL_PATH, () => next) };
}
