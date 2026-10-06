#!/usr/bin/env python3
"""Email failed/overdue backup alerts; no mail for routine successful checks."""
import argparse
import datetime as dt
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
import fcntl
import json
import os
from pathlib import Path
import smtplib
import socket
import ssl
import subprocess
import sys

from runner import read_status


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
    return sorted(issues)


def send_email(settings, subject, body):
    path = Path(settings['smtpFile'])
    if path.stat().st_mode & 0o077:
        raise ValueError('SMTP credential file must be private (0600)')
    smtp = json.loads(path.read_text())
    mode = smtp.get('tls', 'starttls')
    if mode not in ('starttls', 'tls'):
        raise ValueError('SMTP requires verified TLS')
    message = EmailMessage()
    message['From'] = settings['from']
    message['To'] = settings['to']
    message['Subject'] = subject
    message['Date'] = formatdate(localtime=False)
    message['Message-ID'] = make_msgid()
    message.set_content(body)
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
    settings = config.get('alerts')
    if not settings or not settings.get('enabled', True):
        return {'configured': False, 'sent': False}
    host = socket.gethostname()
    if test:
        message_id = send_email(settings, '[Hatchkit] Backup alert test — ' + host,
            'Backup failure alerts are configured for this address.\n\n'
            'This is a test; no backup failure was triggered. Failed captures, a stopped backup timer, '
            'and backups overdue by 36 hours will trigger an email. Unchanged issues are repeated '
            'at most once every 24 hours. Recovery sends one confirmation. Routine success sends no email.\n\n'
            'Inspect: hatchkit backup status --json\n')
        return {'configured': True, 'sent': True, 'kind': 'test', 'messageId': message_id}
    now = now or dt.datetime.now(dt.timezone.utc)
    path = work / 'alerts-status.json'
    previous = json.loads(path.read_text()) if path.exists() else {}
    issues = issues_for(config, work)
    previous_issues = previous.get('issues', [])
    last_sent = previous.get('lastSentAt')
    due = not last_sent or (now - dt.datetime.fromisoformat(last_sent)).total_seconds() >= 24 * 3600
    kind = None
    if issues and (issues != previous_issues or due):
        kind = 'failure'
        subject = '[Hatchkit] Backup needs attention — ' + host
        body = '\n'.join('- ' + issue for issue in issues)
    elif not issues and previous_issues:
        kind = 'recovery'
        subject = '[Hatchkit] Backups recovered — ' + host
        body = 'All registered projects have a successful, recent backup and the daily timer is active.'
    message_id = None
    if kind:
        message_id = send_email(settings, subject, body + '\n\n'
            'Inspect: hatchkit backup status --json\n'
            'Server logs: journalctl -u hatchkit-backups.service\n'
            'Server access remains Tailscale-only.\n')
        # Record delivery only after SMTP acceptance. Failures remain retryable.
        last_sent = now.isoformat()
    state = {'checkedAt': now.isoformat(), 'issues': issues, 'lastSentAt': last_sent,
             'lastKind': kind or previous.get('lastKind'),
             'messageId': message_id or previous.get('messageId')}
    temporary = work / 'alerts-status.json.tmp'
    temporary.write_text(json.dumps(state, indent=2) + '\n')
    temporary.replace(path)
    return {'configured': True, 'sent': bool(kind), 'kind': kind, 'issues': issues}


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
        print(json.dumps(check(config, work, test=args.action == 'test')))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # SMTP exceptions may echo login details or remote responses. Keep logs secret-free.
        print(json.dumps({'sent': False, 'error': type(error).__name__}), file=sys.stderr)
        sys.exit(1)
