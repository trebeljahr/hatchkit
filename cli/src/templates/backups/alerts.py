#!/usr/bin/env python3
"""Mail a new backup failure at once, run the daily digest, and hold the shared SMTP sender."""
import argparse
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import smtplib
import socket
import ssl
import subprocess
import sys

from hatchkit_mail import build_message
from ops_digest import backup_command, backup_item, is_restore_issue, run as run_digest
from runner import read_status

RESTORE_TIMER = Path('/etc/systemd/system/hatchkit-restore-check.timer')


def restore_issues(config, work, now=None):
    if not RESTORE_TIMER.is_file():
        return []  # Legacy installations acquire this check with the drill units.
    now = now or dt.datetime.now(dt.timezone.utc)
    issues = []
    try:
        report = json.loads((work / 'restore-check-all.json').read_text())
        rows = {r['project']: r for r in report['results']}
    except (OSError, ValueError, KeyError, TypeError):
        rows = {}
    for project in config['projects']:
        row = rows.get(project['name'], {})
        try:
            checked = dt.datetime.fromisoformat(row['checkedAt'])
            fresh = dt.timedelta(minutes=-5) <= now - checked <= dt.timedelta(days=9)
        except (ValueError, KeyError, TypeError):
            fresh = False
        if not row.get('ok') or not fresh:
            issues.append(project['name'] + ': isolated native restore failed, is missing or is older than nine days.')
    try:
        if unit_value('hatchkit-restore-check.timer', 'ActiveState') != 'active':
            issues.append('Weekly native restore timer is not active.')
    except Exception:
        issues.append('Weekly native restore timer state could not be read.')
    return issues


def unit_value(unit, prop):
    return subprocess.check_output(
        ['systemctl', 'show', unit, '--property=' + prop, '--value'],
        stderr=subprocess.DEVNULL, timeout=15, text=True).strip()


def issues_for(config, work):
    issues = []
    try:
        status = read_status(config['projects'], work)
        if not status['results']:
            issues.append('No projects are registered for backup.')
        for result in status['results']:
            name = result['project']
            if not result.get('ok') and result.get('state') == 'source-missing':
                issues.append(name + ': registered source(s) ' + ', '.join(result.get('missingSources', []))
                              + ' no longer exist on this host (database moved or removed?). '
                              + 'Fix: hatchkit backup sources --project ' + name)
            elif not result.get('ok'):
                issues.append(name + ': latest backup failed or has never completed.')
            elif result['stale']:
                issues.append(name + ': no verified backup within 36 hours.')
    except Exception:
        issues.append('Backup status could not be read; inspect the server logs.')
    try:
        if unit_value('hatchkit-backups.service', 'ActiveState') == 'failed':
            issues.append('Backup service failed; inspect the server logs.')
        if unit_value('hatchkit-backups.timer', 'ActiveState') != 'active':
            issues.append('Daily backup timer is not active.')
    except Exception:
        issues.append('Backup service/timer state could not be read.')
    return sorted(issues + restore_issues(config, work))


def send_email(settings, subject, body):
    """Send one branded multipart mail. `body` is a hatchkit_mail document or plain text."""
    path = Path(settings['smtpFile'])
    if path.stat().st_mode & 0o077:
        raise ValueError('SMTP credential file must be private (0600)')
    smtp = json.loads(path.read_text())
    mode = smtp.get('tls', 'starttls')
    if mode not in ('starttls', 'tls'):
        raise ValueError('SMTP requires verified TLS')
    message = build_message(settings, subject, body)
    context = ssl.create_default_context()
    client = (smtplib.SMTP_SSL(smtp['host'], smtp.get('port', 465), timeout=30, context=context)
              if mode == 'tls' else smtplib.SMTP(smtp['host'], smtp.get('port', 587), timeout=30))
    with client:
        client.ehlo()
        if mode == 'starttls':
            client.starttls(context=context)
            client.ehlo()
        client.login(smtp['username'], smtp['password'])
        if client.send_message(message):
            raise RuntimeError('SMTP rejected a recipient')
    return str(message['Message-ID'])


def check(config, work, *, test=False, now=None):
    """Mail a new backup failure at once. Open issues repeat in the daily digest."""
    settings = config.get('alerts')
    if not settings or not settings.get('enabled', True):
        return {'configured': False, 'sent': False}
    host = socket.gethostname()
    if test:
        message_id = send_email(settings, '[Hatchkit] ' + host + ': test mail', {
            'title': 'Test mail', 'host': host,
            'intro': 'Hatchkit alerts reach this address. Nothing failed.\n\n'
                     'Failed backups mail at once. Everything else that is open goes in one daily digest. '
                     'A day with nothing open sends no mail.',
            'footer': ['Inspect: ' + backup_command(host)]})
        return {'configured': True, 'sent': True, 'kind': 'test', 'messageId': message_id}
    now = now or dt.datetime.now(dt.timezone.utc)
    path = work / 'alerts-status.json'
    previous = json.loads(path.read_text()) if path.exists() else {}
    issues = issues_for(config, work)
    failures = [issue for issue in issues if not is_restore_issue(issue)]
    notified = previous.get('notifiedIssues', previous.get('issues', []))
    new = [issue for issue in failures if issue not in notified]
    last_sent = previous.get('lastSentAt')
    kind = 'failure' if new else None
    message_id = None
    if kind:
        message_id = send_email(settings, '[Hatchkit] ' + host + ': backup failed', {
            'title': 'Backup failed', 'host': host,
            'sections': {'needs': [backup_item(issue, host) for issue in new]},
            'footer': ['Server logs: journalctl -u hatchkit-backups.service',
                       'The daily digest lists this until it clears. No further mail means it cleared.',
                       'Server access remains Tailscale-only.']})
        # Record delivery only after SMTP acceptance. Failures remain retryable.
        last_sent = now.isoformat()
    state = {'checkedAt': now.isoformat(), 'issues': issues, 'lastSentAt': last_sent,
             'notifiedIssues': sorted(set(new) | {issue for issue in notified if issue in failures}),
             'lastKind': kind or previous.get('lastKind'),
             'messageId': message_id or previous.get('messageId')}
    temporary = work / 'alerts-status.json.tmp'
    temporary.write_text(json.dumps(state, indent=2) + '\n')
    temporary.replace(path)
    return {'configured': True, 'sent': bool(kind), 'kind': kind, 'issues': issues}


def run_all(config, work):
    """The backup check and the digest each get their chance; a failure in one stays visible."""
    failure = None
    result = {}
    try:
        result = check(config, work)
    except Exception as error:
        failure = error
    try:
        issues = result['issues'] if 'issues' in result else issues_for(config, work)
        result['digest'] = run_digest(config, work, send_email, socket.gethostname(), backup_issues=issues)
    except Exception as error:
        failure = failure or error
    if failure is not None:
        raise failure
    return result


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['check', 'test'])
    parser.add_argument('--config', default='/etc/hatchkit-backups/config.json')
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    work = Path(config.get('workDir', '/var/lib/hatchkit-backups'))
    work.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (work / '.alerts.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        print(json.dumps(check(config, work, test=True) if args.action == 'test' else run_all(config, work)))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # SMTP exceptions may echo login details or remote responses. Keep logs secret-free.
        print(json.dumps({'sent': False, 'error': type(error).__name__}), file=sys.stderr)
        sys.exit(1)
