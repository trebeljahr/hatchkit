import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

base = Path(__file__).parent / 'src/templates/backups'
sys.path.insert(0, str(base))
import runner
spec = importlib.util.spec_from_file_location('recovery', base / 'recovery.py')
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)


def make_archive(path, invalid=False):
    content = b'hello'
    import hashlib
    manifest = {'sources': [{'name': 'uploads', 'kind': 'files'}],
                'files': {'uploads/file.txt': {'size': len(content), 'sha256': 'bad' if invalid else hashlib.sha256(content).hexdigest()}}}
    with tarfile.open(path, 'w') as archive:
        for name, value in [('manifest.json', json.dumps(manifest).encode()), ('uploads/file.txt', content)]:
            item = tarfile.TarInfo(name)
            item.size = len(value)
            archive.addfile(item, io.BytesIO(value))


class RecoverySafety(unittest.TestCase):
    def test_selection_and_verified_listing(self):
        values = [{'id': 'a' * 64, 'time': '2026-10-01'}, {'id': 'b' * 64, 'time': '2026-10-02'}]
        with patch.object(runner, 'restic', return_value=json.dumps(values).encode()) as restic:
            self.assertEqual(recovery.snapshots({})[0]['id'], 'b' * 64)
            self.assertIn('hatchkit-verified', restic.call_args.args[0])
        self.assertEqual(recovery.choose_snapshot(values, 'aaaaaaaa')['id'], 'a' * 64)
        for value in ['latest', '../bad', 'cccccccc', 'a;bad']:
            with self.assertRaises(runner.BackupError):
                recovery.choose_snapshot(values, value)
        with self.assertRaises(runner.BackupError):
            recovery.choose_snapshot(values + [values[0]], 'aaaaaaaa')

    def test_unknown_project_rejected_before_credentials(self):
        with patch.object(runner, 'credential_env') as credentials:
            with self.assertRaises(runner.BackupError):
                recovery.project_env({'projects': [{'name': 'known'}]}, 'unknown')
            credentials.assert_not_called()

    def test_retained_files_private_report_and_failed_checksum(self):
        old_mask = os.umask(0o077)
        try:
            for invalid in [False, True]:
                with tempfile.TemporaryDirectory() as temp:
                    root = Path(temp)
                    archive = root / 'fixture.tar'
                    make_archive(archive, invalid)
                    def dump(argv, **kwargs):
                        self.assertEqual(argv[:2], ['restic', 'dump'])
                        kwargs['output'].write(archive.read_bytes())
                    with patch.object(recovery, 'snapshots', return_value=[{'id': 'a' * 64, 'time': '2026-10-04'}]), patch.object(runner, 'run', side_effect=dump):
                        report = recovery.recover({'workDir': temp}, 'app', 'aaaaaaaa', {})
                    self.assertEqual(report['ok'], not invalid)
                    self.assertFalse(report['productionChanged'])
                    directory = Path(report['directory'])
                    self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
                    self.assertEqual(json.loads((directory / 'recovery.json').read_text()), report)
                    self.assertTrue((directory / 'project.tar').exists())
        finally:
            os.umask(old_mask)

    def test_retained_native_stopped_and_failed_native_removed(self):
        restore = recovery.restore_check
        for fail in [False, True]:
            with tempfile.TemporaryDirectory() as temp:
                directory = Path(temp)
                (directory / 'redis.rdb').write_bytes(b'fixture')
                def docker(*args, **kwargs):
                    if fail and args[0] == 'start':
                        raise runner.BackupError('fixture failure')
                    return b''
                with patch.object(restore, 'docker', side_effect=docker) as calls, patch.object(restore, 'wait_ready'), patch.object(restore.subprocess, 'run') as cleanup:
                    if fail:
                        with self.assertRaises(runner.BackupError):
                            restore.restore_source({'kind': 'redis', 'image': 'fixture'}, directory, retain=True)
                        cleanup.assert_called_once()
                    else:
                        result = restore.restore_source({'kind': 'redis', 'image': 'fixture'}, directory, retain=True)
                        self.assertEqual(result['state'], 'stopped')
                        self.assertTrue(result['container'].startswith('hatchkit-restore-'))
                        self.assertIn(('stop', result['container']), [call.args for call in calls.call_args_list])
                        cleanup.assert_not_called()
                        create = next(call.args for call in calls.call_args_list if call.args[0] == 'create')
                        self.assertIn('none', create)
                        self.assertNotIn('-p', create)

    def test_partial_failure_keeps_cleanup_ids(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            archive = root / 'fixture.tar'
            make_archive(archive)
            manifest = {'sources': [{'name': 'first', 'kind': 'redis'}, {'name': 'second', 'kind': 'redis'}]}
            def dump(argv, **kwargs):
                kwargs['output'].write(archive.read_bytes())
            with patch.object(recovery, 'snapshots', return_value=[{'id': 'a' * 64, 'time': '2026-10-04'}]), patch.object(runner, 'run', side_effect=dump), patch.object(recovery.restore_check, 'unpack', return_value=manifest), patch.object(recovery.restore_check, 'restore_source', side_effect=[{'kind': 'redis', 'container': 'hatchkit-restore-fixture', 'state': 'stopped'}, runner.BackupError('failed import')]):
                report = recovery.recover({'workDir': temp}, 'app', 'aaaaaaaa', {})
            self.assertFalse(report['ok'])
            self.assertEqual(report['cleanup']['containers'], ['hatchkit-restore-fixture'])
            self.assertEqual(report['error'], 'failed import')
            self.assertTrue(Path(report['directory'], 'recovery.json').exists())

    def test_duplicate_archive_members_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with tarfile.open(root / 'bad.tar', 'w') as archive:
                for _ in range(2):
                    item = tarfile.TarInfo('manifest.json')
                    item.size = 2
                    archive.addfile(item, io.BytesIO(b'{}'))
            with self.assertRaises(runner.BackupError):
                recovery.restore_check.unpack(root / 'bad.tar', root / 'output')


if __name__ == '__main__':
    unittest.main()
