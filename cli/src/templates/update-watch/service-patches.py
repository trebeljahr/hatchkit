#!/usr/bin/env python3
"""Apply patch releases of third-party services, with a canary and rollback.

Coolify's proxy (Traefik), Uptime Kuma and the Postgres containers of shared
services run plain official images. A patch release (Traefik/Kuma: same
major.minor, higher patch) is applied here without asking, so the owner hears
about it only when it cannot be done automatically. Postgres counts a higher
minor of the same major (18.6 -> 18.7, same on-disk format) and an upstream
rebuild of the running tag (same tag, new digest: Alpine package fixes) as a
patch. Never a major jump, never an app image.

What `run` does, once an hour:

  1. Reads the update-watch ledger (never writes it) for advisories against the
     configured services, and Docker Hub for the newest patch tag of the running
     major.minor.
  2. Patches a target when a newer patch exists AND either an advisory finding is
     fixed by it (at once), or the release is at least `minAgeHours` old and the
     hour is inside the quiet `window` (UTC).
  3. Canary: the new image runs first with no network, on the live configuration
     (Traefik: the same command and read-only mounts, its own health test; Kuma: a
     copy of the data volume, the same user and limits, the image's health check,
     and the monitor/user/notification counts).
  4. Swap, verified:
       Traefik — every routed hostname is fetched through 127.0.0.1:443 before and
       after; the proxy's runtime-attached networks are captured before the
       recreate and reconnected right after it (a plain compose recreate drops
       them and every site hangs). The container-policy imageId pin follows the
       new image; the rewritten policy's hash is recorded so file-integrity
       accepts exactly that change.
       Kuma — stopped, its volume snapshotted, recreated on the new tag; healthy,
       same counts, its URL answers.
       Postgres — the new image must report the same major. Stopped cleanly,
       its volume snapshotted; the old image and then the new image each start
       on a copy of the snapshot with no network, and every database must
       hold the same tables with the same exact row counts in both. Then
       recreated on the new digest (imageId pin follows, as for Traefik);
       healthy, the same tables in every database, listed clients healthy.
  5. Any failed check rolls back to the previous compose file, image and policy
     (Kuma: also the data snapshot; Postgres: none needed, a minor release of
     one major reads the same data directory) and pauses that target until
     `clear`.
     The daily digest lists landed patches under Fixed automatically and failures
     under Needs you.

`sync-coolify` (Coolify hosts only, part of `run` when configured): Coolify keeps
its own copy of the proxy compose and of each service compose and rewrites the
host file from it on a proxy restart or redeploy. When a host file differs from
Coolify's copy by exactly the image line and the container runs that image, the
copy is updated (with its change hashes) so a Coolify restart keeps the patch.
Anything else is refused and reported.

Run modes: `run`, `plan` (read-only), `status`, `clear <target>`,
`sync-coolify [--apply]`, and for operator tests
`run --target <t> --to <tag> [--force-rollback]`.
"""
import argparse
import base64
import concurrent.futures
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request

CONFIG = Path('/etc/hatchkit-security/service-patches.json')
WORK = Path('/var/lib/hatchkit-backups')
STATE_NAME = 'service-patch-status.json'
LEDGER_NAME = 'update-watch-status.json'
POLICY = Path('/etc/hatchkit-security/container-policy.json')
# file-integrity.py accepts a container-policy change only with the hash recorded here.
POLICY_RECORD = WORK / 'service-patch-policy.json'
SNAPSHOTS = Path('/var/lib/hatchkit-service-patches')
LOCK = Path('/run/hatchkit-service-patches.lock')
HUB = 'https://hub.docker.com/v2/repositories/'

# What each kind may run. The tag pattern is the whole patch family; anything else
# (rc, nightly, a different variant) never matches.
KINDS = {
    'traefik': {'repository': 'library/traefik', 'image': 'traefik', 'watch': 'traefik',
                'tag': r'v(\d+)\.(\d+)\.(\d+)', 'line': r'traefik[:@]'},
    'kuma': {'repository': 'louislam/uptime-kuma', 'image': 'louislam/uptime-kuma', 'watch': 'uptime-kuma',
             'tag': r'(\d+)\.(\d+)\.(\d+)-rootless', 'line': r'louislam/uptime-kuma:'},
    # major.minor-alpine only: '18-alpine' floats and 'alpine3.24' pins a base we would never leave.
    'postgres': {'repository': 'library/postgres', 'image': 'postgres', 'watch': None,
                 'tag': r'(\d+)\.(\d+)-alpine', 'line': r'postgres[:@]'},
}
POSTGRES_REF = re.compile(r'postgres:(?P<tag>\d+\.\d+-alpine)@(?P<digest>sha256:[0-9a-f]{64})')
BAD_STATUS = ('000', '502', '503', '504')
IMAGE_LINE = re.compile(r'^(?P<indent>[ \t]+)image:[ \t]*(?P<q>[\'"]?)(?P<ref>[^\'"\s]+)(?P=q)[ \t]*$', re.M)
COOLIFY_ROOT = '/var/www/html'


class PatchError(Exception):
    pass


def now_utc():
    return dt.datetime.now(dt.timezone.utc)


def iso(value):
    return value.isoformat(timespec='seconds')


def run(args, timeout=120, check=False, input=None, cwd=None):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout, input=input, cwd=cwd)
    if check and result.returncode:
        raise PatchError('%s failed: %s' % (' '.join(args[:3]), (result.stderr or result.stdout).strip()[-200:]))
    return result


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return default


def write_atomic(path, text, mode=None):
    path = Path(path)
    temp = path.with_name('.' + path.name + '.tmp')
    temp.write_text(text)
    if path.exists():
        shutil.copystat(path, temp)
    elif mode is not None:
        temp.chmod(mode)
    os.replace(temp, path)


# ---------------------------------------------------------------- versions

def parse_version(text):
    match = re.search(r'(\d+)\.(\d+)\.(\d+)', text or '')
    return tuple(int(x) for x in match.groups()) if match else None


def tag_version(kind, tag):
    match = re.fullmatch(KINDS[kind]['tag'], tag or '')
    return tuple(int(x) for x in match.groups()) if match else None


def pick_patch(kind, current, tags):
    """Newest tag of the same major.minor with a higher patch, or None."""
    best = None
    for tag in tags:
        version = tag_version(kind, tag['name'])
        if version and version[:2] == current[:2] and version[2] > current[2]:
            if best is None or version > best[0]:
                best = (version, tag)
    return best


def fmt(version):
    return '.'.join(str(part) for part in version)


def same_line(kind, a, b):
    """Postgres keeps its data format within a major; the others within a minor."""
    return a[:1] == b[:1] if kind == 'postgres' else a[:2] == b[:2]


def pick_postgres(current, digest, tags):
    """Highest minor of the running major; at the running minor only a new digest counts."""
    best = None
    for tag in tags:
        version = tag_version('postgres', tag['name'])
        if not version or version[0] != current[0] or version < current:
            continue
        if version == current and (not tag.get('digest') or tag['digest'] == digest):
            continue
        if best is None or version > best[0]:
            best = (version, tag)
    return best


def advisories_for(ledger, kind, current):
    """Advisory findings of the update watcher against this service and version."""
    if not KINDS[kind]['watch']:
        return []
    rows = []
    for finding in (ledger or {}).get('findings') or []:
        if finding.get('kind') != 'advisory' or finding.get('service') != KINDS[kind]['watch']:
            continue
        if parse_version(finding.get('version')) not in (None, current):
            continue
        fixes = [parse_version(part) for part in str(finding.get('fixed') or '').split(',')]
        same = sorted(v for v in fixes if v and v[:2] == current[:2] and v > current)
        rows.append({'id': finding.get('id') or finding.get('cve') or 'advisory',
                     'severity': finding.get('severity'), 'fixedIn': same[0] if same else None})
    return rows


def decide(kind, current, candidate, advisories, state, now, config, forced=None):
    """-> (action, reason, fixes); action is 'patch', 'wait', 'none' or 'paused'."""
    if forced is not None:
        return 'patch', 'operator run', []
    if (state or {}).get('paused'):
        return 'paused', 'paused after a failed attempt; clear it after review', []
    if candidate is None:
        return 'none', 'no newer patch release of %s' % fmt(current[:2]), []
    version, tag = candidate
    fixes = [a['id'] for a in advisories if a['fixedIn'] and a['fixedIn'] <= version]
    if fixes:
        return 'patch', 'fixes ' + ', '.join(sorted(fixes)), sorted(fixes)
    try:
        published = dt.datetime.fromisoformat((tag.get('last_updated') or '').replace('Z', '+00:00'))
    except ValueError:
        return 'wait', 'release date unknown', []
    min_age = dt.timedelta(hours=float(config.get('minAgeHours', 24)))
    if now - published < min_age:
        return 'wait', 'released %s, waiting %s' % (iso(published), min_age), []
    start, end = config.get('window', [3, 5])
    if not start <= now.hour < end:
        return 'wait', 'outside the %02d:00-%02d:00 UTC window' % (start, end), []
    return 'patch', 'patch release', []


# ---------------------------------------------------------------- compose files

def image_line(text, kind):
    """The one image line of this kind in a compose file -> match, or raise."""
    hits = [m for m in IMAGE_LINE.finditer(text) if re.match(KINDS[kind]['line'], m.group('ref'))]
    if len(hits) != 1:
        raise PatchError('expected one %s image line, found %d' % (kind, len(hits)))
    return hits[0]


def replace_image(text, kind, new_ref):
    match = image_line(text, kind)
    line = "%simage: '%s'" % (match.group('indent'), new_ref)
    return text[:match.start()] + line + text[match.end():], match.group('ref')


# ---------------------------------------------------------------- docker

def inspect(name):
    result = run(['docker', 'inspect', name])
    if result.returncode:
        return None
    return json.loads(result.stdout)[0]


def image_id(ref):
    result = run(['docker', 'image', 'inspect', '-f', '{{.Id}}', ref])
    return result.stdout.strip() if result.returncode == 0 else None


def health(name):
    data = inspect(name) or {}
    state = data.get('State') or {}
    return {'status': (state.get('Health') or {}).get('Status') or state.get('Status'),
            'running': state.get('Running'), 'image': data.get('Image'), 'restarts': data.get('RestartCount')}


def wait_healthy(name, want_image, seconds, sleep=time.sleep):
    deadline = time.monotonic() + seconds
    last = {}
    while time.monotonic() < deadline:
        last = health(name)
        if last['status'] == 'healthy' and (want_image is None or last['image'] == want_image):
            return True, last
        if last['status'] in ('exited', 'dead', 'unhealthy') or last['running'] is False:
            return False, last
        sleep(3)
    return False, last


def hub_tags(kind, prefix, fetch=None):
    repo = KINDS[kind]['repository']
    url = HUB + repo + '/tags?' + urllib.parse.urlencode({'page_size': 100, 'name': prefix})
    tags = []
    for _ in range(5):
        if fetch:
            page = fetch(url)
        else:
            request = urllib.request.Request(url, headers={'User-Agent': 'hatchkit-service-patches'})
            with urllib.request.urlopen(request, timeout=30) as response:
                page = json.loads(response.read(4 * 1024 * 1024))
        tags += [{'name': t.get('name'), 'digest': t.get('digest'), 'last_updated': t.get('last_updated')}
                 for t in page.get('results') or []]
        url = page.get('next')
        if not url or not url.startswith(HUB):
            break
    return tags


def pull(ref):
    run(['docker', 'pull', '-q', ref], timeout=600, check=True)
    found = image_id(ref)
    if not found:
        raise PatchError('pulled image %s is not present' % ref)
    return found


# ---------------------------------------------------------------- routes (Traefik)

def routed_hosts(proxy_dir):
    hosts = set()
    names = run(['docker', 'ps', '--format', '{{.Names}}']).stdout.split()
    for name in names:
        labels = ((inspect(name) or {}).get('Config') or {}).get('Labels') or {}
        for key, value in labels.items():
            if key.startswith('traefik.http.routers.') and key.endswith('.rule'):
                hosts.update(re.findall(r'Host\(`([^`]+)`\)', value))
    for path in sorted(Path(proxy_dir, 'dynamic').glob('*.y*ml')):
        try:
            hosts.update(re.findall(r'Host\(`([^`]+)`\)', path.read_text()))
        except OSError:
            pass
    return sorted(h for h in hosts if re.fullmatch(r'[A-Za-z0-9.-]+', h))


def fetch_status(host):
    result = run(['curl', '-sk', '-o', '/dev/null', '-m', '12', '-w', '%{http_code}',
                  '--resolve', host + ':443:127.0.0.1', 'https://' + host + '/'], timeout=20)
    return result.stdout.strip() or '000'


def statuses(hosts, fetch=fetch_status):
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        return dict(zip(hosts, pool.map(fetch, hosts)))


def regressions(before, after):
    """Hosts that answered before and fail now. A host already failing is not news."""
    return sorted(h for h, code in before.items()
                  if code not in BAD_STATUS and after.get(h, '000') in BAD_STATUS)


# ---------------------------------------------------------------- policy pin

def policy_pin(container, new_image_id, policy_path=None, record_path=None):
    """Point the container-policy imageId pin at the new image. -> (old text, changed)."""
    policy_path, record_path = policy_path or POLICY, record_path or POLICY_RECORD
    try:
        raw = Path(policy_path).read_text()
    except OSError:
        return None, False
    policy = json.loads(raw)
    changed = False
    for row in policy.get('policies') or []:
        if row.get('selector') == {'name': container} and 'imageId' in (row.get('expected') or {}):
            if row['expected']['imageId'] != new_image_id:
                row['expected']['imageId'] = new_image_id
                changed = True
    if changed:
        write_policy(json.dumps(policy, indent=2) + '\n', policy_path, record_path)
    return raw, changed


def write_policy(text, policy_path=None, record_path=None):
    policy_path, record_path = policy_path or POLICY, record_path or POLICY_RECORD
    write_atomic(policy_path, text)
    record = {'path': str(policy_path), 'sha256': hashlib.sha256(text.encode()).hexdigest(),
              'at': iso(now_utc()), 'by': 'service-patches'}
    write_atomic(record_path, json.dumps(record, indent=2) + '\n', mode=0o600)


# ---------------------------------------------------------------- Traefik

def traefik_version(container):
    out = run(['docker', 'exec', container, 'traefik', 'version']).stdout
    match = re.search(r'Version:\s*v?(\d+\.\d+\.\d+)', out)
    return parse_version(match.group(1)) if match else None


def traefik_canary(live, ref, workdir):
    """New image, live command and read-only mounts, no network; its own health test must pass."""
    name = 'hatchkit-patch-canary-traefik'
    run(['docker', 'rm', '-f', name])
    config = live['Config']
    env_file = Path(workdir) / 'canary.env'
    env_file.write_text(''.join(e + '\n' for e in config.get('Env') or [] if '\n' not in e))
    env_file.chmod(0o600)
    args = ['docker', 'run', '-d', '--name', name, '--network', 'none', '--read-only', '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp', '--memory', '512m',
            '--pids-limit', '128', '--env-file', str(env_file), '--label', 'io.hatchkit.service-patch=canary']
    for mount in live.get('Mounts') or []:
        source = mount.get('Name') if mount.get('Type') == 'volume' else mount.get('Source')
        args += ['-v', '%s:%s:ro' % (source, mount['Destination'])]
    if config.get('Entrypoint'):
        args += ['--entrypoint', config['Entrypoint'][0]]
        command = config['Entrypoint'][1:] + (config.get('Cmd') or [])
    else:
        command = config.get('Cmd') or []
    try:
        started = run(args + [ref] + command, timeout=60)
        env_file.unlink()
        if started.returncode:
            raise PatchError('canary did not start')
        test = (config.get('Healthcheck') or {}).get('Test') or []
        probe = test[1:] if test[:1] == ['CMD'] else ['sh', '-c', test[1]] if test[:1] == ['CMD-SHELL'] else None
        for _ in range(15):
            time.sleep(2)
            state = health(name)
            if not state['running']:
                raise PatchError('canary exited')
            if probe is None or run(['docker', 'exec', name] + probe, timeout=15).returncode == 0:
                time.sleep(4)
                if health(name)['running']:
                    return
                raise PatchError('canary exited after its health test')
        raise PatchError('canary never passed its health test')
    finally:
        run(['docker', 'rm', '-f', name])
        if env_file.exists():
            env_file.unlink()


def patch_traefik(target, new_ref, force_rollback, log):
    container = target['container']
    compose = Path(target['compose'])
    proxy_dir = compose.parent
    live = inspect(container)
    if not live:
        raise PatchError('container %s is not running' % container)
    old_text = compose.read_text()
    new_text, old_ref = replace_image(old_text, 'traefik', new_ref)
    if old_ref == new_ref and not force_rollback:
        raise PatchError('compose already names ' + new_ref)
    old_image = live['Image']
    new_image = pull(new_ref)
    snap = SNAPSHOTS / target['name']
    snap.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.TemporaryDirectory(dir=snap) as workdir:
        traefik_canary(live, new_ref, workdir)
    log('canary passed')
    networks = sorted(live['NetworkSettings']['Networks'])
    hosts = routed_hosts(proxy_dir)
    before = statuses(hosts)
    log('%d routed hosts checked before' % len(hosts))
    stamp = now_utc().strftime('%Y%m%dT%H%M%SZ')
    backup = proxy_dir / 'backups' / ('docker-compose.before-service-patch-%s.yml' % stamp)
    backup.parent.mkdir(exist_ok=True)
    shutil.copy2(compose, backup)
    policy_before, pinned = policy_pin(container, new_image)

    def up():
        result = run(['docker', 'compose', '-f', str(compose), 'up', '-d', '--no-deps', '--force-recreate',
                      target.get('composeService', 'traefik')],
                     timeout=300, cwd=str(proxy_dir))
        missing = []
        for network in networks:
            connect = run(['docker', 'network', 'connect', network, container])
            if connect.returncode and 'already exists' not in connect.stderr:
                missing.append(network)
        return result.returncode, missing

    def verify(want_image):
        ok, state = wait_healthy(container, want_image, 120)
        if not ok:
            return 'proxy not healthy on the expected image (%s)' % state.get('status')
        time.sleep(5)
        after = statuses(hosts)
        worse = regressions(before, after)
        if worse:
            time.sleep(8)
            again = statuses(worse)
            worse = [h for h in worse if again.get(h, '000') in BAD_STATUS]
        if worse:
            return 'routes stopped answering: ' + ', '.join(worse[:8])
        return None

    try:
        write_atomic(compose, new_text)
        code, missing = up()
        problem = 'compose up failed' if code else ('networks not reconnected: ' + ', '.join(missing) if missing else None)
        problem = problem or verify(new_image)
    except Exception as error:  # whatever broke, put the old proxy back
        problem = 'crashed during the swap: %s' % error
    if problem is None and not force_rollback:
        return {'from': old_ref, 'to': new_ref, 'hostsChecked': len(hosts), 'backup': str(backup)}
    reason = problem or 'operator test: forced rollback after every check passed'
    log('rolling back: ' + reason)
    write_atomic(compose, old_text)
    if pinned:
        write_policy(policy_before)
    code, missing = up()
    rollback_problem = 'compose up failed' if code else ('networks not reconnected: ' + ', '.join(missing) if missing else None)
    rollback_problem = rollback_problem or verify(old_image)
    raise RolledBack(reason, rollback_problem, verified=problem is None)


class RolledBack(PatchError):
    def __init__(self, reason, rollback_problem, verified=False):
        super().__init__(reason)
        self.reason = reason
        self.rollback_problem = rollback_problem
        self.verified = verified


# ---------------------------------------------------------------- Kuma

KUMA_COUNTS = ('select (select count(*) from monitor),(select count(*) from user),'
               '(select count(*) from notification)')


def kuma_counts(container):
    result = run(['docker', 'exec', container, 'mariadb', '-S', '/app/data/run/mariadb.sock', 'kuma', '-N',
                  '-e', KUMA_COUNTS], timeout=30)
    values = result.stdout.split()
    return [int(v) for v in values] if result.returncode == 0 and len(values) == 3 else None


def kuma_version(compose_text):
    return tag_version('kuma', image_line(compose_text, 'kuma').group('ref').split(':', 1)[1])


def volume_path(name):
    result = run(['docker', 'volume', 'inspect', '-f', '{{.Mountpoint}}', name], check=True)
    return Path(result.stdout.strip())


def kuma_run_args(live, name, volume, ref):
    return canary_run_args(live, name, volume, '/app/data', ref)


def canary_run_args(live, name, volume, destination, ref, env_file=None):
    """The live container's user, caps and limits, no network, the volume copy at `destination`."""
    host = live['HostConfig']
    args = ['docker', 'run', '-d', '--name', name, '--network', 'none', '--label', 'io.hatchkit.service-patch=canary']
    if env_file:
        args += ['--env-file', str(env_file)]
    if live['Config'].get('User'):
        args += ['--user', live['Config']['User']]
    for cap in host.get('CapDrop') or []:
        args += ['--cap-drop', cap]
    for opt in host.get('SecurityOpt') or []:
        args += ['--security-opt', opt]
    if host.get('Memory'):
        args += ['--memory', str(host['Memory'])]
    if host.get('MemorySwap'):
        args += ['--memory-swap', str(host['MemorySwap'])]
    if host.get('NanoCpus'):
        args += ['--cpus', '%g' % (host['NanoCpus'] / 1e9)]
    if host.get('PidsLimit'):
        args += ['--pids-limit', str(host['PidsLimit'])]
    for path, options in sorted((host.get('Tmpfs') or {}).items()):
        args += ['--tmpfs', path + (':' + options if options else '')]
    return args + ['-v', volume + ':' + destination, ref]


def kuma_canary(live, ref, data_dir, counts):
    name, volume = 'hatchkit-patch-canary-kuma', 'hatchkit-patch-canary-kuma'
    run(['docker', 'rm', '-f', name])
    run(['docker', 'volume', 'rm', volume])
    try:
        run(['docker', 'volume', 'create', volume], check=True)
        copy = volume_path(volume)
        run(['rsync', '-a', '--delete', '--exclude', '/run/*', str(data_dir) + '/', str(copy) + '/'],
            timeout=900, check=True)
        run(kuma_run_args(live, name, volume, ref), timeout=60, check=True)
        ok, state = wait_healthy(name, None, 240)
        if not ok:
            raise PatchError('canary not healthy (%s)' % state.get('status'))
        got = kuma_counts(name)
        if got != counts:
            raise PatchError('canary counts %s differ from live %s' % (got, counts))
    finally:
        run(['docker', 'rm', '-f', name])
        run(['docker', 'volume', 'rm', volume])


def url_ok(url):
    host = urllib.parse.urlparse(url).hostname
    code = run(['curl', '-sk', '-o', '/dev/null', '-m', '12', '-w', '%{http_code}', '--resolve',
                host + ':443:127.0.0.1', url], timeout=20).stdout.strip()
    return code not in BAD_STATUS and code[:1] in ('2', '3'), code


def patch_kuma(target, new_ref, force_rollback, log):
    container = target['container']
    compose = Path(target['compose'])
    live = inspect(container)
    if not live:
        raise PatchError('container %s is not running' % container)
    old_text = compose.read_text()
    new_text, old_ref = replace_image(old_text, 'kuma', new_ref)
    if old_ref == new_ref and not force_rollback:
        raise PatchError('compose already names ' + new_ref)
    new_image = pull(new_ref)
    user = run(['docker', 'image', 'inspect', '-f', '{{.Config.User}}', new_ref]).stdout.strip()
    if user not in ('node', '1000', '1000:1000'):
        raise PatchError('new image does not run as node (User=%r)' % user)
    data_dir = volume_path(target['volume'])
    counts = kuma_counts(container)
    if counts is None:
        raise PatchError('could not read live Kuma counts')
    kuma_canary(live, new_ref, data_dir, counts)
    log('canary passed with counts %s' % counts)
    snap = SNAPSHOTS / target['name']
    snap.mkdir(parents=True, exist_ok=True, mode=0o700)
    (snap / 'data').mkdir(exist_ok=True, mode=0o700)
    shutil.copy2(compose, snap / 'compose.before.yml')
    project_dir = compose.parent
    project = target.get('project') or project_dir.name

    def up():
        return run(['docker', 'compose', '-p', project, '-f', str(compose), 'up', '-d', '--force-recreate'], timeout=300,
                   cwd=str(project_dir)).returncode

    def verify(want_image):
        ok, state = wait_healthy(container, want_image, 300)
        if not ok:
            return 'Kuma not healthy on the expected image (%s)' % state.get('status')
        now_counts = kuma_counts(container)
        if now_counts != counts:
            return 'counts %s differ from %s' % (now_counts, counts)
        good, code = url_ok(target['url'])
        return None if good else '%s answered %s' % (target['url'], code)

    old_image = live['Image']
    run(['docker', 'stop', '-t', '60', container], timeout=120, check=True)
    snapshot = run(['rsync', '-a', '--delete', str(data_dir) + '/', str(snap / 'data') + '/'], timeout=900)
    if snapshot.returncode:
        run(['docker', 'start', container])
        raise PatchError('data snapshot failed; the old container was started again')
    try:
        write_atomic(compose, new_text)
        problem = 'compose up failed' if up() else None
        problem = problem or verify(new_image)
    except Exception as error:  # whatever broke, put the old Kuma and its data back
        problem = 'crashed during the swap: %s' % error
    if problem is None and not force_rollback:
        return {'from': old_ref, 'to': new_ref, 'counts': counts, 'snapshot': str(snap / 'data')}
    reason = problem or 'operator test: forced rollback after every check passed'
    log('rolling back: ' + reason)
    run(['docker', 'stop', '-t', '60', container], timeout=120)
    restore = run(['rsync', '-a', '--delete', str(snap / 'data') + '/', str(data_dir) + '/'], timeout=900)
    write_atomic(compose, old_text)
    rollback_problem = 'data restore failed' if restore.returncode else None
    rollback_problem = rollback_problem or ('compose up failed' if up() else None) or verify(old_image)
    raise RolledBack(reason, rollback_problem, verified=problem is None)


# ---------------------------------------------------------------- Postgres

PSQL = 'exec psql -XAtq -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d "$1" -c "$2"'
DATABASES_SQL = 'select datname from pg_database where datallowconn and not datistemplate order by 1'
# Exact rows: every heap is read, so a new image that cannot read the data fails here.
ROWS_SQL = ("select count(*), coalesce(sum((xpath('/row/c/text()', query_to_xml(format("
            "'select count(*) as c from %I.%I', schemaname, relname), false, true, '')))[1]::text::bigint), 0) "
            "from pg_stat_user_tables")
TABLES_SQL = 'select count(*) from pg_stat_user_tables'


def psql(container, database, sql, timeout=300):
    result = run(['docker', 'exec', container, 'sh', '-c', PSQL, 'sh', database, sql], timeout=timeout)
    if result.returncode:
        raise PatchError('psql in %s failed' % container)  # stderr can name roles; keep it out
    return result.stdout.split()


def pg_shape(container, exact=True):
    """{database: [tables, exact rows]} (exact) or {database: tables}."""
    shape = {}
    for database in psql(container, 'postgres', DATABASES_SQL):
        if exact:
            tables, rows = psql(container, database, ROWS_SQL)[0].split('|')
            shape[database] = [int(tables), int(rows)]
        else:
            shape[database] = int(psql(container, database, TABLES_SQL)[0])
    return shape


def pg_ready(container, seconds=120, sleep=time.sleep):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not health(container)['running']:
            return False
        if run(['docker', 'exec', container, 'sh', '-c',
                'pg_isready -q -U "${POSTGRES_USER:-postgres}" -d postgres'], timeout=15).returncode == 0:
            return True
        sleep(2)
    return False


def pg_major(args):
    match = re.search(r'\(PostgreSQL\) (\d+)\.', run(args, timeout=60).stdout)
    return int(match.group(1)) if match else None


def postgres_ref(compose_text):
    """-> ((major, minor), digest) of the compose image line, which must be a digest-pinned tag."""
    ref = image_line(compose_text, 'postgres').group('ref')
    match = POSTGRES_REF.fullmatch(ref)
    if not match:
        raise PatchError('compose names %s, not postgres:<major>.<minor>-alpine@sha256:<digest>' % ref)
    return tag_version('postgres', match.group('tag')), match.group('digest')


def data_mount(live):
    mounts = [m for m in live.get('Mounts') or []
              if m.get('Type') == 'volume' and m['Destination'].startswith('/var/lib/postgresql')]
    if len(mounts) != 1:
        raise PatchError('expected one Postgres data volume, found %d' % len(mounts))
    return mounts[0]


def postgres_canaries(live, old_ref, new_ref, snapshot, destination, workdir):
    """Old image, then new image, on one copy of the stopped data. -> (old shape, new shape)."""
    name, volume = 'hatchkit-patch-canary-postgres', 'hatchkit-patch-canary-postgres'
    env_file = Path(workdir) / 'canary.env'
    env_file.write_text(''.join(e + '\n' for e in live['Config'].get('Env') or [] if '\n' not in e))
    env_file.chmod(0o600)
    shapes = []
    run(['docker', 'rm', '-f', name])
    run(['docker', 'volume', 'rm', volume])
    try:
        run(['docker', 'volume', 'create', volume], check=True)
        run(['rsync', '-a', '--delete', str(snapshot) + '/', str(volume_path(volume)) + '/'], timeout=900, check=True)
        for label, ref in (('old', old_ref), ('new', new_ref)):
            run(canary_run_args(live, name, volume, destination, ref, env_file), timeout=60, check=True)
            if not pg_ready(name):
                raise PatchError('%s-image canary never accepted connections' % label)
            shapes.append(pg_shape(name))
            run(['docker', 'stop', '-t', '60', name], timeout=120)
            run(['docker', 'rm', '-f', name])
    finally:
        env_file.unlink(missing_ok=True)
        run(['docker', 'rm', '-f', name])
        run(['docker', 'volume', 'rm', volume])
    if shapes[0] != shapes[1]:
        raise PatchError('canary tables/rows %s differ from the old image on the same data %s' % (shapes[1], shapes[0]))
    return shapes


def client_health(names, seconds=120, sleep=time.sleep):
    """Clients may restart once on the dropped connection; report, never roll back for them."""
    deadline = time.monotonic() + seconds
    states = {}
    while True:
        states = {n: health(n) for n in names}
        if all(s['status'] in ('healthy', 'running') for s in states.values()) or time.monotonic() > deadline:
            return {n: s['status'] for n, s in states.items()}
        sleep(5)


def patch_postgres(target, new_ref, force_rollback, log):
    container = target['container']
    compose = Path(target['compose'])
    live = inspect(container)
    if not live or not (live.get('State') or {}).get('Running'):
        raise PatchError('container %s is not running' % container)
    old_text = compose.read_text()
    new_text, old_ref = replace_image(old_text, 'postgres', new_ref)
    if old_ref == new_ref and not force_rollback:
        raise PatchError('compose already names ' + new_ref)
    if live['Config'].get('Image') != old_ref:
        raise PatchError('the container does not run the compose image')
    mount = data_mount(live)
    new_image = pull(new_ref)
    running = pg_major(['docker', 'exec', container, 'postgres', '--version'])
    coming = pg_major(['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'postgres', new_ref, '--version'])
    if running is None or running != coming:
        raise PatchError('new image runs Postgres %s, the container runs %s' % (coming, running))
    old_image = live['Image']
    tables = pg_shape(container, exact=False)
    snap = SNAPSHOTS / target['name']
    snap.mkdir(parents=True, exist_ok=True, mode=0o700)
    (snap / 'data').mkdir(exist_ok=True, mode=0o700)
    shutil.copy2(compose, snap / 'compose.before.yml')
    data_dir = volume_path(mount['Name'])
    project = target.get('project') or compose.parent.name
    service = target['composeService']

    def up():
        return run(['docker', 'compose', '-p', project, '-f', str(compose), 'up', '-d', '--no-deps', '--force-recreate',
                    service], timeout=300, cwd=str(compose.parent)).returncode

    def verify(want_image):
        ok, state = wait_healthy(container, want_image, 180)
        if not ok:
            return 'Postgres not healthy on the expected image (%s)' % state.get('status')
        now_tables = pg_shape(container, exact=False)
        return None if now_tables == tables else 'tables per database %s differ from %s' % (now_tables, tables)

    # A clean stop gives a copy the canaries can open without crash recovery.
    run(['docker', 'stop', '-t', '120', container], timeout=180, check=True)
    snapshot = run(['rsync', '-a', '--delete', str(data_dir) + '/', str(snap / 'data') + '/'], timeout=900)
    try:
        if snapshot.returncode:
            raise PatchError('data snapshot failed')
        with tempfile.TemporaryDirectory(dir=snap) as workdir:
            shapes = postgres_canaries(live, old_ref, new_ref, snap / 'data', mount['Destination'], workdir)
        log('canaries agree: %s' % shapes[1])
    except Exception:
        run(['docker', 'start', container])
        raise
    policy_before, pinned = policy_pin(container, new_image)
    try:
        write_atomic(compose, new_text)
        problem = 'compose up failed' if up() else None
        problem = problem or verify(new_image)
    except Exception as error:  # whatever broke, put the old image back on the same data
        problem = 'crashed during the swap: %s' % error
    if problem is None and not force_rollback:
        clients = client_health(target.get('clients') or [])
        return {'from': old_ref, 'to': new_ref, 'databases': shapes[1], 'clients': clients,
                'snapshot': str(snap / 'data')}
    reason = problem or 'operator test: forced rollback after every check passed'
    log('rolling back: ' + reason)
    write_atomic(compose, old_text)
    if pinned:
        write_policy(policy_before)
    rollback_problem = ('compose up failed' if up() else None) or verify(old_image)
    raise RolledBack(reason, rollback_problem, verified=problem is None)


PATCHERS = {'traefik': patch_traefik, 'kuma': patch_kuma, 'postgres': patch_postgres}


# ---------------------------------------------------------------- planning

def current_version(target):
    if target['kind'] == 'postgres':
        return postgres_ref(Path(target['compose']).read_text())[0]
    if target['kind'] == 'traefik':
        version = traefik_version(target['container'])
        if not version:
            raise PatchError('cannot read the running Traefik version')
        return version
    version = kuma_version(Path(target['compose']).read_text())
    if not version:
        raise PatchError('compose does not name a %s tag' % KINDS['kuma']['tag'])
    return version


def new_ref_for(kind, version, tag):
    ref = KINDS[kind]['image'] + ':' + tag['name']
    if kind in ('traefik', 'postgres'):
        digest = tag.get('digest') or ''
        if not re.fullmatch(r'sha256:[0-9a-f]{64}', digest):
            raise PatchError('Docker Hub gave no digest for ' + ref)
        ref += '@' + digest
    return ref


def plan_target(target, state, ledger, now, config, forced_tag=None, fetch=None):
    kind = target['kind']
    current = current_version(target)
    advisories = advisories_for(ledger, kind, current)
    prefix = {'traefik': 'v%d.%d.' % current[:2], 'postgres': '%d.' % current[0]}.get(kind, '%d.%d.' % current[:2])
    tags = hub_tags(kind, prefix, fetch)
    if forced_tag:
        version = tag_version(kind, forced_tag)
        if not version or not same_line(kind, version, current) or version < current:
            raise PatchError('--to must be a %s tag of the running line %s at or above the running version'
                             % (kind, fmt(current[:1] if kind == 'postgres' else current[:2])))
        match = [t for t in tags if t['name'] == forced_tag]
        if not match:
            raise PatchError('Docker Hub has no tag ' + forced_tag)
        candidate = (version, match[0])
    elif kind == 'postgres':
        candidate = pick_postgres(current, postgres_ref(Path(target['compose']).read_text())[1], tags)
    else:
        candidate = pick_patch(kind, current, tags)
    action, reason, fixes = decide(kind, current, candidate, advisories, state, now, config,
                                   forced=forced_tag)
    plan = {'target': target['name'], 'kind': kind, 'current': fmt(current),
            'action': action, 'reason': reason, 'fixes': fixes,
            'advisories': [a['id'] for a in advisories],
            'unpatchable': sorted(a['id'] for a in advisories if not a['fixedIn'])}
    if candidate:
        plan['candidate'] = fmt(candidate[0])
        if candidate[0] == current:
            plan['rebuild'] = candidate[1].get('digest')
        if action == 'patch':
            plan['ref'] = new_ref_for(kind, candidate[0], candidate[1])
    return plan


# ---------------------------------------------------------------- Coolify copy

SYNC_PHP = r'''<?php
require '/var/www/html/vendor/autoload.php';
$app = require '/var/www/html/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
$args = json_decode(getenv('HK_ARGS'), true);
$apply = (bool) $args['apply'];
function hk_line($text, $prefix) {
  preg_match_all('/^([ \t]+)image:[ \t]*([\'"]?)([^\'"\s]+)\2[ \t]*$/m', $text, $m, PREG_SET_ORDER);
  $hits = array_values(array_filter($m, fn($x) => str_starts_with($x[3], $prefix)));
  return count($hits) === 1 ? $hits[0] : null;
}
function hk_remote($server, $cmd) { return trim((string) instant_remote_process([$cmd], $server, false)); }
function hk_swap($db, $host, $prefix) {
  $a = hk_line($db, $prefix); $b = hk_line($host, $prefix);
  if (!$a || !$b) return [null, 'no single image line'];
  if ($a[3] === $b[3]) return [null, 'image lines already match but files differ'];
  if (substr_count($db, $a[0]) !== 1) return [null, 'image line not unique'];
  $candidate = str_replace($a[0], $b[0], $db);
  if (rtrim($candidate) !== rtrim($host)) return [null, 'host file differs from Coolify beyond the image line'];
  return [[$candidate, $a[3], $b[3]], null];
}
$out = [];
foreach ($args['proxies'] as $p) {
  $r = ['kind' => 'proxy', 'server' => $p['server']];
  try {
    $server = App\Models\Server::where('uuid', $p['server'])->firstOrFail();
    $path = rtrim($server->proxyPath(), '/') . '/docker-compose.yml';
    $host = base64_decode(hk_remote($server, 'base64 -w0 ' . escapeshellarg($path)), true);
    $running = hk_remote($server, "docker inspect -f '{{.Config.Image}}' coolify-proxy");
    $db = (string) $server->proxy->get('last_saved_proxy_configuration');
    if ($host === false || $host === '') { $r['status'] = 'refused'; $r['reason'] = 'cannot read the host file'; }
    elseif (rtrim($db) === rtrim($host)) { $r['status'] = 'in-sync'; $r['image'] = (hk_line($db, $p['prefix']) ?? [3 => null])[3]; }
    else {
      [$swap, $why] = hk_swap($db, $host, $p['prefix']);
      if (!$swap) { $r['status'] = 'refused'; $r['reason'] = $why; }
      elseif ($running !== $swap[2]) { $r['status'] = 'refused'; $r['reason'] = 'the proxy does not run the host file image'; }
      elseif (!preg_match($p['pattern'], $swap[2])) { $r['status'] = 'refused'; $r['reason'] = 'unexpected image ' . $swap[2]; }
      else {
        App\Services\ProxyPortParser::fromConfiguration($swap[0]);
        $r += ['from' => $swap[1], 'to' => $swap[2], 'status' => $apply ? 'updated' : 'would-update'];
        if ($apply) {
          $saved = $server->proxy->get('last_saved_settings');
          $applied = $server->proxy->get('last_applied_settings');
          $hash = md5(base64_encode($swap[0]));
          $server->proxy->last_saved_proxy_configuration = $swap[0];
          $server->proxy->last_saved_settings = $hash;
          if ($saved && $saved === $applied) { $server->proxy->last_applied_settings = $hash; }
          $server->save();
        }
      }
    }
  } catch (Throwable $e) { $r['status'] = 'refused'; $r['reason'] = substr(get_class($e) . ': ' . $e->getMessage(), 0, 200); }
  $out[] = $r;
}
foreach ($args['services'] as $s) {
  $r = ['kind' => 'service', 'service' => $s['uuid'], 'app' => $s['app']];
  try {
    $service = App\Models\Service::where('uuid', $s['uuid'])->firstOrFail();
    $isDb = ($s['part'] ?? 'application') === 'database';
    $application = ($isDb ? $service->databases() : $service->applications())->where('name', $s['app'])->firstOrFail();
    $server = $service->destination->server;
    $path = '/data/coolify/services/' . $service->uuid . '/docker-compose.yml';
    $host = base64_decode(hk_remote($server, 'base64 -w0 ' . escapeshellarg($path)), true);
    $running = hk_remote($server, "docker inspect -f '{{.Config.Image}}' " . escapeshellarg($s['container']));
    $db = (string) $service->docker_compose;
    if ($host === false || $host === '') { $r['status'] = 'refused'; $r['reason'] = 'cannot read the host file'; }
    elseif (rtrim($db) === rtrim($host) && $application->image === $running) { $r['status'] = 'in-sync'; $r['image'] = $running; }
    else {
      [$swap, $why] = rtrim($db) === rtrim($host) ? [null, 'Coolify app image differs from the running image'] : hk_swap($db, $host, $s['prefix']);
      $raw = (string) $service->docker_compose_raw;
      if (!$swap) { $r['status'] = 'refused'; $r['reason'] = $why; }
      elseif ($running !== $swap[2]) { $r['status'] = 'refused'; $r['reason'] = 'the container does not run the host file image'; }
      elseif (!preg_match($s['pattern'], $swap[2])) { $r['status'] = 'refused'; $r['reason'] = 'unexpected image ' . $swap[2]; }
      elseif (substr_count($raw, $swap[1]) !== 1 || $application->image !== $swap[1]) { $r['status'] = 'refused'; $r['reason'] = 'Coolify raw compose or app image does not name ' . $swap[1]; }
      else {
        $newRaw = str_replace($swap[1], $swap[2], $raw);
        Symfony\Component\Yaml\Yaml::parse($newRaw); Symfony\Component\Yaml\Yaml::parse($swap[0]);
        $r += ['from' => $swap[1], 'to' => $swap[2], 'status' => $apply ? 'updated' : 'would-update'];
        if ($apply) {
          Illuminate\Support\Facades\DB::transaction(function () use ($service, $application, $newRaw, $swap) {
            Illuminate\Support\Facades\DB::table('services')->where('id', $service->id)->update(['docker_compose_raw' => $newRaw, 'docker_compose' => $swap[0]]);
            Illuminate\Support\Facades\DB::table($isDb ? 'service_databases' : 'service_applications')->where('id', $application->id)->update(['image' => $swap[2]]);
          });
        }
      }
    }
  } catch (Throwable $e) { $r['status'] = 'refused'; $r['reason'] = substr(get_class($e) . ': ' . $e->getMessage(), 0, 200); }
  $out[] = $r;
}
// Standalone databases: Coolify writes their compose from the model at start, so only the image field follows.
foreach ($args['standalone'] ?? [] as $s) {
  $r = ['kind' => 'standalone', 'database' => $s['uuid']];
  try {
    $db = App\Models\StandalonePostgresql::where('uuid', $s['uuid'])->firstOrFail();
    $running = hk_remote($db->destination->server, "docker inspect -f '{{.Config.Image}}' " . escapeshellarg($s['uuid']));
    if ($db->image === $running) { $r['status'] = 'in-sync'; $r['image'] = $running; }
    elseif (!preg_match($s['pattern'], $running)) { $r['status'] = 'refused'; $r['reason'] = 'unexpected image ' . $running; }
    elseif (!preg_match($s['pattern'], (string) $db->image) && !preg_match('/^postgres:\d+(\.\d+)?-alpine$/', (string) $db->image)) { $r['status'] = 'refused'; $r['reason'] = 'Coolify names ' . $db->image; }
    else {
      $r += ['from' => $db->image, 'to' => $running, 'status' => $apply ? 'updated' : 'would-update'];
      if ($apply) { Illuminate\Support\Facades\DB::table('standalone_postgresqls')->where('id', $db->id)->update(['image' => $running]); }
    }
  } catch (Throwable $e) { $r['status'] = 'refused'; $r['reason'] = substr(get_class($e) . ': ' . $e->getMessage(), 0, 200); }
  $out[] = $r;
}
echo json_encode($out), "\n";
'''

SYNC_PREFIXES = {'traefik': 'traefik', 'kuma': 'louislam/uptime-kuma:', 'postgres': 'postgres:'}
SYNC_PATTERNS = {'traefik': '/^traefik(:v\\d+\\.\\d+\\.\\d+)?@sha256:[0-9a-f]{64}$/',
                 'kuma': '/^louislam\\/uptime-kuma:\\d+\\.\\d+\\.\\d+-rootless$/',
                 'postgres': '/^postgres:\\d+\\.\\d+-alpine@sha256:[0-9a-f]{64}$/'}


def sync_coolify(sync, apply):
    """Follow patched host files in Coolify's own copies. Prints and returns no compose text."""
    args = {'apply': apply,
            'proxies': [{'server': s, 'prefix': SYNC_PREFIXES['traefik'], 'pattern': SYNC_PATTERNS['traefik']}
                        for s in sync.get('proxies') or []],
            'services': [{'uuid': s['uuid'], 'app': s['app'], 'container': s['container'],
                          'part': s.get('part', 'application'),
                          'prefix': SYNC_PREFIXES[s.get('kind', 'kuma')], 'pattern': SYNC_PATTERNS[s.get('kind', 'kuma')]}
                         for s in sync.get('services') or []],
            'standalone': [{'uuid': u, 'pattern': SYNC_PATTERNS['postgres']} for u in sync.get('standalonePostgres') or []]}
    container = sync.get('container', 'coolify')
    # The script goes over stdin: a file in the container's /tmp is exactly what
    # host-integrity's temp-file detector reports (and mails).
    result = run(['docker', 'exec', '-i', '-u', 'root', '-e', 'HK_ARGS=' + json.dumps(args), container, 'php'],
                 input=SYNC_PHP, timeout=180)
    lines = [l for l in result.stdout.splitlines() if l.startswith('[')]
    if result.returncode or not lines:
        raise PatchError('the Coolify sync script failed (exit %d)' % result.returncode)
    return json.loads(lines[-1])


# ---------------------------------------------------------------- state and main

def load_state(work):
    return read_json(work / STATE_NAME, {}) or {}


def save_state(work, state):
    write_atomic(work / STATE_NAME, json.dumps(state, indent=2, sort_keys=True) + '\n', mode=0o600)


def record_attempt(state, name, attempt, keep=10):
    target = state.setdefault('targets', {}).setdefault(name, {})
    target['attempts'] = (target.get('attempts') or [])[-(keep - 1):] + [attempt]
    failed = attempt['status'] in ('rolled-back', 'rollback-failed', 'failed', 'canary-failed')
    # An operator test that rolled back as asked is no failure; anything else is.
    if failed and not (attempt.get('test') and attempt['status'] == 'rolled-back' and attempt.get('checksPassed')):
        target['paused'] = True
    return target


def attempt_target(target, plan, force_rollback, log):
    started = now_utc()
    attempt = {'at': iso(started), 'from': plan['current'], 'to': plan.get('candidate'), 'ref': plan.get('ref'),
               'fixes': plan.get('fixes') or [], 'reason': plan['reason']}
    if force_rollback:
        attempt['test'] = True
    try:
        detail = PATCHERS[target['kind']](target, plan['ref'], force_rollback, log)
        attempt.update(status='landed', verifiedAt=iso(now_utc()), detail=detail)
    except RolledBack as error:
        if error.rollback_problem:
            attempt.update(status='rollback-failed', error=error.reason, rollbackError=error.rollback_problem)
        else:
            attempt.update(status='rolled-back', error=error.reason, checksPassed=error.verified)
    except PatchError as error:
        attempt.update(status='canary-failed' if 'canary' in str(error) else 'failed', error=str(error)[:300])
    except Exception as error:  # an unexpected crash still pauses the target
        attempt.update(status='failed', error=('%s: %s' % (type(error).__name__, error))[:300])
    attempt['seconds'] = round((now_utc() - started).total_seconds())
    return attempt


def after_landing(kind=None):
    units = ['hatchkit-update-watch.service', 'hatchkit-container-policy.service']
    if kind == 'postgres':  # both key on the container name, which a recreate keeps; prove it at once
        units += ['hatchkit-database-guard-check.service', 'hatchkit-database-egress-check.service']
    for unit in units:
        run(['systemctl', 'start', '--no-block', unit])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('mode', choices=('run', 'plan', 'status', 'clear', 'sync-coolify'))
    parser.add_argument('name', nargs='?')
    parser.add_argument('--target')
    parser.add_argument('--to')
    parser.add_argument('--force-rollback', action='store_true')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args(argv)
    work = WORK
    if args.mode == 'status':
        print(json.dumps(load_state(work), indent=2))
        return 0
    LOCK.touch(mode=0o600)
    with open(LOCK) as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(json.dumps({'ok': False, 'error': 'another service-patches run holds the lock'}))
            return 1
        return locked(args, work)


def locked(args, work):
    state = load_state(work)
    if args.mode == 'clear':
        target = (state.get('targets') or {}).get(args.name or '')
        if not target:
            print(json.dumps({'ok': False, 'error': 'no such target in the state file'}))
            return 1
        target['paused'] = False
        for attempt in target.get('attempts') or []:
            attempt.setdefault('cleared', iso(now_utc()))
        save_state(work, state)
        print(json.dumps({'ok': True, 'cleared': args.name}))
        return 0
    config = read_json(CONFIG)
    if not isinstance(config, dict):
        print(json.dumps({'ok': False, 'error': str(CONFIG) + ' is missing or not JSON'}))
        return 1
    if args.mode == 'sync-coolify':
        results = sync_coolify(config.get('coolifySync') or {}, args.apply)
        print(json.dumps(results, indent=2))
        return 0
    now = now_utc()
    ledger = read_json(work / LEDGER_NAME, {})
    targets = [t for t in config.get('targets') or [] if t.get('kind') in KINDS]
    if args.target:
        targets = [t for t in targets if t['name'] == args.target]
        if not targets:
            print(json.dumps({'ok': False, 'error': 'no target named ' + args.target}))
            return 1
    if (args.to or args.force_rollback) and not args.target:
        print(json.dumps({'ok': False, 'error': '--to and --force-rollback need --target'}))
        return 1
    state['checkedAt'] = iso(now)
    state['error'] = None
    plans = []
    for target in targets:
        record = (state.setdefault('targets', {})).setdefault(target['name'], {})
        try:
            plan = plan_target(target, record, ledger, now, config, forced_tag=args.to)
        except Exception as error:
            plan = {'target': target['name'], 'action': 'error', 'reason': str(error)[:300]}
        record.update(lastPlan=plan, kind=target['kind'])
        plans.append(plan)
        if args.mode == 'run' and plan['action'] == 'patch':
            def log(message, name=target['name']):
                print('%s: %s' % (name, message), flush=True)
            attempt = attempt_target(target, plan, args.force_rollback, log)
            record_attempt(state, target['name'], attempt)
            print(json.dumps({'attempt': attempt}), flush=True)
            if attempt['status'] == 'landed':
                after_landing(target['kind'])
            save_state(work, state)
    if args.mode == 'run' and config.get('coolifySync'):
        try:
            state['coolifySync'] = {'at': iso(now_utc()), 'results': sync_coolify(config['coolifySync'], True)}
        except Exception as error:
            state['coolifySync'] = {'at': iso(now_utc()), 'error': str(error)[:300]}
    if args.mode == 'run':
        save_state(work, state)
    print(json.dumps({'ok': True, 'plans': plans, 'coolifySync': state.get('coolifySync') if args.mode == 'run' else None},
                     indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
