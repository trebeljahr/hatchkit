# Paid unlock Worker

A buyer pays through Stripe Checkout and gets a page, a download or an
email. This Worker answers on the site's own origin through Workers
routes, so it works next to a static site and next to an app whose
domain is proxied through Cloudflare. The logic lives in `src/core.ts`,
the same file the hatchkit starter's Express server runs.

Written by `hatchkit add <project> paid-unlock`. Running it again
refreshes `src/core.ts` and reports a conflict instead of overwriting a
file you changed.

## What a buyer sees

1. A buy button on your site (a plain form, below) opens Stripe Checkout.
2. After paying, Stripe sends the buyer to `/api/unlock/return`. The
   Worker checks the session with Stripe, sets a cookie for that product
   and opens it: `/paid/<key>/` for a page, a file list for a download,
   "sent to your email" for an email product.
3. The webhook mails one email: a link that opens the purchase on any
   device (or the email product's content), the refund line, and for a
   subscription a "manage or cancel" link.
4. Lost the email? `/api/unlock/restore` mails fresh links to the address
   that paid. It answers the same whether or not a purchase exists.

No buyer database: the paid Checkout Session in Stripe is the record. A
full refund, an open or lost dispute, or an ended subscription ends
access. Email links check Stripe on every use; a cookie once a day.
Refunding a subscription payment does not cancel the subscription:
cancel it in the Stripe dashboard.

## Routes

| Route | Does |
| --- | --- |
| `POST /api/unlock/checkout` | Form field `product`. 303 to Stripe Checkout |
| `GET /api/unlock/return?session_id=…` | Cookie + 303 to the product. Works for 24 h after checkout |
| `GET /api/unlock/claim?t=…` | The email link: cookie + 303 to the product |
| `GET /api/unlock/files/<key>` | File list of a download product |
| `GET /api/unlock/download/<key>/<n>` | File `n` (cookie, or `?t=` from the email) |
| `GET /api/unlock/sent/<key>` | Email product: "sent to your email" |
| `GET /api/unlock/status/<key>` | `{"unlocked": true\|false}` for your own UI |
| `GET\|POST /api/unlock/restore` | Mail fresh links |
| `POST /api/unlock/manage` | Form field `product`. 303 to Stripe's customer portal |
| `POST /api/unlock/webhook` | Stripe events (`checkout.session.completed`, `…async_payment_succeeded`) |
| `GET /paid/<key>/…` | Page product, served from `private/paid/<key>/` to buyers |

## The buy button

```html
<form method="post" action="/api/unlock/checkout">
  <input type="hidden" name="product" value="field-guide">
  <button>Buy · €9.00</button>
</form>
```

If your site sends a Content-Security-Policy, its `form-action` must
allow `https://checkout.stripe.com` (the Worker answers with a redirect
there).

A subscriber's "manage" button:

```html
<form method="post" action="/api/unlock/manage">
  <input type="hidden" name="product" value="supporter">
  <button>Manage subscription</button>
</form>
```

## Products

`src/unlocks.json` is the allowlist. The form sends only a key.
`hatchkit add <project> paid-unlock --key …` edits it, and `hatchkit
stripe sync` creates the Stripe products, prices and webhook from it.

```json
{
  "project": "example",
  "currency": "eur",
  "refundPolicy": "Not happy? Write to hello@example.com within 30 days for a full refund.",
  "products": {
    "field-guide": {
      "name": "Field guide",
      "kind": "download",
      "price": 900,
      "files": [{ "object": "field-guide.pdf", "filename": "Field guide.pdf" }]
    },
    "making-of": { "name": "Making of", "kind": "page", "price": { "min": 300, "preset": 800 } },
    "letters": { "name": "Five letters", "kind": "email", "price": 500, "email": "letters.html" },
    "supporter": { "name": "Supporter", "kind": "page", "price": 500, "interval": "month" }
  }
}
```

- `price` is in the smallest unit (900 = 9.00). `{"min", "preset"}` is
  pay what you want. Subscriptions (`interval`) need a fixed price.
- A page product's files go in `private/paid/<key>/`. A download's
  `object` is a key in the R2 bucket bound as `FILES` (uncomment
  `r2_buckets`). An email product's body is `private/emails/<email>`.
- `"active": false` stops new sales; buyers keep access.
- `"automaticTax": true` turns on Stripe Tax (registrations first, in
  the Stripe dashboard; set `taxCode` per product as needed).
- Removing a product ends access for everyone who bought it.

Keep paid content out of the public site build. A static export puts
every page in its output folder; move paid pages into `private/paid/`
instead.

## Setup

```sh
pnpm --dir workers/unlock install --ignore-workspace
hatchkit stripe sync <project> --mode test          # products, prices, webhook; writes .dev.vars
pnpm --dir workers/unlock exec wrangler secret put STRIPE_SECRET_KEY
pnpm --dir workers/unlock exec wrangler secret put UNLOCK_TOKEN_SECRET
pnpm --dir workers/unlock exec wrangler secret put LISTMONK_API_TOKEN
hatchkit stripe sync <project> --mode live          # prints the webhook secret command
pnpm --dir workers/unlock exec wrangler deploy
```

`UNLOCK_TOKEN_SECRET`: any long random string (`openssl rand -base64 32`).
The Stripe key is a restricted key of the project's own Stripe account
(see the comment in `wrangler.jsonc` for its permissions). The customer
portal needs a saved configuration in the Stripe dashboard (Settings →
Billing → Customer portal) before "manage" works in live mode.

Local: `stripe listen --forward-to localhost:8787/api/unlock/webhook`
prints its own `whsec_…`; put that in `.dev.vars` while it runs.

Email goes through Listmonk's `/api/tx` with `subscriber_mode:
"external"`, so a buyer never becomes a Listmonk subscriber. That needs
a Listmonk release with external mode. Without the Listmonk vars nothing
is mailed and access still works by cookie.

Tests: `pnpm --filter hatchkit run test:paid-unlock` in the hatchkit repo.
