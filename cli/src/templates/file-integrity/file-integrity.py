#!/usr/bin/env python3
"""Check a reviewed AIDE baseline.

A diff is accepted without review only when a signed package explains all of it:
every added or changed file belongs to an installed package and matches, byte for
byte and in mode and owner, the file in that package version's .deb as apt
downloads and verifies it against the signed archive index. Directories may only
change mtime/ctime. Anything else (removed files, foreign files, conffile edits,
diversions, a failed download) mails for review and keeps the old baseline.
"""
import datetime as dt
import fcntl
import grp
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import socket
import stat
import subprocess
import sys
import tarfile
import tempfile

WORK = Path('/var/lib/hatchkit-security/aide')
STATUS = Path('/var/lib/hatchkit-backups/file-integrity-status.json')
CONFIG = '/etc/hatchkit-security/aide.conf'
# Files Hatchkit itself rewrites: accepted only when their hash equals the
# record the writer left beside its own status, never by path alone.
SELF_MANAGED = {'/etc/hatchkit-security/image-assessments.json': ('/var/lib/hatchkit-backups/review-renewal.json',
                                                                  'Hatchkit review renewal')}
SECTIONS = {'Added entries:': 'added', 'Removed entries:': 'removed', 'Changed entries:': 'changed'}
ENTRY = re.compile(r'^(\S)\s?([=+\-<>!])[^:]*:\s(/.*)$')
MAX_AUTO_FILES = 400


def report_entries(text):
    """AIDE summary lines -> [(section, type, flags, path)]; the detailed block is ignored."""
    entries, section = [], None
    for line in text.splitlines():
        if line in SECTIONS:
            section = SECTIONS[line]
        elif line.startswith('Detailed information') or line.startswith('The attributes of'):
            section = None
        elif section:
            match = ENTRY.match(line)
            if match:
                flags = line[:line.index(':')]
                entries.append((section, match.group(1), flags, match.group(3)))
    return entries


def run(args, timeout=120):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout)


def owner_packages(paths):
    """path -> package for files with exactly one owner and no diversion."""
    owners = {}
    for chunk in range(0, len(paths), 100):
        result = run(['dpkg-query', '-S', *paths[chunk:chunk + 100]])
        for line in result.stdout.splitlines():
            if line.startswith('diversion by') or ': ' not in line:
                continue
            packages, path = line.split(': ', 1)
            if path in owners or ',' in packages:
                owners[path] = None  # shared or ambiguous ownership needs a person
            else:
                owners[path] = packages.strip()
    return owners


def package_matches(package, paths, scratch):
    """True when every path equals the file in the apt-verified .deb of the installed version."""
    version = run(['dpkg-query', '-W', '-f=${Version}', package]).stdout.strip()
    if not version:
        return False
    target = scratch / re.sub(r'[^A-Za-z0-9.+-]', '_', package)
    target.mkdir()
    # apt checks the .deb against the hash in the signed index before saving it.
    fetched = subprocess.run(['apt-get', '-q', '-o', 'APT::Sandbox::User=root', 'download', package + '=' + version],
                             cwd=target, capture_output=True, text=True, timeout=600)
    debs = list(target.glob('*.deb'))
    if fetched.returncode != 0 or len(debs) != 1:
        return False
    with subprocess.Popen(['dpkg-deb', '--fsys-tarfile', str(debs[0])], stdout=subprocess.PIPE) as tar_stream:
        members = {}
        with tarfile.open(fileobj=tar_stream.stdout, mode='r|') as archive:
            wanted = {'.' + p for p in paths}
            for member in archive:
                if member.name in wanted:
                    data = archive.extractfile(member).read() if member.isreg() else None
                    members[member.name[1:]] = (member, data and hashlib.sha256(data).hexdigest())
    for path in paths:
        if path not in members:
            return False
        member, digest = members[path]
        info = os.lstat(path)
        try:
            user, group = pwd.getpwuid(info.st_uid).pw_name, grp.getgrgid(info.st_gid).gr_name
        except KeyError:
            return False
        if (user, group) != (member.uname, member.gname) or stat.S_IMODE(info.st_mode) != member.mode:
            return False
        if member.issym():
            if not stat.S_ISLNK(info.st_mode) or os.readlink(path) != member.linkname:
                return False
        elif not stat.S_ISREG(info.st_mode) or digest != hashlib.sha256(Path(path).read_bytes()).hexdigest():
            return False
    return True


def explain(entries):
    """(packages, reason): packages that explain the whole diff, or why a person must look."""
    if not entries:
        return None, 'no parsed entries'
    files = []
    for section, kind, flags, path in entries:
        if section == 'removed':
            return None, 'a file was removed'
        if kind == 'd':
            # Only a directory's timestamps may move; mode, owner or ACL changes need review.
            if section != 'changed' or set(re.sub(r'[\s.=]', '', flags[1:])) - set('mc'):
                return None, 'a directory changed more than its timestamps'
            continue
        if kind not in ('f', 'l'):
            return None, 'an unsupported entry type changed'
        files.append(path)
    explained = []
    for path in [p for p in files if p in SELF_MANAGED]:
        record_path, label = SELF_MANAGED[path]
        try:
            record = json.loads(Path(record_path).read_text())
            matches = record['path'] == path and record['sha256'] == hashlib.sha256(Path(path).read_bytes()).hexdigest()
        except (OSError, ValueError, KeyError, TypeError):
            matches = False
        if not matches:
            return None, 'a Hatchkit-managed file does not match its recorded rewrite'
        explained.append(label)
        files.remove(path)
    if not files:
        return (sorted(set(explained)), None) if explained else (None, 'only directories changed')
    if len(files) > MAX_AUTO_FILES:
        return None, 'too many files to verify automatically'
    owners = owner_packages(files)
    by_package = {}
    for path in files:
        if not owners.get(path):
            return None, 'a changed file has no single owning package'
        by_package.setdefault(owners[path], []).append(path)
    with tempfile.TemporaryDirectory(prefix='hatchkit-aide-') as scratch:
        for package, paths in sorted(by_package.items()):
            if not package_matches(package, paths, Path(scratch)):
                return None, 'a changed file does not match its signed package'
    return sorted(by_package) + sorted(set(explained)), None

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
        candidate = WORK / 'aide.db.new'
        candidate.unlink(missing_ok=True)
        # One scan both reports the diff and writes the candidate baseline, so
        # nothing can change between the check and an accepted package update.
        with log.open('w') as output:
            result = subprocess.run(['/usr/bin/aide', '--config=' + CONFIG, '--update'],
                                    stdout=output, stderr=subprocess.STDOUT, timeout=1800)
        code = result.returncode
        issue = None if code == 0 else 'AIDE reported changes or failed; inspect the root-private check log'
        accepted = None
        if 0 < code < 8 and candidate.is_file():
            packages, reason = explain(report_entries(log.read_text(errors='replace')))
            if packages:
                previous_db = WORK / ('aide.db.before-' + now.strftime('%Y%m%dT%H%M%SZ'))
                os.link(WORK / 'aide.db', previous_db)
                candidate.replace(WORK / 'aide.db')
                accepted = {'at': now.isoformat(timespec='seconds'), 'packages': packages,
                            'previousBaseline': str(previous_db)}
                code, issue = 0, None
            else:
                issue = 'AIDE reported changes that no signed package explains (' + reason + '); inspect the root-private check log'
        candidate.unlink(missing_ok=True)
    state = {'checkedAt': now.isoformat(timespec='seconds'), 'ok': code == 0,
             'exitCode': code, 'issue': issue, 'log': str(log)}
    if accepted:
        state['autoAccepted'] = accepted
    elif previous.get('autoAccepted') and code == 0:
        state['autoAccepted'] = previous['autoAccepted']
    if issue:
        # Hash the private diff to detect changed incidents without sending file contents.
        fingerprint = finding_fingerprint(log)
        # The same diff is not news: it stays in the daily digest until reviewed.
        state.update({k: previous[k] for k in ('lastSentAt', 'notifiedFingerprint') if k in previous})
        if fingerprint != previous.get('notifiedFingerprint'):
            try:
                sys.path.insert(0, '/opt/hatchkit-backups')
                from alerts import send_email
                config = json.loads(Path('/etc/hatchkit-backups/config.json').read_text())
                host = socket.gethostname()
                state['messageId'] = send_email(config['alerts'], '[Hatchkit] ' + host + ': file changes to review', {
                    'title': 'File changes to review', 'host': host,
                    'sections': {'needs': [{'what': issue + '.',
                                            'detail': 'Review each change. Hatchkit accepts a new baseline itself only '
                                                      'when a signed package explains every change.',
                                            'command': 'sudo less ' + str(log)}]},
                    'footer': ['The daily digest lists this until it clears. No further mail means it cleared.',
                               'Server access remains Tailscale-only.']})
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
