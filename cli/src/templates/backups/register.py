#!/usr/bin/env python3
"""Register one explicit project without replacing an existing backup policy."""
import fcntl
import json
import os
from pathlib import Path
import sys
import runner


def register(project, config_path=Path('/etc/hatchkit-backups/config.json')):
    runner.validate_project(project)
    with config_path.with_name('.register.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        config = json.loads(config_path.read_text())
        existing = next((p for p in config['projects'] if p['name'] == project['name']), None)
        if existing:
            if existing != project:
                raise runner.BackupError('Existing project policy differs; review it explicitly instead of replacing sources')
            return {'project': project['name'], 'registered': True, 'existing': True}
        work = Path(config.get('workDir', '/var/lib/hatchkit-backups'))
        env = runner.credential_env(config, work)
        env['RESTIC_REPOSITORY'] = config['repositoryBase'].rstrip('/') + '/' + project['name']
        try:
            runner.restic(['cat', 'config'], env)
        except runner.BackupError:
            # init refuses an existing repository. Network/auth failures never reset one.
            runner.restic(['init'], env)
        config['projects'].append(project)
        temporary = config_path.with_name('config.json.new')
        temporary.write_text(json.dumps(config, indent=2) + '\n')
        temporary.chmod(0o600)
        temporary.replace(config_path)
        return {'project': project['name'], 'registered': True, 'existing': False}


if __name__ == '__main__':
    os.umask(0o077)
    try:
        print(json.dumps(register(json.load(sys.stdin))))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error) if isinstance(error, runner.BackupError) else type(error).__name__}))
        sys.exit(1)
