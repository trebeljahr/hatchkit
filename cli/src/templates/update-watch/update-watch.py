#!/usr/bin/env python3
"""Hatchkit update watch: a shared service running a version with a known
high or critical advisory.

Plausible CE v3.0.1 on the shared Coolify host ran four months past a
critical fix (GHSA-mhcv-h7gf-57cf) and was taken over on 2026-09-17:
nothing compared the running versions with upstream advisories. This
script does, for every running container whose image is one of the
services in update-watch-services.json (Coolify, Traefik, Plausible CE,
Listmonk, Uptime Kuma, GlitchTip, ClickHouse):

  1. the running version: the image's version label or env, else a full
     version tag, else the binary inside the container (a floating tag
     such as traefik:v3.6 names a line, not a release);
  2. the upstream feeds: GitHub repository security advisories and the
     latest release (GlitchTip publishes tags on GitLab and no advisories);
  3. every high or critical advisory whose vulnerable range covers the
     running version, with its fixed version and the latest release.

It also reports Coolify's own auto-update failing (the newest
/data/coolify/source/upgrade-*.log ends in an error), and Cloudflare's
published IP ranges drifting from the ones the origin firewalls allow on
80/443: both hosts drop everything else, so a new Cloudflare edge would be
dropped. The ranges are compared with the pinned snapshot
(update-watch-cloudflare.json) and with this host's HATCHKIT-CF chain.

It only reads: docker inspect, `docker exec` of a version command when a
tag floats, the status lines of the upgrade logs, `iptables -S HATCHKIT-CF`,
and HTTPS GETs to api.github.com, gitlab.com and api.cloudflare.com. It never prints environment values; of an
image's env it reads only the version keys the services file names.

  scan    print the report as JSON
  check   scan, mail findings through the backup-alert SMTP and record the
          result (what the weekly timer runs)
  failed  mail that a check did not finish (systemd OnFailure)
  test    send a test mail
"""
import argparse
import datetime as dt
import hashlib
from email.utils import formataddr, parseaddr
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import ssl
import subprocess
import sys
import urllib.error
from urllib.parse import quote
import urllib.request

BACKUP_CONFIG = '/etc/hatchkit-backups/config.json'
SERVICES_NAME = 'update-watch-services.json'
CLOUDFLARE_NAME = 'update-watch-cloudflare.json'
CLOUDFLARE_IPS = 'https://api.cloudflare.com/client/v4/ips'
CF_CHAIN = 'HATCHKIT-CF'
STATUS_NAME = 'update-watch-status.json'
TIMER = 'hatchkit-update-watch.timer'
SERVICE = 'hatchkit-update-watch.service'
COOLIFY_SOURCE = '/data/coolify/source'
GITHUB = 'https://api.github.com'
GITLAB = 'https://gitlab.com/api/v4'
FLAGGED = ('critical', 'high')
# Distro and channel suffixes are not prereleases: 24.12.6.70-alpine,
# v23.8.15.35-lts, v26.7.34.3-stable.
SUFFIXES = {'alpine', 'lts', 'stable', 'slim', 'official', 'debian', 'bookworm', 'ubuntu'}
VERSION = re.compile(r'^[vV]?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$')
CONSTRAINT = re.compile(r'(>=|<=|==|=|>|<)?\s*([vV]?\d[0-9A-Za-z.+-]*)')
# How many upgrade logs to read, newest first, to count a failing streak.
UPGRADE_LOGS = 60
MAX_FINDINGS = 100


class WatchError(Exception):
    """An error whose message is safe to print and mail."""


class FeedError(WatchError):
    """An upstream feed could not be read."""


def safe(value):
    """Escape control and other non-printable characters in every string."""
    if isinstance(value, str):
        return ''.join(c if c.isprintable() else ('\\x%02x' % ord(c) if ord(c) < 256 else '\\u%04x' % ord(c))
                       for c in value)
    if isinstance(value, list):
        return [safe(v) for v in value]
    if isinstance(value, dict):
        return {safe(k): safe(v) for k, v in value.items()}
    return value


# --- versions and ranges ------------------------------------------------------

class Version:
    """Semver-like ordering that also takes four-part ClickHouse versions and
    Coolify's 4.0.0-beta.NNN: 4.0.0-beta.469 < 4.0.0 < 4.4.6."""

    def __init__(self, text):
        self.text = text.strip()
        match = VERSION.match(self.text)
        if not match:
            raise ValueError(text)
        self.release = tuple(int(p) for p in match.group(1).split('.'))
        pre = re.findall(r'\d+|[A-Za-z]+', match.group(2) or '')
        if pre and pre[0].lower() in SUFFIXES:
            pre = []
        self.pre = tuple((0, int(p), '') if p.isdigit() else (1, 0, p.lower()) for p in pre)

    def key(self):
        release = self.release + (0,) * (6 - len(self.release))
        return (release, (0, self.pre) if self.pre else (1, ()))

    def branch(self):
        return self.release[:2]

    def __eq__(self, other):
        return self.key() == other.key()

    def __lt__(self, other):
        return self.key() < other.key()

    def __le__(self, other):
        return self.key() <= other.key()

    def __gt__(self, other):
        return self.key() > other.key()

    def __ge__(self, other):
        return self.key() >= other.key()

    def __str__(self):
        return self.text.lstrip('vV')


def parse_version(text):
    try:
        return Version(text)
    except (ValueError, AttributeError):
        return None


def full_version(text):
    """A tag that names one release (three or more parts), not a line."""
    version = parse_version(text or '')
    return version if version and len(version.release) >= 3 else None


def parse_range(text):
    """Alternatives (OR) of constraint lists (AND), or None when the text names
    no version ('latest'). Advisories write commas both ways: '>= v3.7.0, <= v3.7.14'
    is one window, '<= v2.11.42, <= v3.6.13, <= v3.7.0-rc.1' is one per branch,
    '2.0.0-beta.0, 2.0.0-beta.1' is a list. So each upper bound or exact
    version closes an alternative, and lower bounds join the next one."""
    text = (text or '').replace('≤', '<=').replace('≥', '>=').replace('&&', ',')
    text = re.sub(r'\band\b', ',', text).strip()
    if text in ('*', 'all', 'any'):
        return [[]]
    alternatives = []
    for part in text.split('||'):
        hyphen = re.fullmatch(r'\s*(\S+)\s+-\s+(\S+)\s*', part)
        if hyphen:
            low, high = parse_version(hyphen.group(1)), parse_version(hyphen.group(2))
            if not low or not high:
                return None
            alternatives.append([('>=', low), ('<=', high)])
            continue
        if CONSTRAINT.sub('', part).strip(' ,;'):
            return None
        current = []
        for op, raw in CONSTRAINT.findall(part):
            version = parse_version(raw)
            if not version:
                return None
            op = '=' if op in ('', '==') else op
            current.append((op, version))
            if op in ('<', '<=', '='):
                alternatives.append(current)
                current = []
        if current:
            if alternatives and all(op in ('>', '>=') for op, _ in current):
                alternatives[-1].extend(current)
            else:
                alternatives.append(current)
    return alternatives or None


def satisfies(version, constraint):
    op, bound = constraint
    return {'<': version < bound, '<=': version <= bound, '>': version > bound,
            '>=': version >= bound, '=': version == bound}[op]


def parse_patched(text):
    versions = []
    for part in re.split(r',|\|\|', text or ''):
        version = parse_version(re.sub(r'^\s*(>=|=|==)?\s*', '', part))
        if version:
            versions.append(version)
    return versions


def relevant(entry, service):
    """An advisory entry about this product, not Go, a library or a sibling app."""
    package = entry.get('package') or {}
    name = (package.get('name') or '').strip().lower()
    text = ((package.get('ecosystem') or '') + ' ' + name).lower()
    if any(word in text for word in service.get('skipWords', ())):
        return False
    return not name or any(word in text for word in service.get('packageWords', ()))


def covers(version, advisory, service, released_at=None):
    """True or False, or None when no range can be read and no release date
    decides it. A version at or past a patched release on its own branch, or
    past every patched release, is not covered."""
    entries = [e for e in advisory.get('vulnerabilities') or [] if relevant(e, service)]
    if not entries:
        return False
    patched = [p for e in entries for p in parse_patched(e.get('patched_versions'))]
    if any(version >= p for p in patched if p.branch() == version.branch()):
        return False
    if patched and version >= max(patched):
        return False
    unknown = False
    for entry in entries:
        alternatives = parse_range(entry.get('vulnerable_version_range'))
        if alternatives is None:
            unknown = True
        elif any(all(satisfies(version, c) for c in alt) for alt in alternatives):
            return True
    if unknown and released_at and advisory.get('published_at'):
        # 'latest' with no patched version: the release that was current when
        # the advisory went out. A release after it is not known to be covered.
        return released_at <= advisory['published_at']
    return None if unknown else False


def fixed_in(version, advisory, service):
    patched = sorted({str(p): p for e in advisory.get('vulnerabilities') or [] if relevant(e, service)
                      for p in parse_patched(e.get('patched_versions'))}.values())
    later = [p for p in patched if p > version]
    same = [p for p in later if p.branch() == version.branch()]
    return str((same or later)[0]) if later else None


# --- feeds --------------------------------------------------------------------

def http_get(url):
    request = urllib.request.Request(url, headers={
        'Accept': 'application/vnd.github+json', 'User-Agent': 'hatchkit-update-watch'})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode()), response.headers.get('Link') or ''
    except urllib.error.HTTPError as error:
        if error.code in (403, 429) and error.headers.get('X-RateLimit-Remaining') == '0':
            reset = error.headers.get('X-RateLimit-Reset') or ''
            when = (dt.datetime.fromtimestamp(int(reset), dt.timezone.utc).strftime('%H:%M UTC')
                    if reset.isdigit() else 'within the hour')
            raise FeedError('GitHub API rate limit reached for this address; it resets at ' + when) from None
        raise FeedError('HTTP ' + str(error.code) + ' from ' + url.split('?')[0]) from None
    except (urllib.error.URLError, OSError, ValueError):
        raise FeedError('could not read ' + url.split('?')[0]) from None


class Feeds:
    """Upstream reads. `prefetched` holds answers the caller already has
    (hatchkit doctor reads GitHub with its own login); the rest go out from here."""

    def __init__(self, prefetched=None, get=http_get):
        self.prefetched = prefetched or {}
        self.get = get
        self.cache = {}

    def json(self, url, pages=False):
        if url in self.prefetched:
            return self.prefetched[url]
        if url in self.cache:
            return self.cache[url]
        data, link = self.get(url)
        while pages and isinstance(data, list):
            following = re.search(r'<([^>]+)>;\s*rel="next"', link)
            if not following:
                break
            more, link = self.get(following.group(1))
            data = data + more
        self.cache[url] = data
        return data


def advisories_url(repo):
    return GITHUB + '/repos/' + repo + '/security-advisories?per_page=100&state=published'


def latest_url(repo):
    return GITHUB + '/repos/' + repo + '/releases/latest'


def gitlab_tags_url(project):
    return GITLAB + '/projects/' + quote(project, safe='') + '/repository/tags?order_by=version&sort=desc&per_page=20'


def release_date(feeds, repo, version):
    """When the running version was released on GitHub, or None."""
    for tag in ('v' + str(version), str(version)):
        try:
            release = feeds.json(GITHUB + '/repos/' + repo + '/releases/tags/' + quote(tag, safe=''))
        except FeedError:
            continue
        if isinstance(release, dict) and release.get('published_at'):
            return release['published_at']
    return None


def latest_release(feeds, service):
    if service.get('github'):
        release = feeds.json(latest_url(service['github']))
        tag = release.get('tag_name') or ''
        version = parse_version(tag)
        return {'version': str(version) if version else (tag or None), 'publishedAt': release.get('published_at')}
    if service.get('gitlab'):
        for tag in feeds.json(gitlab_tags_url(service['gitlab'])):
            version = full_version(tag.get('name') or '')
            if version and not version.pre:
                return {'version': str(version), 'publishedAt': ((tag.get('commit') or {}).get('created_at'))}
    return None


# --- the host -----------------------------------------------------------------

def run_docker(args, timeout=60):
    try:
        done = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=timeout)
    except (subprocess.SubprocessError, OSError):
        raise WatchError('docker ' + args[0] + ' failed') from None
    if done.returncode != 0 and not (args[0] in ('inspect', 'image') and done.stdout.strip()):
        raise WatchError('docker ' + ' '.join(args[:2] if args[0] == 'image' else args[:1]) + ' failed')
    return done.stdout


def split_image(ref):
    """'ghcr.io/plausible/community-edition:v3.2.1@sha256:…' → ('plausible/community-edition', 'v3.2.1')."""
    ref = ref.split('@', 1)[0]
    name, tag = ref, None
    if ':' in ref.rsplit('/', 1)[-1]:
        name, tag = ref.rsplit(':', 1)
    parts = name.split('/')
    if len(parts) > 1 and ('.' in parts[0] or ':' in parts[0] or parts[0] == 'localhost'):
        parts = parts[1:]
    if parts[0] == 'library' and len(parts) > 1:
        parts = parts[1:]
    return '/'.join(parts).lower(), tag


INSPECT = '{{json .Name}}\t{{json .Config.Image}}\t{{json .Image}}\t{{json (index .Config.Labels "io.hatchkit.security.original-image")}}'
# `.Config.Labels` is a template error on an image without labels (glitchtip),
# so take `.Config` whole and keep its Labels and Env here.
IMAGE_INSPECT = '{{json .Id}}\t{{json .Config}}\t{{json .RepoDigests}}'


def list_services(docker, services):
    """Running containers of the watched images, grouped by service and version."""
    ids = docker(['ps', '-q', '--no-trunc']).split()
    if not ids:
        return [], []
    by_repo = {image: s for s in services for image in s['images']}
    containers = []
    for line in docker(['inspect', '--format', INSPECT, *ids]).splitlines():
        try:
            fields = [json.loads(f) for f in line.split('\t')]
            name, ref, image_id = fields[:3]
            original = fields[3] if len(fields) > 3 else None
        except ValueError:
            continue
        repo, tag = split_image(original or ref or '')
        if repo in by_repo:
            containers.append({'name': name.lstrip('/'), 'ref': ref, 'repo': repo, 'tag': tag,
                               'imageId': image_id, 'service': by_repo[repo]})
    images = {}
    wanted = sorted({c['imageId'] for c in containers})
    if wanted:
        for line in docker(['image', 'inspect', '--format', IMAGE_INSPECT, *wanted]).splitlines():
            try:
                image_id, config, digests = (json.loads(f) for f in line.split('\t'))
            except ValueError:
                continue
            config = config or {}
            images[image_id] = {'labels': config.get('Labels') or {}, 'env': config.get('Env') or [],
                                'digests': digests or []}
    return containers, images


def resolve_version(docker, container, image, service):
    """(version, source): an image label or env key, a full tag, then the binary."""
    for key in service.get('labels', ()):
        version = full_version(str(image.get('labels', {}).get(key) or ''))
        if version:
            return version, 'label ' + key
    for key in service.get('env', ()):
        for entry in image.get('env', ()):
            if entry.startswith(key + '='):
                version = full_version(entry.split('=', 1)[1])
                if version:
                    return version, 'image env ' + key
    version = full_version(container['tag'] or '')
    if version:
        return version, 'tag'
    probe = service.get('probe')
    if probe:
        try:
            output = docker(['exec', container['name'], *probe['argv']], timeout=30)
        except WatchError:
            output = ''
        match = re.search(probe['pattern'], output, re.M)
        version = full_version(match.group(1)) if match else None
        if version:
            return version, 'binary (' + ' '.join(probe['argv'][:2]) + ')'
    return None, None


def read_upgrade_log(path):
    """The status lines of one Coolify upgrade log; never other content."""
    try:
        text = path.read_text(errors='replace')
    except OSError:
        return None
    head = {}
    for key, label in (('started', 'Started'), ('target', 'Target Version'), ('registry', 'Registry URL')):
        match = re.search(r'^' + label + r':\s*(.+)$', text, re.M)
        head[key] = safe(match.group(1).strip()[:80]) if match else None
    ok = 'upgrade completed successfully' in text
    errors = re.findall(r'ERROR:\s*(.+)$', text, re.M)
    error = None
    if not ok:
        error = safe(errors[-1].strip()[:200]) if errors else 'the log ends before the upgrade completed'
        if 'toomanyrequests' in text:
            error += ' (registry rate limit: toomanyrequests)'
    return dict(head, log=path.name, ok=ok, error=error)


def coolify_auto_update(source=COOLIFY_SOURCE, now=None):
    """Coolify's nightly auto-update runs upgrade.sh when a newer version is
    out. A pull that fails leaves an upgrade-*.log ending in ERROR and nobody
    is told (every night from 2026-09-27 to 2026-10-18 on dedicated-vps)."""
    logs = sorted(Path(source).glob('upgrade-*.log'))[-UPGRADE_LOGS:]
    runs = [r for r in (read_upgrade_log(p) for p in reversed(logs)) if r]
    if not runs:
        return None
    newest = runs[0]
    now = now or dt.datetime.now(dt.timezone.utc)
    try:
        age = now.timestamp() - (Path(source) / newest['log']).stat().st_mtime
    except OSError:
        age = None
    if not newest['ok'] and age is not None and age < 900 and 'ends before' in newest['error']:
        newest = dict(newest, error=None, running=True)
    failed = 0
    for run in runs:
        if run['ok'] or run.get('running'):
            break
        failed += 1
    return {'lastRun': newest['started'], 'log': newest['log'], 'ok': newest['ok'] or bool(newest.get('running')),
            'running': bool(newest.get('running')), 'target': newest['target'], 'registry': newest['registry'],
            'error': newest['error'], 'failedRuns': failed,
            'failingSince': runs[failed - 1]['started'] if failed else None}


# --- Cloudflare ranges ---------------------------------------------------------

def networks(cidrs):
    found = set()
    for cidr in cidrs or ():
        try:
            found.add(str(ipaddress.ip_network(str(cidr).strip(), strict=False)))
        except ValueError:
            pass
    return found


def read_chain(binary):
    """The `-S HATCHKIT-CF` rules, or None when this host has no such chain."""
    try:
        done = subprocess.run([binary, '-w', '5', '-S', CF_CHAIN], capture_output=True, text=True, timeout=30)
    except (subprocess.SubprocessError, OSError):
        return None
    return done.stdout if done.returncode == 0 else None


def chain_sources(rules):
    return re.findall(r'^-A ' + CF_CHAIN + r' -s (\S+) -j ACCEPT$', rules or '', re.M)


def join(items):
    return ', '.join(items) if items else 'none'


def cloudflare_check(feeds, pinned, chain=read_chain):
    """Cloudflare's published edge ranges against the snapshot the origin
    firewalls were built from, and against this host's HATCHKIT-CF chain."""
    state = {'pinnedEtag': pinned.get('etag'), 'etag': None, 'added': [], 'removed': [], 'chain': None,
             'error': None}
    findings = []
    try:
        body = feeds.json(CLOUDFLARE_IPS)
        result = body['result']
        live = {'ipv4': networks(result['ipv4_cidrs']), 'ipv6': networks(result['ipv6_cidrs'])}
        etag = str(result['etag'])
        if body.get('success') is False or not live['ipv4']:
            raise KeyError('result')
    except FeedError as error:
        state['error'] = str(error)
        return state, findings
    except (KeyError, TypeError, AttributeError):
        state['error'] = 'unexpected answer from ' + CLOUDFLARE_IPS
        return state, findings
    every = live['ipv4'] | live['ipv6']
    pin = networks(pinned.get('ipv4')) | networks(pinned.get('ipv6'))
    state.update(etag=etag, ranges=len(every), added=sorted(every - pin), removed=sorted(pin - every))
    if etag != pinned.get('etag') or every != pin:
        findings.append({
            'kind': 'cloudflare-ranges', 'service': 'cloudflare', 'name': 'Cloudflare IP ranges', 'etag': etag,
            'pinnedEtag': pinned.get('etag'), 'added': state['added'], 'removed': state['removed'],
            'summary': ('Cloudflare changed its IP ranges (etag %s; the origin firewalls were built from %s): '
                        'added %s; removed %s. An origin that allows only the old list on 80/443 drops traffic '
                        'from the new edges: update chain %s, every Hetzner firewall http_source_ips list and '
                        '%s together.') % (etag, pinned.get('etag'), join(state['added']), join(state['removed']),
                                           CF_CHAIN, CLOUDFLARE_NAME)})
    enforced = {}
    for family, binary in (('ipv4', 'iptables'), ('ipv6', 'ip6tables')):
        rules = chain(binary)
        if rules is not None:
            enforced[family] = networks(chain_sources(rules))
    if enforced:
        missing = sorted(n for family, nets in enforced.items() for n in live[family] - nets)
        extra = sorted(n for family, nets in enforced.items() for n in nets - live[family])
        state['chain'] = {'name': CF_CHAIN, 'families': sorted(enforced), 'missing': missing, 'extra': extra}
        if missing or extra:
            findings.append({
                'kind': 'cloudflare-chain', 'service': 'cloudflare', 'name': CF_CHAIN, 'missing': missing,
                'extra': extra,
                'summary': ('Chain %s on this host does not match Cloudflare\'s published ranges: missing %s '
                            '(dropped on 80/443); not Cloudflare\'s %s.') % (CF_CHAIN, join(missing), join(extra))})
    return state, findings


NODE_SECURITY_FLOORS = {22: (22, 23, 4), 24: (24, 22, 1), 26: (26, 12, 1)}
DISTRUSTED_ROOTS = ('AAA Certificate Services', 'emSign ECC Root CA - G3')


def vulnerable_node(text):
    version = parse_version(text)
    if not version:
        return True
    floor = NODE_SECURITY_FLOORS.get(version.release[0])
    return floor is None or version < Version('.'.join(str(part) for part in floor))


def distrusted_roots(pem):
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.load_verify_locations(cadata=pem)
    subjects = [str(cert.get('subject')) for cert in context.get_ca_certs()]
    return [root for root in DISTRUSTED_ROOTS if any(root in subject for subject in subjects)]


def runtime_trust(docker):
    """Offline runtime floors and CA contents, independent of application tags.

    Missing optional executables/files are normal for minimal container images.
    Unexpected output from an executable or malformed PEM is an incomplete check.
    """
    ids = docker(['ps', '-q', '--no-trunc']).split()
    findings, skipped = [], []
    for cid in ids:
        name = docker(['inspect', '--format', '{{.Name}}', cid]).strip().lstrip('/')
        def finding(kind, detail):
            findings.append({'kind': kind, 'service': name, 'name': name, 'severity': 'high',
                             'summary': name + ': ' + detail})
        try:
            version = docker(['exec', cid, 'node', '--version'], timeout=15).strip()
        except WatchError:
            version = None
        if version and vulnerable_node(version):
            finding('node-runtime', 'Node ' + safe(version) + ' is below the 2026-10-21 security release; '
                    'require 22.23.4, 24.22.1 or 26.12.1 within that major')
        paths = ['/etc/ssl/certs/ca-certificates.crt', '/etc/ssl/cert.pem']
        try:
            extra = docker(['exec', cid, 'sh', '-c',
                            'for p in /app/lib/castore-*/priv/cacerts.pem /app/lib/certifi-*/priv/cacerts.pem; '
                            'do test ! -f "$p" || echo "$p"; done'], timeout=15)
            paths += [p for p in extra.splitlines() if p.startswith('/app/lib/')]
        except WatchError:
            pass
        try:
            certifi = docker(['exec', cid, 'python3', '-c',
                              'import certifi; print(certifi.where())'], timeout=15).strip()
            if certifi.startswith('/'):
                paths.append(certifi)
        except WatchError:
            pass
        checked = set()
        for path in paths:
            try:
                pem = docker(['exec', cid, 'cat', path], timeout=15)
            except WatchError:
                continue
            digest = hashlib.sha256(pem.encode()).hexdigest()
            if digest in checked:
                continue
            checked.add(digest)
            try:
                roots = distrusted_roots(pem)
            except (ssl.SSLError, ValueError):
                skipped.append(name + ': malformed CA bundle at ' + path)
                continue
            if roots:
                finding('certificate-trust', path + ' still trusts compromised eMudhra chains via ' + ', '.join(roots))
    return findings, skipped


def scan(docker, services, feeds, source=COOLIFY_SOURCE, now=None, cloudflare=None, chain=read_chain, runtime=False):
    now = now or dt.datetime.now(dt.timezone.utc)
    containers, images = list_services(docker, services)
    groups = {}
    skipped = []
    for container in containers:
        service = container['service']
        image = images.get(container['imageId'], {})
        version, source_of = resolve_version(docker, container, image, service)
        if not version:
            skipped.append(service['name'] + ' in ' + container['name'] + ': no version in the image labels, '
                           'and the tag ' + json.dumps(container['tag']) + ' does not name a release')
            continue
        key = (service['key'], str(version))
        group = groups.setdefault(key, {
            'service': service['key'], 'name': service['name'], 'version': str(version), 'versionSource': source_of,
            'containers': [], 'images': [], 'digests': [], '_version': version, '_service': service})
        group['containers'].append(container['name'])
        if container['ref'] not in group['images']:
            group['images'].append(container['ref'])
        for digest in image.get('digests', ()):
            if digest not in group['digests']:
                group['digests'].append(digest)
        tag_version = full_version(container['tag'] or '')
        if not tag_version or tag_version != version:
            group['floatingTag'] = container['tag']
    findings = []
    report_services = []
    for group in sorted(groups.values(), key=lambda g: (g['service'], g['_version'].key())):
        service, version = group.pop('_service'), group.pop('_version')
        group.update({'latest': None, 'advisorySource': None, 'advisoriesChecked': 0, 'findings': [],
                      'unknown': [], 'feedError': None})
        try:
            group['latest'] = latest_release(feeds, service)
        except FeedError as error:
            group['feedError'] = str(error)
        latest = (group['latest'] or {}).get('version')
        if service.get('github'):
            group['advisorySource'] = 'github:' + service['github']
            try:
                advisories = feeds.json(advisories_url(service['github']), pages=True)
            except FeedError as error:
                group['feedError'] = str(error)
                advisories = []
            released_at = None
            for advisory in advisories:
                if advisory.get('withdrawn_at') or advisory.get('severity') not in FLAGGED:
                    continue
                group['advisoriesChecked'] += 1
                covered = covers(version, advisory, service)
                if covered is None:
                    released_at = released_at or release_date(feeds, service['github'], version)
                    covered = covers(version, advisory, service, released_at)
                entry = {'id': advisory.get('ghsa_id'), 'severity': advisory.get('severity'),
                         'summary': safe((advisory.get('summary') or '')[:200]),
                         'url': advisory.get('html_url'), 'published': (advisory.get('published_at') or '')[:10]}
                if covered is None:
                    ranges = [e.get('vulnerable_version_range') for e in advisory.get('vulnerabilities') or []]
                    group['unknown'].append(dict(entry, range=safe(', '.join(r or '' for r in ranges))))
                elif covered:
                    fixed = fixed_in(version, advisory, service)
                    group['findings'].append(dict(entry, fixed=fixed))
                    findings.append({
                        'kind': 'advisory', 'service': group['service'], 'name': group['name'],
                        'version': group['version'], 'containers': group['containers'], 'id': entry['id'],
                        'severity': entry['severity'], 'fixed': fixed, 'latest': latest, 'url': entry['url'],
                        'summary': '%s %s (%s): %s %s, %s; latest %s. %s' % (
                            group['name'], group['version'], ', '.join(group['containers']), entry['id'],
                            entry['severity'], 'fixed in ' + fixed if fixed else 'no fixed release yet',
                            latest or 'unknown', entry['summary'])})
        if group['feedError']:
            skipped.append(group['name'] + ': ' + group['feedError'])
        for unknown in group['unknown']:
            skipped.append('%s %s: %s (%s) has a range that cannot be read: %s; check %s' % (
                group['name'], group['version'], unknown['id'], unknown['severity'], unknown['range'], unknown['url']))
        report_services.append(group)
    auto_update = coolify_auto_update(source, now) if Path(source).is_dir() else None
    if auto_update and not auto_update['ok']:
        findings.append({
            'kind': 'auto-update', 'service': 'coolify', 'name': 'Coolify auto-update',
            'summary': 'Coolify auto-update failed %d run(s) in a row since %s (target %s, registry %s): %s' % (
                auto_update['failedRuns'], auto_update['failingSince'], auto_update['target'],
                auto_update['registry'], auto_update['error'])})
    cloudflare_state = None
    if cloudflare:
        cloudflare_state, cloudflare_findings = cloudflare_check(feeds, cloudflare, chain)
        findings += cloudflare_findings
        if cloudflare_state['error']:
            skipped.append('Cloudflare IP ranges: ' + cloudflare_state['error'])
    if runtime:
        runtime_findings, runtime_skipped = runtime_trust(docker)
        findings += runtime_findings
        skipped += runtime_skipped
    severity_rank = {'critical': 0, 'high': 1}
    findings.sort(key=lambda f: (f['kind'] != 'auto-update', severity_rank.get(f.get('severity'), 2), f['service']))
    notes = [g['name'] + ' publishes no advisory feed; it is compared with its latest release only.'
             for g in report_services if not g['advisorySource']]
    return safe({'host': socket.gethostname(), 'scannedAt': now.isoformat(timespec='seconds'),
                 'services': report_services, 'findings': findings[:MAX_FINDINGS], 'autoUpdate': auto_update,
                 'cloudflare': cloudflare_state, 'skipped': skipped, 'notes': notes})


# --- timer --------------------------------------------------------------------

def work_dir():
    try:
        config = json.loads(Path(BACKUP_CONFIG).read_text())
    except (OSError, ValueError):
        config = {}
    return Path(config.get('workDir', '/var/lib/hatchkit-backups')), config


def unit_value(unit, prop):
    try:
        return subprocess.run(['systemctl', 'show', unit, '--property=' + prop, '--value'],
                              capture_output=True, text=True, timeout=15).stdout.strip()
    except (subprocess.SubprocessError, OSError):
        return ''


def timer_state(work):
    installed = Path('/etc/systemd/system/' + TIMER).exists()
    state = {'installed': installed}
    if installed:
        state['active'] = unit_value(TIMER, 'ActiveState') == 'active'
        state['serviceResult'] = unit_value(SERVICE, 'Result') or None
        state['nextRun'] = unit_value(TIMER, 'NextElapseUSecRealtime') or None
    try:
        state['lastCheck'] = json.loads((work / STATUS_NAME).read_text())
    except (OSError, ValueError):
        state['lastCheck'] = None
    return state


def mail_settings(config):
    settings = dict(config.get('alerts') or {})
    if not settings.get('enabled', False) or not settings.get('to') or not settings.get('smtpFile'):
        raise WatchError('backup alert mail is not configured (hatchkit backup alerts)')
    settings['from'] = formataddr(('Hatchkit Update Watch', parseaddr(settings['from'])[1]))
    return settings


MAIL_FOOTER = ('\nInspect: hatchkit host updates --json\n'
               'Server logs: journalctl -u ' + SERVICE + '\n')


def mail_body(report, error):
    if error:
        return 'The weekly update watch could not finish: ' + error + '.\n' + MAIL_FOOTER
    lines = []
    if report['findings']:
        lines += [str(len(report['findings'])) + ' finding(s):', '']
        lines += ['- ' + f['summary'] for f in report['findings']]
        lines += ['', 'Upgrade each service to its fixed version or the latest release, then run '
                  'hatchkit host updates to confirm.']
    if report['skipped']:
        lines += ['', 'Not checked this run:'] + ['- ' + s for s in report['skipped']]
    return '\n'.join(lines) + '\n' + MAIL_FOOTER


def write_status(work, state):
    path = work / STATUS_NAME
    temporary = work / (STATUS_NAME + '.tmp')
    temporary.write_text(json.dumps(state, indent=2) + '\n')
    temporary.replace(path)


def check(docker, services, feeds, work, config, send, now=None, source=COOLIFY_SOURCE, cloudflare=None,
          chain=read_chain, runtime=False):
    """One timer run. Mails findings and checks it could not make every week,
    a failed run, and the first clean run after either."""
    now = now or dt.datetime.now(dt.timezone.utc)
    try:
        previous = json.loads((work / STATUS_NAME).read_text())
    except (OSError, ValueError):
        previous = {}
    report, error = None, None
    try:
        report = scan(docker, services, feeds, source, now, cloudflare, chain, runtime=runtime)
    except WatchError as failure:
        error = str(failure)
    except Exception as failure:  # never echo a message that might carry host data
        error = type(failure).__name__
    findings = report['findings'] if report else []
    skipped = report['skipped'] if report else []
    hostname = socket.gethostname()
    kind, subject = None, None
    if error:
        kind, subject = 'error', '[Hatchkit] Update watch failed — ' + hostname
    elif findings:
        kind, subject = 'findings', ('[Hatchkit] Update watch: ' + str(len(findings)) + ' finding'
                                     + ('' if len(findings) == 1 else 's') + ' — ' + hostname)
    elif skipped:
        kind, subject = 'incomplete', '[Hatchkit] Update watch could not check everything — ' + hostname
    elif previous.get('findings') or previous.get('error') or previous.get('skipped'):
        kind, subject = 'recovery', '[Hatchkit] Update watch clear — ' + hostname
    state = {'checkedAt': now.isoformat(timespec='seconds'), 'ok': not error and not findings and not skipped,
             'error': error, 'services': [{'service': s['service'], 'version': s['version'],
                                           'latest': (s['latest'] or {}).get('version')}
                                          for s in (report or {}).get('services', [])],
             'findings': findings[:50], 'skipped': skipped, 'mailed': None, 'messageId': None}
    mail_error = None
    if kind:
        if kind == 'recovery':
            body = ('Every watched service runs a version with no known high or critical advisory, '
                    'Coolify auto-update is not failing, and Cloudflare\'s IP ranges match what the origins '
                    'allow.\n' + MAIL_FOOTER)
        else:
            body = mail_body(report, error)
        try:
            state['messageId'] = send(mail_settings(config), subject, body)
            state['mailed'] = kind
        except Exception as failure:  # SMTP errors may echo login details; keep the type only
            mail_error = failure if isinstance(failure, WatchError) else type(failure).__name__
            state['mailError'] = str(mail_error)
    write_status(work, state)
    return state, mail_error


def load(payload, key, name):
    if payload and payload.get(key):
        return payload[key]
    return json.loads((Path(__file__).resolve().parent / name).read_text())


def main(payload=None):
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['scan', 'check', 'failed', 'test'])
    args = parser.parse_args()
    work, config = work_dir()
    services = load(payload, 'services', SERVICES_NAME)
    cloudflare = load(payload, 'cloudflare', CLOUDFLARE_NAME)
    feeds = Feeds((payload or {}).get('feeds'))
    if args.action == 'scan':
        report = scan(run_docker, services, feeds, cloudflare=cloudflare, runtime=True)
        report['timer'] = timer_state(work)
        print(json.dumps(report))
        return
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from alerts import send_email
    work.mkdir(mode=0o700, parents=True, exist_ok=True)
    hostname = socket.gethostname()
    if args.action == 'test':
        message_id = send_email(mail_settings(config), '[Hatchkit] Update watch alert test — ' + hostname,
                                'Update watch alerts are configured for this address.\n\n'
                                'This is a test. The weekly check mails when a shared service (Coolify, Traefik, '
                                'Plausible CE, Listmonk, Uptime Kuma, GlitchTip, ClickHouse) runs a version that a '
                                'high or critical upstream advisory covers, when Coolify auto-update fails, when '
                                'Cloudflare changes the IP ranges the origin firewalls allow, and when it could not '
                                'check something. The first clean run after that sends one all-clear.\n'
                                + MAIL_FOOTER)
        print(json.dumps({'sent': True, 'messageId': message_id}))
        return
    if args.action == 'failed':
        message_id = send_email(mail_settings(config), '[Hatchkit] Update watch did not finish — ' + hostname,
                                'systemd stopped the weekly update watch before it finished (a timeout, the memory '
                                'limit, or a crash). Nothing was checked this run.\n' + MAIL_FOOTER)
        print(json.dumps({'sent': True, 'messageId': message_id}))
        return
    state, mail_error = check(run_docker, services, feeds, work, config, send_email, cloudflare=cloudflare, runtime=True)
    print(json.dumps({'ok': state['ok'], 'findings': len(state['findings']), 'error': state['error'],
                      'mailed': state['mailed'], 'mailError': state.get('mailError')}))
    if mail_error:
        sys.exit(1)


if __name__ == '__main__':
    try:
        main(globals().get('PAYLOAD'))
    except WatchError as error:
        print(json.dumps({'ok': False, 'error': str(error)}))
        sys.exit(1)
    except Exception as error:
        print(json.dumps({'ok': False, 'error': type(error).__name__}))
        sys.exit(1)
