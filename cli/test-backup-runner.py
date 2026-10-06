import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import unittest
import sys
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('runner', Path(__file__).parent / 'src/templates/backups/runner.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
sys.modules['runner'] = runner
register_spec = importlib.util.spec_from_file_location('register', Path(__file__).parent / 'src/templates/backups/register.py')
register = importlib.util.module_from_spec(register_spec)
register_spec.loader.exec_module(register)


class BackupSafety(unittest.TestCase):
    def test_mongo_secrets_only_enter_child_stdin(self):
        container = {'Id': 'synthetic-mongo', 'Image': 'sha256:fixture', 'Config': {'Image': 'mongo:7'}}
        with tempfile.TemporaryDirectory() as temp, patch.object(runner, 'run') as command:
            runner.dump_database({'kind': 'mongo', 'selector': {'container': 'synthetic-mongo'}}, container, Path(temp))
            args, kwargs = command.call_args
            self.assertEqual(args[0], ['docker', 'exec', '-i', 'synthetic-mongo', 'mongosh', '--quiet', '--norc', '--file', '/dev/stdin'])
            self.assertEqual(kwargs['input'], runner.MONGO_DUMP_JS.encode())
            self.assertEqual(kwargs['timeout'], 660)
        self.assertNotIn('--password', runner.MONGO_DUMP_JS)
        self.assertIn('mongodump --config /dev/stdin --archive --gzip', runner.MONGO_DUMP_JS)
        self.assertIn('input: JSON.stringify({uri})', runner.MONGO_DUMP_JS)
        self.assertLess(runner.MONGO_DUMP_JS.index('await ready'), runner.MONGO_DUMP_JS.index('admin.fsyncLock()'))
        self.assertIn('if ((await admin.runCommand({currentOp: 1})).fsyncLock)', runner.MONGO_DUMP_JS)
        self.assertIn('if (released && watchdog)', runner.MONGO_DUMP_JS)

    def test_registration_preserves_existing_sources_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'config.json'
            old = {'name': 'existing', 'sources': [{'name': 'data', 'kind': 'files', 'paths': ['/srv/existing']}]}
            new = {'name': 'new', 'sources': [{'name': 'data', 'kind': 'files', 'paths': ['/srv/new']}]}
            config = {'projects': [old], 'repositoryBase': 's3:https://example.test/backups'}
            path.write_text(json.dumps(config))
            with patch.object(runner, 'credential_env', return_value={}), patch.object(runner, 'restic', return_value=b'{}'):
                self.assertFalse(register.register(new, path)['existing'])
                self.assertTrue(register.register(new, path)['existing'])
                self.assertEqual(json.loads(path.read_text())['projects'], [old, new])
                with self.assertRaises(runner.BackupError):
                    register.register({**old, 'sources': new['sources']}, path)
            before = path.read_text()
            with patch.object(runner, 'credential_env', return_value={}), patch.object(runner, 'restic', side_effect=runner.BackupError('unavailable')):
                with self.assertRaises(runner.BackupError):
                    register.register({**new, 'name': 'failed'}, path)
            self.assertEqual(path.read_text(), before)

    def test_partial_status_keeps_other_projects_and_reports_staleness(self):
        with tempfile.TemporaryDirectory() as temp:
            work = Path(temp)
            now = runner.dt.datetime.now(runner.dt.timezone.utc).isoformat()
            runner.save_status([{'project': 'a', 'ok': True, 'verifiedAt': now, 'snapshot': 'good'}, {'project': 'b', 'ok': True, 'verifiedAt': '2000-01-01T00:00:00+00:00'}], work)
            runner.save_status([{'project': 'a', 'ok': False, 'error': 'test failure'}], work)
            status = runner.read_status([{'name': 'a'}, {'name': 'b'}, {'name': 'c'}], work)
            self.assertFalse(status['healthy'])
            self.assertEqual(status['results'][0]['lastGoodSnapshot'], 'good')
            self.assertFalse(status['results'][0]['stale'])
            self.assertTrue(status['results'][1]['stale'])
            self.assertEqual(status['results'][2]['state'], 'never-run')

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

    def test_raw_database_files_require_native_dump_and_exclusion(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / 'data'
            (source / 'mariadb').mkdir(parents=True)
            (source / 'mariadb/ibdata1').write_bytes(b'live database pages')
            (source / 'settings.json').write_text('{}')
            with self.assertRaisesRegex(runner.BackupError, 'Raw database'):
                runner.copy_files([str(source)], root / 'unsafe')
            runner.copy_files([str(source)], root / 'safe', ['mariadb'])
            self.assertTrue((root / 'safe/0/settings.json').exists())
            self.assertFalse((root / 'safe/0/mariadb').exists())

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

    @staticmethod
    def container(cid, name, image, project=None, service=None, coolify_project=None, resource=None, env=()):
        labels = {'com.docker.compose.project': project, 'com.docker.compose.service': service,
                  'coolify.projectName': coolify_project, 'coolify.resourceName': resource}
        return {'Id': cid, 'Name': '/' + name, 'Config': {'Image': image, 'Env': list(env),
                'Labels': {k: v for k, v in labels.items() if v}}}

    def test_source_report_names_missing_sources_and_offers_unclaimed_same_engine(self):
        # mood-magic's compose app-mongo moved to a Coolify-managed mongo.
        # The image is pinned by ID, so the engine comes from image env names.
        moved = self.container('m1', 'gbbs', 'dce1a146801e', 'gbbs', 'gbbs', 'mood-magic', 'mood-magic-mongo', ['MONGO_VERSION=7', 'MONGO_INITDB_ROOT_PASSWORD=SECRET'])
        other = self.container('m2', 'r79p', 'mongo:7', 'r79p', 'r79p', 'broadcastdock', 'broadcastdock-mongo')
        cache = self.container('r1', 'hz02', 'redis:7.2', 'hz02', 'hz02', 'chess-app', 'chess-redis')
        projects = [
            {'name': 'mood-magic', 'sources': [{'name': 'app-mongo', 'kind': 'mongo', 'selector': {'project': 'old-compose', 'service': 'mongo'}}]},
            {'name': 'broadcastdock', 'sources': [{'name': 'standalone-mongo', 'kind': 'mongo', 'selector': {'project': 'r79p', 'service': 'r79p'}}]},
            {'name': 'chess-app', 'sources': [{'name': 'app-data', 'kind': 'files', 'paths': ['/srv/chess', '/srv/gone']}]},
        ]
        rows = runner.source_report(projects, [moved, other, cache], path_exists=lambda p: p == '/srv/chess')
        by = {r['project']: r for r in rows}
        self.assertEqual(by['broadcastdock']['state'], 'ok')
        self.assertEqual(by['broadcastdock']['container'], 'r79p')
        self.assertEqual(by['mood-magic']['state'], 'missing')
        # broadcastdock's mongo is claimed; the redis is the wrong engine.
        self.assertEqual([c['container'] for c in by['mood-magic']['candidates']], ['gbbs'])
        self.assertEqual(by['mood-magic']['candidates'][0]['selector'], {'project': 'gbbs', 'service': 'gbbs'})
        self.assertEqual(by['mood-magic']['candidates'][0]['coolifyProject'], 'mood-magic')
        self.assertNotIn('SECRET', json.dumps(rows))
        self.assertEqual(by['chess-app']['state'], 'missing')
        self.assertEqual(by['chess-app']['missingPaths'], ['/srv/gone'])
        ambiguous = runner.source_report([{'name': 'x', 'sources': [{'name': 'db', 'kind': 'redis', 'selector': {'project': 'p'}}]}],
                                         [self.container('a', 'a', 'redis', 'p', 'a'), self.container('b', 'b', 'redis', 'p', 'b')])
        self.assertEqual((ambiguous[0]['state'], ambiguous[0]['matches']), ('ambiguous', 2))

    def test_missing_source_fails_the_project_by_name_before_any_capture(self):
        project = {'name': 'chess-app', 'sources': [
            {'name': 'app-data', 'kind': 'files', 'paths': ['/']},
            {'name': 'app-redis', 'kind': 'redis', 'selector': {'project': 'gone', 'service': 'redis'}}]}
        with tempfile.TemporaryDirectory() as temp:
            project['sources'][0]['paths'] = [temp]
            with patch.object(runner, 'restic') as restic, patch.object(runner, 'dump_database') as dump:
                with self.assertRaises(runner.SourceMissing) as caught:
                    runner.backup_project(project, {'repositoryBase': 's3:https://example.test/b'}, {}, [], Path(temp))
            restic.assert_not_called()
            dump.assert_not_called()
        self.assertEqual(caught.exception.sources, ['app-redis'])
        self.assertIn('hatchkit backup sources --project chess-app', str(caught.exception))

    def test_policy_replace_and_remove_require_the_policy_that_was_read(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'config.json'
            keep = {'name': 'keep', 'sources': [{'name': 'data', 'kind': 'files', 'paths': ['/srv/keep']}]}
            old = {'name': 'app', 'sources': [{'name': 'mongo', 'kind': 'mongo', 'selector': {'project': 'a', 'service': 'a'}},
                                              {'name': 'redis', 'kind': 'redis', 'selector': {'project': 'b', 'service': 'b'}}]}
            path.write_text(json.dumps({'projects': [keep, old]}))
            new = {**old, 'sources': old['sources'][:1]}
            with self.assertRaisesRegex(runner.BackupError, 'changed since'):
                register.replace(new, {**old, 'sources': []}, path)
            self.assertTrue(register.replace(new, old, path)['replaced'])
            self.assertEqual(json.loads(path.read_text())['projects'], [keep, new])
            self.assertTrue(register.replace(new, new, path)['unchanged'])
            with self.assertRaisesRegex(runner.BackupError, 'changed since'):
                register.remove('app', old, path)
            self.assertTrue(register.remove('app', new, path)['snapshotsKept'])
            self.assertEqual(json.loads(path.read_text())['projects'], [keep])
            with self.assertRaisesRegex(runner.BackupError, 'not registered'):
                register.remove('app', new, path)


if __name__ == '__main__':
    unittest.main()
