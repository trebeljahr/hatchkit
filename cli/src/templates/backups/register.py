#!/usr/bin/env python3
"""Register, replace or deregister one explicit project's backup policy.

add      registers a new project and never replaces an existing policy.
replace  swaps a project's policy, only if the host still holds `expected`.
remove   drops a project from the schedule, only if the host still holds
         `expected`. Its restic repository and snapshots stay in the bucket.

`expected` is the policy the caller read before deciding on the change, so
two operators (or a hand edit on the host) can never silently overwrite each
other."""
import fcntl
import json
import os
from pathlib import Path
import sys
import runner

CONFIG = Path('/etc/hatchkit-backups/config.json')


def _locked(config_path, change):
    with config_path.with_name('.register.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        config = json.loads(config_path.read_text())
        result, write = change(config)
        if write:
            temporary = config_path.with_name('config.json.new')
            temporary.write_text(json.dumps(config, indent=2) + '\n')
            temporary.chmod(0o600)
            temporary.replace(config_path)
        return result


def _current(config, name, expected):
    existing = next((p for p in config['projects'] if p['name'] == name), None)
    if existing is None:
        raise runner.BackupError('Project is not registered on this host')
    if existing != expected:
        raise runner.BackupError('Host policy changed since it was read; re-run the command to review it')
    return existing


def register(project, config_path=CONFIG):
    runner.validate_project(project)

    def change(config):
        existing = next((p for p in config['projects'] if p['name'] == project['name']), None)
        if existing:
            if existing != project:
                raise runner.BackupError('Existing project policy differs; review it explicitly instead of replacing sources')
            return {'project': project['name'], 'registered': True, 'existing': True}, False
        work = Path(config.get('workDir', '/var/lib/hatchkit-backups'))
        env = runner.credential_env(config, work)
        env['RESTIC_REPOSITORY'] = config['repositoryBase'].rstrip('/') + '/' + project['name']
        try:
            runner.restic(['cat', 'config'], env)
        except runner.BackupError:
            # init refuses an existing repository. Network/auth failures never reset one.
            runner.restic(['init'], env)
        config['projects'].append(project)
        return {'project': project['name'], 'registered': True, 'existing': False}, True

    return _locked(config_path, change)


def replace(project, expected, config_path=CONFIG):
    runner.validate_project(project)

    def change(config):
        existing = _current(config, project['name'], expected)
        if existing == project:
            return {'project': project['name'], 'replaced': False, 'unchanged': True}, False
        config['projects'][config['projects'].index(existing)] = project
        return {'project': project['name'], 'replaced': True}, True

    return _locked(config_path, change)


def remove(name, expected, config_path=CONFIG):
    runner.valid_name(name)

    def change(config):
        config['projects'].remove(_current(config, name, expected))
        return {'project': name, 'deregistered': True, 'snapshotsKept': True}, True

    return _locked(config_path, change)


if __name__ == '__main__':
    os.umask(0o077)
    try:
        mode = sys.argv[1] if len(sys.argv) > 1 else 'add'
        payload = json.load(sys.stdin)
        if mode == 'add':
            result = register(payload)
        elif mode == 'replace':
            result = replace(payload['project'], payload['expected'])
        elif mode == 'remove':
            result = remove(payload['name'], payload['expected'])
        else:
            raise runner.BackupError('Unknown registration mode')
        print(json.dumps(result))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error) if isinstance(error, runner.BackupError) else type(error).__name__}))
        sys.exit(1)
