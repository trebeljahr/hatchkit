#!/usr/bin/env python3
"""Check a reviewed AIDE baseline. This program never accepts a new baseline."""
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys

WORK = Path('/var/lib/hatchkit-security/aide')
STATUS = Path('/var/lib/hatchkit-backups/file-integrity-status.json')
CONFIG = '/etc/hatchkit-security/aide.conf'

def finding_fingerprint(log):
    # AIDE's run timestamps change even when its actual diff is identical.
    # Keep file timestamps/attributes inside the diff: those are findings.
    stable = '\n'.join(line for line in log.read_text(errors='replace').splitlines()
                       if not line.startswith(('Start timestamp:', 'End timestamp:')))
    return hashlib.sha256(stable.encode()).hexdigest()

def check():
    now = dt.datetime.now(dt.timezone.utc)
    try:
        previous = json.loads(STATUS.read_text())
    except (OSError, ValueError):
        previous = {}
    log = WORK / ('check-' + now.strftime('%Y%m%dT%H%M%SZ') + '.log')
    if not (WORK / 'aide.db').is_file():
        code, issue = 64, 'AIDE baseline is missing; file integrity is not covered'
        log.write_text(issue + '\n')
    else:
        with log.open('w') as output:
            result = subprocess.run(['/usr/bin/aide', '--config=' + CONFIG, '--check'],
                                    stdout=output, stderr=subprocess.STDOUT, timeout=1800)
        code = result.returncode
        issue = None if code == 0 else 'AIDE reported changes or failed; inspect the root-private check log'
    state = {'checkedAt': now.isoformat(timespec='seconds'), 'ok': code == 0,
             'exitCode': code, 'issue': issue, 'log': str(log)}
    if issue:
        # Hash the private diff to detect changed incidents without sending file contents.
        fingerprint = finding_fingerprint(log)
        last = previous.get('lastSentAt')
        due = not last or now - dt.datetime.fromisoformat(last) >= dt.timedelta(hours=24)
        state.update({k: previous[k] for k in ('lastSentAt', 'notifiedFingerprint') if k in previous})
        if fingerprint != previous.get('notifiedFingerprint') or due:
            try:
                sys.path.insert(0, '/opt/hatchkit-backups')
                from alerts import send_email
                config = json.loads(Path('/etc/hatchkit-backups/config.json').read_text())
                state['messageId'] = send_email(config['alerts'], '[Hatchkit] File integrity needs attention — ' + socket.gethostname(),
                    issue + '.\nHost access remains Tailscale-only.\nLog: ' + str(log) + '\n')
                state.update(lastSentAt=state['checkedAt'], notifiedFingerprint=fingerprint)
            except Exception as error:
                state['mailError'] = type(error).__name__
    temporary = STATUS.with_suffix('.tmp')
    temporary.write_text(json.dumps(state, indent=2) + '\n')
    temporary.replace(STATUS)
    print(json.dumps(state))
    return 0 if state['ok'] and not state.get('mailError') else 1

def main():
    os.umask(0o077)
    WORK.mkdir(parents=True, exist_ok=True, mode=0o700)
    STATUS.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (WORK / '.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            return check()
        except Exception as error:
            # Ensure a killed/failed checker cannot leave a fresh healthy status.
            STATUS.write_text(json.dumps({'checkedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
                'ok': False, 'error': type(error).__name__}) + '\n')
            raise
if __name__ == '__main__':
    sys.exit(main())
