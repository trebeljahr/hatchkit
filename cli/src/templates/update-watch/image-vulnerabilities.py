#!/usr/bin/env python3
"""Scan final running image IDs locally; package inventories never leave the host."""
import argparse
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

WORK = Path('/var/lib/hatchkit-backups')
REPORTS = Path('/var/lib/hatchkit-security/image-reports')
SCRATCH = Path('/var/cache/hatchkit-security/tmp')

class CommandError(RuntimeError):
    def __init__(self, program, code, diagnostic):
        super().__init__(program + ' failed (exit ' + str(code) + ')')
        self.code, self.diagnostic = code, diagnostic

def command(argv, timeout=600):
    SCRATCH.mkdir(parents=True, exist_ok=True, mode=0o700)
    p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout,
                       env={**os.environ, 'GOMAXPROCS': '2', 'GRYPE_CHECK_FOR_APP_UPDATE': 'false',
                            'GRYPE_DB_CACHE_DIR': '/var/cache/hatchkit-security/grype',
                            'GRYPE_DB_AUTO_UPDATE': 'false',
                            'TMPDIR': str(SCRATCH), 'GOMEMLIMIT': '1536MiB'})
    if p.returncode:
        with tempfile.NamedTemporaryFile(mode='w', prefix='command-', suffix='.stderr', dir=SCRATCH, delete=False) as log:
            log.write(p.stderr)
        raise CommandError(argv[0], p.returncode, log.name)
    return p.stdout

def summarize(report, image, containers):
    findings = {}
    for match in report.get('matches', []):
        vuln, package = match['vulnerability'], match['artifact']
        severity = vuln.get('severity', '').lower()
        if severity not in ('high', 'critical'):
            continue
        key = (vuln['id'], package['name'], package['version'])
        fix = vuln.get('fix') or {}
        findings[key] = {
            'kind': 'image-package', 'service': image, 'name': package['name'],
            'id': vuln['id'], 'severity': severity, 'version': package['version'],
            'fixed': ', '.join(fix.get('versions') or []) or None,
            'fixState': fix.get('state'), 'url': vuln.get('dataSource'), 'containers': containers,
            'aliases': sorted({v['id'] for v in match.get('relatedVulnerabilities', []) if v.get('id')}),
            'summary': package['name'] + ' ' + package['version'] + ': ' + vuln['id'] + ' (' + severity + ')'}
    return sorted(findings.values(), key=lambda x: (x['severity'] != 'critical', x['id'], x['name']))

def running_images():
    ids = command(['docker', 'ps', '-q']).split()
    assert ids, 'No running containers'
    raw = command(['docker', 'inspect', '--format', '{{json .Name}}\t{{json .Image}}', *ids])
    images = {}
    for line in raw.splitlines():
        name, image = map(json.loads, line.split('\t'))
        images.setdefault(image, []).append(name.lstrip('/'))
    return {image: sorted(names) for image, names in images.items()}


def usable_report(report, image, database, scanner_version, now):
    """Reuse only the same image, scanner and verified DB for at most 24 hours.

    Read the report's own provenance, not a file mtime. A new vulnerability DB
    invalidates every cache entry; a deployment invalidates its image entry.
    """
    try:
        descriptor = report['descriptor']
        scanned = dt.datetime.fromisoformat(descriptor['timestamp'].replace('Z', '+00:00'))
        built = dt.datetime.fromisoformat(database['built'].replace('Z', '+00:00'))
        prior = descriptor['db']['status']
        return (isinstance(report['matches'], list)
                and report['source']['target']['userInput'] == image
                and descriptor['name'] == 'grype' and descriptor['version'] == scanner_version
                and bool(scanner_version) and database.get('valid') is True and prior.get('valid') is True
                and all(database.get(key) and prior.get(key) == database[key]
                        for key in ('schemaVersion', 'from', 'built'))
                and scanned.tzinfo is not None and built.tzinfo is not None
                and -dt.timedelta(minutes=5) <= now - scanned <= dt.timedelta(hours=24)
                and -dt.timedelta(minutes=5) <= now - built <= dt.timedelta(days=5))
    except (KeyError, TypeError, ValueError, AttributeError):
        return False


def scan():
    images = running_images()
    REPORTS.mkdir(parents=True, exist_ok=True, mode=0o700)
    findings, errors, inventories = [], [], []
    initial = {'checkedAt': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),
               'ok': False, 'complete': False, 'findings': [], 'errors': ['scan in progress']}
    (WORK / 'image-vulnerability-status.json').write_text(json.dumps(initial) + '\n')
    print(json.dumps({'phase': 'database', 'images': len(images)}), flush=True)
    command(['/usr/local/bin/grype', 'db', 'update'], 900)
    db = json.loads(command(['/usr/local/bin/grype', 'db', 'status', '-o', 'json']))
    scanner_version = json.loads(command(['/usr/local/bin/grype', 'version', '-o', 'json']))['version']
    for image, containers in sorted(images.items()):
        path = REPORTS / (image.removeprefix('sha256:') + '.json')
        partial = path.with_suffix('.partial')
        try:
            now = dt.datetime.now(dt.timezone.utc)
            try:
                report = json.loads(path.read_text())
            except (OSError, ValueError):
                report = {}
            reused = usable_report(report, image, db, scanner_version, now)
            print(json.dumps({'phase': 'cached' if reused else 'image', 'image': image, 'containers': containers}), flush=True)
            if not reused:
                partial.unlink(missing_ok=True)
                command(['/usr/local/bin/grype', 'docker:' + image, '-o', 'json', '--file', str(partial)], 900)
                report = json.loads(partial.read_text())
                assert usable_report(report, image, db, scanner_version, dt.datetime.now(dt.timezone.utc)), 'Invalid scan provenance'
                partial.replace(path)
            rows = summarize(report, image, containers)
            findings.extend(rows)
            inventories.append({'image': image, 'containers': containers,
                                'matchedPackages': len({(m['artifact']['name'], m['artifact']['version'])
                                                        for m in report.get('matches', [])}),
                                'findings': len(rows), 'scannedAt': report['descriptor']['timestamp'],
                                'cached': reused})
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError, AssertionError) as error:
            errors.append({'image': image, 'error': type(error).__name__,
                           **({'exitCode': error.code, 'diagnostic': error.diagnostic}
                              if isinstance(error, CommandError) else {})})
    if running_images() != images:
        errors.append({'error': 'Running image inventory changed during scan; repeat required'})
    return {'checkedAt': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),
            'ok': not findings and not errors, 'complete': not errors, 'findings': findings,
            'errors': errors, 'images': inventories, 'database': db}

def main():
    os.umask(0o077)
    WORK.mkdir(parents=True, exist_ok=True)
    with (WORK / '.image-vulnerability-scan.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            report = scan()
        except Exception as error:
            report = {'checkedAt': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),
                      'ok': False, 'complete': False, 'findings': [], 'errors': [type(error).__name__]}
        path = WORK / 'image-vulnerability-status.json'
        temporary = path.with_suffix('.tmp')
        temporary.write_text(json.dumps(report, indent=2) + '\n')
        temporary.replace(path)
        print(json.dumps({'ok': report['ok'], 'complete': report['complete'],
                          'images': len(report.get('images', [])), 'findings': len(report['findings']),
                          'errors': report['errors']}))
        return 0 if report['complete'] else 1

if __name__ == '__main__':
    sys.exit(main())
