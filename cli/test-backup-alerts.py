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
    def test_delivery_dedup_reminder_recovery_and_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            config = {'alerts': {'to': 'owner@example.test', 'from': 'backup@example.test'}, 'projects': []}
            now = dt.datetime.now(dt.timezone.utc)
            with patch.object(alerts, 'issues_for', return_value=['project: failed']), patch.object(alerts, 'send_email', return_value='message') as send:
                self.assertEqual(alerts.check(config, work, now=now)['kind'], 'failure')
                self.assertFalse(alerts.check(config, work, now=now + dt.timedelta(hours=1))['sent'])
                self.assertTrue(alerts.check(config, work, now=now + dt.timedelta(hours=24))['sent'])
                self.assertEqual(send.call_count, 2)
            with patch.object(alerts, 'issues_for', return_value=[]), patch.object(alerts, 'send_email', return_value='message') as send:
                self.assertEqual(alerts.check(config, work, now=now)['kind'], 'recovery')
                self.assertFalse(alerts.check(config, work, now=now)['sent'])
                self.assertEqual(send.call_count, 1)
            before = (work / 'alerts-status.json').read_text()
            with patch.object(alerts, 'issues_for', return_value=['new failure']), patch.object(alerts, 'send_email', side_effect=RuntimeError('smtp unavailable')):
                with self.assertRaises(RuntimeError): alerts.check(config, work, now=now)
            self.assertEqual((work / 'alerts-status.json').read_text(), before)
            with patch.object(alerts, 'issues_for', return_value=['new failure']), patch.object(alerts, 'send_email', return_value='message'):
                self.assertTrue(alerts.check(config, work, now=now)['sent'])

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
            self.assertNotIn('secret', message.as_string())


if __name__ == '__main__': unittest.main()
