/**
 * `document` — the SOURCE catalog for generated documents (receipts,
 * invoices, statements, exported reports), in this project's source
 * language (__HATCHKIT_SOURCE_LABEL__).
 *
 * The seeded wording below is English, because that is the language
 * hatchkit's own templates are written in. If your source language is not
 * English, rewrite these values in place — they are the original.
 *
 * A document is the strictest surface in the product: it is rendered once, in
 * the language stored on it by `resolveDocumentLocale`, and re-rendered years
 * later from the same stored locale. So a key here is never renamed in place
 * — an old row still asks for it. Add the new key, keep the old one until
 * nothing stored refers to it.
 *
 * Numbers, dates and money arrive ALREADY FORMATTED, as `{amount}` and
 * `{date}`. A PDF has no viewer to take a time zone from, and the amounts on
 * it are snapshots of what was charged, not live figures to re-format in the
 * reader's convention.
 *
 * Column headings here are for HUMAN readers of the PDF. The machine-readable
 * export of the same document — CSV, JSON, the API — keeps its source-language
 * field names in every locale, because something downstream parses them.
 */
export const document = {
  /** The kind of document, printed as its title. */
  title: {
    receipt: "Receipt",
    invoice: "Invoice",
    statement: "Statement",
    quote: "Quote",
  },

  header: {
    number: "No. {number}",
    issuedOn: "Issued {date}",
    dueOn: "Due {date}",
    /** Above the issuing party's address block. */
    from: "From",
    /** Above the recipient's address block. */
    to: "To",
    reference: "Reference: {reference}",
    period: "Period {from} to {to}",
  },

  table: {
    description: "Description",
    quantity: "Qty",
    unitPrice: "Unit price",
    amount: "Amount",
    /** Printed instead of the table when a document has no lines. */
    empty: "This document has no line items.",
  },

  totals: {
    subtotal: "Subtotal",
    discount: "Discount",
    tax: "Tax {rate}",
    taxExempt: "No tax charged.",
    total: "Total",
    paid: "Paid",
    due: "Amount due",
    /** `currency` is an ISO code, so it stays as it is in every language. */
    currencyNote: "All amounts in {currency}.",
  },

  notes: {
    paidInFull: "Paid in full. Nothing is due.",
    payWithin: "Please pay within {days, plural, one {# day} other {# days}}.",
    thanks: "Thank you.",
  },

  footer: {
    page: "Page {page} of {pages}",
    issuedBy: "Issued by __HATCHKIT_APP_NAME__",
    /** Printed under the totals so a reader knows why an old document reads
     *  differently from a new one. */
    archived: "This is a copy of a document issued on {date}.",
  },
} as const;
