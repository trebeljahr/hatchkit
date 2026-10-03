import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('runner', Path(__file__).parent / 'src/templates/backups/runner.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class BackupSafety(unittest.TestCase):
    @unittest.skipUnless(shutil.which('restic'), 'restic binary not installed')
    def test_real_encryption_restore_and_rolling_retention(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / 'value.txt'
            password = root / 'test-password'
            password.write_text('isolated-test-password')
            env = {**os.environ, 'RESTIC_PASSWORD_FILE': str(password), 'GOMAXPROCS': '2',
                   'RESTIC_CACHE_DIR': str(root / 'cache'), 'RESTIC_REPOSITORY': str(root / 'repo/app')}
            runner.restic(['init'], env)
            project = {'name': 'app', 'sources': [{'name': 'data', 'kind': 'files', 'paths': [str(source)]}]}
            config = {'repositoryBase': str(root / 'repo')}
            for i in range(4):
                if i == 3:
                    # An unverified upload from a failed run must not count
                    # toward retention or displace a verified recovery point.
                    runner.run(['restic', 'backup', '--stdin', '--stdin-filename', 'project.tar', '--tag', 'hatchkit-pending'],
                               env=env, input=b'unverified upload')
                source.write_text('generation ' + str(i))
                self.assertTrue(runner.backup_project(project, config, env, [], root)['ok'])
            snapshots = json.loads(runner.restic(['snapshots', '--json'], env))
            self.assertEqual(len(snapshots), 3)
            self.assertTrue(all('hatchkit-verified' in s['tags'] for s in snapshots))
            runner.restic(['check', '--read-data'], env)
            bad_env = {**env, 'RESTIC_PASSWORD': 'incorrect', 'RESTIC_PASSWORD_FILE': ''}
            with self.assertRaises(runner.BackupError):
                runner.restic(['snapshots', '--json'], bad_env)

    def test_sqlite_committed_wal_is_in_restorable_copy(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / 'source'
            source.mkdir()
            db = sqlite3.connect(source / 'app.db')
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE records (value TEXT)')
            db.execute("INSERT INTO records VALUES ('kept')")
            db.commit()
            self.assertTrue((source / 'app.db-wal').exists())
            runner.copy_files([str(source)], root / 'backup')
            restored = sqlite3.connect(root / 'backup/0/app.db')
            self.assertEqual(restored.execute('SELECT value FROM records').fetchone(), ('kept',))
            self.assertEqual(restored.execute('PRAGMA integrity_check').fetchone(), ('ok',))
            self.assertFalse((root / 'backup/0/app.db-wal').exists())
            restored.close()
            db.close()

    def exercise_backup(self, *, corrupt=False, missing=False):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            data = root / 'app.txt'
            if not missing:
                data.write_text('data that must survive')
            project = {'name': 'example', 'sources': [{'name': 'files', 'kind': 'files', 'paths': [str(data)]}]}
            config = {'repositoryBase': 's3:https://example.test/backups'}
            events = []
            captured = b''
            real_run = runner.run
            def fake_run(argv, **kw):
                nonlocal captured
                if argv[0] != 'restic':
                    return real_run(argv, **kw)
                action = argv[1]
                events.append(action)
                if action == 'backup':
                    captured = kw['stdin'].read()
                    return b'{"message_type":"summary","snapshot_id":"abc123"}\n'
                if action == 'dump':
                    kw['output'].write(b'corruption' if corrupt else captured)
                    return None
                raise AssertionError(argv)
            def fake_restic(argv, env):
                events.append(argv[0])
                if argv[:3] == ['snapshots', '--json', '--tag']:
                    if argv[3] == 'hatchkit-pending':
                        return b'[]'
                    return b'[{"id":"verified123","tags":["hatchkit-verified"]}]'
                if argv[0] == 'forget':
                    self.assertEqual(argv, ['forget', '--tag', 'hatchkit-verified', '--keep-last', '3', '--group-by', '', '--prune'])
                    self.assertIn('dump', events[:-1])
                return b'{}'
            with patch.object(runner, 'run', fake_run), patch.object(runner, 'restic', fake_restic):
                if corrupt or missing:
                    with self.assertRaises(runner.BackupError):
                        runner.backup_project(project, config, {}, [], root)
                    self.assertNotIn('forget', events)
                else:
                    result = runner.backup_project(project, config, {}, [], root)
                    self.assertTrue(result['ok'])
                    self.assertEqual(events, ['cat', 'backup', 'dump', 'tag', 'snapshots', 'snapshots', 'forget'])

    def test_verified_backup_advances_three_snapshot_policy(self):
        self.exercise_backup()

    def test_corrupt_download_keeps_old_generations(self):
        self.exercise_backup(corrupt=True)

    def test_missing_source_keeps_old_generations(self):
        self.exercise_backup(missing=True)

    def test_ambiguous_container_is_not_guessed(self):
        c = {'Id': 'a', 'Name': '/mongo-a', 'Config': {'Labels': {'com.docker.compose.project': 'app'}}}
        with self.assertRaises(runner.BackupError):
            runner.resolve_container({'project': 'app'}, [c, c])

    def test_unsafe_names_and_duplicate_sources_fail(self):
        with self.assertRaises(runner.BackupError):
            runner.valid_name('../other-project')
        with self.assertRaises(runner.BackupError):
            runner.validate_project({'name': 'app', 'sources': [{'name': 'data', 'kind': 'files', 'paths': ['/']}]})
        with self.assertRaises(runner.BackupError):
            runner.validate_project({'name': 'app', 'sources': [{'name': 'data', 'kind': 'files', 'paths': ['/var/..']}]})


if __name__ == '__main__':
    unittest.main()
