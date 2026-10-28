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

def write_json(name, value):
    path = WORK / name
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.chmod(0o600)
    temporary.replace(path)


def progress(started, total, completed, errors=0, phase='running'):
    write_json('image-vulnerability-progress.json', {
        'startedAt': started, 'checkedAt': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),
        'phase': phase, 'imagesTotal': total, 'imagesCompleted': completed, 'errors': errors})

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


def needs_refresh(report, attempt, images, now):
    """A current ledger must cover names and immutable images, not just a tag.

    Recheck the vulnerability database daily even if no workload changes.
    Failed attempts remain visible and are retried by the bounded timer.
    """
    try:
        if report['complete'] is not True or report['errors'] != [] or attempt['complete'] is not True or attempt['errors'] != []:
            return True
        checked = dt.datetime.fromisoformat(report['checkedAt'].replace('Z', '+00:00'))
        if checked.tzinfo is None or not -dt.timedelta(minutes=5) <= now - checked < dt.timedelta(hours=23):
            return True
        rows = report['images']
        if not isinstance(rows, list) or any(not isinstance(row['containers'], list)
                or not all(isinstance(name, str) for name in row['containers']) for row in rows):
            return True
        if len({row['image'] for row in rows}) != len(rows):
            return True
        covered = {row['image']: sorted(row['containers']) for row in rows}
        if covered != images:
            return True
        for row in rows:
            scanned = dt.datetime.fromisoformat(row['scannedAt'].replace('Z', '+00:00'))
            if scanned.tzinfo is None or not -dt.timedelta(minutes=5) <= now - scanned < dt.timedelta(hours=24):
                return True
        database = report['database']
        built = dt.datetime.fromisoformat(database['built'].replace('Z', '+00:00'))
        return not (database['valid'] is True and built.tzinfo is not None
                    and -dt.timedelta(minutes=5) <= now - built <= dt.timedelta(days=5))
    except (KeyError, TypeError, ValueError, AttributeError):
        return True


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
    started = dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')
    progress(started, len(images), 0)
    print(json.dumps({'phase': 'database', 'images': len(images)}), flush=True)
    command(['/usr/local/bin/grype', 'db', 'update'], 900)
    db = json.loads(command(['/usr/local/bin/grype', 'db', 'status', '-o', 'json']))
    scanner_version = json.loads(command(['/usr/local/bin/grype', 'version', '-o', 'json']))['version']
    for image, containers in sorted(images.items()):
        progress(started, len(images), len(inventories), len(errors))
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
        progress(started, len(images), len(inventories), len(errors))
    if running_images() != images:
        errors.append({'error': 'Running image inventory changed during scan; repeat required'})
    return {'checkedAt': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),
            'ok': not findings and not errors, 'complete': not errors, 'findings': findings,
            'errors': errors, 'images': inventories, 'database': db}

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--needs-refresh', action='store_true', help='Read-only systemd condition: 0 refresh, 1 current, 255 inspection failed')
    args = parser.parse_args(argv)
    if args.needs_refresh:
        try:
            images = running_images()
            def previous(name):
                try:
                    return json.loads((WORK / name).read_text())
                except (OSError, ValueError):
                    return {}
            needed = needs_refresh(previous('image-vulnerability-status.json'),
                                   previous('image-vulnerability-attempt.json'), images,
                                   dt.datetime.now(dt.timezone.utc))
            print(json.dumps({'refreshRequired': needed}), flush=True)
            return 0 if needed else 1
        except Exception as error:
            # ExecCondition 255 fails visibly; 1 would silently skip coverage.
            print(json.dumps({'refreshInspectionFailed': type(error).__name__}), flush=True)
            return 255
    os.umask(0o077)
    WORK.mkdir(parents=True, exist_ok=True)
    with (WORK / '.image-vulnerability-scan.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            report = scan()
        except Exception as error:
            report = {'checkedAt': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),
                      'ok': False, 'complete': False, 'findings': [], 'errors': [type(error).__name__]}
        # Keep the last complete ledger through refreshes and failed attempts.
        # Progress/failure is separate and must still be checked for coverage.
        write_json('image-vulnerability-attempt.json', report)
        if report['complete']:
            write_json('image-vulnerability-status.json', report)
        try:
            previous_progress = json.loads((WORK / 'image-vulnerability-progress.json').read_text())
        except (OSError, ValueError):
            previous_progress = {}
        progress(previous_progress.get('startedAt', report['checkedAt']),
                 previous_progress.get('imagesTotal', 0), len(report.get('images', [])),
                 len(report['errors']), 'complete' if report['complete'] else 'failed')
        print(json.dumps({'ok': report['ok'], 'complete': report['complete'],
                          'images': len(report.get('images', [])), 'findings': len(report['findings']),
                          'errors': report['errors']}))
        return 0 if report['complete'] else 1

if __name__ == '__main__':
    sys.exit(main())
