# Project data backups

Requires Python 3, Docker, GNU tar, and restic 0.16 or newer on the server.
Use a private R2 Standard bucket and a token restricted to object access in that
bucket. EU buckets require the `.eu.r2.cloudflarestorage.com` endpoint.

## Hatchkit integration

Configure one backup host with `hatchkit backup configure --config provider.json`.
The input JSON has this shape; input credential files must have mode 0600:

```json
{
  "repositoryBase": "s3:https://ACCOUNT.eu.r2.cloudflarestorage.com/BUCKET",
  "host": {"transport": "tailscale", "target": "root@backup-host", "serverUuid": "COOLIFY_SERVER_UUID"},
  "autoRegister": true,
  "credentialsFile": "/private/path/credentials.json",
  "passwordFile": "/private/path/restic-password"
}
```

Hatchkit stores the bucket's S3 access key, secret key, and restic recovery
password in the OS keychain: service `hatchkit`, account
`backups:r2:credentials`. Provider metadata contains no credentials. Keep a
separate secure recovery copy: resetting Hatchkit or losing the Mac must not
lose the only encryption password. Backup keys never enter app environments.

`hatchkit backup install --dry-run` previews the target without reading keys.
`hatchkit backup install` retrieves those keys and sends the maintained runner
and root-only credential files over Tailscale SSH stdin. It preserves registered
sources and refuses a changed repository or recovery password. Dependencies
must already be installed. It does not enable the schedule. It also updates an
existing runner and can apply replacement R2 keys while preserving the password.

With `autoRegister: true`, `hatchkit create` registers standard managed
PostgreSQL/MongoDB/Redis and generated Compose database sources when deploying
to this exact Coolify server. It initializes each new encrypted repository and
saves the source mapping under `<config-dir>/backups/<project>.json`. Registration
failure becomes a deferred step with a retry command. Registration precedes the
first successful capture; a manifest policy alone is not evidence of protection.
External databases, custom file mounts, other hosts, existing/adopted projects,
and R2 asset buckets require explicit coverage decisions. Shared services such
as analytics and mailing lists are backed up under their service project.

For existing projects, use `hatchkit backup register --config project.json`,
where the JSON contains `serverUuid` and `project` (one of the project objects
below). `--dry-run` previews the target and sources. Registration is idempotent
and refuses to replace a different existing source policy. Policy changes must
be reviewed and applied to the host config explicitly.

`hatchkit backup run` starts a full capture. `hatchkit backup status --json`
reads each project's result, missing or stale captures (36 hours), timer state,
and latest full restore drill. This read requires Tailscale access, not keychain
access. The host runs independently of the Mac once the timer is enabled.

`hatchkit backup bundle` remains available to export an explicit host policy
for manual installation. `hatchkit backup plan` reads the current manifest.

Example host config (keep outside application Git repositories):

```json
{
  "repositoryBase": "s3:https://ACCOUNT.eu.r2.cloudflarestorage.com/BUCKET",
  "credentialsFile": "/etc/hatchkit-backups/credentials.json",
  "passwordFile": "/etc/hatchkit-backups/password",
  "projects": [{
    "name": "example",
    "keepLast": 3,
    "sources": [{
      "name": "database",
      "kind": "postgres",
      "selector": {"project": "COOLIFY_RESOURCE_UUID", "service": "postgres"}
    }, {
      "name": "uploads",
      "kind": "files",
      "paths": ["/absolute/upload/path"]
    }]
  }]
}
```

Selectors must match exactly one running container. A container's Compose
project/service labels survive redeployments. Supported database kinds:
`postgres`, `mongo`, `clickhouse`, `redis`. The runner reads database credentials
inside each container. Custom authentication requires an adapter; a failed
source aborts that project's backup and retains its previous generations.

`kuma-mariadb` captures Uptime Kuma v2's embedded MariaDB through its local
socket using a single-transaction SQL dump. Pair it with a file source for
`/app/data`'s host mount and `"exclude": ["mariadb", "run", "error.log"]`.
The file adapter rejects recognized raw database directories so they cannot
silently pass as consistent file backups. SQLite is still copied with its
online backup API. Update source mappings when applications change engines.

Credentials JSON contains `accessKeyId` and `secretAccessKey`. Both that file and
the restic password file must have mode 0600. Keep a copy of the password and
recovery instructions outside the server, in an existing secure store. Never
put credentials in the manifest, host config, Git, arguments, or logs.

Run `sh install.sh`. Initialize a new project with
`python3 /opt/hatchkit-backups/runner.py init --project example`, then run
`python3 /opt/hatchkit-backups/runner.py run --project example`. Initialization
is separate from backup so an authentication failure never resets a repository.

After the first verified backups and an isolated database restore, enable the
timer with `systemctl enable --now hatchkit-backups.timer`. It runs daily from
03:15–03:30 UTC. Inspect `runner.py status`, `systemctl status
hatchkit-backups.service`, and `journalctl -u hatchkit-backups.service`. Connect
the failed-service status to the operator's existing monitoring. The installer
does not configure an alert destination.

Run `python3 /opt/hatchkit-backups/restore-check.py` for the maintained restore
drill (`--project example` limits it). It verifies archive member checksums and
restores native exports into disposable Docker containers with `--network none`,
no published ports, existing images only, and CPU/memory limits. It checks SQLite
integrity from restored files, removes its containers and volumes, and writes
`/var/lib/hatchkit-backups/restore-check-all.json`. This requires enough free
host resources and does not modify production data. The initial rollout checks
every configured source; daily jobs verify downloaded bytes without starting
restore containers. Repeat native drills after engine upgrades or source changes.

Each project has a separate encrypted restic repository. Every run creates
native database exports and consistent SQLite copies, uploads an archive,
downloads it and checks its SHA-256, then keeps the latest three snapshots and
prunes unreferenced data. A fourth snapshot exists briefly before verification
and pruning. Failures never prune previous snapshots. File archives can fail if
files change while copied; retry after quiescing the relevant writer.

PostgreSQL uses `pg_dumpall` including roles. MongoDB briefly locks writes for a
consistent dump; a watchdog unlocks after ten minutes if the process is lost.
ClickHouse uses its native `BACKUP ALL` File archive; its configuration must
allow the relative `backups` path. Redis uses a replication RDB. These exports
are consistent per engine; related PostgreSQL and ClickHouse databases are not
one atomic transaction. Coordinate application writes if that is required.

Restore into an isolated environment first. Supply the same restic credentials,
password file, and project repository, then `restic snapshots` and `restic dump
SNAPSHOT /project.tar > project.tar`. Extract into an empty directory. The
manifest records engine image versions, original paths, sizes and checksums.
Restore PostgreSQL SQL with `psql`, Mongo archives with `mongorestore --archive
--gzip`, ClickHouse archives with native `RESTORE`, and Redis with its RDB
startup flow. Keep restore containers off production networks and ports.

To add a project, register every live data source in the host config, initialize
that project's repository, and complete the same backup/restore checks. Extra
or duplicate database resources should not replace the application's actual
data store. The runner deliberately does not guess which stores are disposable.

Rollback: `systemctl disable --now hatchkit-backups.timer`. Stop an active backup
through systemd if needed; allow its cleanup/watchdog to release any Mongo write
lock. Disabling the timer leaves retained backups and credentials intact.
