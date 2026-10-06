#!/usr/bin/env python3
"""Daily, encrypted project backups. Credentials and policy stay outside app repos."""
import argparse
from contextlib import closing
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import uuid


class BackupError(RuntimeError):
    pass


class SourceMissing(BackupError):
    """A registered source no longer exists on this host.

    Kept distinct from a capture failure: the usual cause is a database that
    was moved or removed without updating the backup policy, and the fix is a
    policy change, not a retry. It still fails the run. The host cannot tell
    a removed database from one that crashed, and skipping it would let
    retention prune the last snapshots that contain its data."""

    def __init__(self, project=None, sources=()):
        self.sources = list(sources)
        super().__init__(
            f"Registered source(s) {', '.join(self.sources)} not found on this host (moved or removed?). "
            f"Previous snapshots retained. Fix: hatchkit backup sources --project {project}"
            if project else 'Source selector matches 0 running containers; expected one')


def run(argv, *, env=None, output=None, input=None, stdin=None, timeout=1800):
    result = subprocess.run(argv, input=input, stdin=stdin, stdout=output or subprocess.PIPE,
                            stderr=subprocess.PIPE, env=env, timeout=timeout)
    if result.returncode:
        # Engine stderr can contain a connection string or secret. Keep logs safe.
        raise BackupError(f"{Path(argv[0]).name} failed (exit {result.returncode})")
    return result.stdout


def sha256(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def valid_name(name):
    if not isinstance(name, str) or not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,99}', name):
        raise BackupError('Project/source names must contain lowercase letters, digits, - or _')
    return name


def validate_project(project):
    valid_name(project['name'])
    if project.get('keepLast', 3) != 3:
        raise BackupError('This policy retains exactly three successful generations')
    if not project.get('sources'):
        raise BackupError('No backup sources configured')
    names = set()
    for source in project['sources']:
        name = valid_name(source['name'])
        if name in names:
            raise BackupError('Duplicate source name')
        names.add(name)
        if source['kind'] not in ('postgres', 'mongo', 'clickhouse', 'redis', 'kuma-mariadb', 'files'):
            raise BackupError('Unsupported source kind')
        if source['kind'] == 'files':
            if not source.get('paths') or any(not Path(p).is_absolute() or os.path.normpath(p) == '/' or Path(p).resolve() == Path('/') for p in source['paths']):
                raise BackupError('File sources require explicit absolute paths, never /')
            if any(Path(p).is_absolute() or '..' in Path(p).parts for p in source.get('exclude', [])):
                raise BackupError('File exclusions must be relative to each source directory')
        elif not source.get('selector'):
            raise BackupError('Database sources require an exact container selector')
    return project


def containers():
    ids = run(['docker', 'ps', '-q']).decode().split()
    return json.loads(run(['docker', 'inspect', *ids])) if ids else []


def selector_matches(selector, inventory):
    allowed = {'container', 'project', 'service'}
    if not selector or not set(selector).issubset(allowed):
        raise BackupError('Invalid container selector')
    matches = []
    for item in inventory:
        labels = item['Config'].get('Labels') or {}
        values = {'container': item['Name'].lstrip('/'),
                  'project': labels.get('com.docker.compose.project'),
                  'service': labels.get('com.docker.compose.service')}
        if all(values[k] == v for k, v in selector.items()):
            matches.append(item)
    return matches


def resolve_container(selector, inventory):
    matches = selector_matches(selector, inventory)
    if not matches:
        raise SourceMissing()
    if len(matches) != 1:
        raise BackupError(f'Source selector matches {len(matches)} running containers; expected one')
    return matches[0]


# Names only. Image-baked env keys identify official images whose tag was
# replaced by an image ID; values are never read.
KIND_TEXT = {'postgres': ('postgres', 'postgis', 'timescale'), 'mongo': ('mongo',),
             'redis': ('redis', 'valkey', 'keydb'), 'clickhouse': ('clickhouse',),
             'kuma-mariadb': ('uptime-kuma',)}
KIND_ENV = {'postgres': ('PG_MAJOR',), 'mongo': ('MONGO_VERSION', 'MONGO_MAJOR'),
            'redis': ('REDIS_VERSION',), 'clickhouse': ('CLICKHOUSE_VERSION',)}


def container_kinds(item):
    labels = item['Config'].get('Labels') or {}
    text = ' '.join(filter(None, [item['Config'].get('Image'), item['Name'], labels.get('com.docker.compose.service'),
                                  labels.get('coolify.resourceName')])).lower()
    env = {entry.split('=', 1)[0] for entry in item['Config'].get('Env') or []}
    return {kind for kind, words in KIND_TEXT.items()
            if any(word in text for word in words) or env.intersection(KIND_ENV.get(kind, ()))}


def describe_container(item):
    labels = item['Config'].get('Labels') or {}
    name = item['Name'].lstrip('/')
    project, service = labels.get('com.docker.compose.project'), labels.get('com.docker.compose.service')
    return {'container': name, 'image': item['Config'].get('Image'),
            'selector': {'project': project, 'service': service} if project and service else {'container': name},
            'coolifyProject': labels.get('coolify.projectName'), 'coolifyResource': labels.get('coolify.resourceName'),
            'kinds': sorted(container_kinds(item))}


def source_report(projects, inventory, path_exists=os.path.exists):
    """Resolve every registered source against the running containers. Read-only."""
    rows, claimed = [], set()
    for project in projects:
        for source in project['sources']:
            row = {'project': project['name'], 'source': source['name'], 'kind': source['kind']}
            if source['kind'] == 'files':
                missing = [p for p in source['paths'] if not path_exists(p)]
                row.update(paths=source['paths'], missingPaths=missing, state='missing' if missing else 'ok')
            else:
                matches = selector_matches(source['selector'], inventory)
                row.update(selector=source['selector'], matches=len(matches),
                           state='ok' if len(matches) == 1 else 'missing' if not matches else 'ambiguous')
                if len(matches) == 1:
                    claimed.add(matches[0]['Id'])
                    row['container'] = matches[0]['Name'].lstrip('/')
                elif matches:
                    row['candidates'] = [describe_container(item) for item in matches]
            rows.append(row)
    # Offer only running, unclaimed containers of the same engine as replacements.
    for row in rows:
        if row['state'] == 'missing' and row['kind'] != 'files':
            row['candidates'] = [describe_container(item) for item in inventory
                                 if item['Id'] not in claimed and row['kind'] in container_kinds(item)]
    return rows


def docker_shell(container, script, output=None, timeout=1800):
    return run(['docker', 'exec', container['Id'], 'sh', '-ec', script], output=output, timeout=timeout)


MONGO_AUTH_JS = r'''const admin = db.getSiblingDB("admin");
const username = process.env.MONGO_INITDB_ROOT_USERNAME;
const password = process.env.MONGO_INITDB_ROOT_PASSWORD;
if (username && !admin.auth(username, password)) throw new Error("Mongo authentication failed");
'''

# Pass both shell authentication and mongodump's URI through stdin. Expanding
# secrets in sh "$@" would expose them in child-process argv inside Docker.
MONGO_AUTH_ASYNC_JS = MONGO_AUTH_JS.replace('admin.auth(username, password)', '(await admin.auth(username, password))')
MONGO_DUMP_JS = '(async () => {\n' + MONGO_AUTH_ASYNC_JS + r'''
const cp = require("node:child_process");
const uri = username
  ? "mongodb://" + encodeURIComponent(username) + ":" + encodeURIComponent(password) + "@127.0.0.1:27017/?authSource=admin&directConnection=true"
  : "mongodb://127.0.0.1:27017/?directConnection=true";
let watchdog, locked = false, failed = false;
try {
  if ((await admin.runCommand({currentOp: 1})).fsyncLock) throw new Error("Mongo is already write-locked");
  watchdog = cp.spawn("mongosh", ["--quiet", "--norc", "--eval", __WATCHDOG__], {stdio: ["ignore", "pipe", "ignore"]});
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Mongo unlock watchdog unavailable")), 10000);
    const stop = () => { clearTimeout(timer); reject(new Error("Mongo unlock watchdog stopped")); };
    watchdog.once("error", stop); watchdog.once("exit", stop);
    watchdog.stdout.once("data", () => { clearTimeout(timer); resolve(); });
  });
  await ready;
  if (!(await admin.fsyncLock()).ok) throw new Error("Mongo write lock failed");
  locked = true;
  // Node child stdin is a socket on some hosts; cat supplies a real pipe
  // that Mongo tools can reopen as /dev/stdin without a credential file.
  const result = cp.spawnSync("sh", ["-ec", "cat | timeout 540 mongodump --config /dev/stdin --archive --gzip"], {
    input: JSON.stringify({uri}), stdio: ["pipe", "inherit", "pipe"], timeout: 550000,
  });
  if (result.status !== 0 || result.error) throw new Error("Mongo dump failed");
} catch (_) { failed = true; }
finally {
  let released = !locked;
  if (locked) { try { released = Boolean((await admin.fsyncUnlock()).ok); } catch (_) { failed = true; } }
  if (released && watchdog) watchdog.kill("SIGTERM");
  if (!released) failed = true;
}
if (failed) quit(1);
})().catch(() => quit(1));
'''.replace('__WATCHDOG__', json.dumps(
    '(async () => {' + MONGO_AUTH_ASYNC_JS + 'print("watchdog-ready"); await new Promise(resolve => setTimeout(resolve, 600000)); try { await admin.fsyncUnlock(); } catch (_) {} })().catch(() => quit(1));'
))


def dump_database(source, container, destination):
    kind = source['kind']
    metadata = {'kind': kind, 'image': container['Config']['Image'], 'imageId': container['Image'], 'selector': source['selector']}
    if kind == 'postgres':
        with (destination / 'cluster.sql').open('wb') as output:
            docker_shell(container, 'export PGPASSWORD="${POSTGRES_PASSWORD:-}"; exec pg_dumpall -U "${POSTGRES_USER:-postgres}"', output)
        metadata['format'] = 'pg_dumpall SQL (all databases and roles)'
    elif kind == 'kuma-mariadb':
        # Kuma v2 embeds MariaDB and authenticates its OS user through a local
        # socket. Never archive live InnoDB files as ordinary uploads.
        script = '''const fs=require('fs'); const cp=require('child_process');
const config=JSON.parse(fs.readFileSync('/app/data/db-config.json','utf8'));
if(config.type!=='embedded-mariadb') throw new Error('Expected Kuma embedded MariaDB');
const result=cp.spawnSync('mariadb-dump',['--socket=/app/data/run/mariadb.sock','--user='+require('os').userInfo().username,'--single-transaction','--quick','--routines','--events','--triggers','--hex-blob','--databases','kuma'],{stdio:'inherit'});
process.exit(result.status??1);'''
        with (destination / 'mariadb.sql').open('wb') as output:
            run(['docker', 'exec', container['Id'], 'node', '-e', script], output=output)
        metadata['format'] = 'MariaDB single-transaction SQL; Kuma database, routines, events and triggers'
    elif kind == 'mongo':
        # A standalone MongoDB has no oplog snapshot. Lock writes only during its
        # dump, and install a bounded watchdog before locking, including on timeout.
        with (destination / 'mongo.archive.gz').open('wb') as output:
            run(['docker', 'exec', '-i', container['Id'], 'mongosh', '--quiet', '--norc', '--file', '/dev/stdin'],
                input=MONGO_DUMP_JS.encode(), output=output, timeout=660)
        metadata['format'] = 'mongodump archive+gzip; writes locked during dump'
    elif kind == 'clickhouse':
        filename = f'hatchkit-{uuid.uuid4().hex}.zip'
        backup_path = f'backups/{filename}'
        query = f"BACKUP ALL TO File('{backup_path}')"
        auth = 'set --; if [ -n "${CLICKHOUSE_USER:-}" ]; then set -- --user "$CLICKHOUSE_USER" --password "${CLICKHOUSE_PASSWORD:-}"; fi; '
        try:
            docker_shell(container, auth + 'clickhouse-client "$@" --query ' + shell_quote(query))
            # Relative File paths resolve below ClickHouse's backup directory.
            paths = ['/var/lib/clickhouse/backups/' + backup_path, '/var/lib/clickhouse/' + backup_path, '/' + backup_path]
            for path in paths:
                probe = subprocess.run(['docker', 'exec', container['Id'], 'test', '-f', path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if probe.returncode == 0:
                    run(['docker', 'cp', f"{container['Id']}:{path}", str(destination / 'clickhouse.zip')])
                    metadata['format'] = 'ClickHouse native BACKUP ALL zip'
                    break
            else:
                raise BackupError('ClickHouse completed but its archive could not be found')
        finally:
            docker_shell(container, 'rm -f ' + ' '.join(shell_quote(p) for p in ['/var/lib/clickhouse/backups/' + backup_path, '/var/lib/clickhouse/' + backup_path, '/' + backup_path]))
    elif kind == 'redis':
        path = f'/tmp/hatchkit-{uuid.uuid4().hex}.rdb'
        try:
            docker_shell(container, 'if [ -n "${REDIS_PASSWORD:-}" ]; then export REDISCLI_AUTH="$REDIS_PASSWORD"; else unset REDISCLI_AUTH; fi; redis-cli --rdb ' + shell_quote(path))
            run(['docker', 'cp', f"{container['Id']}:{path}", str(destination / 'redis.rdb')])
        finally:
            docker_shell(container, 'rm -f ' + shell_quote(path))
        metadata['format'] = 'Redis replication RDB'
    return metadata


def shell_quote(value):
    return "'" + value.replace("'", "'\\''") + "'"


def copy_file(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    with source.open('rb') as f:
        is_sqlite = f.read(16) == b'SQLite format 3\0'
    if is_sqlite:
        with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True, timeout=30)) as db:
            with closing(sqlite3.connect(destination)) as target:
                start = time.monotonic()
                def progress(status, remaining, total):
                    if time.monotonic() - start > 300:
                        raise BackupError('SQLite online backup exceeded five minutes')
                db.backup(target, pages=256, progress=progress)
                target.execute('PRAGMA journal_mode=DELETE')
                if target.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                    raise BackupError('SQLite integrity check failed')
    else:
        before = source.stat()
        shutil.copy2(source, destination)
        after = source.stat()
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise BackupError('A file changed during capture; previous backups retained')
    shutil.copystat(source, destination)
    if os.geteuid() == 0:
        stat = source.stat()
        os.chown(destination, stat.st_uid, stat.st_gid)


def copy_files(paths, destination, exclude=()):
    for index, raw in enumerate(paths):
        source = Path(raw)
        if not source.exists():
            raise BackupError('A configured file source is missing')
        root = destination / str(index)
        if source.is_file():
            copy_file(source, root / source.name)
            continue
        root.mkdir(parents=True)
        for current, dirs, files in os.walk(source, followlinks=False):
            rel = Path(current).relative_to(source)
            if any((Path(current) / marker).exists() for marker in ('PG_VERSION', 'WiredTiger', 'ibdata1')):
                raise BackupError('Raw database directory detected; use a native database source and exclude its live files')
            for name in dirs[:]:
                if str(rel / name) in exclude:
                    dirs.remove(name)
                    continue
                p = Path(current) / name
                target = root / rel / name
                if p.is_symlink():
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.symlink_to(os.readlink(p))
                    dirs.remove(name)
                else:
                    target.mkdir(parents=True, exist_ok=True)
            for name in files:
                if str(rel / name) in exclude:
                    continue
                p = Path(current) / name
                target = root / rel / name
                # SQLite backup() incorporates committed WAL data itself.
                if name.endswith(('-wal', '-shm', '-journal')):
                    base = p.with_name(name.rsplit('-', 1)[0])
                    if base.is_file():
                        with base.open('rb') as f:
                            if f.read(16) == b'SQLite format 3\0':
                                continue
                if p.is_symlink():
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.symlink_to(os.readlink(p))
                elif p.is_file():
                    copy_file(p, target)
        # Preserve directory ownership/modes after copying children.
        for current, dirs, files in os.walk(source, topdown=False, followlinks=False):
            p = Path(current)
            target = root / p.relative_to(source)
            if not target.exists() or target.is_symlink():
                continue
            shutil.copystat(p, target)
            if os.geteuid() == 0:
                stat = p.stat()
                os.chown(target, stat.st_uid, stat.st_gid)


def make_manifest(stage, sources):
    files = {}
    links = {}
    for path in sorted(stage.rglob('*')):
        name = str(path.relative_to(stage))
        if path.is_symlink():
            links[name] = os.readlink(path)
        elif path.is_file():
            files[name] = {'size': path.stat().st_size, 'sha256': sha256(path)}
    manifest = {'createdAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'sources': sources, 'files': files, 'symlinks': links}
    (stage / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return manifest


def restic(args, env):
    return run(['restic', '--quiet', *args], env=env, timeout=7200)


def credential_env(config, work):
    credentials_path = Path(config['credentialsFile'])
    password_path = Path(config['passwordFile'])
    for path in (credentials_path, password_path):
        if path.stat().st_mode & 0o077:
            raise BackupError('Credential files must be readable only by their owner')
    credentials = json.loads(credentials_path.read_text())
    return {**os.environ, 'AWS_ACCESS_KEY_ID': credentials['accessKeyId'],
            'AWS_SECRET_ACCESS_KEY': credentials['secretAccessKey'], 'AWS_DEFAULT_REGION': 'auto',
            'RESTIC_PASSWORD_FILE': str(password_path), 'GOMAXPROCS': '2',
            'RESTIC_CACHE_DIR': str(work / 'cache')}


def backup_project(project, config, env, inventory, work):
    validate_project(project)
    name = project['name']
    project_env = {**env, 'RESTIC_REPOSITORY': config['repositoryBase'].rstrip('/') + '/' + name}
    # Resolve every source before capturing any. A moved or removed source is
    # reported by name, as a policy problem, without dumping the others first.
    resolved, missing = {}, []
    for source in project['sources']:
        if source['kind'] == 'files':
            if any(not Path(p).exists() for p in source['paths']):
                missing.append(source['name'])
            continue
        try:
            resolved[source['name']] = resolve_container(source['selector'], inventory)
        except SourceMissing:
            missing.append(source['name'])
        except BackupError as error:
            raise BackupError(f"Source {source['name']} ({source['kind']}): {error}") from error
    if missing:
        raise SourceMissing(name, missing)
    # Initialisation is explicit. A network/auth failure must never be mistaken for an empty repo.
    restic(['cat', 'config'], project_env)
    with tempfile.TemporaryDirectory(prefix=name + '-', dir=work) as temp:
        temp = Path(temp)
        stage = temp / 'data'
        stage.mkdir(mode=0o700)
        metadata = []
        for source in project['sources']:
            dest = stage / source['name']
            dest.mkdir()
            if source['kind'] == 'files':
                copy_files(source['paths'], dest, source.get('exclude', []))
                metadata.append({'name': source['name'], 'kind': 'files', 'paths': source['paths'], 'exclude': source.get('exclude', [])})
            else:
                try:
                    item = dump_database(source, resolved[source['name']], dest)
                except BackupError as error:
                    raise BackupError(f"Source {source['name']} ({source['kind']}): {error}") from error
                metadata.append({'name': source['name'], **item})
        manifest = make_manifest(stage, metadata)
        # Stable archive paths, even though each run uses a private temporary directory.
        archive = temp / 'project.tar'
        run(['tar', '-cf', str(archive), '-C', str(stage), '.'])
        run_tag = 'hatchkit-run-' + uuid.uuid4().hex
        with archive.open('rb') as stream:
            result = run(['restic', 'backup', '--json', '--stdin', '--stdin-filename', 'project.tar', '--tag', 'hatchkit-pending', '--tag', run_tag, '--host', 'hatchkit-backups'],
                         env=project_env, stdin=stream, timeout=7200)
        summary = [json.loads(line) for line in result.decode().splitlines() if line.startswith('{')]
        snapshots = [line['snapshot_id'] for line in summary if line.get('snapshot_id')]
        if len(snapshots) != 1:
            raise BackupError('Backup did not return exactly one completed snapshot')
        snapshot = snapshots[0]
        restored = temp / 'restored.tar'
        with restored.open('wb') as output:
            run(['restic', 'dump', snapshot, '/project.tar'], env=project_env, output=output, timeout=7200)
        if sha256(restored) != sha256(archive):
            raise BackupError('Downloaded backup differs from the captured archive')
        # Failed downloads leave a pending snapshot, which must never displace a
        # verified recovery point on a later run. Tagging creates a new snapshot ID.
        restic(['tag', '--add', 'hatchkit-verified', '--remove', 'hatchkit-pending', snapshot], project_env)
        verified = json.loads(restic(['snapshots', '--json', '--tag', run_tag], project_env))
        if len(verified) != 1 or 'hatchkit-verified' not in verified[0]['tags']:
            raise BackupError('Cannot confirm the verified snapshot tag; previous backups retained')
        snapshot = verified[0]['id']
        pending = json.loads(restic(['snapshots', '--json', '--tag', 'hatchkit-pending'], project_env))
        if pending:
            restic(['forget', *[item['id'] for item in pending]], project_env)
        # Only verified snapshots can advance retention. No pruning follows failed dumps/uploads/restores.
        restic(['forget', '--tag', 'hatchkit-verified', '--keep-last', '3', '--group-by', '', '--prune'], project_env)
        return {'project': name, 'ok': True, 'snapshot': snapshot, 'bytes': archive.stat().st_size,
                'files': len(manifest['files']), 'verifiedAt': dt.datetime.now(dt.timezone.utc).isoformat()}


def read_status(projects, work):
    path = work / 'status.json'
    saved = json.loads(path.read_text()) if path.exists() else {'results': []}
    previous = {r['project']: r for r in saved['results']}
    results = []
    for project in projects:
        result = dict(previous.get(project['name'], {'project': project['name'], 'ok': False, 'state': 'never-run'}))
        verified = result.get('verifiedAt')
        result['stale'] = not verified or (dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(verified)).total_seconds() > 36 * 3600
        results.append(result)
    saved['results'] = results
    saved['healthy'] = bool(results) and all(r.get('ok') and not r['stale'] for r in results)
    return saved


def save_status(results, work):
    path = work / 'status.json'
    previous = json.loads(path.read_text())['results'] if path.exists() else []
    merged = {r['project']: r for r in previous}
    for result in results:
        old = merged.get(result['project'], {})
        if not result.get('ok') and old.get('verifiedAt'):
            result = {**result, 'verifiedAt': old['verifiedAt'], 'lastGoodSnapshot': old.get('snapshot', old.get('lastGoodSnapshot'))}
        merged[result['project']] = result
    status = {'finishedAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'results': list(merged.values())}
    temporary = work / 'status.json.tmp'
    temporary.write_text(json.dumps(status, indent=2) + '\n')
    temporary.replace(path)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['plan', 'init', 'run', 'status', 'sources'])
    parser.add_argument('--config', default='/etc/hatchkit-backups/config.json')
    parser.add_argument('--project')
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    projects = [validate_project(p) for p in config['projects']]
    if len({p['name'] for p in projects}) != len(projects):
        raise BackupError('Duplicate project name')
    if args.action == 'sources':
        # Claims are computed across every project, so a container another
        # project backs up is never offered as a replacement.
        rows = source_report(projects, containers())
        if args.project:
            if args.project not in {p['name'] for p in projects}:
                raise BackupError('Unknown project')
            rows = [r for r in rows if r['project'] == args.project]
        print(json.dumps({'sources': rows, 'stale': sum(r['state'] != 'ok' for r in rows)}, indent=2))
        return
    if args.project:
        projects = [p for p in projects if p['name'] == args.project]
        if not projects:
            raise BackupError('Unknown project')
    work = Path(config.get('workDir', '/var/lib/hatchkit-backups'))
    if args.action == 'plan':
        print(json.dumps({'repositoryBase': config['repositoryBase'], 'projects': projects}, indent=2))
        return
    if args.action == 'status':
        status = read_status(projects, work)
        status['timerEnabled'] = subprocess.run(['systemctl', 'is-enabled', '--quiet', 'hatchkit-backups.timer'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
        state = subprocess.run(['systemctl', 'show', '--property=ActiveState', '--value', 'hatchkit-backups.service'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout.decode().strip()
        status['running'] = state in ('active', 'activating')
        report = work / 'restore-check-all.json'
        alert_state = work / 'alerts-status.json'
        status['alerts'] = {'configured': bool(config.get('alerts', {}).get('enabled', bool(config.get('alerts')))),
                            'to': config.get('alerts', {}).get('to'),
                            'state': json.loads(alert_state.read_text()) if alert_state.exists() else None}
        status['alerts']['timerActive'] = subprocess.run(['systemctl', 'is-active', '--quiet', 'hatchkit-backup-alerts.timer'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
        status['alerts']['serviceFailed'] = subprocess.run(['systemctl', 'is-failed', '--quiet', 'hatchkit-backup-alerts.service'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
        status['restoreCheck'] = json.loads(report.read_text()) if report.exists() else None
        print(json.dumps(status, indent=2))
        return
    work.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (work / '.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        env = credential_env(config, work)
        inventory = containers() if args.action == 'run' else []
        results = []
        for project in projects:
            try:
                if args.action == 'init':
                    restic(['init'], {**env, 'RESTIC_REPOSITORY': config['repositoryBase'].rstrip('/') + '/' + project['name']})
                    result = {'project': project['name'], 'initialized': True}
                else:
                    if shutil.disk_usage(work).free < 2 * 1024**3:
                        raise BackupError('Less than 2 GiB free staging space')
                    result = backup_project(project, config, env, inventory, work)
            except Exception as error:
                result = {'project': project['name'], 'ok': False, 'error': str(error) if isinstance(error, BackupError) else type(error).__name__}
                if isinstance(error, SourceMissing):
                    result.update(state='source-missing', missingSources=error.sources)
            results.append(result)
            print(json.dumps(result), flush=True)
        if args.action == 'run':
            save_status(results, work)
        if any(r.get('ok') is False for r in results):
            sys.exit(1)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error) if isinstance(error, BackupError) else type(error).__name__}))
        sys.exit(1)
