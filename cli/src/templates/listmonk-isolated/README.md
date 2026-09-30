# Dedicated project newsletter staging

This bundle stages one project’s newsletter in an empty Listmonk installation with its own Postgres database. It includes an ingress proxy and an SES v2 relay. Generating the bundle does not deploy services or migrate subscribers. Existing newsletters keep using their current service.

`plan.json` records the exact project, sender policy, required provisioner permissions and rollback boundary. Have an operator review them before provisioning. The AWS IAM simulator can test the proposed policy without creating a sender; it cannot prove live SES condition handling or delivery.

## Prepare after approval

1. Audit the current subscriber/list/template/campaign setup and take a protected backup. Do not load the shared database dump into this stack: that copies other projects' subscriber data and shared SMTP credentials.
2. Provision and audit the project's restricted SES sender with `hatchkit ses isolate <project-directory>`. This is a separate approved mutation. Use only that project's access key; the relay never accepts shared SMTP credentials.
3. Create `secrets/` with mode 0700. Put unique database/admin/relay passwords into `db_password`, `admin_password`, `relay_password` with mode 0600. Use at least 32 random characters for the relay password. Put the project SES key ID/secret into `ses_access_key` and `ses_secret_key`. Never commit these files or paste their values into command arguments. Secure the generated bundle directory and backups too.
4. Copy `.env.example` to `.env`. Choose an unused high loopback port, set the single approved `EMAIL_TEST_RECIPIENT`, and leave `RELAY_MODE=staging`. Review/pin container digests for the target architecture. Do not change shared networks, volume names or another deployment's environment.
5. After deployment approval, start this stack. It initializes only its new volume, with no automatic upgrades. Put a TLS reverse proxy in front of its loopback ingress port at the exact origin in `plan.json`. Protect admin routes; restrict `/webhooks/service/*` using the reviewed SNS authentication/topic policy before any public exposure. No webhook integration is installed by this bundle.
6. In the new Listmonk UI, set the root URL to the planned origin and use the exact From mailbox in `plan.json` (no display name). Under Settings → Messengers add `project-ses`: URL `http://relay:8787/send`, username from the Compose `RELAY_USER`, password from `secrets/relay_password`, retries **0**, timeout **20 seconds**. Select this messenger on every campaign and `/api/tx` request. Do not configure SMTP. Listmonk and Postgres attach only to the internal network. The relay has a separate sending network. The ingress proxy bridges a separate ingress network to Listmonk because Docker may not publish ports from an internal-only network. It accepts requests on the high loopback port and forwards only to `listmonk:9000`; it holds no database or SES credentials. The external TLS proxy must sanitize forwarded headers.
7. Create project-only live/test double-opt-in lists, templates and a restricted API user on this instance. Keep administrative credentials outside the app. Record the new list/template IDs; old IDs are not portable. Backfill the app's `LISTMONK_URL`, user/token, live/test list IDs and template IDs only during an approved cutover. Patch the app to set `LISTMONK_MESSENGER=project-ses` on transactional and campaign calls first; see the current starter implementation.

## Migration acceptance gate

See [MIGRATION.md](MIGRATION.md) for the selective transfer schema, consent rules,
legacy confirmation/unsubscribe handling, validation commands and cutover gates.
`export-memberships.sql` prepares only the two reviewed project lists through a
read-only connection. `prepare-transfer.mjs` compiles that export and a reviewed
list mapping into a guarded initial-import SQL file without executing it. Live
migration remains blocked until SQL execution and the legacy reconciliation
path pass a disposable-data rehearsal.


Import only reviewed subscribers belonging to this project's lists. Preserve consent timestamps, confirmed/unconfirmed/unsubscribed membership, global disabled/blocklisted status, and unsubscribe decisions. Do not promote consent during import. A person subscribed to multiple projects is copied only with this project's membership. Pending signups with no membership cannot be attributed safely from the shared database alone: reconcile against the project signup records, or leave them behind and preserve the old confirmation path until they expire. Protect exports and remove them after the agreed retention period.

Native unsubscribe links contain old subscriber/campaign UUIDs and still point to the old hostname. Preserve those endpoints and propagate late unsubscribe/bounce events to the new database before sending; do not retire the old service until this is solved. Freeze scheduled campaigns during the final delta transfer and reconcile writes received during the switch. Migration automation is intentionally not supplied until these ownership and consent mappings are reviewed.

Run two fresh disposable project stacks or isolated fixtures and prove that A's API token cannot authenticate to B, read/modify B subscribers/lists/campaigns, or send using B's identity or tenant. Verify the sender audit and IAM policy simulation. Obtain approval for one inbox test; the relay's staging allowlist prevents other destinations. Confirm inbox arrival, DKIM/From, working confirmation, welcome delivery, native one-click unsubscribe, bounce/complaint routing and suppression. SMTP success or HTTP 200 alone is insufficient evidence.

The relay rejects attachments, custom campaign headers, malformed senders and multi-recipient requests. Listmonk v6.2 postback supplies rendered HTML/plain body; it does not supply the alternate text body. The relay adds one-click unsubscribe headers from the fixed origin and campaign/subscriber UUIDs. Verify these against your templates before cutover. It forwards no arbitrary headers, From addresses, tenant names or AWS settings.

There is no exactly-once delivery guarantee: an SES response lost after acceptance is ambiguous. SDK retries are disabled; do not automatically retry a 502/timeout. Check delivery evidence before a human retries. Keep normal send limits and monitoring; a leaked project token can still mail as that project.

## Rollback and retirement

Before cutover, stop only this new stack and retain its volumes for inspection. Never run `down -v` against an existing installation. After cutover, restore the prior app image/env and reconcile new subscriptions/unsubscribes before reverting traffic. Retain the prior sender key until delivery is verified. The SES ownership journal's `--recipe` describes separate AWS cleanup; review it before deletion.

Retire old project tokens only after every consumer moves and old unsubscribe/feedback behavior is preserved. Shared root-token rotation is a separate fleet action. Until then, the retained shared token remains a cross-project authority. This bundle alone does not establish full isolation.

References: [Listmonk v6.2 messenger payload](https://github.com/knadh/listmonk/blob/v6.2.0/internal/messenger/postback/postback.go), [subscription routes](https://github.com/knadh/listmonk/blob/v6.2.0/cmd/init.go), [AWS IAM simulator limits](https://docs.aws.amazon.com/IAM/latest/APIReference/API_SimulateCustomPolicy.html).
