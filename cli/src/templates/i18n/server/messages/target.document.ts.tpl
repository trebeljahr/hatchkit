/**
 * `document` in __HATCHKIT_TARGET_LABEL__ (__HATCHKIT_TARGET_LABEL_EN__) —
 * receipts, invoices, statements and exported reports.
 *
 * Voice: __HATCHKIT_VOICE__. Terms and false friends:
 * `packages/client/src/i18n/GLOSSARY.__HATCHKIT_TARGET_LOCALE__.md`.
 *
 * SEEDED, NOT TRANSLATED — every value is the __HATCHKIT_SOURCE_LABEL__ text
 * wrapped in `todo()`. Delete the wrapper as you translate; `grep -c 'todo('`
 * counts what is left. The same rules as the mail catalog apply: the keys and
 * the `{placeholder}` names are fixed, the wording and the word order are
 * yours.
 *
 * Two things this file in particular must get right, because a document is
 * kept and re-rendered from its stored locale years later:
 *
 *   · The column headings are read by a person, so translate them. The
 *     machine-readable export of the same document keeps its
 *     __HATCHKIT_SOURCE_LABEL__ field names in every language.
 *   · Legal and accounting wording is not a style choice. Check what a tax
 *     line and a payment term are actually called on an invoice in
 *     __HATCHKIT_TARGET_LABEL_EN__ before writing one, and record the terms
 *     in the glossary so the next document uses the same words.
 */
import type { Translation } from "__HATCHKIT_PKG_SCOPE__/shared";

import type { document as source } from "../__HATCHKIT_SOURCE_LOCALE__/document.js";

const todo = (message: string): string => `TODO(__HATCHKIT_TARGET_LOCALE__) ${message}`;

export const document: Translation<typeof source> = {
  title: {
    receipt: todo("Receipt"),
    invoice: todo("Invoice"),
    statement: todo("Statement"),
    quote: todo("Quote"),
  },

  header: {
    number: todo("No. {number}"),
    issuedOn: todo("Issued {date}"),
    dueOn: todo("Due {date}"),
    from: todo("From"),
    to: todo("To"),
    reference: todo("Reference: {reference}"),
    period: todo("Period {from} to {to}"),
  },

  table: {
    description: todo("Description"),
    quantity: todo("Qty"),
    unitPrice: todo("Unit price"),
    amount: todo("Amount"),
    empty: todo("This document has no line items."),
  },

  totals: {
    subtotal: todo("Subtotal"),
    discount: todo("Discount"),
    tax: todo("Tax {rate}"),
    taxExempt: todo("No tax charged."),
    total: todo("Total"),
    paid: todo("Paid"),
    due: todo("Amount due"),
    currencyNote: todo("All amounts in {currency}."),
  },

  notes: {
    paidInFull: todo("Paid in full. Nothing is due."),
    payWithin: todo("Please pay within {days, plural, one {# day} other {# days}}."),
    thanks: todo("Thank you."),
  },

  footer: {
    page: todo("Page {page} of {pages}"),
    issuedBy: todo("Issued by __HATCHKIT_APP_NAME__"),
    archived: todo("This is a copy of a document issued on {date}."),
  },
};
