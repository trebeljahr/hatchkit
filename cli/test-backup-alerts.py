import datetime as dt
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).parent / 'src/templates/backups'))
import alerts


class BackupAlerts(unittest.TestCase):
    def test_new_failure_mails_once_repeats_go_to_the_digest_and_failed_delivery_retries(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            config = {'alerts': {'to': 'owner@example.test', 'from': 'backup@example.test'}, 'projects': []}
            now = dt.datetime.now(dt.timezone.utc)
            with patch.object(alerts, 'issues_for', return_value=['project: failed']), patch.object(alerts, 'send_email', return_value='message') as send:
                self.assertEqual(alerts.check(config, work, now=now)['kind'], 'failure')
                self.assertFalse(alerts.check(config, work, now=now + dt.timedelta(hours=1))['sent'])
                self.assertFalse(alerts.check(config, work, now=now + dt.timedelta(hours=24))['sent'])
                self.assertEqual(send.call_count, 1)
                subject, document = send.call_args.args[1:]
                self.assertIn('backup failed', subject)
                self.assertEqual(document['sections']['needs'][0]['what'], 'project: failed')
            with patch.object(alerts, 'issues_for', return_value=['project: failed', 'other: failed']), patch.object(alerts, 'send_email', return_value='message') as send:
                self.assertTrue(alerts.check(config, work, now=now)['sent'])
                self.assertEqual([i['what'] for i in send.call_args.args[2]['sections']['needs']], ['other: failed'])
            with patch.object(alerts, 'issues_for', return_value=[]), patch.object(alerts, 'send_email', return_value='message') as send:
                self.assertFalse(alerts.check(config, work, now=now)['sent'])
                self.assertEqual(send.call_count, 0)
            before = (work / 'alerts-status.json').read_text()
            with patch.object(alerts, 'issues_for', return_value=['project: failed']), patch.object(alerts, 'send_email', side_effect=RuntimeError('smtp unavailable')):
                with self.assertRaises(RuntimeError): alerts.check(config, work, now=now)
            self.assertEqual((work / 'alerts-status.json').read_text(), before)
            with patch.object(alerts, 'issues_for', return_value=['project: failed']), patch.object(alerts, 'send_email', return_value='message'):
                self.assertTrue(alerts.check(config, work, now=now)['sent'])

    def test_restore_drill_issue_waits_for_the_digest(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            issue = 'demo: isolated native restore failed, is missing or is older than nine days.'
            with patch.object(alerts, 'issues_for', return_value=[issue]), patch.object(alerts, 'send_email') as send:
                self.assertFalse(alerts.check({'alerts': {'to': 'x'}}, work)['sent'])
            self.assertEqual(send.call_count, 0)

    def test_upgrade_does_not_repeat_issues_the_old_version_already_announced(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            (work / 'alerts-status.json').write_text(json.dumps({'issues': ['project: failed'], 'lastSentAt': '2026-11-01T00:00:00+00:00'}))
            with patch.object(alerts, 'issues_for', return_value=['project: failed']), patch.object(alerts, 'send_email') as send:
                self.assertFalse(alerts.check({'alerts': {'to': 'x'}}, work)['sent'])
            self.assertEqual(send.call_count, 0)

    def test_the_digest_still_runs_when_the_backup_mail_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            config = {'alerts': {'to': 'owner@example.test'}, 'projects': []}
            with patch.object(alerts, 'issues_for', return_value=[]), patch.object(alerts, 'check', side_effect=OSError('smtp')), \
                 patch.object(alerts, 'run_digest', return_value={'sent': False}) as digest:
                with self.assertRaises(OSError):
                    alerts.run_all(config, work)
            self.assertEqual(digest.call_count, 1)

    def test_detects_failed_stale_missing_and_disabled_timer_without_emailing_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            (work / 'status.json').write_text(json.dumps({'results': [
                {'project': 'failed', 'ok': False, 'error': 'SECRET'},
                {'project': 'stale', 'ok': True, 'verifiedAt': '2000-01-01T00:00:00+00:00'}]}))
            config = {'projects': [{'name': n} for n in ['failed', 'stale', 'missing']]}
            with patch.object(alerts, 'unit_value', side_effect=['failed', 'inactive']):
                issues = alerts.issues_for(config, work)
            self.assertEqual(len(issues), 5)
            self.assertNotIn('SECRET', str(issues))
            (work / 'status.json').write_text('broken json')
            with patch.object(alerts, 'unit_value', side_effect=['inactive', 'active']):
                self.assertIn('could not be read', alerts.issues_for(config, work)[0])

    def test_missing_source_is_its_own_issue_with_the_fix(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            (work / 'status.json').write_text(json.dumps({'results': [
                {'project': 'chess-app', 'ok': False, 'state': 'source-missing', 'missingSources': ['app-redis'], 'error': 'x'}]}))
            with patch.object(alerts, 'unit_value', side_effect=['inactive', 'active']):
                issues = alerts.issues_for({'projects': [{'name': 'chess-app'}]}, work)
            self.assertEqual(len(issues), 1)
            self.assertIn('app-redis no longer exist', issues[0])
            self.assertIn('hatchkit backup sources --project chess-app', issues[0])

    def test_restore_failures_staleness_and_future_dates_are_visible(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            timer = root / 'restore.timer'
            timer.write_text('test fixture')
            now = dt.datetime.now(dt.timezone.utc)
            config = {'projects': [{'name': n} for n in ['fresh', 'failed', 'stale', 'missing', 'future']]}
            rows = [{'project': 'fresh', 'ok': True, 'checkedAt': now.isoformat()},
                    {'project': 'failed', 'ok': False, 'checkedAt': now.isoformat(), 'error': 'PRIVATE'},
                    {'project': 'stale', 'ok': True, 'checkedAt': (now-dt.timedelta(days=10)).isoformat()},
                    {'project': 'future', 'ok': True, 'checkedAt': (now+dt.timedelta(hours=1)).isoformat()}]
            (root / 'restore-check-all.json').write_text(json.dumps({'results': rows}))
            with patch.object(alerts, 'RESTORE_TIMER', timer), patch.object(alerts, 'unit_value', return_value='inactive'):
                issues = alerts.restore_issues(config, root, now)
            self.assertEqual(len(issues), 5)
            self.assertNotIn('PRIVATE', str(issues))
            self.assertFalse(any(i.startswith('fresh:') for i in issues))
            with patch.object(alerts, 'RESTORE_TIMER', root / 'not-installed'):
                self.assertEqual(alerts.restore_issues(config, root, now), [])

    def test_test_email_does_not_change_failure_state(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            with patch.object(alerts, 'send_email', return_value='message'):
                self.assertEqual(alerts.check({'alerts': {'to': 'test@example.test'}}, work, test=True)['kind'], 'test')
            self.assertFalse((work / 'alerts-status.json').exists())
            self.assertFalse(alerts.check({}, work)['sent'])

    def test_smtp_requires_private_credentials_and_verifies_tls(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'smtp.json'
            path.write_text(json.dumps({'host': 'smtp.example.test', 'username': 'login', 'password': 'secret'}))
            settings = {'smtpFile': str(path), 'from': 'Backup <backup@example.test>', 'to': 'owner@example.test'}
            path.chmod(0o644)
            with self.assertRaises(ValueError): alerts.send_email(settings, 'test', 'body')
            path.chmod(0o600)
            client = MagicMock()
            client.__enter__.return_value = client
            client.send_message.return_value = {}
            with patch.object(alerts.smtplib, 'SMTP', return_value=client):
                alerts.send_email(settings, 'test', 'body')
            context = client.starttls.call_args.kwargs['context']
            self.assertTrue(context.check_hostname)
            client.login.assert_called_once_with('login', 'secret')
            message = client.send_message.call_args.args[0]
            self.assertEqual(message['To'], 'owner@example.test')
            self.assertEqual(message['From'], 'Hatchkit Alerts <backup@example.test>')
            self.assertEqual(message['Auto-Submitted'], 'auto-generated')
            self.assertTrue(message['Message-ID'].endswith('@example.test>'))
            self.assertEqual(message.get_content_type(), 'multipart/alternative')
            self.assertNotIn('secret', message.as_string())


if __name__ == '__main__': unittest.main()
