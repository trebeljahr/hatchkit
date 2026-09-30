# Project newsletter migration gates

This is a reviewed procedure template, not an importer or permission to deploy.
Keep the existing transport serving until all gates pass. A project API token
on a shared Listmonk instance is not a data boundary.

## Inventory and ownership

Record the source origin, version, project live/test list IDs **and UUIDs**, list
opt-in mode, campaign/template ownership, app image digest and encrypted env
revision. Verify the source schema matches Listmonk v6.2 before using the SQL.
Record the destination origin, fresh volume/network names, new IDs/UUIDs and
separate API/relay credentials. Numeric IDs are local to an instance.

Do not read or export shared settings, SMTP credentials, API users, arbitrary
subscriber attributes, other projects' list membership, or a full database for
transfer. Backups of the shared service remain with its operator. A shared
subscriber row does not establish ownership of all its data or memberships.

## Minimal transfer

`export-memberships.sql` is a read-only, repeatable-read CSV export. It requires
two explicit list UUIDs and refuses missing, duplicate or non-double-opt-in
lists. Use an approved read-only database connection and `psql -X -q` with
`ON_ERROR_STOP=1`; protect the destination directory (0700) and output (0600).
Redirect stdout to the protected file, never chat/logs. Check exit status before
using it; a failed export must not become an empty successful transfer.

Export one row per **project** membership: source subscriber ID/UUID, email,
global status and timestamps, source list ID/UUID, membership status/timestamps,
and that membership's metadata. Do not copy global `attribs` or names by default.
Membership metadata belongs to the selected list but still needs a personal-data
review. Preserve it in protected evidence; import only reviewed fields.

| Source state | Destination behavior |
| --- | --- |
| enabled + confirmed live membership | Same confirmed membership on mapped live list, once evidence is reconciled |
| disabled or blocklisted | Same global suppression, regardless of membership or later token clicks |
| unsubscribed membership | Same unsubscribed tombstone and original membership update timestamp |
| unconfirmed membership | Remains unconfirmed; no confirmation send during import |
| member of multiple projects | Copy only the selected project's rows; preserve global suppression conservatively |
| member of both live/test lists | Preserve each status independently; never merge the two audiences |
| pending with no project membership | Exclude from this export; handle the verified legacy-confirmation path below |
| source record removed or missing during delta | Hold/suppress for review; do not recreate as enabled |

A timestamp is not proof of consent by itself. `subscriber_created_at` and
`membership_created_at` are not guaranteed confirmation times. Preserve actual
consent evidence when present; mark unknown evidence as unknown. Do not invent
confirmation dates or promote a subscriber during migration.

Prepare a source UUID → destination UUID/ID map per subscriber and list. Import
into the empty destination under a transaction while app writes and sends are
paused. Ordinary CSV import defaults may enable subscribers, preconfirm lists,
change timestamps or emit opt-in mail; do not use those defaults. Exact importer
SQL/API behavior must pass a fixture rehearsal first. This bundle deliberately
does not provide an unverified production importer.

Read back every row and compare email, global status, each membership status,
original timestamps and reviewed evidence. Reconcile counts by live/test list,
status and suppression; compare sets, not just totals. Keep the protected source
export and mapping for rollback under an agreed retention period.

## CoB pending confirmations

CoB creates subscribers with no list membership before a confirmation click.
Its HMAC token contains the normalized email and an expiry 21 days after issue.
Preserve `NEWSLETTER_TOKEN_SECRET` (or its current `CRON_SECRET` fallback), the
CoB confirmation route and token format. Do not export all shared orphans.

At the switch, set `NEWSLETTER_MIGRATION_STARTED_AT` to the actual UTC cutoff.
CoB's prepared guard holds pre-cutoff tokens with no reviewed project membership,
even if a later signup created a new orphan row. A disabled/blocklisted record
always fails. An unsubscribed record needs consent issued after its preserved
unsubscribe timestamp. Unknown timestamps fail closed.

Before cutover, implement and test a privileged legacy reconciliation path
outside the app. Verify the CoB HMAC token first, then look up **only that email**
in the old instance, preserving suppression and any CoB unsubscribe tombstone.
A valid token proves a CoB pending signup; the old database alone does not.
Import the reviewed pending record without promoting consent. If representing
it with an unconfirmed destination membership, keep double opt-in enabled,
disable automatic opt-in mail during that write, and record that explicit mapping.
Then the ordinary confirm route can apply the still-valid token. Missing old
records or unavailable old state remain held for review, not enabled by default.
Do not put the shared administrator token back into CoB to perform this lookup.

The legacy path must work before cutover. Merely holding old links is a safety
guard, not successful migration. Keep it for at least the maximum token lifetime
after the last old issuer stops; account for clock skew and in-flight requests.
A new signup must also check retained suppression evidence before confirmation
mail. Do not release signup writes until this cross-cutover suppression case is
implemented and tested.

## Old unsubscribe links and late feedback

Old campaign/subscriber UUID links remain on the old hostname. Preserve that
service's subscription endpoints and its campaign/list associations. Do not
redirect old links to the new instance or change the shared root URL. New UUIDs
cannot resolve old URLs automatically; even preserving subscriber UUIDs alone
is insufficient because campaign ownership also matters.

Use a privileged per-project reconciler with a durable mapping and event journal
outside app credentials. Project membership unsubscriptions map only to that
project; global blocklist/disabled state propagates conservatively to matching
migrated records. Handle native unsubscribe, global opt-out, bounce, complaint
and deletion. Preserve source event identity/time, deduplicate, retry safely,
and advance the watermark only after the destination write commits. Retain
tombstones. A missing/deleted source row cannot silently become enabled.

Polling only `subscribers.updated_at` misses membership-only changes. Scan both
subscriber and selected membership changes with overlap, plus explicit deletion
reconciliation, or use a reviewed durable change feed. Events that arrive after
the initial snapshot must be replayed before sending. A periodic poll alone
leaves a race between unsubscribe and send: gate sends on healthy reconciliation
and resolve that race explicitly before automatic campaigns resume.

The shared webhook owner owns SNS/authentication and existing suppression
settings. Arrange a separate dedicated feedback route with that owner; no
concurrent shared settings or SNS mutations. Match authenticated feedback to
project identity/configuration set/message evidence. Do not broadcast feedback
to all projects or treat an arbitrary email address as project ownership.

## Rehearsal and cutover

1. Run `test-listmonk-relay-separation.ts` through the isolated Hatchkit runner.
   It exercises two real HTTP relay handlers with fake SES send functions.
2. When memory/swap permits, run `HATCHKIT_RUN_LISTMONK_DOCKER=1 node
   scripts/test.mjs test-listmonk-instance-separation.ts` from `cli/`. This opt-in
   test takes the shared validation lock, requires local cached images, creates
   two disposable Listmonk/Postgres stacks on high loopback ports, and removes
   only its own random Compose projects/volumes. It starts no SES relay. Foreign
   auth/read/write/send requests must fail, while positive controls pass.
3. Rehearse the selective import, every status in the table, duplicate replay,
   deleted rows, old unsubscribe URL, old pending token, late bounce/complaint,
   a returning subscriber and rollback. No real subscribers or mail are needed.
4. Finish the separately owned SES enforcement checks. Relay scope pinning and
   IAM simulation are not proof of deployed AWS enforcement.
5. Obtain approval for the exact new stack, DNS/TLS/proxy route and dedicated
   feedback route. Stage with one allowlisted own inbox and empty project data.
6. Deploy the compatible CoB code while retaining its existing env/transport.
   For project-ses, both `/api/tx` and campaigns must select that messenger.
   Use the exact bare sender; the current relay rejects display-name senders
   and campaign custom headers. CoB rejects incompatible sender/Reply-To settings
   before sending. Do not silently drop reply behavior; review the env change.
7. Approve one own-inbox test, then verify arrival, From/DKIM, confirmation,
   welcome, unsubscribe, bounce/complaint and suppression on the dedicated path.
   Keep relay retries at zero; a timeout can be ambiguous after acceptance.
8. Set `NEWSLETTER_WRITES_PAUSED=true`; separately freeze CoB campaign jobs and
   ensure no running/scheduled source campaign or in-flight send remains. Drain
   app requests. Take final per-project snapshot/delta and reconcile all writes.
9. Review the final mapping, reconciliation watermark and image/env diff. Only
   then approve subscriber import and cutover of URL, API user/token, live/test
   IDs, template IDs, messenger, sender settings and migration cutoff. Switch
   while writes remain paused. Verify read-back and own-inbox checks before
   lifting the pause. Resume real campaigns only under a separate send request.
10. Keep old credentials and endpoints while observing. Remove old project
    tokens only after every consumer moved, legacy links/events work and the
    agreed rollback window ends. Shared root-token retirement is a fleet task.

## Rollback

Before the switch, stop only the new deployment and retain its volumes. After
the switch, pause CoB writes/sends, reconcile destination subscriptions and
suppression back into the old project's lists, then restore the prior image/env.
Never restore an old full database snapshot over the live shared service.
Retain both protected mappings and tombstones. If reconciliation is unavailable,
keep writes paused instead of rolling back into a state that can resubscribe
someone. Do not revoke the old working credentials before verification.

Source review: [Listmonk v6.2 schema](https://github.com/knadh/listmonk/blob/v6.2.0/schema.sql),
[subscriber queries](https://github.com/knadh/listmonk/blob/v6.2.0/queries/subscribers.sql),
[postback payload](https://github.com/knadh/listmonk/blob/v6.2.0/internal/messenger/postback/postback.go).
