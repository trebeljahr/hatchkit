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
        if source['kind'] not in ('postgres', 'mongo', 'clickhouse', 'redis', 'files'):
            raise BackupError('Unsupported source kind')
        if source['kind'] == 'files':
            if not source.get('paths') or any(not Path(p).is_absolute() or os.path.normpath(p) == '/' or Path(p).resolve() == Path('/') for p in source['paths']):
                raise BackupError('File sources require explicit absolute paths, never /')
        elif not source.get('selector'):
            raise BackupError('Database sources require an exact container selector')
    return project


def containers():
    ids = run(['docker', 'ps', '-q']).decode().split()
    return json.loads(run(['docker', 'inspect', *ids])) if ids else []


def resolve_container(selector, inventory):
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
    if len(matches) != 1:
        raise BackupError(f'Source selector matches {len(matches)} running containers; expected one')
    return matches[0]


def docker_shell(container, script, output=None, timeout=1800):
    return run(['docker', 'exec', container['Id'], 'sh', '-ec', script], output=output, timeout=timeout)


MONGO_AUTH = '''set --
if [ -n "${MONGO_INITDB_ROOT_USERNAME:-}" ]; then
  set -- --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin
fi
'''


def dump_database(source, container, destination):
    kind = source['kind']
    metadata = {'kind': kind, 'image': container['Config']['Image'], 'selector': source['selector']}
    if kind == 'postgres':
        with (destination / 'cluster.sql').open('wb') as output:
            docker_shell(container, 'export PGPASSWORD="${POSTGRES_PASSWORD:-}"; exec pg_dumpall -U "${POSTGRES_USER:-postgres}"', output)
        metadata['format'] = 'pg_dumpall SQL (all databases and roles)'
    elif kind == 'mongo':
        # A standalone MongoDB has no oplog snapshot. Lock writes only during its
        # dump, and install a bounded watchdog before locking, including on timeout.
        script = MONGO_AUTH + '''
unlock() { mongosh "$@" --quiet --eval 'db.getSiblingDB("admin").fsyncUnlock()' >/dev/null; }
(sleep 600; unlock "$@") >/dev/null 2>&1 & watchdog=$!
trap 'rc=$?; if unlock "$@"; then kill "$watchdog" 2>/dev/null || true; else rc=1; fi; exit "$rc"' EXIT HUP INT TERM
mongosh "$@" --quiet --eval 'db.getSiblingDB("admin").fsyncLock()' >/dev/null
timeout 540 mongodump "$@" --archive --gzip
'''
        with (destination / 'mongo.archive.gz').open('wb') as output:
            docker_shell(container, script, output, timeout=660)
        metadata['format'] = 'mongodump archive+gzip; writes locked during dump'
    elif kind == 'clickhouse':
        filename = f'hatchkit-{uuid.uuid4().hex}.zip'
        backup_path = f'backups/{filename}'
        query = f"BACKUP ALL TO File('{backup_path}')"
        auth = 'set --; if [ -n "${CLICKHOUSE_USER:-}" ]; then set -- --user "$CLICKHOUSE_USER" --password "${CLICKHOUSE_PASSWORD:-}"; fi; '
        try:
            docker_shell(container, auth + 'clickhouse-client "$@" --query ' + shell_quote(query))
            # ClickHouse resolves a relative File path from its server working directory.
            paths = ['/var/lib/clickhouse/' + backup_path, '/' + backup_path]
            for path in paths:
                probe = subprocess.run(['docker', 'exec', container['Id'], 'test', '-f', path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if probe.returncode == 0:
                    run(['docker', 'cp', f"{container['Id']}:{path}", str(destination / 'clickhouse.zip')])
                    metadata['format'] = 'ClickHouse native BACKUP ALL zip'
                    break
            else:
                raise BackupError('ClickHouse completed but its archive could not be found')
        finally:
            docker_shell(container, 'rm -f ' + ' '.join(shell_quote(p) for p in ['/var/lib/clickhouse/' + backup_path, '/' + backup_path]))
    elif kind == 'redis':
        path = f'/tmp/hatchkit-{uuid.uuid4().hex}.rdb'
        try:
            docker_shell(container, 'export REDISCLI_AUTH="${REDIS_PASSWORD:-}"; redis-cli --rdb ' + shell_quote(path))
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


def copy_files(paths, destination):
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
            for name in dirs[:]:
                p = Path(current) / name
                target = root / rel / name
                if p.is_symlink():
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.symlink_to(os.readlink(p))
                    dirs.remove(name)
                else:
                    target.mkdir(parents=True, exist_ok=True)
            for name in files:
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


def backup_project(project, config, env, inventory, work):
    validate_project(project)
    name = project['name']
    project_env = {**env, 'RESTIC_REPOSITORY': config['repositoryBase'].rstrip('/') + '/' + name}
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
                copy_files(source['paths'], dest)
                metadata.append({'name': source['name'], 'kind': 'files', 'paths': source['paths']})
            else:
                item = dump_database(source, resolve_container(source['selector'], inventory), dest)
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


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['plan', 'init', 'run', 'status'])
    parser.add_argument('--config', default='/etc/hatchkit-backups/config.json')
    parser.add_argument('--project')
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    projects = [validate_project(p) for p in config['projects']]
    if len({p['name'] for p in projects}) != len(projects):
        raise BackupError('Duplicate project name')
    if args.project:
        projects = [p for p in projects if p['name'] == args.project]
        if not projects:
            raise BackupError('Unknown project')
    work = Path(config.get('workDir', '/var/lib/hatchkit-backups'))
    if args.action == 'plan':
        print(json.dumps({'repositoryBase': config['repositoryBase'], 'projects': projects}, indent=2))
        return
    if args.action == 'status':
        status = work / 'status.json'
        print(status.read_text() if status.exists() else '{"state":"never-run"}')
        return
    work.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (work / '.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        credentials_path = Path(config['credentialsFile'])
        password_path = Path(config['passwordFile'])
        for path in (credentials_path, password_path):
            if path.stat().st_mode & 0o077:
                raise BackupError('Credential files must be readable only by their owner')
        credentials = json.loads(credentials_path.read_text())
        env = {**os.environ, 'AWS_ACCESS_KEY_ID': credentials['accessKeyId'],
               'AWS_SECRET_ACCESS_KEY': credentials['secretAccessKey'], 'AWS_DEFAULT_REGION': 'auto',
               'RESTIC_PASSWORD_FILE': str(password_path), 'GOMAXPROCS': '2',
               'RESTIC_CACHE_DIR': str(work / 'cache')}
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
            results.append(result)
            print(json.dumps(result), flush=True)
        if args.action == 'run':
            status = {'finishedAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'results': results}
            temporary = work / 'status.json.tmp'
            temporary.write_text(json.dumps(status, indent=2) + '\n')
            temporary.replace(work / 'status.json')
        if any(r.get('ok') is False for r in results):
            sys.exit(1)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error) if isinstance(error, BackupError) else type(error).__name__}))
        sys.exit(1)
