# Security controller (independent monitor Worker)

A Cloudflare Worker outside the VPSs. It does two jobs on a `*/5 * * * *` cron:

1. **VPS monitor.** Each host's `publish-health.py` (timer
   `hatchkit-health-publisher.timer`) posts timestamps and counts to
   `POST /ping/<host>`. The Worker mails when a check goes dark, fails or
   needs attention.
2. **Cloudflare storage watch** (`storage-watch.mjs`, optional). Once a day it
   reads the size of every R2 bucket, Workers KV namespace and D1 database in
   one account. It mails when one passes 80 % of its limit or grows more than
   a set amount in a day.

Both send the same mail document as the hosts' digests (`mail-core.mjs`, a
copy of `backups/hatchkit_mail.py`; `cli/test-ops-digest.py` compares them).

Only fixed health metadata crosses this boundary: timestamps, counts, sizes
and resource names. No application records, logs or secrets.

## Files

Upload as one ES-module Worker, `worker.mjs` as the main module:

| File | Role |
| --- | --- |
| `worker.mjs` | Entry point; wraps the `send_email` binding |
| `worker-core.mjs` | Pings, VPS sweep, `/status`, `/test` |
| `storage-watch.mjs` | Cloudflare storage watch |
| `mail-core.mjs` | Mail renderer and raw MIME message |

## Bindings

| Name | Kind | Notes |
| --- | --- | --- |
| `STATE` | R2 bucket | `hosts/<host>.json`, `sweep.json`, `storage.json` |
| `EMAIL` | send_email | Destination `MAIL_TO` must be a verified Email Routing address |
| `MAIL_FROM`, `MAIL_TO` | variables | |
| `PING_KEYS` | variable | JSON, host → ping-secret binding name, e.g. `{"app-vps":"APP_PING_KEY"}` |
| `<HOST>_PING_KEY` | secrets | One per host, named in `PING_KEYS` |
| `READER_KEY` | secret | Bearer for `GET /status` and `POST /test` |
| `DIGEST_UTC_HOUR` | variable | Optional, default 22 |
| `CF_ACCOUNT_ID` | variable | Storage watch: the account to watch |
| `CF_USAGE_TOKEN` | secret | Storage watch: Account Analytics Read token (below) |
| `STORAGE_LIMITS` | variable | Storage watch: optional limits (below) |
| `STORAGE_DAILY_GROWTH` | variable | Storage watch: optional, default `1GB` |

Keep existing secrets when you upload a new version (`keep_bindings:
["secret_text"]` in the upload metadata, or `wrangler deploy` with the
secrets set once through `wrangler secret put`).

## Storage watch setup

The watch is off until both `CF_ACCOUNT_ID` and `CF_USAGE_TOKEN` are set.
With only one of them, or with invalid `STORAGE_LIMITS`, it reports
"Not checked". It never falls back to healthy.

### 1. Create the read-only token

Dashboard → **Manage Account → Account API Tokens → Create Token → Custom
token** (an account-owned token survives a user leaving the account):

- Name: `hatchkit-storage-watch`
- Permission: Account → **Account Analytics** → Read. Nothing else.
- Account resources: only the account to watch.
- No TTL, or a long one with a calendar reminder: an expired token shows as
  "Not checked" within a day.

The mail names R2 buckets. KV namespaces and D1 databases appear by id,
because the grants that list their names (Workers KV Storage Read, D1 Read)
also read stored values and run SQL. Adding them gives names, but the token
can then read application data, which breaks the boundary above. Look up an
id with `npx wrangler kv namespace list` or `npx wrangler d1 list`.

### 2. Set the Worker settings

```bash
wrangler secret put CF_USAGE_TOKEN --name <worker>
```

Set `CF_ACCOUNT_ID` (32 hex characters) as a plain variable.

### 3. Set limits for what is already large

Defaults are the free-plan limits, used both per resource and for each
kind's account total: R2 10 GB, KV 1 GB, D1 5 GB. On a paid plan these are
billing thresholds, not hard limits, so set your own before the first run,
or the first mail lists every resource that is already above 8 GB.

`STORAGE_LIMITS` is a JSON object. Values are bytes or strings such as
`"50GB"` and `"500MB"` (decimal units):

```json
{
  "r2": "200GB",
  "r2/*": "20GB",
  "r2/example-assets": "100GB",
  "kv/<namespace title or id>": "2GB",
  "d1": "5GB"
}
```

- `r2`, `kv`, `d1`: the account total for that kind.
- `r2/*`, `kv/*`, `d1/*`: the default for one resource of that kind.
- `r2/<bucket>`, `kv/<id>`, `d1/<id>` (or the title/name, if the token can list them): one resource. R2
  buckets with a jurisdiction are named with its prefix, e.g. `eu_backups`.

`STORAGE_DAILY_GROWTH` (default `1GB`) is the growth per day that alerts.
After missed days it is scaled by the days since the last good read.

### When it mails

- A resource or total passes 80 % of its limit, or grows more than
  `STORAGE_DAILY_GROWTH` since the last read: **Needs you**, once per
  crossing. It mails again only after the value falls back and crosses again.
- A read fails: it retries hourly. After 26 hours without a good read (two
  hours if it never had one) it mails **Not checked** once.
- `GET /status` (bearer `READER_KEY`) shows the last state under `storage`.

## Not included: app-reported limits

Apps that report their own quota (for example an endpoint that returns
`storage: {usedBytes, limitBytes}`) are not polled. The ones seen so far
return that block from an endpoint whose token can also read the app's
records. Holding such a token here would break the boundary above. An app
that wants this needs an endpoint and a token scope that return only the
counts.
