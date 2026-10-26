# Protected recovery generation engine

Prepared implementation; no bucket, credentials, job or payload copy is created
by importing these files. Activation requires explicit approval naming the backup
records and destination. Fixture tests never use real credentials or data.

The intended copy source is the existing private restic backup bucket containing
registered server databases, persistent uploads/files and configuration. Asset
buckets remain excluded. Payloads stay restic-encrypted; the copier needs no
recovery password. Each generation is a full, independent repository tree under
`generations/<unique-id>/repository/<project>/`. Do not apply age expiry directly
to shared restic packs: current snapshots can still reference old packs.

`generation.mjs` validates the exact approved project set and restic key shape,
refuses active backup locks, snapshots a complete sorted source inventory, copies
with source-ETag conditions, verifies destination sizes/ETags and requires the
source inventory to remain identical afterward. It publishes the manifest and
then a completion marker. Incomplete generations are never promoted or deleted
by this code. They count toward the storage cap.

`s3-store.mjs` performs server-side copies and conditionally creates metadata.
The copy credential must permit reading only the source bucket and writing only
the protected destination, without bucket-configuration permissions. Keep it
outside both VPSs. Neither source mutation nor object deletion is implemented.
A conditional destination lease serializes generation writers, including storage
budget accounting. Configure the S3 client with one attempt and a 30-second
per-operation timeout; the lease expires one minute after the ten-minute maximum
work window. Lease acquisition consumes the same work budget. Every
list/copy/head and final promotion checks the work deadline; the final write
reserves a full 30-second request timeout. The installer must enforce the adapter
timeout before activation.
Invalid initial timestamps fail before lease acquisition. A nonfinite clock or
any backward clock step stops the operation; it cannot extend the lease work
window or publish completion. The owned lease is still released on failure.

Before any personal payload copy, the installer must create and read back the
private EU destination, enable a **90-day bucket lock** for `generations/`, and
configure **120-day lifecycle expiry**. Test a dummy generation's overwrite and
delete rejection using the actual constrained writer, and prove VPS source
credentials cannot access the destination. Age rules apply to individual upload
times: completion records conservatively advertise protection from generation
start, and a 119-day usability cutoff before the earliest 120-day expiry. A
restore selector must enforce this cutoff and validate the manifest and every
object before handing a generation to restic.

`restore-selection.mjs` implements this metadata gate with an explicit requested
cutoff. It checks manifest hash/identity, exact approved repository shape,
counts/bytes, every destination size/ETag, protection/expiry boundaries and a
bounded work deadline. Selection defaults to generations still inside their
90-day protection period; using an older but unexpired generation requires an
explicit boolean override and remains marked unprotected. It never claims an
incident-clean point or a successful native restore. `loadRestoreSelection`
requires an explicit generation ID and loads only its completion record and
manifest. The S3 adapter bounds headers and streamed byte counts, rejects
truncation and invalid UTF-8, and cancels rejected streams. Completion metadata
is limited to 4 KiB; manifests to 2 MiB. Lease reads use the same strict stream
bounds and UTF-8 validation, with a 4 KiB ceiling. Invalid or oversized lease
responses never acquire or release another writer; rejected streams are cancelled. Loading and every object HEAD share one
work deadline. Missing or mismatched generations never fall back to a different
recovery point. The independent recovery credential path and actual protected
restore drill still need integration before activation.

The configuration-reviewed ceilings are 2 GiB per generation, 20 GiB total,
4,000 listed objects, 20 pages and ten minutes. Hitting a cap stops the job and
requires review; these are limits, not promises about future backup growth.
The intended schedule is one weekly generation with bounded retries and a
separate external alert for an incomplete attempt, a missed generation, missing
lock coverage or failed protected restore. The wrapper, independent alert
integration and installer remain to be completed and tested before activation;
this engine alone does not establish operating protected history. Account
administrators can change bucket locks; this protects against VPS compromise,
not compromise of the Cloudflare account itself.

Deployment must also verify the actual execution plan. Current Workers limits
allow 50 external subrequests on Free and 10,000 by default on Paid, with a
15-minute scheduled-invocation wall limit. The reviewed 4,000-object copy ceiling
can require more than 8,000 copy/HEAD requests plus inventory and metadata calls;
it is incompatible with Free. Require a verified sufficient plan and explicit
request budget, or implement a separately tested chunked runner. Do not silently
change the account's plan or place copy credentials on either VPS.

The existing account dashboard was reviewed on 25 October: 100,000 daily
requests and an upgrade to Workers Paid were shown. The account remains on Free;
no upgrade, terms acceptance or billing change was submitted. The full-copy
runner remains incompatible with that plan. Activation still needs a tested
execution design, the constrained writer/recovery credential paths, independent
alerts, a real protected restore and explicit records/destination approval.

Cloudflare references verified 23 October 2026:

- [Bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/)
- [S3 CopyObject conditions](https://developers.cloudflare.com/r2/api/s3/api/)
- [Copy destination conditions](https://developers.cloudflare.com/r2/api/s3/extensions/)
- [Workers execution limits](https://developers.cloudflare.com/workers/platform/limits/) (verified 24 October 2026)

Tests:

```sh
node --test cli/test-protected-generation.mjs cli/test-protected-s3-store.mjs cli/test-protected-restore.mjs
```
