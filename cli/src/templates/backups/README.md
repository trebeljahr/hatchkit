# Project data backups

Requires Python 3, Docker, GNU tar, and restic 0.16 or newer on the server.
Use a private R2 Standard bucket and a token restricted to object access in that
bucket. EU buckets require the `.eu.r2.cloudflarestorage.com` endpoint.

`hatchkit backup bundle` exports this runner with an explicit host config. It
does not install or enable anything remotely. New Coolify server projects record
the intended daily, three-generation policy in their manifest; that intent is
not evidence of an installed or successful backup.

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
