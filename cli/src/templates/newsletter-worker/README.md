# Newsletter Worker

Double opt-in, lead-magnet downloads and the 30-day cleanup of
never-confirmed signups, for a static site that has no server. It does
what the hatchkit starter's newsletter service does
(`starter/packages/server/src/services/newsletter`), as a Cloudflare Worker
on the site's own origin. Keep the two in step.

hatchkit does not scaffold or deploy this Worker. Copy this directory into
the site's repo as `workers/newsletter/` and fill in `wrangler.jsonc`.

| Route | Does |
| --- | --- |
| `POST /api/newsletter/subscribe` | Form post (`email`, optional `magnet`). Creates the subscriber on no list, mails the signed link, 303 → `/sub/check-email` |
| `GET /api/newsletter/confirm?token=…` | Verifies the token, adds the list as `confirmed`, mails the download link when the signup asked for a magnet, 303 → `/sub/confirmed` (`?delivery=sent` or `?delivery=failed`) |
| `GET /api/newsletter/download?token=…` | Verifies the download token, streams the R2 object or redirects to the magnet's URL |
| cron, daily | Deletes subscribers on no list, 30 days after Listmonk created them |

Errors redirect to `/sub/error?reason=…`. The site serves the `/sub/*`
pages as static files: `check-email`, `confirmed` and `error`.

## Direct downloads

Link to `/api/newsletter/download?key=wallpapers` for a configured entry. The file is available immediately, without email, membership or a signed token. Put any optional newsletter signup after that link. Existing signed email links continue to work.

## The form

```html
<a href="/api/newsletter/download?key=wallpapers">Download</a>
<p>Want an email when the next one is out? Signup is optional.</p>
<form method="post" action="/api/newsletter/subscribe">
  <input type="email" name="email" required>
  <input type="hidden" name="magnet" value="wallpapers">
  <!-- honeypot: hide it from people -->
  <input type="text" name="website" tabindex="-1" autocomplete="off" hidden>
  <button>Subscribe</button>
</form>
```

## Lead magnets

`src/magnets.json` lists the files the form may ask for. The form sends
only the key, never a URL.

```json
{
  "wallpapers": { "title": "Wallpaper pack", "object": "magnets/wallpapers.zip" },
  "reading-list": { "title": "Reading list", "url": "https://example.com/reading-list.pdf" }
}
```

An `object` is streamed from the R2 bucket bound as `MAGNETS`; uncomment
`r2_buckets` in `wrangler.jsonc`. A `url` is a redirect. `hatchkit add
<project> lead-magnet` edits this file when it is at
`workers/newsletter/src/magnets.json`. Removing an entry stops every link
already sent for it, until an entry with the same key is added again.

The subscriber in Listmonk gets no attribs: nothing records which page or
site it signed up on, or which magnet it asked for. The magnet key lives
only in the signed links. Count downloads from the `newsletter.delivery`
log lines.

`/api/tx` answers before SMTP runs, so a `delivery_sent` log line means
"queued". An SES rejection shows only in Listmonk → Settings → Logs.

## Setup

```sh
pnpm --dir workers/newsletter install --ignore-workspace
pnpm --dir workers/newsletter exec wrangler secret put LISTMONK_API_TOKEN
pnpm --dir workers/newsletter exec wrangler secret put NEWSLETTER_TOKEN_SECRET
pnpm --dir workers/newsletter exec wrangler deploy
```

`LISTMONK_API_TOKEN` is the project's own Listmonk API user (`hatchkit
listmonk user <project>`); the cleanup needs its `subscribers:get_all` and
`subscribers:manage`. The cleanup covers the whole shared Listmonk instance,
the same rule as the starter's (see hatchkit's email docs). Changing `NEWSLETTER_TOKEN_SECRET` invalidates every
confirm and download link already sent. Wrangler needs
`CLOUDFLARE_API_TOKEN` (Workers Scripts edit, Workers Routes edit on the
zone) and `CLOUDFLARE_ACCOUNT_ID`. Deploy the Worker before the site
release that ships the form.

Tests: `pnpm --filter hatchkit run test:newsletter-worker` in the
hatchkit repo.
