# Trusted static Worker deployer

This standalone Python 3.11+ tool separates source builds from Cloudflare credentials.
It accepts static GitHub Actions artifacts and deploys them to a fixed, reviewed Worker.
It uses only the Python standard library. It does not invoke Hatchkit, Wrangler, package scripts, or the OS keychain.

**Status:** local implementation with offline security tests. No trusted repository or production workflow is installed.
The direct-upload and readback schemas need a disposable live canary. Unexpected provider shapes stop deployment rather than relaxing the checks.

## Trust boundary

Copy `deployer.py` and a reviewed `policy.json` into a **separate trusted repository**.
Install `trusted-deploy.yml.example` there as `.github/workflows/deploy-static.yml` only after review.
Source repository writers must not be able to edit the trusted code, policy or environments.
The source workflow builds without Cloudflare credentials; the trusted workflow runs on fresh GitHub-hosted runners.
It neither checks out source-project code nor executes downloaded files. No build cache crosses into the privileged job.

The trusted deployer and its maintainers remain privileged. Compromising that repository, its dependencies, or the runner can compromise deployed projects.
Source compromise still permits malicious browser content on that site's hostname. This tool does not fix shared cookies or application authorization.

A Worker-scoped token can add a binding to another same-account KV namespace. Moving tokens out of project CI only closes that path after the old tokens are revoked.
Keeping a secret in a different job of the same source repository is insufficient: a repository writer can edit the privileged job.

## Files and commands

- `deployer.py`: offline planning, online artifact verification, and explicitly enabled deployment.
- `test_deployer.py`: synthetic archive, metadata, HTTP, upload and recovery tests. No network or real credentials.
- `policy.example.json`: deliberately invalid placeholders. Zero budgets and IDs fail before network access. Set reviewed values; do not copy guessed production limits.
- `source-build.yml.example`: source build without deployment credentials. Preserve the per-project changes below.
- `trusted-deploy.yml.example`: manual two-job verification/deployment workflow with pinned actions and per-project environments.

Run offline checks from this directory:

```sh
make check
```

Offline planning reads an existing ZIP and metadata files. It never accesses providers:

```sh
python3 -I deployer.py plan --policy policy.json --project portfolio \
  --run 123 --attempt 1 --artifact 456 --head-sha FULL_MAIN_COMMIT_SHA \
  --run-json run.json --artifact-json artifact.json --archive static-assets.zip \
  --receipt new-plan.json
```

`verify` fetches GitHub metadata and archive bytes using `SOURCE_READ_TOKEN`, without a Cloudflare token.
`deploy` independently fetches and validates them again, requires an equal `--approved-receipt`,
`--expected-version CURRENT_VERSION_UUID`, and `--allow-live`. Its Cloudflare credential comes only from `CLOUDFLARE_API_TOKEN`.
Pass token values through the trusted environment, never command arguments or files.
Receipts are written to new paths and contain identities, hashes and states, not credential values or signed URLs.
`deploy` does not perform public HTTP site checks. A verified API receipt is not evidence of a healthy site.

## Policy and workflow setup

Record exact numeric source and trusted repository IDs, default branch `main`, source workflow path,
artifact base name (the workflow appends the run attempt), account ID, immutable Worker ID/name, compatibility date, 404 mode and archive budgets.
Mappings must not share a source repository, Worker ID or Worker name. Source and trusted repository IDs must differ.
Unknown policy fields are rejected. Deploy inputs cannot supply bindings, provider URLs, configuration or secrets.

The example policy is a schema illustration, not a ready production mapping. Create separate reviewed entries:

| Project | Build command | Upload directory | Missing-page mode |
|---|---|---|---|
| portfolio | `pnpm build` | `out/` | `404-page` |
| fractal-garden | `pnpm export` | `out/` | `404-page` |
| minecraft-clone | `pnpm build` | `public/` | `none` |
| quaternius-showcase | `pnpm build` | `out/` | `404-page` |

Keep Fractal Garden's full Git history for sitemap dates. Minecraft's artifact includes generated `public/dist` and committed public assets.
The source template excludes hidden files; inspect `.well-known` requirements before adopting it.
`_headers` and `_redirects` are rejected in this first version. Review their semantics and add tests before supporting them.
Compatibility date and asset routing are generated from policy; current examples use `2026-09-28` and automatic trailing-slash handling.

In the trusted repository:

1. Protect `main` and restrict who can change policy, code and workflow files.
2. Create one environment named `cf-static-<project>` per mapping, with a reviewer and **main-only deployment access**.
3. Store each exact Worker-only token only in its matching environment as `CLOUDFLARE_API_TOKEN`. Never store the provisioner or put Cloudflare tokens in repository-level secrets.
4. Store `SOURCE_READ_TOKEN` only on the trusted side. Scope it to metadata/Actions read for the exact source repositories and any required branch-ref read. Review the actual GitHub credential type and permissions before creation.
5. Review all action commit pins and the hosted runner/Python version. Pins were resolved from official action repositories on 2026-09-30; they are not an independent action-code audit.
6. Review a successful source build run, attempt, artifact ID and current Worker version. Dispatch only from trusted `main`.

A protected deployment environment is required even though the program checks Actions repository ID, event and branch.
The checks protect configuration mistakes; they cannot protect a workflow that an attacker can rewrite.
Do not add automatic cross-repository dispatch credentials to source projects. Automation beyond manual dispatch needs separate design and review.

## Validation and deployment behavior

The verifier requires a successful `push` or manual run from the mapped source repository on its current `main` SHA.
It rejects fork/PR origins, changed attempts, an unexpected workflow, duplicate artifact names, expired artifacts and missing/different SHA-256 digests.
Artifact creation must fall inside the current run attempt, and its name must include that attempt.
It checks the branch and attempt again after download and before publishing. GitHub credentials never follow the signed artifact redirect.
Only HTTPS download hosts under `.blob.core.windows.net` or `.actions.githubusercontent.com` are accepted.
A new host fails closed and needs explicit review.

ZIP files are inspected in memory and never extracted. Declared entry counts are bounded before the ZIP library allocates metadata.
The validator checks archive/expanded/file sizes, entry/file counts and compression ratio.
It rejects ZIP64, split/encrypted archives, links, special files, unknown extra fields, unsafe paths, case/Unicode collisions and configuration/control files.
Only stored/deflated entries from Unix or DOS creators are supported. Every artifact must contain `index.html`, plus `404.html` for `404-page` mode.
Budgets have hard upper bounds of 256 MiB compressed/expanded, 25 MiB per file and 20,000 files; set lower measured project limits.
Larger sites require a reviewed streaming implementation, not raised unbounded allocations.

Deployment first checks the immutable Worker identity, a single active 100% version, no bindings, server code, exports, runtime flags, schedules or tail consumers.
The assets upload session names only the policy's Worker. Upload JWTs remain in memory.
The final multipart upload contains generated JSON metadata only: no script modules, storage/service bindings, routes or secret retention.
It does not create/delete Workers, change DNS/custom domains, or mint/revoke credentials.
Existing hostname and workers.dev settings are not changed; verify preservation during the live canary.

Workflow concurrency serializes each project; policy validation prevents alias mappings to the same Worker.
A private local file lock serializes processes on one machine. The expected version is checked before and after asset upload.
Cloudflare's upload API is not a compare-and-swap transaction: disable other deploy paths and revoke source tokens during rollout.
Concurrent external writers can still race the final check. Never describe this as provider-enforced transactional isolation.

## Failure, verification and rollback

The journal moves through `validated`, `uploading`, `deploying`, `deployed-unverified` and `verified`.
Failures before publishing become `stopped-before-deploy`; an uncertain PUT or failed readback becomes `needs-reconciliation`.
The receipt records the previous version before publishing. A failed PUT can still have applied; never blindly repeat it.
The workflow uploads receipts even on failure when the runner remains available.
If the runner disappears before artifact upload, inspect provider deployment history using the reviewed target and expected previous version.
No automatic rollback, credential revocation, cleanup or deletion occurs.

For an approved rollback, review the receipt's previous version against the exact Worker and restore that version through the provider's deployment controls.
Verify that the previous version and its assets are still available before production cutover. This tool deliberately rejects old source artifacts because they are not current `main`.
A version rollback remains a separate operator action; no `rollback` mode is implemented.

The first live check must use a separately approved disposable Worker already bootstrapped with a static-only version and an exact Worker-scoped token.
Record its immutable ID, baseline version, policy, artifact and cleanup recipe before running.
Check homepage, a CSS/JS asset, nested paths, 404 behavior, empty bindings, unchanged domains and restoration of the baseline.
Only then review production workflow publication, token storage, old-token revocation and per-site cutover.

## Provider references

- [Worker authorization and bindings](https://developers.cloudflare.com/workers/authorization/workers/)
- [Direct static asset uploads](https://developers.cloudflare.com/workers/static-assets/direct-upload/)
- [Worker version readback](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/get/)
- [GitHub Actions artifact metadata](https://docs.github.com/en/rest/actions/artifacts?apiVersion=2022-11-28)
- [Privileged follow-up workflow risks](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)
