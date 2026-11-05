"""Scoped assessment fixtures; no live Docker, filesystem state or credentials."""
import datetime as dt
import json
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent/'src/templates/update-watch'))
uw = __import__('update-watch')
NOW = dt.datetime(2026, 10, 24, 13, 0, tzinfo=dt.timezone.utc)
NAME = 'coolify-proxy-error-pages'
IMAGE = 'sha256:'+'a'*64
ROW = {'kind': 'image-package', 'id': 'CVE-2026-38753', 'name': 'busybox', 'version': '1.38.0',
       'severity': 'high', 'service': IMAGE, 'containers': [NAME], 'summary': 'fixture scanner match'}
REVIEW = {'id': 'fixture-review', 'predicate': 'busybox-static-httpd-awk-ash-v1',
          'imageId': IMAGE, 'container': NAME, 'package': 'busybox', 'version': '1.38.0',
          'advisories': ['CVE-2026-38753', 'CVE-2026-38754', 'CVE-2026-38755'],
          'owner': 'fixture operator', 'reason': 'Only static HTTP is exposed; no script inputs.',
          'evidence': ['https://lists.busybox.net/pipermail/busybox/2026-July/092392.html'],
          'reviewedAt': NOW.isoformat(), 'expiresAt': (NOW+dt.timedelta(days=7)).isoformat()}


class Assessments(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root/'reviews.json'
        self.calls = []
        self.container = {'Image': IMAGE, 'Name': '/'+NAME}
        self.write()

    def write(self, review=None):
        self.path.write_text(json.dumps({'schema': 1, 'reviews': [review or dict(REVIEW)]}))

    def docker(self, args):
        self.calls.append(args)
        if args == ['inspect', '--format', '{{json .}}', NAME]:
            return json.dumps(self.container)
        if args == ['exec', NAME, '/bin/busybox', 'test', '!', '-e', '/etc/httpd.conf']:
            return ''
        raise AssertionError('Unexpected Docker request')

    def apply(self, rows=None, now=NOW, boundary=lambda c: True):
        return uw.apply_image_assessments(rows if rows is not None else [dict(ROW)], self.docker, now,
                                          path=self.path, boundary=boundary)

    def test_valid_review_keeps_raw_severity_versions_and_deadlines(self):
        row = dict(ROW, firstSeenAt='2026-10-20T00:00:00+00:00', dueAt='2026-10-23T00:00:00+00:00')
        rows, skipped = self.apply([row])
        self.assertEqual(skipped, [])
        self.assertEqual({k: rows[0][k] for k in row}, row)
        self.assertTrue(uw.current_assessment(rows[0], NOW))
        self.assertNotIn('assessment', row)

    def test_review_does_not_cover_other_workloads_packages_or_advisories(self):
        for changes in [{'containers': ['other']}, {'name': 'other'}, {'version': '1.39.0'},
                        {'id': 'CVE-new'}, {'containers': [NAME, 'other']}]:
            rows, skipped = self.apply([dict(ROW, **changes)])
            self.assertEqual(skipped, [])
            self.assertNotIn('assessment', rows[0])

    def test_image_and_boundary_changes_become_incomplete_coverage(self):
        self.container['Image'] = 'sha256:'+'b'*64
        rows, skipped = self.apply()
        self.assertNotIn('assessment', rows[0]);self.assertIn('context changed', skipped[0])
        self.container['Image'] = IMAGE
        rows, skipped = self.apply(boundary=lambda c: False)
        self.assertNotIn('assessment', rows[0]);self.assertIn('context changed', skipped[0])

    def test_httpd_configuration_override_invalidates_the_review(self):
        def docker(args):
            if args[0] == 'exec':
                raise uw.WatchError('fixture confidential value')
            return self.docker(args)
        rows, skipped = uw.apply_image_assessments([dict(ROW)], docker, NOW, path=self.path, boundary=lambda c: True)
        self.assertNotIn('assessment', rows[0]);self.assertIn('context changed', skipped[0])
        self.assertNotIn('confidential', json.dumps(skipped))

    def test_expiry_alerts_only_while_matching_findings_remain(self):
        rows, skipped = self.apply(now=NOW+dt.timedelta(days=7))
        self.assertIn('expired', skipped[0]);self.assertNotIn('assessment', rows[0])
        rows, skipped = self.apply([], now=NOW+dt.timedelta(days=8))
        self.assertEqual((rows, skipped), ([], []))

    def test_exploitation_and_reviewed_internet_exposure_always_bypass(self):
        for fields in [{'knownExploited': True}, {'applicability': 'affected', 'exposure': 'internet'}]:
            rows, skipped = self.apply([dict(ROW, **fields)])
            self.assertEqual(skipped, []);self.assertNotIn('assessment', rows[0])
            self.assertTrue(uw.immediate_finding(rows[0]))

    def test_invalid_lifetimes_evidence_and_predicates_fail_closed(self):
        variations = [{'expiresAt': (NOW+dt.timedelta(days=8)).isoformat()},
                      {'reviewedAt': (NOW+dt.timedelta(hours=1)).isoformat()},
                      {'expiresAt': NOW.replace(tzinfo=None).isoformat()},
                      {'evidence': ['https://fixture:secret@example.invalid/source']},
                      {'advisories': ['CVE-httpd-new']}, {'predicate': 'arbitrary'}, {'reason': 'line\nbreak'}]
        for change in variations:
            self.write(dict(REVIEW, **change));rows, skipped = self.apply()
            self.assertNotIn('assessment', rows[0]);self.assertIn('configuration is invalid', skipped[0])
            self.assertNotIn('secret', json.dumps(skipped))

    def test_duplicate_reviews_do_not_partially_apply(self):
        for second in [REVIEW, dict(REVIEW, id='other-id')]:
            self.path.write_text(json.dumps({'schema': 1, 'reviews': [REVIEW, second]}))
            rows, skipped = self.apply()
            self.assertNotIn('assessment', rows[0]);self.assertTrue(skipped)

    def test_missing_optional_configuration_strips_any_old_annotation(self):
        self.path.unlink()
        rows, skipped = self.apply([dict(ROW, assessment={'status': 'stale'})])
        self.assertEqual(skipped, []);self.assertNotIn('assessment', rows[0]);self.assertEqual(self.calls, [])

    def test_static_boundary_rejects_scripts_symlinks_and_command_changes(self):
        content = self.root/'www';content.mkdir();content.chmod(0o755)
        file = content/'503.html';file.write_text('fixture');file.chmod(0o644)
        c = {'Config': {'Cmd': ['httpd', '-f', '-p', '80', '-h', '/www']},
             'Mounts': [{'Source': str(content), 'Type': 'bind', 'Destination': '/www', 'RW': False}]}
        check = lambda: uw.static_httpd_boundary(c, expected_root=content.resolve(), trusted_uids=(os.getuid(),))
        self.assertTrue(check())
        file.chmod(0o755);self.assertFalse(check());file.chmod(0o644)
        extra = content/'httpd.conf';extra.write_text('fixture');self.assertFalse(check());extra.unlink()
        extra.symlink_to(file);self.assertFalse(check());extra.unlink()
        c['Config']['Entrypoint'] = ['sh'];self.assertFalse(check());c['Config'].pop('Entrypoint')
        c['Mounts'][0]['RW'] = True;self.assertFalse(check())

    def test_current_assessment_does_not_create_an_empty_weekly_email(self):
        rows, skipped = self.apply()
        started = (NOW-dt.timedelta(days=5)).isoformat();due = (NOW-dt.timedelta(days=2)).isoformat()
        previous = {'checkedAt': NOW.isoformat(), 'findings': [dict(ROW, firstSeenAt=started, dueAt=due)],
                    'lastWeeklyReviewKey': '2026-W43', 'notificationIdentityVersion': 3}
        (self.root/uw.STATUS_NAME).write_text(json.dumps(previous))
        sent = []
        with patch.object(uw, 'scan', return_value={'services': [], 'findings': rows, 'skipped': skipped}):
            state, error = uw.check(None, [], None, self.root, {}, lambda *a: sent.append(a), NOW)
        self.assertIsNone(error);self.assertEqual(sent, [])
        self.assertEqual(state['assessedPackageMatches'], 1);self.assertEqual(state['unreviewedPackageMatches'], 0)
        self.assertEqual(state['findings'][0]['firstSeenAt'], started);self.assertEqual(state['findings'][0]['dueAt'], due)

    def test_expired_review_loses_coverage_and_reaches_the_digest_as_not_checked(self):
        when = NOW+dt.timedelta(days=7)
        rows, skipped = self.apply(now=when)
        (self.root/uw.STATUS_NAME).write_text(json.dumps({'checkedAt': when.isoformat(), 'findings': [], 'lastWeeklyReviewKey': '2026-W44'}))
        sent = []
        with patch.object(uw, 'scan', return_value={'services': [], 'findings': rows, 'skipped': skipped}):
            state, error = uw.check(None, [], None, self.root, {}, lambda *a: sent.append(a), when)
        self.assertIsNone(error);self.assertEqual(sent, [])
        self.assertIn('expired', json.dumps(state['skipped']))
        # The digest treats a skip as active, so the weekly gate cannot hide it.
        sys.path.insert(0, str(Path(__file__).parent/'src/templates/backups'))
        import ops_digest
        digests = []
        ops_digest.run({'alerts': {'enabled': True}}, self.root, lambda *a: digests.append(a) or 'id', 'fixture-host', when, (), self.root/'no-units')
        self.assertEqual(len(digests), 1)
        self.assertTrue(any('expired' in item['what'] for item in digests[0][2]['sections']['unchecked']))



if __name__ == '__main__':
    unittest.main()
