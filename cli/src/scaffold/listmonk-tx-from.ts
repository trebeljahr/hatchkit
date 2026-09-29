/*
 * Listmonk `/api/tx` sender — retrofitted onto the newsletter client of a
 * project scaffolded before 2026-09-29.
 *
 * Why this exists: the starter's
 * `packages/server/src/services/newsletter/listmonk.ts` sent the
 * double-opt-in confirmation (and every other `sendTransactional` mail) to
 * `/api/tx` with no `from_email`. Listmonk then uses its global
 * `app.from_email`, which on a shared instance belongs to whichever
 * project set it last — so a new reader's first email from the project
 * arrives under another project's sender. Nothing fails; the mail is
 * delivered, just from the wrong address.
 *
 * The fix is one property, read from the same env names the account-email
 * transport uses. `subscriber_mode` is deliberately NOT added here: the
 * newsletter creates the subscriber first (`ensureSubscriber`), so the
 * default mode is correct. That fix belongs to `services/email.ts` only
 * (see listmonk-tx-mode.ts).
 */

import type { FeatureLedger, FileAction } from "../features/contract.js";

export const NEWSLETTER_LISTMONK_REL_PATH = "packages/server/src/services/newsletter/listmonk.ts";

/** The line the starter sends, and the line the retrofit inserts. */
export const TX_FROM_PROPERTY =
  "from_email: process.env.LISTMONK_FROM || process.env.LISTMONK_FROM_EMAIL,";

export type TxFromOutcome =
  /** `from_email` was inserted into every `/api/tx` body that lacked it. */
  | "patched"
  /** Every `/api/tx` body already names a `from_email`, whatever its value. */
  | "already"
  /** The file makes no `/api/tx` call, so there is no body to patch. */
  | "no-tx"
  /** An `/api/tx` body lacks `from_email`, but no recipient property line
   *  was found to anchor on. Reported as a manual step, never forced. */
  | "no-anchor";

export interface TxFromRewrite {
  source: string;
  outcome: TxFromOutcome;
}

/** A call whose first argument is a string literal ending in `/api/tx`:
 *  `listmonkFetch("/api/tx", …` or `` fetch(`${base}/api/tx`, … ``. The
 *  opening paren keeps prose like "`POST /api/tx`" in a comment out. */
const TX_CALL = /\(\s*(["'`])[^"'`\n]*\/api\/tx\1/g;

/** A `from_email:` property at the start of a line. */
const FROM_PROPERTY = /^[ \t]*["']?from_email["']?\s*:/m;

/** A single-line recipient property ending in a comma, so the new line can
 *  go straight after it. */
const RECIPIENT_PROPERTY = /^([ \t]*)subscriber_(?:emails?|ids?)\s*:[^\n]*,[ \t]*$/m;

/** The rest of each `/api/tx` call's argument list: from just after the
 *  path literal to the call's closing paren. Brackets are counted, not
 *  parsed, which holds for the object literals a request body is made of. */
function txCallArguments(source: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const match of source.matchAll(TX_CALL)) {
    const start = match.index + match[0].length;
    let depth = 0;
    for (let i = start; i < source.length; i++) {
      const ch = source[i];
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      else if (ch === ")" || ch === "}" || ch === "]") {
        if (depth === 0) {
          ranges.push({ start, end: i });
          break;
        }
        depth--;
      }
    }
  }
  return ranges;
}

/**
 * Insert `from_email` after the recipient of every `/api/tx` body that has
 * none.
 *
 * A pure fixed point: once each body has a `from_email` the source comes
 * back unchanged, so a second `update` reports nothing. A body that already
 * names a sender is left alone whatever it names. Only `/api/tx` bodies are
 * read — the campaign body in the same file always had its own
 * `from_email`, and must not count as the transactional one's.
 */
export function upgradeListmonkTxFromEmail(source: string): TxFromRewrite {
  const calls = txCallArguments(source);
  if (calls.length === 0) return { source, outcome: "no-tx" };
  const missing = calls.filter(({ start, end }) => !FROM_PROPERTY.test(source.slice(start, end)));
  if (missing.length === 0) return { source, outcome: "already" };

  const insertions: Array<{ at: number; text: string }> = [];
  for (const { start, end } of missing) {
    const recipient = RECIPIENT_PROPERTY.exec(source.slice(start, end));
    if (!recipient) return { source, outcome: "no-anchor" };
    const indent = recipient[1] ?? "";
    insertions.push({
      at: start + recipient.index + recipient[0].length,
      text: [
        "",
        `${indent}// Without it Listmonk sends from its global app.from_email, which on a`,
        `${indent}// shared instance is another project's sender.`,
        `${indent}${TX_FROM_PROPERTY}`,
      ].join("\n"),
    });
  }
  // Back to front, so each offset still points where it was measured.
  let next = source;
  for (const { at, text } of insertions.reverse()) next = next.slice(0, at) + text + next.slice(at);
  return { source: next, outcome: "patched" };
}

export interface TxFromRetrofit {
  outcome: TxFromOutcome | "absent";
  /** What the ledger did with the file; `would-write` in a dry run. */
  action: FileAction;
}

/**
 * Apply {@link upgradeListmonkTxFromEmail} to the project's newsletter
 * client, if it has one. A project without the newsletter is `absent`, not
 * an error. A file the transform cannot anchor in is recorded as a ledger
 * conflict carrying the manual fix.
 */
export function retrofitListmonkTxFrom(ledger: FeatureLedger): TxFromRetrofit {
  const source = ledger.read(NEWSLETTER_LISTMONK_REL_PATH);
  if (source === undefined) return { outcome: "absent", action: "absent" };
  const { outcome, source: next } = upgradeListmonkTxFromEmail(source);
  if (outcome === "no-anchor") {
    return {
      outcome,
      action: ledger.conflict(
        NEWSLETTER_LISTMONK_REL_PATH,
        `add \`${TX_FROM_PROPERTY}\` to the /api/tx request body by hand`,
      ),
    };
  }
  return { outcome, action: ledger.edit(NEWSLETTER_LISTMONK_REL_PATH, () => next) };
}
