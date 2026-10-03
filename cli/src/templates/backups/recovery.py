#!/usr/bin/env python3
"""Select verified backups and retain an isolated native recovery, never cut over live data."""
import argparse
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import tempfile
import runner

spec = importlib.util.spec_from_file_location('restore_check', Path(__file__).with_name('restore-check.py'))
restore_check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restore_check)


def project_env(config, project):
    runner.valid_name(project)
    if not any(p['name'] == project for p in config['projects']):
        raise runner.BackupError('Unknown backup project')
    work = Path(config.get('workDir', '/var/lib/hatchkit-backups'))
    return {**runner.credential_env(config, work),
            'RESTIC_REPOSITORY': config['repositoryBase'].rstrip('/') + '/' + project}


def snapshots(env):
    values = json.loads(runner.restic(['snapshots', '--json', '--tag', 'hatchkit-verified'], env))
    # Do not expose repository paths, usernames, or unrelated restic metadata.
    result = []
    for item in values:
        if not re.fullmatch('[a-f0-9]{64}', item['id']):
            raise runner.BackupError('Invalid snapshot ID')
        result.append({'id': item['id'], 'time': item['time']})
    return sorted(result, key=lambda item: item['time'], reverse=True)


def choose_snapshot(values, snapshot):
    if not re.fullmatch('[a-f0-9]{8,64}', snapshot):
        raise runner.BackupError('Use a verified snapshot ID (8-64 hex characters)')
    matches = [item for item in values if item['id'].startswith(snapshot)]
    if len(matches) != 1:
        raise runner.BackupError('Snapshot is missing, unverified, or ambiguous')
    return matches[0]


def recover(config, project, snapshot, env):
    work = Path(config.get('workDir', '/var/lib/hatchkit-backups'))
    # Serialize with backup/pruning. The ID is rechecked while holding the lock.
    with (work / '.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        selected = choose_snapshot(snapshots(env), snapshot)
        root = work / 'recovery'
        root.mkdir(mode=0o700, exist_ok=True)
        destination = Path(tempfile.mkdtemp(prefix=project + '-', dir=root))
        report = {'project': project, 'snapshot': selected['id'], 'time': selected['time'],
                  'directory': str(destination), 'productionChanged': False,
                  'mode': 'isolated', 'ok': False, 'sources': []}
        try:
            archive = destination / 'project.tar'
            with archive.open('wb') as output:
                runner.run(['restic', 'dump', selected['id'], '/project.tar'], env=env, output=output, timeout=7200)
            data = destination / 'data'
            manifest = restore_check.unpack(archive, data)
            names = set()
            for source in manifest['sources']:
                name = runner.valid_name(source['name'])
                if name in names:
                    raise runner.BackupError('Duplicate recovery source')
                names.add(name)
            (destination / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
            for source in manifest['sources']:
                result = restore_check.restore_source(source, data / source['name'], retain=True)
                report['sources'].append({'name': source['name'], **result})
            report['ok'] = True
            report['nextStep'] = 'Inspect retained data; production cutover requires a separate reviewed plan.'
        except Exception as error:
            # Recovery may already contain successful engine imports. Keep their IDs and
            # files in the report, including failures, so cleanup is always reviewable.
            report['error'] = str(error) if isinstance(error, runner.BackupError) else type(error).__name__
        finally:
            report['cleanup'] = {
                'containers': [s['container'] for s in report['sources'] if 'container' in s],
                'directory': str(destination),
                'instructions': 'Remove only these recovery containers with docker rm -v, then remove this private recovery directory when no longer needed.'}
            (destination / 'recovery.json').write_text(json.dumps(report, indent=2) + '\n')
        return report


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['snapshots', 'restore'])
    parser.add_argument('--project', required=True)
    parser.add_argument('--snapshot')
    parser.add_argument('--config', default='/etc/hatchkit-backups/config.json')
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    env = project_env(config, args.project)
    if args.action == 'snapshots':
        print(json.dumps(snapshots(env)))
        return
    if not args.snapshot:
        parser.error('restore requires --snapshot')
    report = recover(config, args.project, args.snapshot, env)
    # A failed restore remains a structured result so callers can report the
    # private recovery directory rather than hide it behind SSH stderr.
    print(json.dumps(report))


if __name__ == '__main__':
    main()
