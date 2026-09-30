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
using it; a failed export must not become an empty successful transfer. The script
sets `ON_ERROR_STOP` internally and raises a SQL error on an invalid list selection,
which [psql 17](https://www.postgresql.org/docs/17/app-psql.html) returns as exit code 3.

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
SQL/API behavior must pass a fixture rehearsal first. `prepare-transfer.mjs`
now compiles the reviewed export into an initial-import transaction. Its offline
input tests and synthetic PostgreSQL rehearsal pass. Rehearse the actual reviewed
mapping in an empty staging destination before any production import.

Read back every row and compare email, global status, each membership status,
original timestamps and reviewed evidence. Reconcile counts by live/test list,
status and suppression; compare sets, not just totals. Keep the protected source
export and mapping for rollback under an agreed retention period.

## Prepare the initial import offline

Copy `transfer-review.example.json` to a protected working file. Fill in the
project and target origin from this bundle's `plan.json`, the audited source
origin, live/test source IDs/UUIDs, new target UUIDs, and independently reviewed
subscriber/membership counts. Set `reviewed` only after that review. Do not use
an empty export to infer there are no subscribers.

From this generated bundle, run:

```sh
node prepare-transfer.mjs reviewed-mapping.json protected-memberships.csv new-import.sql
```

This command reads local files only. It creates a new 0600 SQL file and prints
counts plus a SHA-256 digest. It refuses to overwrite files. Treat the SQL file
as personal data: it includes the selected subscriber rows and membership
metadata. Do not commit, paste, or log it. The compiler does not connect to any
database, read credentials, import data or send mail.

The transaction locks the relevant tables and requires the exact destination
root URL and pinned sender, an empty SMTP array, exactly the two approved active
double-opt-in lists, and no subscribers or campaigns. It creates a private
migration mapping schema; an existing schema is a collision. Fresh Listmonk
sample data must be reviewed and removed only in the owned new installation
before import. Never clear an existing database to make these guards pass.

It creates new subscriber UUIDs/IDs and preserves the source global status,
per-list status, original timestamps (including unknown values), and selected
membership evidence. A source-to-target mapping and manifest digest remain in
`hatchkit_newsletter_transfer`. Names default to email; global subscriber
attributes and unrelated data are not copied. Read-back checks run before commit;
any failure aborts the transaction. Run with `psql -X` and check the exit code.

This is **initial import only**. It refuses a populated target or a repeated
import; it never upserts over newer suppressions. If the result is ambiguous,
inspect the protected manifest/mapping and actual rows. Do not blindly retry.
The bridge below supplies ongoing reconciliation, deletion tombstones and authenticated feedback. Install source capture before the final snapshot; the importer itself remains initial-only.
The opt-in two-instance test now includes a synthetic export/import rehearsal:
wrong-origin refusal, selective data ownership, each consent/suppression state,
unknown timestamps, rollback after inserts, and replay after a new blocklist.
Only an actual successful run establishes the PostgreSQL behavior.

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

`prepare-bridge.mjs` generates reviewed SQL and configuration for the privileged
bridge outside the app. It validates the existing CoB HMAC token before looking
up that exact email. A valid old token and an existing eligible orphan can create
a destination orphan and then confirm the selected list. Missing old records,
unknown unsubscribe timestamps, deletions and global suppressions remain held.
No unrelated orphan export is needed. CoB forwards the original token through
`/bridge/prepare` or `/bridge/confirm` using a distinct project app password.
Source database credentials never enter CoB.

Keep the bridge for at least 21 days after the final old token issuer stops,
including clock skew and in-flight requests. Old unsubscribe URLs and feedback
can outlive that period; retain reconciliation until their retirement is agreed.
New signups also pass reconciliation before confirmation mail.

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
and acknowledge events only after the destination write commits. Sequence IDs are not commit-ordered, so the bridge uses a pending queue rather than a watermark. Retain
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


## Bridge installation and operation

Read and approve both generated SQL files before installation. This changes
shared database triggers and grants access to exact-email state; it requires
operator approval even though no subscriber data is copied by installation.

1. Fill `bridge-review.example.json` with the audited origins, source list IDs
   and UUIDs, target list UUIDs and actual write-freeze cutoff. Generate a new
   protected directory with `node prepare-bridge.mjs reviewed-bridge.json output`.
2. Pause CoB writes and sends, drain requests, and freeze source CoB campaigns.
   Install `source.sql` **before** taking the final selective export. It installs
   a per-project schema, durable event journal and native row triggers. Other
   projects keep their existing transport. Subscriber-row triggers briefly
   serialize each email; review this shared-service impact and back up first.
3. Pre-create a dedicated login with a unique secret and no table privileges.
   Run source SQL with `psql -X -v bridge_role=<role>` through an approved admin
   connection. The granted functions expose exact-email state, selected-list
   membership and pending project events. Never grant table SELECT or ownership.
4. Import the reviewed final snapshot into the empty destination. Install
   `target.sql` after the initial import and before starting the bridge. Both SQL
   files are transactional and refuse an existing schema; inspect an ambiguous
   result rather than replaying. Keep schemas and roles out of app credentials.
5. Add protected files `bridge_scope` (generated bridge.json),
   `bridge_source_database_url`, `bridge_target_database_url`,
   `bridge_app_password` (at least 32 random characters) and
   `newsletter_token_secret`. The token secret must match CoB's existing effective
   secret, including its CRON_SECRET fallback when used. Do not rotate it here.
   Make files readable by the container's node UID 1000 without world access.
6. Review the existing private DB network name. Set `LEGACY_DATABASE_NETWORK`
   and a dedicated `BRIDGE_SNS_TOPIC_ARN` in the protected env. Apply
   `compose.bridge.yml` with the base Compose file. Only the privileged relay
   joins the legacy network. The app and new Listmonk keep project-only access.
7. Preserve the shared SNS route. Configure a new topic and SES configuration-set
   event destination for Bounce and Complaint only. Publish SES events to that
   topic using a resource policy restricted to the account/configuration set.
   Route HTTPS `/webhooks/service/ses` to the bridge. It verifies the AWS SNS
   certificate/signature, exact topic, sender, account and configuration set,
   then matches an accepted SES message ID and recipient before suppression.
8. A signed SNS SubscriptionConfirmation stores its token in the protected
   `confirmations` table. An approved operator confirms the exact topic through
   AWS; the bridge does not follow arbitrary SubscribeURL values. Verify the
   subscription and real dedicated feedback with owned test addresses before
   allowing production. Unknown message IDs return 503 for retry/review.
9. Configure CoB's `NEWSLETTER_BRIDGE_URL` to the exact new LISTMONK_URL,
   `NEWSLETTER_BRIDGE_PASSWORD` to the project app secret, and
   `NEWSLETTER_BRIDGE_LIST_ROLE` to live or test as appropriate. Set the same
   actual cutoff in `NEWSLETTER_MIGRATION_STARTED_AT`. Missing bridge access
   refuses dedicated migration confirmations without a direct-write fallback.

The bridge polls unacknowledged events every five seconds. Each send also takes
the same per-email source and destination advisory locks as native mutations,
reconciles current state and retained events, and holds those locks through the
SES response and receipt commit. A native unsubscribe racing an accepted send
commits after that send; later sends see it. Source outages and disabled capture
triggers refuse delivery. This requires every sender to use project-ses with zero
retries; it does not gate an unreviewed alternative transport.

An attempt is committed before SES. Timeouts, crashes or lost receipt commits
leave `attempts.status=pending`, holding further mail to that recipient. An
operator must reconcile SES evidence before marking an attempt reviewed. Never
bulk-clear pending attempts. Hard bounces and complaints create retained global
suppression; transient bounces are recorded without enabling anyone. Retained
unknown unsubscribe dates and deletions require operator review, not token replay.

`GET /health` checks database reachability and destination configuration.
Monitor reconciliation errors, queue age, pending attempts and SNS delivery
failures. Health alone cannot prove that SES feedback is correctly configured.
No message content or recipient addresses are logged by the bridge.

For a synthetic PostgreSQL rehearsal, build `bridge/Dockerfile` from this bundle
as `hatchkit-newsletter-bridge-fixture:local`, then add
`HATCHKIT_BRIDGE_TEST_IMAGE=hatchkit-newsletter-bridge-fixture:local` to the
opt-in two-instance test. It tests old orphan tokens, per-list consent,
source/target native suppression, deletion, disabled triggers, an unsubscribe
racing a fake SES call, ambiguous acceptance, and duplicate/foreign feedback.
`test-listmonk-bridge.ts` separately tests signed SNS envelopes and token policy.
The rehearsal sends no mail and uses disposable data only.

Before rollback, pause both sides and reconcile new target consent/suppression
back into the selected source lists. Keep journals and mappings. Removing source
hooks or the role while target sending continues makes sends fail closed; stop
the target first. After the agreed legacy window, an approved operator may drop
only the two named per-project source triggers and generated project schema,
then revoke/drop that project's bridge login. Never drop shared tables or use a
full database restore as rollback.

## Rehearsal and cutover

1. Run `test-listmonk-relay-separation.ts` through the isolated Hatchkit runner.
   It exercises two real HTTP relay handlers with fake SES send functions.
2. With safe current memory pressure, run `HATCHKIT_RUN_LISTMONK_DOCKER=1 node
   scripts/test.mjs test-listmonk-instance-separation.ts` from `cli/`. This opt-in
   test requires cached Postgres 17, Listmonk 6.2
   and nginx 1.28 Alpine images, creates
   two disposable Listmonk/Postgres stacks on high loopback ports, and removes
   only its own random Compose projects/volumes. It starts no SES relay. Foreign
   auth/read/write/send requests must fail, while positive controls pass.
   Only after explicit operator approval, `HATCHKIT_LISTMONK_RESOURCE_OVERRIDE=1`
   permits the capped rehearsal despite historical load/swap. Unknown metrics
   and unsafe current memory pressure still refuse; run checks serially.
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
9. Review the final mapping, pending event queue and image/env diff. Only
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
