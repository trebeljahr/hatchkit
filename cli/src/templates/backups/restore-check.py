#!/usr/bin/env python3
"""Restore downloaded backups into disposable, network-isolated engine containers."""
import argparse
import datetime as dt
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile
import time
import uuid
import runner


def unpack(archive, destination):
    # Do not follow archived symlinks or allow absolute/parent paths during a drill.
    with tarfile.open(archive) as tar:
        members = {m.name.removeprefix('./'): m for m in tar.getmembers()}
        manifest = json.load(tar.extractfile(members['manifest.json']))
        for name, expected in manifest['files'].items():
            path = PurePosixPath(name)
            if path.is_absolute() or '..' in path.parts or not members[name].isfile():
                raise runner.BackupError('Unsafe archive member')
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with tar.extractfile(members[name]) as source, target.open('wb') as output:
                shutil.copyfileobj(source, output)
            if target.stat().st_size != expected['size'] or runner.sha256(target) != expected['sha256']:
                raise runner.BackupError('Archive manifest checksum mismatch')
        return manifest


def docker(*args, **kwargs):
    return runner.run(['docker', *args], **kwargs)


def wait_ready(name, command):
    for _ in range(90):
        try:
            result = subprocess.run(['docker', 'exec', name, *command], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
        except subprocess.TimeoutExpired:
            continue
        if result.returncode == 0:
            return
        state = docker('inspect', '--format', '{{.State.Running}}', name).decode().strip()
        if state != 'true':
            raise runner.BackupError('Isolated restore container stopped during startup')
        time.sleep(1)
    raise runner.BackupError('Isolated restore container readiness timed out')


def restore_source(source, directory):
    kind = source['kind']
    if kind == 'files':
        checked = 0
        for path in directory.rglob('*'):
            if not path.is_file():
                continue
            with path.open('rb') as stream:
                if stream.read(16) != b'SQLite format 3\0':
                    continue
            db = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)
            try:
                if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                    raise runner.BackupError('Restored SQLite database failed integrity check')
            finally:
                db.close()
            checked += 1
        return {'kind': kind, 'sqliteDatabases': checked, 'checksums': 'passed'}
    image = source.get('imageId', source['image'])
    # inspect refuses to fetch an image. Never pull a replacement during a drill.
    docker('image', 'inspect', image)
    name = 'hatchkit-restore-' + uuid.uuid4().hex[:16]
    admin = 'restore_' + uuid.uuid4().hex[:12]
    common = ['create', '--name', name, '--network', 'none', '--memory', '768m', '--cpus', '0.5', '--pids-limit', '512', '--label', 'hatchkit.restore-check=true']
    try:
        if kind == 'postgres':
            docker(*common, '-e', 'POSTGRES_USER=' + admin, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', image)
            docker('start', name)
            wait_ready(name, ['pg_isready', '-h', '127.0.0.1', '-U', admin])
            with (directory / 'cluster.sql').open('rb') as stream:
                docker('exec', '-i', name, 'psql', '-U', admin, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', stdin=stream)
            docker('exec', name, 'psql', '-U', admin, '-d', 'postgres', '-Atc', 'SELECT count(*) FROM pg_database')
        elif kind == 'mongo':
            docker(*common, image, 'mongod', '--bind_ip', '127.0.0.1', '--wiredTigerCacheSizeGB', '0.25')
            docker('start', name)
            wait_ready(name, ['mongosh', '--quiet', '--eval', 'quit(db.adminCommand({ping:1}).ok ? 0 : 1)'])
            with (directory / 'mongo.archive.gz').open('rb') as stream:
                docker('exec', '-i', name, 'mongorestore', '--archive', '--gzip', '--drop', stdin=stream)
        elif kind == 'kuma-mariadb':
            script = 'mkdir /tmp/restore-db; mariadb-install-db --no-defaults --datadir=/tmp/restore-db --auth-root-authentication-method=normal --skip-test-db --user=root >/dev/null; exec mariadbd --no-defaults --user=root --datadir=/tmp/restore-db --socket=/tmp/restore.sock --pid-file=/tmp/restore.pid --skip-networking --innodb-buffer-pool-size=64M'
            docker(*common, '--user', '0', '--entrypoint', 'sh', image, '-ec', script)
            docker('start', name)
            wait_ready(name, ['mariadb-admin', '--no-defaults', '--socket=/tmp/restore.sock', '-uroot', 'ping'])
            with (directory / 'mariadb.sql').open('rb') as stream:
                docker('exec', '-i', name, 'mariadb', '--no-defaults', '--socket=/tmp/restore.sock', '-uroot', stdin=stream)
            count = docker('exec', name, 'mariadb', '--no-defaults', '--socket=/tmp/restore.sock', '-uroot', '-N', '-e', "SELECT count(*) FROM information_schema.tables WHERE table_schema='kuma'")
            if int(count.strip()) == 0:
                raise runner.BackupError('Restored Kuma database has no tables')
        elif kind == 'redis':
            docker(*common, image, 'redis-server', '--appendonly', 'no', '--save', '', '--bind', '127.0.0.1')
            docker('cp', str(directory / 'redis.rdb'), name + ':/data/dump.rdb')
            docker('start', name)
            wait_ready(name, ['redis-cli', 'ping'])
            docker('exec', name, 'redis-cli', 'info', 'keyspace')
        elif kind == 'clickhouse':
            # Cap background pools for the small production host; no production mounts.
            config = directory / 'restore.xml'
            config.write_text('<clickhouse><backups><allowed_path>/backups/</allowed_path></backups><background_pool_size>4</background_pool_size><background_schedule_pool_size>4</background_schedule_pool_size><background_message_broker_schedule_pool_size>2</background_message_broker_schedule_pool_size><background_distributed_schedule_pool_size>2</background_distributed_schedule_pool_size><max_thread_pool_size>1024</max_thread_pool_size><backups_io_thread_pool_size>2</backups_io_thread_pool_size><merge_tree><number_of_free_entries_in_pool_to_execute_mutation>2</number_of_free_entries_in_pool_to_execute_mutation><number_of_free_entries_in_pool_to_lower_max_size_of_merge>2</number_of_free_entries_in_pool_to_lower_max_size_of_merge><number_of_free_entries_in_pool_to_execute_optimize_entire_partition>2</number_of_free_entries_in_pool_to_execute_optimize_entire_partition></merge_tree></clickhouse>')
            config.chmod(0o644)
            # A rootless engine needs read access to only this isolated archive directory.
            directory.chmod(0o755)
            (directory / 'clickhouse.zip').chmod(0o644)
            docker(*common, '-e', 'CLICKHOUSE_SKIP_USER_SETUP=1', '-v', str(directory) + ':/backups:ro', '-v', str(config) + ':/etc/clickhouse-server/config.d/restore.xml:ro', image)
            docker('start', name)
            wait_ready(name, ['clickhouse-client', '--receive_timeout', '5', '--query', 'SELECT 1'])
            docker('exec', name, 'clickhouse-client', '--query', "RESTORE ALL FROM File('/backups/clickhouse.zip')", timeout=300)
            docker('exec', name, 'clickhouse-client', '--query', 'SELECT count() FROM system.tables WHERE database NOT IN (\'system\', \'INFORMATION_SCHEMA\', \'information_schema\')')
        else:
            raise runner.BackupError('Unsupported restore engine')
        return {'kind': kind, 'image': source['image'], 'nativeRestore': 'passed'}
    finally:
        subprocess.run(['docker', 'rm', '-f', '-v', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', default='/etc/hatchkit-backups/config.json')
    parser.add_argument('--project')
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    work = Path(config.get('workDir', '/var/lib/hatchkit-backups'))
    env = runner.credential_env(config, work)
    results = []
    for project in config['projects']:
        if args.project and project['name'] != args.project:
            continue
        result = {'project': project['name'], 'ok': False}
        try:
            project_env = {**env, 'RESTIC_REPOSITORY': config['repositoryBase'].rstrip('/') + '/' + project['name']}
            snapshots = json.loads(runner.restic(['snapshots', '--json', '--tag', 'hatchkit-verified'], project_env))
            snapshot = max(snapshots, key=lambda s: s['time'])['id']
            result['snapshot'] = snapshot
            with tempfile.TemporaryDirectory(prefix='restore-check-', dir=work) as temp:
                temp = Path(temp)
                archive = temp / 'project.tar'
                with archive.open('wb') as output:
                    runner.run(['restic', 'dump', snapshot, '/project.tar'], env=project_env, output=output)
                manifest = unpack(archive, temp / 'data')
                result['sources'] = []
                for source in manifest['sources']:
                    result['checking'] = source['name']
                    result['sources'].append({'name': source['name'], **restore_source(source, temp / 'data' / source['name'])})
                result.pop('checking', None)
                result['ok'] = True
        except Exception as error:
            result['error'] = str(error) if isinstance(error, runner.BackupError) else type(error).__name__
        result['checkedAt'] = dt.datetime.now(dt.timezone.utc).isoformat()
        results.append(result)
        print(json.dumps(result), flush=True)
        combined_path = work / 'restore-check-all.json'
        previous = json.loads(combined_path.read_text())['results'] if combined_path.exists() else []
        merged = {r['project']: r for r in previous}
        merged[project['name']] = result
        temporary = work / 'restore-check-all.json.tmp'
        temporary.write_text(json.dumps({'checkedAt': result['checkedAt'], 'results': list(merged.values())}, indent=2) + '\n')
        temporary.replace(combined_path)
    report = {'checkedAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'results': results}
    report_path = work / ('restore-check-' + (args.project or 'all') + '.json')
    if args.project:
        report_path.write_text(json.dumps(report, indent=2) + '\n')
    if not results or not all(r['ok'] for r in results):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
