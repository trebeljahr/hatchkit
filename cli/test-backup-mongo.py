"""Opt-in isolated native Mongo proof: HATCHKIT_TEST_MONGO_IMAGE=mongo:7 python3 cli/test-backup-mongo.py."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
import uuid

spec = importlib.util.spec_from_file_location('runner', Path(__file__).parent / 'src/templates/backups/runner.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


@unittest.skipUnless(os.environ.get('HATCHKIT_TEST_MONGO_IMAGE'), 'explicit pre-existing synthetic test image required')
class MongoStdinBackup(unittest.TestCase):
    def test_authenticated_all_database_dump_restores_users_indexes_and_data(self):
        image = os.environ['HATCHKIT_TEST_MONGO_IMAGE']
        runner.run(['docker', 'image', 'inspect', image])
        source = 'hatchkit-mongo-proof-' + uuid.uuid4().hex[:12]
        restored = source + '-restore'

        def docker(*args, **kwargs):
            return runner.run(['docker', *args], timeout=60, **kwargs)

        def shell(name, script, auth=False):
            code = (runner.MONGO_AUTH_JS if auth else '') + script
            return docker('exec', '-i', name, 'mongosh', '--quiet', '--norc', '--file', '/dev/stdin', input=code.encode())

        def ready(name, auth=False):
            for _ in range(100):
                try:
                    shell(name, 'if(!db.adminCommand({ping:1}).ok) quit(1);', auth)
                    return
                except runner.BackupError:
                    time.sleep(0.1)
            self.fail('Synthetic Mongo did not become ready')

        common = ['--detach', '--pull=never', '--network', 'none', '--memory', '768m', '--cpus', '0.5']
        try:
            # These credentials are deliberately synthetic and isolated.
            docker('run', *common, '--name', source, '-e', 'MONGO_INITDB_ROOT_USERNAME=synthetic',
                   '-e', 'MONGO_INITDB_ROOT_PASSWORD=synthetic-proof-password', image,
                   'mongod', '--wiredTigerCacheSizeGB', '0.25')
            ready(source, True)
            shell(source, 'db.getSiblingDB("test").records.insertOne({_id:"kept",value:1}); db.getSiblingDB("other").records.insertOne({_id:"also-kept",value:2}); db.getSiblingDB("test").records.createIndex({value:1},{unique:true});', True)
            container = json.loads(docker('inspect', source))[0]
            with tempfile.TemporaryDirectory(prefix='hatchkit-mongo-archive-') as temp:
                directory = Path(temp)
                runner.dump_database({'kind': 'mongo', 'selector': {'container': source}}, container, directory)
                locked = json.loads(shell(source, 'print(JSON.stringify({locked:Boolean(admin.runCommand({currentOp:1}).fsyncLock)}));', True))
                self.assertFalse(locked['locked'])
                docker('stop', source)
                docker('run', *common, '--name', restored, image, 'mongod', '--bind_ip', '127.0.0.1', '--wiredTigerCacheSizeGB', '0.25')
                ready(restored)
                with (directory / 'mongo.archive.gz').open('rb') as stream:
                    docker('exec', '-i', restored, 'mongorestore', '--archive', '--gzip', stdin=stream)
                report = json.loads(shell(restored, 'print(JSON.stringify({test:db.getSiblingDB("test").records.countDocuments({}),other:db.getSiblingDB("other").records.countDocuments({}),indexes:db.getSiblingDB("test").records.getIndexes().length,users:db.getSiblingDB("admin").system.users.countDocuments({})}));'))
                self.assertEqual(report, {'test': 1, 'other': 1, 'indexes': 2, 'users': 1})
        finally:
            for name in (source, restored):
                subprocess.run(['docker', 'rm', '-f', '-v', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == '__main__':
    unittest.main()
