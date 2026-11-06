#!/usr/bin/env python3
"""Rebuild opted-in app images on a fresh base image when the scanner reports fixes.

The image scanner finds OS packages in app images whose fix is already published:
Debian or Alpine shipped a new curl or libc, but the running image was built before
it. Rebuilding the same commit with a re-pulled base image and no layer cache picks
the fix up. This runner does that for apps the operator listed, and nothing else.

What it does, once an hour:

  1. Reads the update-watch ledger (never writes it) and the running containers.
  2. Picks at most one opted-in app whose CURRENT image has image-package rows
     with a reported fix, within the rate limits below.
  3. Dispatches that app's own rebuild workflow on GitHub. The payload carries no
     package data: only the ref and the inputs the operator configured. The
     workflow rebuilds the live commit with `--pull --no-cache`, runs the app's
     tests, deploys, checks health and rolls back to the previous image itself.
  4. Follows the run on later passes. A successful run counts only once this host
     runs a different image for the app AND the scanner has covered it. The
     digest then lists the app under "Fixed automatically".

Deliberately conservative:

  · Opt-in per image repository, in a root-only config file. No inference.
  · Databases and anything with a writable mount are refused, whatever the config
    says: a rebuild is a restart, and a stateful service needs a reviewed upgrade.
  · One dispatch per pass, a per-day cap across all apps, a minimum interval per
    app, and a seven-day pause when the last rebuild left the same fixes behind
    (the fix is not in the base image yet; rebuilding again changes nothing).
  · A failed, cancelled or unverified rebuild pauses that app until the operator
    clears it. The digest says so every day until then.
  · It never resets a deadline, never edits or hides a finding. The rows of the
    old image clear only because the next scan no longer sees that image, and the
    rows the rebuild did not fix keep their original clocks in the ledger.

Run modes: `run` (the timer), `plan` (read-only: what `run` would dispatch),
`status` (print the state file), `clear <image>` (unpause one app).
"""
import argparse
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

CONFIG = Path('/etc/hatchkit-security/image-rebuilds.json')
TOKEN = Path('/etc/hatchkit-security/image-rebuild-github-token')
WORK = Path('/var/lib/hatchkit-backups')
STATE_NAME = 'image-rebuild-status.json'
LEDGER_NAME = 'update-watch-status.json'
SCAN_NAME = 'image-vulnerability-status.json'
API = 'https://api.github.com'

DEFAULT_INTERVAL = dt.timedelta(hours=24)
MIN_INTERVAL = dt.timedelta(hours=12)
DEFAULT_PER_DAY = 2
MAX_PER_DAY = 5
SAME_FIXES_PAUSE = dt.timedelta(days=7)
LEDGER_MAX_AGE = dt.timedelta(hours=26)
RUN_NOT_FOUND_AFTER = dt.timedelta(minutes=30)
RUN_TIMEOUT = dt.timedelta(hours=8)
LAND_GRACE = dt.timedelta(hours=2)
ATTEMPTS_KEPT = 10
RESPONSE_LIMIT = 2 * 1024 * 1024

TERMINAL = {'landed', 'failed', 'not-landed', 'dispatch-failed'}
PAUSING = {'failed', 'not-landed', 'dispatch-failed'}

# Never rebuilt automatically, whatever the config says. Matched against the
# image repository's last path segment.
STATEFUL = re.compile(r'(^|[._-])(postgres|postgis|pg|mysql|mariadb|mongo|mongodb|redis|valkey|keydb|clickhouse|'
                      r'elasticsearch|opensearch|meilisearch|typesense|minio|seaweedfs|rabbitmq|kafka|nats|etcd|'
                      r'couchdb|cassandra|influxdb|timescaledb|db|database)([._-]|$)', re.I)
IMAGE = re.compile(r'ghcr\.io/[a-z0-9](?:[a-z0-9-]{0,38})/[a-z0-9][a-z0-9._/-]{0,127}')
REPO = re.compile(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}')
WORKFLOW = re.compile(r'[A-Za-z0-9._-]{1,100}\.ya?ml')
REF = re.compile(r'[A-Za-z0-9._/-]{1,100}')
INPUT_KEY = re.compile(r'[A-Za-z_][A-Za-z0-9_-]{0,63}')


class ConfigError(ValueError):
    pass


def now_utc():
    return dt.datetime.now(dt.timezone.utc)


def stamp(value):
    return value.isoformat(timespec='seconds')


def parse_time(value):
    try:
        parsed = dt.datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo else None


def read_json(path):
    try:
        value = json.loads(Path(path).read_text())
        return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


def write_state(state, work=None):
    path = (work or WORK) / STATE_NAME
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(state, indent=2) + '\n')
    temporary.chmod(0o600)
    temporary.replace(path)


# ── config ───────────────────────────────────────────────────────────────

def load_config(raw):
    """Validate the operator's opt-in list. Returns (apps, refused, per_day).

    A malformed file is an error, not an empty list: a typo must not look like
    "no app opted in". A stateful image is refused per entry, so one bad entry
    does not stop the others.
    """
    if not isinstance(raw, dict) or raw.get('version') != 1 or not isinstance(raw.get('apps'), list):
        raise ConfigError('expected {"version": 1, "apps": [...]}')
    per_day = raw.get('maxDispatchesPerDay', DEFAULT_PER_DAY)
    if not isinstance(per_day, int) or isinstance(per_day, bool) or not 1 <= per_day <= MAX_PER_DAY:
        raise ConfigError('maxDispatchesPerDay must be an integer from 1 to %d' % MAX_PER_DAY)
    apps, refused, seen = [], [], set()
    for index, entry in enumerate(raw['apps']):
        where = 'apps[%d]' % index
        if not isinstance(entry, dict):
            raise ConfigError(where + ' is not an object')
        unknown = set(entry) - {'image', 'repo', 'workflow', 'ref', 'inputs', 'minIntervalHours', 'note'}
        if unknown:
            raise ConfigError(where + ' has unknown keys: ' + ', '.join(sorted(unknown)))
        image, repo = entry.get('image'), entry.get('repo')
        workflow, ref = entry.get('workflow'), entry.get('ref', 'main')
        if not isinstance(image, str) or not IMAGE.fullmatch(image):
            raise ConfigError(where + '.image must be a ghcr.io repository without a tag')
        if image in seen:
            raise ConfigError(where + '.image is listed twice')
        seen.add(image)
        if not isinstance(repo, str) or not REPO.fullmatch(repo):
            raise ConfigError(where + '.repo must be owner/name')
        if not isinstance(workflow, str) or not WORKFLOW.fullmatch(workflow):
            raise ConfigError(where + '.workflow must be a workflow file name')
        if not isinstance(ref, str) or not REF.fullmatch(ref) or '..' in ref:
            raise ConfigError(where + '.ref must be a branch name')
        inputs = entry.get('inputs', {})
        if (not isinstance(inputs, dict) or len(inputs) > 10
                or not all(isinstance(k, str) and INPUT_KEY.fullmatch(k) and isinstance(v, str) and len(v) <= 200
                           for k, v in inputs.items())):
            raise ConfigError(where + '.inputs must map up to 10 names to short strings')
        hours = entry.get('minIntervalHours', DEFAULT_INTERVAL.total_seconds() / 3600)
        if not isinstance(hours, (int, float)) or isinstance(hours, bool) or hours > 24 * 30:
            raise ConfigError(where + '.minIntervalHours must be a number of hours')
        interval = max(dt.timedelta(hours=hours), MIN_INTERVAL)
        if STATEFUL.search(image.rsplit('/', 1)[-1]):
            refused.append({'image': image, 'reason': 'looks like a database or other stateful service'})
            continue
        apps.append({'image': image, 'repo': repo, 'workflow': workflow, 'ref': ref,
                     'inputs': dict(inputs), 'interval': interval})
    return apps, refused, per_day


# ── host inventory ───────────────────────────────────────────────────────

def docker(argv, timeout=60):
    result = subprocess.run(['docker', *argv], capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError('docker ' + argv[0] + ' failed (exit %d)' % result.returncode)
    return result.stdout


def repository_of(reference):
    """`ghcr.io/o/r:live`, `ghcr.io/o/r@sha256:…` → `ghcr.io/o/r`. A colon is a tag
    only after the last slash, so a registry port survives."""
    reference = (reference or '').split('@', 1)[0]
    head, _, tail = reference.rpartition('/')
    if ':' in tail:
        tail = tail.split(':', 1)[0]
    return (head + '/' + tail) if head else tail


def containers(run=docker):
    """Name, image ID, image repository and mounts of every running container.

    Reads only those fields: never the environment or the command line.
    """
    ids = run(['ps', '-q']).split()
    if not ids:
        return []
    fmt = '{{json .Name}}\t{{json .Image}}\t{{json .Config.Image}}\t{{json .Mounts}}'
    found = []
    for line in run(['inspect', '--format', fmt, *ids]).splitlines():
        name, image_id, reference, mounts = (json.loads(part) for part in line.split('\t'))
        found.append({'name': name.lstrip('/'), 'imageId': image_id, 'repository': repository_of(reference),
                      'mounts': [{'type': m.get('Type'), 'rw': bool(m.get('RW')), 'destination': m.get('Destination')}
                                 for m in mounts or []]})
    return found


def writable_mounts(app_containers):
    return sorted({c['name'] + ':' + str(m['destination']) for c in app_containers for m in c['mounts']
                   if m['rw'] and m['type'] in ('volume', 'bind')})


def fix_rows(ledger, image_ids):
    """Image-package rows with a reported fix, on the images running now.

    Rows of an image that is no longer running are not this app's problem any
    more; the next scan drops them by itself.
    """
    return [f for f in (ledger.get('findings') or []) if f.get('kind') == 'image-package'
            and f.get('fixed') and f.get('service') in image_ids]


def identities(rows):
    return sorted({(r.get('id') or '', r.get('name') or '') for r in rows})


def earliest_due(rows):
    due = [parse_time(r.get('dueAt')) for r in rows]
    due = [d for d in due if d]
    return min(due) if due else None


# ── GitHub ───────────────────────────────────────────────────────────────

class GitHubError(RuntimeError):
    def __init__(self, what, status=None):
        super().__init__(what + (' (HTTP %d)' % status if status else ''))
        self.status = status


def github(token, method, path, body=None, timeout=20):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(API + path, data=data, method=method, headers={
        'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'hatchkit-image-rebuilds',
        **({'Content-Type': 'application/json'} if data else {})})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = response.read(RESPONSE_LIMIT + 1)
    except urllib.error.HTTPError as error:
        # The body is GitHub's message; keep only the status so nothing echoed lands in mail.
        raise GitHubError(method + ' ' + path.split('?')[0], error.code) from None
    except (urllib.error.URLError, OSError) as error:
        raise GitHubError(method + ' ' + path.split('?')[0] + ': ' + type(error).__name__) from None
    if len(payload) > RESPONSE_LIMIT:
        raise GitHubError(method + ' ' + path.split('?')[0] + ': oversized response')
    return json.loads(payload) if payload.strip() else {}


def dispatch(call, app):
    workflow = urllib.parse.quote(app['workflow'], safe='')
    call('POST', '/repos/%s/actions/workflows/%s/dispatches' % (app['repo'], workflow),
         {'ref': app['ref'], 'inputs': app['inputs']})


def find_run(call, attempt, claimed):
    since = parse_time(attempt['dispatchedAt']) - dt.timedelta(minutes=1)
    query = urllib.parse.urlencode({'event': 'workflow_dispatch', 'branch': attempt['ref'], 'per_page': 20,
                                    'created': '>=' + since.strftime('%Y-%m-%dT%H:%M:%SZ')})
    workflow = urllib.parse.quote(attempt['workflow'], safe='')
    runs = call('GET', '/repos/%s/actions/workflows/%s/runs?%s' % (attempt['repo'], workflow, query)).get('workflow_runs') or []
    candidates = sorted((r for r in runs if isinstance(r.get('id'), int) and r['id'] not in claimed),
                        key=lambda r: r.get('created_at') or '')
    return candidates[0] if candidates else None


# ── one pass ─────────────────────────────────────────────────────────────

def app_view(app, inventory, ledger):
    mine = [c for c in inventory if c['repository'] == app['image']]
    image_ids = sorted({c['imageId'] for c in mine})
    rows = fix_rows(ledger, set(image_ids))
    # Coolify names containers by UUID; the ledger carries the readable name next to each.
    display = {}
    for row in (ledger or {}).get('findings') or []:
        for name, shown in zip(row.get('containers') or [], row.get('containerDisplayNames') or []):
            if isinstance(name, str) and isinstance(shown, str) and shown:
                display.setdefault(name, shown)
    return {'containers': mine, 'imageIds': image_ids, 'rows': rows,
            'workloads': sorted({display.get(c['name'], c['name']) for c in mine}), 'writable': writable_mounts(mine)}


def scanned_after(scan, image_ids, moment):
    """The scanner has a complete report for every image ID, newer than `moment`."""
    if not scan or scan.get('complete') is not True:
        return False
    covered = {}
    for row in scan.get('images') or []:
        covered[row.get('image')] = parse_time(row.get('scannedAt'))
    checked = parse_time(scan.get('checkedAt'))
    return bool(image_ids) and checked is not None and checked > moment and all(
        covered.get(image) is not None for image in image_ids)


def follow(attempt, view, ledger, scan, call, claimed, now):
    """Advance one non-terminal attempt. Returns nothing; edits `attempt`."""
    if attempt['status'] == 'dispatched':
        run = find_run(call, attempt, claimed)
        if not run:
            if now - parse_time(attempt['dispatchedAt']) > RUN_NOT_FOUND_AFTER:
                attempt.update(status='failed', reason='GitHub accepted the dispatch but no run started',
                               completedAt=stamp(now))
            return
        attempt.update(status='running', runId=run['id'], runUrl=run.get('html_url'))
        claimed.add(run['id'])
    if attempt['status'] == 'running':
        run = call('GET', '/repos/%s/actions/runs/%d' % (attempt['repo'], attempt['runId']))
        if run.get('status') != 'completed':
            if now - parse_time(attempt['dispatchedAt']) > RUN_TIMEOUT:
                attempt.update(status='failed', reason='the run did not finish within 8 hours', completedAt=stamp(now))
            return
        attempt['conclusion'] = run.get('conclusion')
        attempt['completedAt'] = stamp(parse_time(run.get('updated_at')) or now)
        if run.get('conclusion') == 'success':
            attempt['status'] = 'succeeded'
        else:
            attempt.update(status='failed', reason='the run ended ' + str(run.get('conclusion') or 'without a conclusion')
                           + '; the workflow restores the previous image on a failed deploy')
            return
    if attempt['status'] == 'succeeded':
        completed = parse_time(attempt['completedAt'])
        before = set(attempt.get('imageIdsBefore') or [])
        current = view['imageIds']
        changed = bool(current) and not (set(current) & before)
        if changed and scanned_after(scan, current, completed) and (parse_time(ledger.get('checkedAt')) or completed) > completed:
            after = view['rows']
            attempt.update(status='landed', verifiedAt=stamp(now), imageIdsAfter=current,
                           fixCountAfter=len(after), fixesAfter=[list(i) for i in identities(after)])
        elif not changed and now - completed > LAND_GRACE:
            attempt.update(status='not-landed',
                           reason='the run succeeded but this host still runs the previous image')


def paused(attempts):
    last = attempts[-1] if attempts else None
    if last and last['status'] in PAUSING and not last.get('cleared'):
        return last
    return None


def blocked_by_same_fixes(attempts, rows, now):
    """The last rebuild landed and left exactly these fixes behind: the base image
    does not carry them yet. Try again after a week, or sooner if a new fix shows up."""
    landed = [a for a in attempts if a['status'] == 'landed']
    if not landed:
        return False
    last = landed[-1]
    left = {tuple(i) for i in last.get('fixesAfter') or []}
    verified = parse_time(last.get('verifiedAt'))
    return bool(left) and set(identities(rows)) <= left and verified and now - verified < SAME_FIXES_PAUSE


def plan(apps, state, inventory, ledger, now, per_day):
    """Decide what this pass may dispatch. Pure: no I/O."""
    decisions = []
    recent = sum(1 for record in state['apps'].values() for a in record.get('attempts') or []
                 if (parse_time(a.get('dispatchedAt')) or now) > now - dt.timedelta(hours=24))
    for app in apps:
        view = app_view(app, inventory, ledger)
        attempts = state['apps'].get(app['image'], {}).get('attempts') or []
        last = attempts[-1] if attempts else None
        reason = None
        if not view['containers']:
            reason = 'not running on this host'
        elif view['writable']:
            reason = 'has writable mounts (' + ', '.join(view['writable'][:3]) + '); stateful services are not rebuilt'
        elif not view['rows']:
            reason = 'no fixable scanner matches on the running image'
        elif last and last['status'] not in TERMINAL:
            reason = 'a rebuild is in progress'
        elif paused(attempts):
            reason = 'paused after a failed rebuild'
        elif last and now - parse_time(last['dispatchedAt']) < app['interval']:
            reason = 'rebuilt less than %d hours ago' % (app['interval'].total_seconds() // 3600)
        elif blocked_by_same_fixes(attempts, view['rows'], now):
            reason = 'the last rebuild left these fixes behind; waiting for the base image'
        decisions.append({'app': app, 'view': view, 'reason': reason})
    eligible = sorted((d for d in decisions if d['reason'] is None),
                      key=lambda d: (earliest_due(d['view']['rows']) or now + dt.timedelta(days=3650), d['app']['image']))
    chosen = None
    if eligible:
        if recent >= per_day:
            for d in eligible:
                d['reason'] = 'daily limit of %d rebuilds reached' % per_day
        else:
            chosen = eligible[0]
            for d in eligible[1:]:
                d['reason'] = 'one rebuild per pass; queued for the next pass'
    return chosen, decisions


def summary(decisions, chosen):
    return [{'image': d['app']['image'], 'repo': d['app']['repo'], 'workloads': d['view']['workloads'],
             'fixCount': len(d['view']['rows']), 'action': 'dispatch' if d is chosen else 'skip',
             **({'reason': d['reason']} if d is not chosen else {})} for d in decisions]


def run_pass(now, config_raw, token, inventory, ledger, scan, previous, call, dry_run=False):
    """One timer pass. Returns the new state. Never touches the ledger."""
    state = {'checkedAt': stamp(now), 'ok': True, 'error': None, 'refused': [], 'decisions': [],
             'apps': {k: v for k, v in ((previous or {}).get('apps') or {}).items() if isinstance(v, dict)}}
    try:
        apps, refused, per_day = load_config(config_raw)
    except ConfigError as error:
        state.update(ok=False, error='The rebuild config is invalid: ' + str(error) + '.')
        return state
    state['refused'] = refused
    for app in apps:
        record = state['apps'].setdefault(app['image'], {'attempts': []})
        record.update(repo=app['repo'], workflow=app['workflow'])
    if token is None and not dry_run:
        state.update(ok=False, error='The GitHub token file is missing, so no rebuild can be dispatched or followed.')
        return state

    checked = parse_time((ledger or {}).get('checkedAt'))
    if not ledger or checked is None or not -dt.timedelta(minutes=5) <= now - checked <= LEDGER_MAX_AGE:
        state.update(ok=False, error='The update-watch ledger is missing or older than 26 hours; nothing was dispatched.')
        return state

    claimed = {a.get('runId') for r in state['apps'].values() for a in r.get('attempts') or [] if a.get('runId')}
    by_image = {app['image']: app for app in apps}
    for image, record in state['apps'].items():
        app = by_image.get(image)
        for attempt in record.get('attempts') or []:
            if attempt['status'] in TERMINAL or dry_run:
                continue
            view = app_view(app or {'image': image}, inventory, ledger)
            try:
                follow(attempt, view, ledger, scan, call, claimed, now)
            except GitHubError as error:
                attempt['lastError'] = str(error)

    chosen, decisions = plan(apps, state, inventory, ledger, now, per_day)
    state['decisions'] = summary(decisions, chosen)
    if chosen is None or dry_run:
        return state
    app, view = chosen['app'], chosen['view']
    attempt = {'dispatchedAt': stamp(now), 'repo': app['repo'], 'workflow': app['workflow'], 'ref': app['ref'],
               'workloads': view['workloads'], 'imageIdsBefore': view['imageIds'], 'fixCountBefore': len(view['rows']),
               'fixesBefore': [list(i) for i in identities(view['rows'])], 'status': 'dispatched'}
    try:
        dispatch(call, app)
    except GitHubError as error:
        attempt.update(status='dispatch-failed', reason=str(error), completedAt=stamp(now))
    record = state['apps'][app['image']]
    record['attempts'] = (record.get('attempts') or [])[-(ATTEMPTS_KEPT - 1):] + [attempt]
    return state


def clear(previous, image, now):
    record = ((previous or {}).get('apps') or {}).get(image)
    last = paused((record or {}).get('attempts') or [])
    if not last:
        return False
    last.update(cleared=True, clearedAt=stamp(now))
    return True


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('mode', choices=['run', 'plan', 'status', 'clear'])
    parser.add_argument('image', nargs='?')
    args = parser.parse_args(argv)
    os.umask(0o077)
    previous = read_json(WORK / STATE_NAME) or {}
    if args.mode == 'status':
        print(json.dumps(previous, indent=2))
        return 0
    if args.mode == 'clear':
        if not args.image:
            parser.error('clear needs the image repository, e.g. ghcr.io/owner/app-server')
        with (WORK / '.image-rebuilds.lock').open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            previous = read_json(WORK / STATE_NAME) or {}
            if not clear(previous, args.image, now_utc()):
                print(json.dumps({'cleared': False, 'reason': 'no paused rebuild for ' + args.image}))
                return 1
            write_state(previous)
        print(json.dumps({'cleared': True, 'image': args.image}))
        return 0

    config_raw = read_json(CONFIG)
    try:
        token = TOKEN.read_text().strip() or None
    except OSError:
        token = None
    call = (lambda method, path, body=None: github(token, method, path, body)) if token else None
    with (WORK / '.image-rebuilds.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            inventory = containers()
            state = run_pass(now_utc(), config_raw, token, inventory, read_json(WORK / LEDGER_NAME),
                             read_json(WORK / SCAN_NAME), previous, call, dry_run=args.mode == 'plan')
        except Exception as error:  # keep the type only; never echo command output
            state = dict(previous, checkedAt=stamp(now_utc()), ok=False,
                         error='The rebuild runner crashed: ' + type(error).__name__ + '.')
        if args.mode == 'plan':
            print(json.dumps({'decisions': state.get('decisions'), 'refused': state.get('refused'),
                              'error': state.get('error')}, indent=2))
            return 0
        write_state(state)
    print(json.dumps({'ok': state['ok'], 'error': state.get('error'),
                      'dispatched': [d['image'] for d in state.get('decisions') or [] if d['action'] == 'dispatch']}))
    return 0 if state['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
