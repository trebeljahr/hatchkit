# Alert mail

The watcher writes the full ledger on every run and mails only a crash or a new
urgent finding: known exploited, or critical with explicitly affected internet
exposure. An urgent finding announced once is announced again only if it clears and
returns. Everything else reaches the owner through the host's daily digest
(`backups/ops_digest.py`). Advisory changes and overdue repeats no longer send their
own mail. This changes when mail is sent, not what is recorded: deadlines never reset,
and skipped checks appear under Not checked and bypass the weekly review gate.

# Reviewed image applicability

Runtime trust checks probe actual `php -v` and `php-fpm -v`, separately from
image tags. The known `coolify` controller requires both probes; missing or
unrecognized output is incomplete coverage. Optional binaries absent from
unrelated containers are normal. Supported PHP2Shell floors are 8.2.35,
8.3.36, 8.4.27 and 8.5.12; an affected binary keeps its 24-hour advisory clock
through a still-affected upgrade. Other branches require an explicit supported
release/backport review. This does not discover differently named SAPIs or
establish application reachability. Review the separate October 23 session
upload-progress advisory and actual web-SAPI configuration too; a version floor
alone does not establish that configuration predicate.

Application dependency review must compare source-audit results with the final
image and actual enabled features. Multi-workspace production graphs can include
docs tools and optional peers that the server never executes. Check existing
image reports for the GHSA before creating a duplicate feed. Raw matches remain
visible while applicability is reviewed; they are not incident counts.

Confirm that a proposed fixed release is published. If the registry cannot
supply the advisory's suggested version, preserve its deadline and record the
missing fix plus vendor mitigation/review expiry. Test an upstream-supported
worker or adapter branch against its actual build/protocol before pinning it.
Authentication updates also require matching integration versions, replay and
2FA checks, and review of custom verification-identifier hooks. Use synthetic
accounts to prove OAuth state cannot act as a Magic Link and cannot consume
another flow's state. Restart pending links/flows as the vendor requires.

Public RCE/authentication-bypass notices need immediate operator applicability
review. Positive exposure ingestion is not yet automatic. Keep named ownership,
evidence and expiry; only use automated assessments with an implemented, tested
predicate. Never add an unsupported predicate or broad severity exemption to
silence a notification. The weekly raw queue does not replace urgent review.

Host Tailscale coverage includes its [vendor security bulletin RSS](https://tailscale.com/security-bulletins/index.xml)
as well as GitHub advisories. The required security floor is 1.104.4. Vendor
notices are maintenance review items with a 24-hour deadline; their high review
priority does not invent a vendor severity, exploitation claim or enabled
SSH/Serve feature. Confirm each feature's applicability. The bounded one-hour
cache preserves retrieval times. Missing, oversized, malformed, duplicate,
wrong-origin, future-dated or regressed feeds fail visibly. New unsupported
notice wording remains incomplete coverage for manual review. Reviewed older
notice wording through TS-2026-013 remains covered by the existing floor;
do not treat an empty GitHub advisory list as successful vendor coverage.

Keep the vendor RSS bound separate from larger JSON catalogs: 1 MiB for the
Tailscale feed and 8 MiB for JSON downloads. CISA's real catalog exceeds 1 MiB.
An oversized or unreadable catalog must remain missing coverage, never an empty
successful result. Exercise that larger-catalog case before deploying feed work.

Patch the access daemon one host at a time. Retain authenticated old/new
packages and private recovery state on the original host, run the update in
a transient system service that survives SSH disconnection, and reconnect over
the existing tailnet. Verify actual version, node identity/preferences/Serve,
container starts and containment, firewall and normal checks before the second
host. The file-integrity check accepts an AIDE diff by itself only when every
added or changed file matches, in content, mode and owner, its owning package's
`.deb` as `apt-get download` fetches and verifies it against the signed archive
index, and directories changed only their timestamps. Removed files, foreign or
shared files, conffile edits, diversions and failed downloads still mail for
review and keep the old baseline; the previous baseline is kept on disk.

The optional `/etc/hatchkit-security/image-assessments.json` is root-owned mode
0600. Start from the empty example. Reviews are explicit operator decisions;
feed text cannot create or extend one. Raw findings, severities, first-seen
timestamps and deadlines remain in the private ledger.

Image-package deadlines follow one host-level advisory/package identity across
affected versions, images and rolling container names. Raw version rows remain
separate. Migration from older per-version identities keeps the earliest clock
and deadline and combines any known-exploited classification, regardless of row
order. An upgrade that remains affected does not restart its patch window or
carry a version-bound applicability assessment to the new version.

The supported `busybox-static-httpd-awk-ash-v1` predicate covers only
CVE-2026-38753, CVE-2026-38754 and CVE-2026-38755. Bind a review to the exact
container name, immutable image ID, `busybox` package/version and advisory IDs.
Supply a named owner, reason, primary HTTPS evidence, `reviewedAt` and
`expiresAt` no more than seven days later. Duplicate/overlapping reviews fail.

Every run verifies the fixed direct `httpd` command, image and read-only
`/www` mount. The host-admin-owned content directory must contain only regular,
non-executable, non-group/world-writable 503/maintenance HTML files. Scripts,
CGI directories, symlinks, HTTP configuration overrides and unexpected paths
invalidate the review. The current fleet's trusted host-admin UIDs are 0/1000;
review that predicate before adapting it to another host.

A current assessment leaves its raw matches visible and removes them from the
unreviewed weekly maintenance queue (the digest's weekly review). Expiry or a changed live boundary becomes
incomplete coverage and bypasses the weekly gate. Resolved findings do not leave
stale-review alerts behind. Known exploitation and explicitly affected internet
exposure always bypass assessments. Add a separately reviewed predicate for a
different vulnerability or execution context; never broaden this one by editing
advisory lists. Keep the review file under manual AIDE baseline review too.

Fixture checks:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 cli/test-image-assessments.py
PYTHONDONTWRITEBYTECODE=1 python3 cli/test-update-watch.py
```

A pending trusted APT update is an actionable maintenance item, even when a
runtime's embedded copy was already patched. Review the current vendor notice:
the APT review priority is not a CVE severity assessment. Public code execution
uses the 24-hour patch-or-isolate target. Pin the reviewed package set, retain
authenticated recovery artifacts, patch hosts serially, restart identified
consumers and verify the actual running image inventory separately. Refresh this
watcher after successful validation so resolved host findings clear without
resetting continuing image/advisory deadlines. Keep LLM review paused when the
operator has paused it; deterministic checks and external freshness alerts remain
independent of that reviewer.

Runtime trust inspection reads known public CA bundles through the local Docker
archive API, so an image needs no `cat` or shell for those files. Requests have
a deadline and byte bounds; the parser accepts one regular expected-name file
without extracting it. Directories, hard links, sparse files, unexpected entries,
oversize archives and malformed PEM make coverage incomplete. A symbolic alias
is never followed: it is deduplicated only when its known public target was
independently read as a regular file. Arbitrary paths returned by an executable
are rejected without a read or raw diagnostic in reports.

The version inventory also includes CoreDNS and Coolify Sentinel. These roles
require the real CoreDNS version command or Sentinel's documented public local
version endpoint; an unreadable probe cannot fall back to an image tag. They use
their upstream repository advisory/release feeds with the existing bounded cache
and backoff. This adds visibility, not an automatic upgrade or finding suppression.
Existing raw-package clocks, weekly review and urgent/missed-run behavior stay
in force. Known-path CA inspection does not inventory custom application stores,
embedded roots or a program's TLS verification behavior; review those separately.

For an app dependency match, inspect the full local report's artifact locations
before choosing the source repository or override. A package under global npm
is a different installation from the app's traced production package. Review
vendor platform/feature conditions against the real deployed configuration and
record evidence without claiming scanner matches are incidents.

Qualify a dependency/lockfile patch with the app's existing native tests,
typechecks, production build and release/recovery contracts using synthetic
configuration. Preserve qualified deployment controls and persistent paths.
Verify the new immutable image and actual installed versions, then scan the
final image and refresh the watcher. Do not close a finding based only on a
source commit, reset continuing deadlines or suppress unrelated bundled copies.
Git publication and protected-record uploads retain their separate approval
boundaries; a maintenance request does not silently grant either.

Route image-scan and advisory-watcher failures to their own named handlers. An image inventory invalidated by a deployment must identify the image service and its retry, not claim the update watcher crashed or that no checks ran. Preserve the previous complete ledger and the failed attempt separately; the independent monitor still reports incomplete coverage.

The image timer checks coverage every 15 minutes with up to one minute of
jitter. Its read-only `--needs-refresh` condition skips the scanner and watcher
when the same immutable images and workload names already have current coverage.
Changed or removed images, rolling names, failed attempts, malformed provenance,
24-hour-old image reports and a ledger 23 hours old require a refresh. This keeps
database review daily without rescanning unchanged images every quarter hour.
An unavailable Docker inventory returns ExecCondition 255 and fails visibly;
only verified current coverage returns the normal skip code 1. Existing resource
limits, scan locking, failed-attempt evidence and notification deadlines remain.

For a database image's library-only patch, verify the database binary hash is
unchanged and enumerate the exact package delta. Qualify native dump/restore,
restart, current-data downgrade and reapplication on a synthetic volume first.
Capture the registered backup on the original host before deployment. Change
only the image in both native Compose documents, compare parser output in a
rolled-back transaction, deploy only that database component, then verify its
original volume, prior credential values, resources and application queries.
Review any native metadata additions explicitly. Enroll the qualified image in
the existing exact-image policy and review AIDE differences before accepting a
new baseline. A retained image alone is not a tested recovery path.

Put a meaningful regression in the application's existing publication gate.
Where native server modules matter, run compiled tests in the Linux build stage
before pruning dev dependencies, using synthetic configuration and bounded
concurrency. A failing test must stop image publication. Check both the repaired
failure path and normal requests; qualify crash regressions only on disposable
localhost fixtures, never a live workload. Source tests do not replace final
image scanning or deployment-policy checks.

Inspect a fresh production dependency closure too: in-place pruning can leave
orphaned development packages in pnpm's virtual store. Preserve legitimate
production peers and qualify native modules after any clean installation.
Skipped install scripts require an explicit, reviewed native rebuild. Pin the
manager in independently installed subprojects and verify overrides took effect.
Rolling tests should prove a late in-flight response finishes and its idle
keep-alive socket retires within the existing shutdown budget, with clean exit
and preserved state on the surviving replica.
