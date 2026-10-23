import contextlib
import io
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('integrity', Path(__file__).parent / 'src/templates/file-integrity/file-integrity.py')
integrity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(integrity)


class FileIntegrityAlerts(unittest.TestCase):
    def test_identical_diff_does_not_email_again_for_changed_run_timestamps(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'aide.db').write_text('fixture baseline')
            messages = []
            fake_alerts = types.SimpleNamespace(send_email=lambda *args: messages.append(args) or 'fixture-message')
            runs = iter([('first', 'original -> changed'), ('second', 'original -> changed'), ('third', 'original -> another-change')])
            def run(argv, **kwargs):
                timestamp, difference = next(runs)
                kwargs['stdout'].write('Start timestamp: ' + timestamp + '\nFile: /etc/fixture\n SHA256: ' + difference + '\nEnd timestamp: ' + timestamp + '\n')
                return subprocess.CompletedProcess(argv, 4)
            original = Path.read_text
            def read(path, *args, **kwargs):
                if str(path) == '/etc/hatchkit-backups/config.json':
                    return json.dumps({'alerts': {'fixture': True}})
                return original(path, *args, **kwargs)
            with patch.object(integrity, 'WORK', root), patch.object(integrity, 'STATUS', root / 'status.json'), patch.object(integrity.subprocess, 'run', side_effect=run), patch.object(Path, 'read_text', read), patch.dict(sys.modules, {'alerts': fake_alerts}), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(integrity.check(), 1)
                self.assertEqual(len(messages), 1)
                self.assertEqual(integrity.check(), 1)
                self.assertEqual(len(messages), 1)
                self.assertEqual(integrity.check(), 1)
                self.assertEqual(len(messages), 2)
            self.assertNotIn('another-change', str(messages))


if __name__ == '__main__':
    unittest.main()
