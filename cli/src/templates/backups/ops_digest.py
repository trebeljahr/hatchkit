#!/usr/bin/env python3
"""One daily mail per host, built from the checks' own status files.

The checks keep their ledgers and mail only what cannot wait. This module reads
those files once a day and sends nothing when nothing is open. It runs inside the
hourly hatchkit-backup-alerts service, so a host with alert mail needs no new unit.

There is no fleet digest. The hosts share only the security-controller Worker, and
its boundary is fixed health metadata: package findings must not cross it. Each host
therefore sends its own digest. The Worker mails coverage across all hosts.

Raw scanner matches keep their weekly gate: they appear on the weekly review day and
do not cause a mail on their own the rest of the week. Their clocks keep running in
the ledger and the copy section always lists them. Known exploitation and explicitly
affected internet exposure bypass that gate.
"""
import datetime as dt
import hashlib
import json
from pathlib import Path
from zoneinfo import ZoneInfo

STATUS_NAME = 'digest-status.json'
ZONE = 'Australia/Sydney'
HOUR = 9  # A digest day starts here, in ZONE.
UNITS = Path('/etc/systemd/system')
LEDGER = '/var/lib/hatchkit-backups/update-watch-status.json'
# status file, its timer, longest healthy gap. The same limits as the external monitor.
CHECKS = (('update-watch-status.json', 'hatchkit-update-watch.timer', 8 * 3600, 'Update watch'),
          ('host-integrity-status.json', 'hatchkit-host-integrity.timer', 28 * 3600, 'Daily host integrity check'),
          ('host-integrity-quick-status.json', 'hatchkit-host-integrity-quick.timer', 3600, 'Quick host integrity check'),
          ('file-integrity-status.json', 'hatchkit-file-integrity.timer', 28 * 3600, 'File integrity check'))
# Not coverage gaps: the quick scan leaves these to the daily scan by design.
QUICK_EXCLUSIONS = {'CPU not measured: the window was under 5 s.',
                    'Sustained CPU and outbound peers use the daily full scan.'}
WORKLOADS_SHOWN = 6


def local_shifted(now):
    return now.astimezone(ZoneInfo(ZONE)) - dt.timedelta(hours=HOUR)


def day_key(now):
    return local_shifted(now).date().isoformat()


def week_key(now):
    year, week, _ = local_shifted(now).isocalendar()
    return '%04d-W%02d' % (year, week)


def read_json(path):
    try:
        value = json.loads(Path(path).read_text())
        return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


def advisory_id(finding):
    aliases = [finding.get('id') or ''] + (finding.get('aliases') or [])
    return next(iter(sorted(a for a in aliases if a.startswith('CVE-'))), finding.get('id') or 'unknown')


def urgent(finding):
    """Bypasses the weekly gate and any assessment, as the update watch rules require."""
    return bool(finding.get('knownExploited') or
                (finding.get('applicability') == 'affected' and finding.get('exposure') == 'internet'))


def assessed(finding, now):
    review = finding.get('assessment') or {}
    try:
        return (not urgent(finding) and review['status'] == 'not-reachable-in-reviewed-configuration'
                and dt.datetime.fromisoformat(review['reviewedAt']) <= now < dt.datetime.fromisoformat(review['expiresAt']))
    except (KeyError, TypeError, ValueError):
        return False


def workloads(finding):
    return sorted(set(finding.get('containerDisplayNames') or finding.get('containers')
                      or [finding.get('name') or 'unknown image']))


def named(names, shown=WORKLOADS_SHOWN):
    return ', '.join(names[:shown]) + (' and %d more' % (len(names) - shown) if len(names) > shown else '')


def when(value):
    try:
        return dt.datetime.fromisoformat(value).astimezone(dt.timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
    except (TypeError, ValueError):
        return None


def deadline(rows):
    """The earliest clock of a group. It is never reset or hidden by the later ones."""
    due = sorted((r['dueAt'] for r in rows if r.get('dueAt')), key=lambda v: dt.datetime.fromisoformat(v))
    if not due:
        return None
    return when(due[0]) + (' (past due)' if any(r.get('overdue') for r in rows) else '')


def flags(rows):
    return ['Known exploited'] if any(r.get('knownExploited') for r in rows) else []


def fix_floors(rows):
    return sorted({part.strip() for r in rows for part in (r.get('fixed') or '').split(',') if part.strip()})


def group_packages(rows):
    """Advisory + package + fixed version, whatever container or version repeats it."""
    groups = {}
    for row in rows:
        groups.setdefault((advisory_id(row), row.get('name'), row.get('fixed') or ''), []).append(row)
    def priority(item):
        (advisory, name, _), members = item
        due = min((r['dueAt'] for r in members if r.get('dueAt')), default='9999')
        return (not any(r.get('knownExploited') for r in members), not any(r.get('overdue') for r in members),
                not any(r.get('severity') == 'critical' for r in members), due, advisory, name or '')
    return sorted(groups.items(), key=priority)


def updates_command(host):
    return 'hatchkit host updates --host ' + host + ' --json'


def integrity_command(host):
    return 'hatchkit host integrity --host ' + host + ' --json'


def backup_command(host):
    return 'hatchkit backup status --host ' + host + ' --json'


def backup_item(issue, host):
    what, _, fix = issue.partition(' Fix: ')
    return {'what': what, 'command': fix.strip() or backup_command(host)}


def is_restore_issue(issue):
    return 'native restore' in issue


def urgent_item(key, rows, host):
    advisory, name, fixed = key
    versions = sorted({r.get('version') for r in rows if r.get('version')})
    what = advisory + ' in ' + (name or 'a package') + (' ' + ', '.join(versions) if versions else '')
    what += ' (' + named(sorted({w for r in rows for w in workloads(r)})) + ').'
    what += ' Fix reported: ' + fixed + '.' if fixed else ' No fix reported.'
    if any(r.get('exposure') == 'internet' for r in rows):
        what += ' Explicitly affected internet exposure.'
    return {'what': what, 'flags': flags(rows), 'deadline': deadline(rows), 'command': updates_command(host)}


def workload_items(raw, host):
    """One line per workload: a rebuild is what clears a workload's matches."""
    by_workload = {}
    for row in raw:
        for name in workloads(row):
            by_workload.setdefault(name, []).append(row)
    needs, waiting = [], []
    for name, rows in sorted(by_workload.items()):
        fixes = {(r.get('name'), r.get('version')): r for r in rows if r.get('fixed')}
        unfixed = {advisory_id(r) for r in rows if not r.get('fixed')}
        fixable = [r for r in rows if r.get('fixed')]
        if fixable:
            advisories = {advisory_id(r) for r in fixable}
            shown = sorted(fixes)[:3]
            detail = ', '.join((p or 'package') + ' ' + (v or '') + ' to ' + fixes[(p, v)]['fixed'] for p, v in shown)
            if len(fixes) > len(shown):
                detail += ' and %d more' % (len(fixes) - len(shown))
            needs.append({'what': '%s: %d package fixes reported for %d advisories.' % (name, len(fixes), len(advisories)),
                          'detail': detail, 'deadline': deadline(fixable), 'command': updates_command(host)})
        if unfixed:
            late = [r for r in rows if not r.get('fixed')]
            waiting.append({'what': '%s: %d advisories have no reported fix.' % (name, len(unfixed)),
                            'deadline': deadline(late), 'command': updates_command(host)})
    return needs, waiting


REBUILD_STATUS = 'image-rebuild-status.json'
REBUILD_TIMER = 'hatchkit-image-rebuilds.timer'
REBUILD_LIMIT = 3 * 3600
REBUILD_COMMAND = 'sudo python3 /opt/hatchkit-backups/image-rebuilds.py'


def rebuild_items(work, now, units=UNITS):
    """Automatic base-image rebuilds (update-watch/image-rebuilds.py).

    A rebuild that landed rides along under Fixed automatically; it never sends a
    digest by itself. Its old image's rows leave the ledger only because the scanner
    no longer sees that image, and what it did not fix keeps its own clock above.
    A failed or unverified rebuild pauses that app and stays under Needs you until
    the operator clears it. Only named fields of the status file are read.
    """
    fixed, needs, unchecked = [], [], []
    status = read_json(work / REBUILD_STATUS)
    # Installed is not enabled: the unit file alone means nobody opted in yet.
    enabled = (Path(units) / 'timers.target.wants' / REBUILD_TIMER).exists()
    if status is None:
        if enabled:
            unchecked.append({'what': 'Automatic image rebuilds have no recent result.',
                              'command': 'systemctl status ' + REBUILD_TIMER})
        return fixed, needs, unchecked
    try:
        checked = dt.datetime.fromisoformat(status['checkedAt'])
    except (KeyError, TypeError, ValueError):
        checked = None
    if enabled and (checked is None or (now - checked).total_seconds() > REBUILD_LIMIT):
        unchecked.append({'what': 'Automatic image rebuilds have no recent result.',
                          'command': 'systemctl status ' + REBUILD_TIMER})
    if status.get('error'):
        needs.append({'what': str(status['error']), 'detail': 'No app image is rebuilt automatically until this is fixed.',
                      'command': REBUILD_COMMAND + ' plan'})
    for refused in status.get('refused') or []:
        needs.append({'what': '%s is listed for automatic rebuilds but is not rebuilt: %s.'
                              % (refused.get('image') or 'An image', refused.get('reason') or 'refused'),
                      'detail': 'Remove it from /etc/hatchkit-security/image-rebuilds.json and update it by hand.',
                      'command': REBUILD_COMMAND + ' plan'})
    for image, record in sorted((status.get('apps') or {}).items()):
        attempts = [a for a in (record or {}).get('attempts') or [] if isinstance(a, dict)]
        if not attempts:
            continue
        last = attempts[-1]
        names = named(sorted(str(n) for n in last.get('workloads') or [])) or image
        run = ' Run: ' + str(last['runUrl']) + '.' if last.get('runUrl') else ''
        if last.get('status') in ('failed', 'not-landed', 'dispatch-failed') and not last.get('cleared'):
            needs.append({'what': 'Automatic rebuild of %s did not finish: %s.' % (names, last.get('reason') or 'failed'),
                          'detail': 'Rebuilds of this app are paused until you clear them. The previous image keeps '
                                    'running and its findings keep their deadlines.' + run,
                          'command': REBUILD_COMMAND + ' clear ' + image})
        for attempt in attempts:
            try:
                verified = dt.datetime.fromisoformat(attempt['verifiedAt'])
            except (KeyError, TypeError, ValueError):
                continue
            if attempt.get('status') != 'landed' or now - verified >= dt.timedelta(hours=26):
                continue
            who = named(sorted(str(n) for n in attempt.get('workloads') or [])) or image
            after = attempt.get('fixCountAfter')
            detail = 'Scanner matches with a reported fix: %s before, %s after.' % (attempt.get('fixCountBefore'), after)
            if after:
                detail += ' The rest wait for the base image and keep their deadlines.'
            fixed.append({'what': 'Rebuilt %s on a fresh base image and deployed it after its tests and health checks.' % who,
                          'detail': detail + (' Run: ' + str(attempt['runUrl']) + '.' if attempt.get('runUrl') else ''),
                          'command': REBUILD_COMMAND + ' status'})
    return fixed, needs, unchecked


def collect(work, host, now, backup_issues, units=UNITS):
    """Everything open on this host. Reads only named fields of the status files."""
    needs, waiting, unchecked, raw_needs, raw_waiting, paste_rows = [], [], [], [], [], []
    watch = read_json(work / 'update-watch-status.json') or {}
    findings = watch.get('findings') or []
    packages = [f for f in findings if f.get('kind') == 'image-package']
    direct = [f for f in findings if f.get('kind') != 'image-package']
    urgent_rows = [f for f in packages if urgent(f)]
    reviewed = [f for f in packages if assessed(f, now)]
    raw = [f for f in packages if not urgent(f) and not assessed(f, now)]

    for key, rows in group_packages(urgent_rows):
        needs.append(urgent_item(key, rows, host))
    host_packages = [f for f in direct if f.get('kind') == 'host-package']
    for finding in direct:
        if finding.get('kind') == 'host-package':
            continue
        item = {'what': finding.get('summary') or finding.get('name') or 'Update watch finding',
                'flags': flags([finding]), 'deadline': deadline([finding]), 'command': updates_command(host)}
        if finding.get('kind') == 'advisory' and not finding.get('fixed'):
            waiting.append(item)
        else:
            needs.append(item)
    if host_packages:
        names = sorted({f.get('name') or 'package' for f in host_packages})
        needs.append({'what': '%d Ubuntu security updates are pending.' % len(names), 'detail': named(names),
                      'flags': flags(host_packages), 'deadline': deadline(host_packages),
                      'command': updates_command(host)})
    if raw:
        raw_needs, raw_waiting = workload_items(raw, host)

    integrity_rows = []
    seen = set()
    for name in ('host-integrity-status.json', 'host-integrity-quick-status.json'):
        status = read_json(work / name) or {}
        for finding in status.get('findings') or []:
            summary = finding.get('summary')
            if summary and summary not in seen:
                seen.add(summary)
                integrity_rows.append(summary)
                needs.append({'what': summary, 'flags': ['Possible compromise'], 'command': integrity_command(host)})
        for skip in status.get('skipped') or []:
            if skip not in QUICK_EXCLUSIONS:
                unchecked.append({'what': skip, 'command': integrity_command(host)})
        if status.get('error'):
            unchecked.append({'what': 'A host integrity check could not finish: ' + str(status['error']) + '.',
                              'command': integrity_command(host)})

    files = read_json(work / 'file-integrity-status.json') or {}
    auto_fixed = []
    accepted = files.get('autoAccepted') or {}
    try:
        accepted_at = dt.datetime.fromisoformat(accepted['at'])
    except (KeyError, TypeError, ValueError):
        accepted_at = None
    if accepted_at and now - accepted_at < dt.timedelta(hours=26):
        auto_fixed.append({'what': 'Accepted file changes that verified updates explain: '
                              + named(sorted(str(p) for p in accepted.get('packages') or [])) + '.',
                      'detail': 'Every changed file matched its signed package or a hash Hatchkit recorded when '
                                'it rewrote the file. The previous baseline is kept.',
                      'command': 'sudo ls ' + str(accepted.get('previousBaseline') or '/var/lib/hatchkit-security/aide')})
    renewal = watch.get('lastAutoRenewal') or {}
    try:
        renewed_at = dt.datetime.fromisoformat(renewal['at'])
    except (KeyError, TypeError, ValueError):
        renewed_at = None
    if renewed_at and now - renewed_at < dt.timedelta(hours=26) and renewal.get('ids'):
        auto_fixed.append({'what': 'Renewed the not-reachable review for one more week: '
                                   + named(sorted(str(i) for i in renewal['ids'])) + '.',
                           'detail': 'Its container, image and read-only content still match, no fixed release '
                                     'exists yet and nothing is known exploited. A fix or a change stops renewal.',
                           'command': updates_command(host)})
    rebuilt, rebuild_needs, rebuild_unchecked = rebuild_items(work, now, units)
    auto_fixed += rebuilt
    needs += rebuild_needs
    unchecked += rebuild_unchecked
    file_issue = None
    if files.get('error'):
        file_issue = 'The file integrity check crashed: ' + str(files['error']) + '.'
        unchecked.append({'what': file_issue, 'command': 'journalctl -u hatchkit-file-integrity.service -n 50'})
    elif files.get('ok') is False:
        file_issue = str(files.get('issue') or 'AIDE reported changes or failed.')
        needs.append({'what': file_issue, 'detail': 'Review each change. Hatchkit accepts a new baseline itself only '
                                                    'when a signed package explains every change.',
                      'command': 'sudo less ' + str(files.get('log') or '/var/lib/hatchkit-security/aide')})

    for issue in backup_issues:
        needs.append(backup_item(issue, host))

    for skip in watch.get('skipped') or []:
        unchecked.append({'what': skip, 'command': updates_command(host)})
    if watch.get('error'):
        unchecked.append({'what': 'The update watch could not finish: ' + str(watch['error']) + '.',
                          'command': 'journalctl -u hatchkit-update-watch.service -n 50'})
    for name, timer, limit, label in CHECKS:
        if not (Path(units) / timer).exists():
            continue
        checked = None
        try:
            checked = dt.datetime.fromisoformat((read_json(work / name) or {})['checkedAt'])
        except (KeyError, TypeError, ValueError):
            pass
        if checked is None or (now - checked).total_seconds() > limit:
            unchecked.append({'what': label + ' has no recent result.',
                              'command': 'systemctl status ' + timer})

    if integrity_rows:
        paste_rows.append('## Host integrity')
        paste_rows += ['- ' + row for row in integrity_rows]
    if file_issue:
        paste_rows += ['## File integrity', '- ' + file_issue.rstrip('.') + '. Log: ' + str(files.get('log') or 'not recorded')]
    if backup_issues:
        paste_rows.append('## Backups')
        paste_rows += ['- ' + issue for issue in backup_issues]
    if unchecked:
        paste_rows.append('## Not checked')
        paste_rows += ['- ' + item['what'] for item in unchecked]
    if direct:
        paste_rows.append('## Services, runtimes and host packages')
        for finding in direct:
            line = finding.get('summary') or finding.get('name') or 'Update watch finding'
            if finding.get('dueAt'):
                line += ' | due ' + when(finding['dueAt'])
            if finding.get('overdue'):
                line += ' | past due'
            if finding.get('knownExploited'):
                line += ' | known exploited'
            paste_rows.append('- ' + line)
    grouped = group_packages(packages)
    if grouped:
        paste_rows.append('## Image packages: advisory | severity | package | fixed | workloads | deadline')
        for (advisory, name, fixed), rows in grouped:
            versions = sorted({r.get('version') for r in rows if r.get('version')})
            severity = 'critical' if any(r.get('severity') == 'critical' for r in rows) else (rows[0].get('severity') or 'unknown')
            line = ' | '.join([advisory, severity, (name or 'unknown') + ' ' + ', '.join(versions),
                               'fixed ' + fixed if fixed else 'no fix reported',
                               named(sorted({w for r in rows for w in workloads(r)}))])
            when_due = deadline(rows)
            line += ' | due ' + when_due if when_due else ''
            if any(r.get('knownExploited') for r in rows):
                line += ' | known exploited'
            if all(assessed(r, now) for r in rows):
                line += ' | reviewed not reachable'
            paste_rows.append('- ' + line)
    return {'needs': needs, 'fixed': auto_fixed, 'waiting': waiting, 'unchecked': unchecked,
            'rawNeeds': raw_needs, 'rawWaiting': raw_waiting,
            'pasteRows': paste_rows, 'rawCount': len(raw), 'reviewedCount': len(reviewed), 'packageCount': len(packages),
            'groupCount': len(grouped)}


def quiet_fingerprint(state):
    """A new vendor-blocked item is news once. Its unchanged repeats wait for the weekly mail."""
    rows = sorted(item['what'] for item in state['waiting'])
    return hashlib.sha256(json.dumps(rows).encode()).hexdigest() if rows else None


def document(state, host, now, weekly):
    needs = list(state['needs'])
    waiting = list(state['waiting'])
    notes = []
    if weekly:
        needs += state['rawNeeds']
        waiting += state['rawWaiting']
        if state['rawCount']:
            notes.append('Scanner matches are not confirmed incidents. Check vendor guidance and real exposure '
                         'before a rollout, and keep the original deadlines.')
    elif state['rawCount']:
        notes.append('%d unreviewed scanner matches stay in the ledger with their deadlines. '
                     'They are summarised in the weekly review.' % state['rawCount'])
    if state['reviewedCount']:
        notes.append('%d scanner matches have a current reviewed assessment and stay in the ledger.'
                     % state['reviewedCount'])
    doc = {'title': 'Daily digest', 'host': host, 'ledger': LEDGER, 'notes': notes,
           # Auto-fixes ride along in a digest that is due anyway; they never send one.
           'sections': {'needs': needs, 'fixed': state.get('fixed', []), 'waiting': waiting,
                        'unchecked': state['unchecked']},
           'footer': ['This host sends one digest a day while something is open. No mail means nothing is open.',
                      'Server access remains Tailscale-only.']}
    if state['pasteRows']:
        doc['paste'] = {
            'instruction': 'Help me fix these Hatchkit findings. Check vendor guidance first, keep every '
                           'deadline, never suppress a finding, and list each change you make.',
            'meta': ['Host: ' + host, 'Generated: ' + when(now.isoformat()), 'Ledger: ' + LEDGER,
                     'Inspect updates: ' + updates_command(host), 'Inspect integrity: ' + integrity_command(host),
                     'Inspect backups: ' + backup_command(host),
                     'Image package rows in ledger: %d, grouped here into %d lines' % (state['packageCount'], state['groupCount'])],
            'rows': state['pasteRows'], 'ledger': LEDGER}
    return doc


def subject_for(doc):
    from hatchkit_mail import summary_line
    return '[Hatchkit] ' + doc['host'] + ': ' + summary_line(doc)


def run(config, work, send, host, now=None, backup_issues=(), units=UNITS):
    """Send at most one digest per digest day. A failed send retries at the next hourly run."""
    now = now or dt.datetime.now(dt.timezone.utc)
    settings = config.get('alerts')
    if not settings or not settings.get('enabled', True):
        return {'configured': False, 'sent': False}
    path = work / STATUS_NAME
    previous = read_json(path) or {}
    day, week = day_key(now), week_key(now)
    state = collect(work, host, now, list(backup_issues), units)
    last_week = previous.get('lastWeeklyReviewKey')
    if not last_week:
        # An upgrade must not repeat the review the update watch already sent this week.
        last_week = (read_json(work / 'update-watch-status.json') or {}).get('lastWeeklyReviewKey')
    has_raw = bool(state['rawNeeds'] or state['rawWaiting'])
    weekly = has_raw and week != last_week
    fingerprint = quiet_fingerprint(state)
    new_waiting = bool(fingerprint) and fingerprint != previous.get('quietFingerprint')
    active = bool(state['needs'] or state['unchecked'] or new_waiting)
    due = day != previous.get('evaluatedDay')
    record = {'checkedAt': now.isoformat(timespec='seconds'), 'ok': True, 'evaluatedDay': previous.get('evaluatedDay'),
              'lastSentAt': previous.get('lastSentAt'), 'lastWeeklyReviewKey': last_week,
              'lastWeeklyReviewAt': previous.get('lastWeeklyReviewAt'),
              'quietFingerprint': previous.get('quietFingerprint'), 'messageId': previous.get('messageId'),
              'mailed': None}
    result = {'configured': True, 'sent': False, 'kind': None}
    failure = None
    if due:
        if active or weekly:
            doc = document(state, host, now, weekly)
            try:
                record['messageId'] = send(settings, subject_for(doc), doc)
                record.update(mailed='digest', evaluatedDay=day, lastSentAt=now.isoformat(timespec='seconds'),
                              quietFingerprint=fingerprint)
                if weekly:
                    record.update(lastWeeklyReviewKey=week, lastWeeklyReviewAt=now.isoformat(timespec='seconds'))
                result.update(sent=True, kind='digest')
            except Exception as error:  # SMTP errors may echo login details; keep the type only
                failure = error
                record.update(ok=False, mailError=type(error).__name__)
                result['mailError'] = type(error).__name__
        else:
            record.update(evaluatedDay=day, quietFingerprint=fingerprint)
    temporary = work / (STATUS_NAME + '.tmp')
    temporary.write_text(json.dumps(record, indent=2) + '\n')
    temporary.replace(path)
    if failure is not None:
        raise failure
    return result
