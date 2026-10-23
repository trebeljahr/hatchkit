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
work window. Every list/copy/head and final promotion checks the work deadline.

Before any personal payload copy, the installer must create and read back the
private EU destination, enable a **90-day bucket lock** for `generations/`, and
configure **120-day lifecycle expiry**. Test a dummy generation's overwrite and
delete rejection using the actual constrained writer, and prove VPS source
credentials cannot access the destination. Age rules apply to individual upload
times: completion records conservatively advertise protection from generation
start, and a 119-day usability cutoff before the earliest 120-day expiry. A
restore selector must enforce this cutoff and validate the manifest and every
object before handing a generation to restic.

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

Cloudflare references verified 23 October 2026:

- [Bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/)
- [S3 CopyObject conditions](https://developers.cloudflare.com/r2/api/s3/api/)
- [Copy destination conditions](https://developers.cloudflare.com/r2/api/s3/extensions/)

Tests:

```sh
node --test cli/test-protected-generation.mjs cli/test-protected-s3-store.mjs
```
