# Reviewed image applicability

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
