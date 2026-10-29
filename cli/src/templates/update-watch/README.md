# Reviewed image applicability

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

Patch the access daemon one host at a time. Retain authenticated old/new
packages and private recovery state on the original host, run the update in
a transient system service that survives SSH disconnection, and reconnect over
the existing tailnet. Verify actual version, node identity/preferences/Serve,
container starts and containment, firewall and normal checks before the second
host. Review AIDE package-file differences separately; never auto-accept them.

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
unreviewed weekly maintenance queue. Expiry or a changed live boundary becomes
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
