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
            self.assertIn('[Hatchkit]', messages[0][1])
            self.assertEqual(messages[0][2]['sections']['needs'][0]['command'].split()[:2], ['sudo', 'less'])

    def test_the_same_diff_never_repeats_after_a_day(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'aide.db').write_text('fixture baseline')
            messages = []
            fake_alerts = types.SimpleNamespace(send_email=lambda *args: messages.append(args) or 'fixture-message')
            def run(argv, **kwargs):
                kwargs['stdout'].write('File: /etc/fixture\n SHA256: same\n')
                return subprocess.CompletedProcess(argv, 4)
            original = Path.read_text
            def read(path, *args, **kwargs):
                if str(path) == '/etc/hatchkit-backups/config.json':
                    return json.dumps({'alerts': {'fixture': True}})
                return original(path, *args, **kwargs)
            with patch.object(integrity, 'WORK', root), patch.object(integrity, 'STATUS', root / 'status.json'), patch.object(integrity.subprocess, 'run', side_effect=run), patch.object(Path, 'read_text', read), patch.dict(sys.modules, {'alerts': fake_alerts}), contextlib.redirect_stdout(io.StringIO()):
                integrity.check()
                status = json.loads((root / 'status.json').read_text())
                status['lastSentAt'] = '2020-01-01T00:00:00+00:00'
                (root / 'status.json').write_text(json.dumps(status))
                integrity.check()
            self.assertEqual(len(messages), 1)


REPORT = '''Start timestamp: 2026-11-05 04:43:48 +0000 (AIDE 0.18.6)
AIDE found differences between database and filesystem!!

Summary:
  Total number of entries:\t5115
  Changed entries:\t\t3

---------------------------------------------------
Changed entries:
---------------------------------------------------

d = ... mc.. ..   : /usr/bin
f = ... mci.H..   : /usr/bin/dig
f = ... mci.H..   : /usr/bin/host

---------------------------------------------------
Detailed information about changes:
---------------------------------------------------

File: /usr/bin/dig
 SHA256    : old | new
'''


class PackageExplainedChanges(unittest.TestCase):
    def test_report_entries_reads_only_the_summary_lists(self):
        self.assertEqual(integrity.report_entries(REPORT), [
            ('changed', 'd', 'd = ... mc.. ..   ', '/usr/bin'),
            ('changed', 'f', 'f = ... mci.H..   ', '/usr/bin/dig'),
            ('changed', 'f', 'f = ... mci.H..   ', '/usr/bin/host')])

    def test_explain_refuses_anything_a_package_cannot_vouch_for(self):
        self.assertEqual(integrity.explain([('removed', 'f', 'f-----', '/usr/bin/x')])[1], 'a file was removed')
        self.assertIn('directory', integrity.explain([('changed', 'd', 'd = p.. mc', '/etc')])[1])
        self.assertEqual(integrity.explain([('changed', 'd', 'd = ... mc.. ..', '/etc')])[1], 'only directories changed')
        with patch.object(integrity, 'owner_packages', return_value={}):
            self.assertIn('no single owning package', integrity.explain([('changed', 'f', 'f = ', '/etc/foreign')])[1])
        with patch.object(integrity, 'owner_packages', return_value={'/usr/bin/dig': ('bind9-dnsutils', '/usr/bin/dig')}), \
             patch.object(integrity, 'package_matches', return_value=False):
            self.assertIn('does not match', integrity.explain([('changed', 'f', 'f = ', '/usr/bin/dig')])[1])
        with patch.object(integrity, 'owner_packages', return_value={'/usr/bin/dig': ('bind9-dnsutils', '/usr/bin/dig')}), \
             patch.object(integrity, 'package_matches', return_value=True):
            self.assertEqual(integrity.explain(integrity.report_entries(REPORT)[:2]), (['bind9-dnsutils'], None))

    def test_usrmerge_alias_maps_only_through_a_real_top_level_symlink(self):
        import os
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'usr' / 'lib').mkdir(parents=True)
            (root / 'usr' / 'sbin').mkdir()
            (root / 'sbin').mkdir()  # a real directory, not merged
            os.symlink('usr/lib', root / 'lib')
            alias = lambda p: integrity.usrmerge_alias(p, root=str(root))
            self.assertEqual(alias('/usr/lib/systemd/system/x.service'), '/lib/systemd/system/x.service')
            self.assertIsNone(alias('/usr/sbin/tool'))  # /sbin is not a symlink here
            self.assertIsNone(alias('/usr/share/doc/x'))
            self.assertIsNone(alias('/etc/x'))

    def test_owner_packages_retries_the_merged_usr_path_once(self):
        def fake_run(argv):
            known = {'/usr/bin/tool': 'tool-pkg', '/lib/systemd/system/x.service': 'svc-pkg',
                     '/lib/shared.so': 'a, b'}
            out = ''.join(f'{known[p]}: {p}\n' for p in argv[2:] if p in known)
            return subprocess.CompletedProcess(argv, 0, out, '')
        alias = lambda p: '/' + p.split('/', 2)[2] if p.startswith('/usr/lib/') else None
        with patch.object(integrity, 'run', side_effect=fake_run):
            owners = integrity.owner_packages(
                ['/usr/bin/tool', '/usr/lib/systemd/system/x.service', '/usr/lib/shared.so', '/usr/lib/foreign'], alias=alias)
        self.assertEqual(owners, {'/usr/bin/tool': ('tool-pkg', '/usr/bin/tool'),
                                  '/usr/lib/systemd/system/x.service': ('svc-pkg', '/lib/systemd/system/x.service')})

    def test_package_matches_reads_the_deb_under_the_package_path(self):
        import grp, os, pwd
        with tempfile.TemporaryDirectory() as folder:
            live = Path(folder) / 'unit.service'
            live.write_bytes(b'unit')
            live.chmod(0o644)
            buffer = io.BytesIO()
            with integrity.tarfile.open(fileobj=buffer, mode='w') as tar:
                member = integrity.tarfile.TarInfo('./lib/systemd/system/unit.service')
                member.size, member.mode = 4, 0o644
                member.uname = pwd.getpwuid(os.getuid()).pw_name
                member.gname = grp.getgrgid(os.getgid()).gr_name
                tar.addfile(member, io.BytesIO(b'unit'))
            def fake_run(argv, **kwargs):
                if argv[0] == 'dpkg-query':
                    return subprocess.CompletedProcess(argv, 0, '1.0', '')
                (Path(kwargs['cwd']) / 'svc_1.0_amd64.deb').write_bytes(b'deb')
                return subprocess.CompletedProcess(argv, 0, '', '')
            popen = lambda *a, **k: contextlib.nullcontext(types.SimpleNamespace(stdout=io.BytesIO(buffer.getvalue())))
            with tempfile.TemporaryDirectory() as scratch, \
                 patch.object(integrity.subprocess, 'run', side_effect=fake_run), \
                 patch.object(integrity.subprocess, 'Popen', side_effect=popen):
                self.assertTrue(integrity.package_matches('svc', [(str(live), '/lib/systemd/system/unit.service')], Path(scratch)))

    def test_a_hatchkit_rewrite_is_accepted_only_with_its_recorded_hash(self):
        import hashlib
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            review, record = root / 'image-assessments.json', root / 'review-renewal.json'
            review.write_text('{"renewed": true}')
            managed = {str(review): (str(record), 'Hatchkit review renewal')}
            entries = [('changed', 'd', 'd = ... mc.. ..', str(root)), ('changed', 'f', 'f > ... mci.H..', str(review))]
            with patch.object(integrity, 'SELF_MANAGED', managed):
                self.assertIn('recorded rewrite', integrity.explain(entries)[1])  # no record at all
                record.write_text(json.dumps({'path': str(review), 'sha256': hashlib.sha256(review.read_bytes()).hexdigest()}))
                self.assertEqual(integrity.explain(entries), (['Hatchkit review renewal'], None))
                review.write_text('{"renewed": true, "extra": "edit"}')  # edited after the rewrite
                self.assertIn('recorded rewrite', integrity.explain(entries)[1])

    def test_package_matches_compares_content_mode_and_owner_with_the_deb(self):
        import grp, os, pwd
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            live = root / 'tool'
            live.write_bytes(b'patched binary')
            live.chmod(0o755)
            def archive(content):
                buffer = io.BytesIO()
                with integrity.tarfile.open(fileobj=buffer, mode='w') as tar:
                    member = integrity.tarfile.TarInfo('.' + str(live))
                    member.size, member.mode = len(content), 0o755
                    member.uname = pwd.getpwuid(os.getuid()).pw_name
                    member.gname = grp.getgrgid(os.getgid()).gr_name
                    tar.addfile(member, io.BytesIO(content))
                return buffer.getvalue()
            def fake_run(argv, **kwargs):
                if argv[0] == 'dpkg-query':
                    return subprocess.CompletedProcess(argv, 0, '1.2-3', '')
                (Path(kwargs['cwd']) / 'pkg_1.2-3_amd64.deb').write_bytes(b'deb')
                return subprocess.CompletedProcess(argv, 0, '', '')
            for content, expected in ((b'patched binary', True), (b'something else', False)):
                popen = lambda *a, **k: contextlib.nullcontext(types.SimpleNamespace(stdout=io.BytesIO(archive(content))))
                with tempfile.TemporaryDirectory() as scratch, \
                     patch.object(integrity.subprocess, 'run', side_effect=fake_run), \
                     patch.object(integrity.subprocess, 'Popen', side_effect=popen):
                    self.assertEqual(integrity.package_matches('pkg', [(str(live), str(live))], Path(scratch)), expected)

    def test_explained_diff_installs_the_candidate_baseline_without_mail(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'aide.db').write_text('old baseline')
            messages = []
            fake_alerts = types.SimpleNamespace(send_email=lambda *args: messages.append(args) or 'id')
            def run(argv, **kwargs):
                self.assertIn('--update', argv)
                kwargs['stdout'].write(REPORT)
                (root / 'aide.db.new').write_text('new baseline')
                return subprocess.CompletedProcess(argv, 4)
            with patch.object(integrity, 'WORK', root), patch.object(integrity, 'STATUS', root / 'status.json'), \
                 patch.object(integrity.subprocess, 'run', side_effect=run), \
                 patch.object(integrity, 'explain', return_value=(['bind9-dnsutils'], None)), \
                 patch.dict(sys.modules, {'alerts': fake_alerts}), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(integrity.check(), 0)
            status = json.loads((root / 'status.json').read_text())
            self.assertEqual((status['ok'], status['autoAccepted']['packages'], messages), (True, ['bind9-dnsutils'], []))
            self.assertEqual((root / 'aide.db').read_text(), 'new baseline')
            self.assertEqual(Path(status['autoAccepted']['previousBaseline']).read_text(), 'old baseline')
            self.assertFalse((root / 'aide.db.new').exists())

    def test_unexplained_diff_keeps_the_old_baseline_and_mails(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'aide.db').write_text('old baseline')
            messages = []
            fake_alerts = types.SimpleNamespace(send_email=lambda *args: messages.append(args) or 'id')
            def run(argv, **kwargs):
                kwargs['stdout'].write(REPORT)
                (root / 'aide.db.new').write_text('new baseline')
                return subprocess.CompletedProcess(argv, 4)
            original = Path.read_text
            def read(path, *args, **kwargs):
                if str(path) == '/etc/hatchkit-backups/config.json':
                    return json.dumps({'alerts': {}})
                return original(path, *args, **kwargs)
            with patch.object(integrity, 'WORK', root), patch.object(integrity, 'STATUS', root / 'status.json'), \
                 patch.object(integrity.subprocess, 'run', side_effect=run), patch.object(Path, 'read_text', read), \
                 patch.object(integrity, 'explain', return_value=(None, 'a file was removed')), \
                 patch.dict(sys.modules, {'alerts': fake_alerts}), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(integrity.check(), 1)
            self.assertEqual(len(messages), 1)
            self.assertEqual((root / 'aide.db').read_text(), 'old baseline')
            self.assertFalse((root / 'aide.db.new').exists())
            self.assertIn('a file was removed', json.loads((root / 'status.json').read_text())['issue'])


if __name__ == '__main__':
    unittest.main()
