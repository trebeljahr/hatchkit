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
80/443: a hardened host drops everything else, so a new Cloudflare edge would be
dropped. The ranges are compared with the pinned snapshot
(update-watch-cloudflare.json) and with this host's HATCHKIT-CF chain.

The scheduled check refreshes authenticated APT indexes before inspecting
installed Ubuntu packages against trusted security-pocket versions. It never
installs packages or restarts services. Failed refreshes, missing sources and
indexes older than eight hours lose coverage explicitly. `scan` only reads.

Its other checks only read: docker inspect, `docker exec` of a version command when a
tag floats, the status lines of the upgrade logs, `iptables -S HATCHKIT-CF`,
and HTTPS GETs to api.github.com, gitlab.com and api.cloudflare.com. It never prints environment values; of an
image's env it reads only the version keys the services file names.

  scan    print the report as JSON
  check   scan, mail findings through the backup-alert SMTP and record the
          result (what the scheduled timer runs)
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
import stat
import subprocess
import sys
import tempfile
import urllib.error
from urllib.parse import quote, urlsplit
import urllib.request
from zoneinfo import ZoneInfo

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
KEV_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json'
KEV_MIRROR_URL = 'https://raw.githubusercontent.com/cisagov/kev-data/develop/known_exploited_vulnerabilities.json'
FLAGGED = ('critical', 'high')
# Distro and channel suffixes are not prereleases: 24.12.6.70-alpine,
# v23.8.15.35-lts, v26.7.34.3-stable.
SUFFIXES = {'alpine', 'lts', 'stable', 'slim', 'official', 'debian', 'bookworm', 'ubuntu'}
VERSION = re.compile(r'^[vV]?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$')
CONSTRAINT = re.compile(r'(>=|<=|==|=|>|<)?\s*([vV]?\d[0-9A-Za-z.+-]*)')
# How many upgrade logs to read, newest first, to count a failing streak.
UPGRADE_LOGS = 60
MAX_MAIL_FINDINGS = 50
IMAGE_ASSESSMENTS = '/etc/hatchkit-security/image-assessments.json'


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

class FeedRateLimit(FeedError):
    def __init__(self, retry_at):
        self.retry_at = retry_at
        super().__init__('GitHub API rate limit reached for this address; it resets at '
                         + retry_at.strftime('%H:%M UTC'))


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
            if reset.isdigit():
                raise FeedRateLimit(dt.datetime.fromtimestamp(int(reset), dt.timezone.utc)) from None
            raise FeedError('GitHub API rate limit reached for this address; it resets at ' + when) from None
        raise FeedError('HTTP ' + str(error.code) + ' from ' + url.split('?')[0]) from None
    except (urllib.error.URLError, OSError, ValueError):
        raise FeedError('could not read ' + url.split('?')[0]) from None


class GithubFeedReader:
    """Reuse public responses for one hour; never extend retrieval timestamps.

    Failed reads are never cached as success. `fresh` bypasses positive cache
    reads but still honors the API's primary-rate-limit reset.
    """
    TTL = dt.timedelta(hours=1)
    MAX_BYTES = 1024**2
    MAX_ENTRIES = 64

    def __init__(self, work, get=http_get, clock=None, fresh=False, readonly=False):
        self.directory = Path(work) / 'github-feeds'
        self.readonly = readonly
        self.blocked_until = None
        if not readonly:
            self.directory.mkdir(mode=0o700, exist_ok=True)
        try:
            s = self.directory.lstat()
            if not stat.S_ISDIR(s.st_mode) or s.st_uid != os.geteuid() or stat.S_IMODE(s.st_mode) != 0o700:
                raise FeedError('Unsafe GitHub feed cache directory')
        except FileNotFoundError:
            if not readonly:
                raise
        self.get, self.clock, self.fresh = get, clock or (lambda:dt.datetime.now(dt.timezone.utc)), fresh
        self.retrieved = []
        self.hits = self.network_reads = 0

    def read(self, path):
        try:
            s = path.lstat()
            if not stat.S_ISREG(s.st_mode) or s.st_uid != os.geteuid() or stat.S_IMODE(s.st_mode) != 0o600 or s.st_size > self.MAX_BYTES:
                return None
            with path.open('rb') as file:
                raw = file.read(self.MAX_BYTES + 1)
            if len(raw) > self.MAX_BYTES:
                return None
            value = json.loads(raw)
            return value if isinstance(value, dict) and value.get('schema') == 1 else None
        except (OSError, ValueError):
            return None

    def write(self, path, record):
        if self.readonly:
            return
        data = json.dumps(record, ensure_ascii=False).encode()
        if len(data) > self.MAX_BYTES:
            return
        try:
            entries = sorted(self.directory.glob('*.feed.json'), key=lambda p:p.lstat().st_mtime)
            while len(entries) >= self.MAX_ENTRIES and path not in entries:
                entries.pop(0).unlink()
            fd, name = tempfile.mkstemp(prefix='.feed-', dir=self.directory)
            try:
                with os.fdopen(fd, 'wb') as file:
                    file.write(data)
                    file.flush()
                    os.fsync(file.fileno())
                Path(name).replace(path)
            finally:
                Path(name).unlink(missing_ok=True)
        except OSError:
            raise FeedError('GitHub feed cache could not be written') from None

    def __call__(self, url):
        parsed = urlsplit(url)
        if parsed.scheme != 'https' or parsed.netloc != 'api.github.com' or not parsed.path.startswith('/repos/'):
            return self.get(url)
        now = self.clock()
        path = self.directory / (hashlib.sha256(url.encode()).hexdigest() + '.feed.json')
        cached = None if self.fresh else self.read(path)
        if cached and cached.get('url') == url and isinstance(cached.get('data'), (dict,list)) and isinstance(cached.get('link'), str):
            try:
                retrieved = dt.datetime.fromisoformat(cached['retrievedAt'])
                if retrieved.tzinfo is not None and dt.timedelta(0) <= now - retrieved < self.TTL:
                    self.hits += 1
                    self.retrieved.append(retrieved)
                    return cached['data'], cached['link']
            except (KeyError, TypeError, ValueError):
                pass
        block_path = self.directory / 'primary-rate-limit.json'
        if self.blocked_until is not None and now < self.blocked_until:
            raise FeedRateLimit(self.blocked_until)
        blocked = self.read(block_path)
        if blocked:
            try:
                until = dt.datetime.fromisoformat(blocked['until'])
                observed = dt.datetime.fromisoformat(blocked['observedAt'])
                if (observed.tzinfo is not None and until.tzinfo is not None
                        and dt.timedelta(0) <= now - observed < dt.timedelta(hours=2)
                        and observed < until <= observed + dt.timedelta(hours=2) and now < until):
                    raise FeedRateLimit(until)
            except (KeyError, TypeError, ValueError):
                pass
        try:
            self.network_reads += 1
            data, link = self.get(url)
        except FeedRateLimit as error:
            if now < error.retry_at <= now + dt.timedelta(hours=2):
                self.blocked_until = error.retry_at
                self.write(block_path, {'schema':1,'observedAt':now.isoformat(),'until':error.retry_at.isoformat()})
            raise
        if not isinstance(data, (dict,list)) or not isinstance(link,str):
            raise FeedError('Invalid GitHub feed response')
        self.write(path, {'schema':1,'url':url,'retrievedAt':now.isoformat(),'data':data,'link':link})
        self.retrieved.append(now)
        return data, link

    def receipt(self):
        return {'maximumCacheAgeSeconds':int(self.TTL.total_seconds()),'cacheHits':self.hits,
                'networkReads':self.network_reads,
                'oldestRetrievedAt':min(self.retrieved).isoformat() if self.retrieved else None}


def known_exploited_catalog(feeds, now):
    """CISA's own mirror is a fallback when its canonical site blocks a host.

    CISA documents synchronization within minutes. Do not accept malformed,
    empty, future-dated or more than 14-day-old data as successful coverage.
    A catalog can legitimately remain unchanged between new KEV additions.
    """
    failures = []
    for url in (KEV_URL, KEV_MIRROR_URL):
        try:
            catalog = feeds.json(url)
            entries = catalog['vulnerabilities']
            count = catalog['count']
            released = dt.datetime.fromisoformat(catalog['dateReleased'].replace('Z', '+00:00'))
            if (not isinstance(entries, list) or not isinstance(count, int) or isinstance(count, bool)
                    or count < 1 or count != len(entries) or released.tzinfo is None
                    or released > now + dt.timedelta(minutes=5)
                    or now - released > dt.timedelta(days=14)):
                raise FeedError('invalid or stale CISA KEV feed')
            identifiers = {entry['cveID'] for entry in entries}
            if len(identifiers) != count or not all(re.fullmatch(r'CVE-\d{4}-\d{4,}', value) for value in identifiers):
                raise FeedError('invalid CISA KEV identifiers')
            return identifiers, {'source': url, 'dateReleased': catalog['dateReleased'], 'count': count,
                                 'fallbackDiagnostics': failures}
        except (FeedError, AttributeError, KeyError, TypeError, ValueError) as failure:
            failures.append({'source': url, 'error': str(failure) if isinstance(failure, FeedError) else type(failure).__name__})
            continue
    raise FeedError('CISA known exploited vulnerability catalog could not be checked; '
                    + '; '.join(row['source'] + ': ' + row['error'] for row in failures))


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


def list_services(docker, services, skipped=None):
    """Resolve watched upstreams even after local package/runtime rebuilds."""
    skipped = skipped if skipped is not None else []
    ids = docker(['ps', '-q', '--no-trunc']).split()
    if not ids:
        return [], {}
    by_repo = {image: s for s in services for image in s['images']}
    inventory = []
    for line in docker(['inspect', '--format', INSPECT, *ids]).splitlines():
        try:
            fields = [json.loads(f) for f in line.split('\t')]
            name, ref, image_id = fields[:3]
            original = fields[3] if len(fields) > 3 else None
            inventory.append((name, ref, image_id, original))
        except ValueError:
            skipped.append('Container inventory: unreadable identity')
    images = {}
    wanted = sorted({row[2] for row in inventory})
    if wanted:
        for line in docker(['image', 'inspect', '--format', IMAGE_INSPECT, *wanted]).splitlines():
            try:
                image_id, config, digests = (json.loads(f) for f in line.split('\t'))
            except ValueError:
                skipped.append('Image inventory: unreadable identity')
                continue
            config = config or {}
            images[image_id] = {'labels': config.get('Labels') or {}, 'env': config.get('Env') or [],
                                'digests': digests or []}
    containers = []
    derived = lambda ref: isinstance(ref, str) and ref.startswith(('hatchkit-security/', 'hatchkit-rollback/', 'sha256:'))
    for name, ref, image_id, original in inventory:
        baked = images.get(image_id, {}).get('labels', {}).get('io.hatchkit.security.original-image')
        candidates = [origin for origin in (original, baked) if origin and not derived(origin)]
        if len(set(candidates)) > 1:
            skipped.append('Upstream advisory coverage in ' + name.lstrip('/') + ': conflicting upstream provenance')
            continue
        origin = candidates[0] if candidates else ref
        repo, tag = split_image(origin or '')
        if repo in by_repo:
            containers.append({'name': name.lstrip('/'), 'ref': ref, 'repo': repo, 'tag': tag,
                               'imageId': image_id, 'service': by_repo[repo]})
        elif not candidates and (derived(original) or derived(baked) or (ref or '').startswith(('hatchkit-security/', 'hatchkit-rollback/'))):
            skipped.append('Upstream advisory coverage in ' + name.lstrip('/') + ': unresolved derived-image provenance')
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
    is told, night after night."""
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


HOST_RUNTIMES = (
    {'key': 'host-docker', 'name': 'Docker Engine', 'github': 'moby/moby',
     'argv': ['docker', 'version', '--format', '{{.Server.Version}}'], 'pattern': r'^(\d+\.\d+\.\d+)',
     'packageWords': ['docker engine'], 'floor': '29.9.2'},
    {'key': 'host-containerd', 'name': 'containerd', 'github': 'containerd/containerd',
     'argv': ['containerd', '--version'], 'pattern': r'containerd.*?v?(\d+\.\d+\.\d+)',
     'packageWords': ['containerd']},
    {'key': 'host-runc', 'name': 'runc', 'github': 'opencontainers/runc',
     'argv': ['runc', '--version'], 'pattern': r'runc version v?(\d+\.\d+\.\d+)',
     'packageWords': ['runc']},
    {'key': 'host-tailscale', 'name': 'Tailscale', 'github': 'tailscale/tailscale',
     'argv': ['tailscale', 'version'], 'pattern': r'^(\d+\.\d+\.\d+)',
     'packageWords': ['tailscale'], 'floor': '1.104.2'},
)


def host_runtime_versions(run=None):
    """Only fixed version commands; never process arguments or host credentials."""
    if run is None:
        def run(argv):
            p = subprocess.run(argv, capture_output=True, text=True, timeout=20)
            if p.returncode:
                raise WatchError('host runtime version command failed')
            return p.stdout
    rows, skipped = [], []
    for spec in HOST_RUNTIMES:
        try:
            match = re.search(spec['pattern'], run(spec['argv']))
            version = parse_version(match.group(1)) if match else None
            if not version:
                raise WatchError('unreadable version')
            rows.append((spec, version))
        except (WatchError, OSError, subprocess.SubprocessError):
            skipped.append(spec['name'] + ': host version could not be checked')
    return rows, skipped


APT_DIAGNOSTIC_LIMIT = 65536
APT_FAILURE_HINTS = {
    'certificate-verification': 'Check the configured repository certificate and host clock; keep TLS verification enabled.',
    'repository-authentication': 'Review repository signing keys and signed source configuration; keep signature verification enabled.',
    'name-resolution': 'Check host DNS and repository name resolution.',
    'network-connection': 'Check repository availability and the host network path.',
    'lock-contention': 'Inspect the active package-manager job before retrying; do not delete live locks.',
    'timeout': 'Inspect the package refresh timeout and network path.',
    'execution': 'Inspect the package-manager executable and host permissions.',
    'unknown': 'Inspect the root-private APT diagnostic on this host.',
}


def apt_failure_category(output, fallback='unknown'):
    text = output.decode('utf-8', errors='replace').lower()
    if any(x in text for x in ['certificate verification failed', 'certificate has expired',
                               'certificate is not trusted', 'certificate chain uses expired']):
        return 'certificate-verification'
    if any(x in text for x in ['no_pubkey', 'expkeysig', 'badsig', 'is not signed',
                               'signatures couldn\'t be verified', 'invalid signature']):
        return 'repository-authentication'
    if any(x in text for x in ['temporary failure resolving', 'could not resolve', 'couldn\'t resolve']):
        return 'name-resolution'
    if any(x in text for x in ['could not get lock', 'unable to acquire', 'is held by process']):
        return 'lock-contention'
    if any(x in text for x in ['could not connect', 'connection refused', 'network is unreachable', 'connection failed']):
        return 'network-connection'
    return fallback


def retain_apt_diagnostic(work, output):
    """Atomic 0600 tail; private repository URLs/output never enter mail/state."""
    output.seek(0, os.SEEK_END)
    size = output.tell()
    output.seek(max(0, size - APT_DIAGNOSTIC_LIMIT))
    tail = output.read(APT_DIAGNOSTIC_LIMIT)
    fd, temporary = tempfile.mkstemp(prefix='.apt-refresh-diagnostic-', dir=work)
    try:
        with os.fdopen(fd, 'wb') as file:
            file.write(tail)
            file.flush()
            os.fsync(file.fileno())
        Path(temporary).replace(work / 'host-package-refresh.private.log')
    finally:
        Path(temporary).unlink(missing_ok=True)
    return tail, {'retainedBytes':len(tail), 'truncated':size > len(tail)}


def refresh_host_package_indexes(work, run=subprocess.run, now=None):
    """Refresh authenticated indexes only; never install, resolve or restart."""
    error = None
    category = None
    diagnostic = None
    with tempfile.TemporaryFile(dir=work) as output:
        try:
            result = run(['apt-get', '-o', 'APT::Update::Error-Mode=any',
                      '-o', 'DPkg::Lock::Timeout=20', '-o', 'Acquire::Retries=0',
                      '-o', 'Acquire::http::Timeout=20', '-o', 'Acquire::https::Timeout=20',
                      'update'], stdout=output, stderr=subprocess.STDOUT,
                     timeout=300, env={**os.environ, 'LC_ALL':'C', 'DEBIAN_FRONTEND':'noninteractive'})
            if result.returncode:
                error = 'Authenticated APT refresh failed (exit %d)' % result.returncode
                category = 'unknown'
        except subprocess.TimeoutExpired:
            error = 'Authenticated APT refresh could not finish'
            category = 'timeout'
        except (OSError, subprocess.SubprocessError):
            error = 'Authenticated APT refresh could not finish'
            category = 'execution'
        if error:
            tail, diagnostic = retain_apt_diagnostic(work, output)
            category = apt_failure_category(tail, category)
    state = {'checkedAt': (now or dt.datetime.now(dt.timezone.utc)).isoformat(),
             'ok': error is None, 'error': error}
    if error:
        state.update(failureCategory=category, action=APT_FAILURE_HINTS[category], diagnostic=diagnostic)
    path = work / 'host-package-refresh.json'
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(state) + '\n')
    temporary.replace(path)
    return state


def host_package_findings(now, cache=None, sources=None, refresh_path=None, distro=None, compare=None):
    """Security-pocket versions, including fixes hidden by candidate pinning.

    High is review priority, not a claimed CVE score. Actual vendor severity and
    exploitation remain unclassified until advisory applicability is reviewed.
    """
    findings, skipped = [], []
    try:
        path = Path(refresh_path) if refresh_path else work_dir()[0] / 'host-package-refresh.json'
        refresh = json.loads(path.read_text())
        checked = dt.datetime.fromisoformat(refresh['checkedAt'])
        if refresh.get('ok') is not True or refresh.get('error'):
            skipped.append('Host package coverage incomplete: latest authenticated APT refresh failed')
            category = refresh.get('failureCategory')
            if category in APT_FAILURE_HINTS:
                skipped.append('APT failure category: ' + category + '. ' + APT_FAILURE_HINTS[category])
        if now - checked > dt.timedelta(hours=8) or checked > now + dt.timedelta(minutes=5):
            skipped.append('Host package coverage incomplete: authenticated APT indexes are stale')
    except (OSError, ValueError, KeyError, TypeError):
        skipped.append('Host package coverage incomplete: authenticated APT refresh proof missing or invalid')
    try:
        distro = distro if distro is not None else dict(
            line.split('=', 1) for line in Path('/etc/os-release').read_text().splitlines() if '=' in line)
        codename = distro.get('VERSION_CODENAME', '').strip('"')
        if distro.get('ID', '').strip('"') != 'ubuntu' or not re.fullmatch('[a-z]+', codename):
            raise ValueError('Unsupported distro')
        pocket = codename + '-security'
        if cache is None or sources is None or compare is None:
            import apt
            import apt_pkg
            if cache is None:
                cache = apt.Cache()
            if sources is None:
                source_list = apt_pkg.SourceList()
                source_list.read_main_list()
                sources = source_list.list
            compare = compare or apt_pkg.version_compare
        if not any(source.dist == pocket and source.is_trusted for source in sources):
            skipped.append('Host package coverage incomplete: trusted Ubuntu security source is missing')
        for package in cache:
            if not package.is_installed:
                continue
            fixed = None
            for version in package.versions:
                if compare(version.version, package.installed.version) <= 0:
                    continue
                if any(origin.trusted and origin.origin == 'Ubuntu' and origin.archive == pocket for origin in version.origins):
                    if fixed is None or compare(version.version, fixed) > 0:
                        fixed = version.version
            if fixed:
                name = package.fullname
                candidate = package.candidate.version if package.candidate else None
                findings.append({'kind':'host-package', 'service':'host-os', 'name':name,
                                 'package':name, 'id':'ubuntu-security:' + name,
                                 'version':package.installed.version, 'fixed':fixed, 'candidate':candidate,
                                 'severity':'high', 'vendorSeverity':'unclassified',
                                 'blockedByPolicy':candidate is None or compare(candidate, fixed) < 0,
                                 'summary':name + ' has a trusted Ubuntu security update pending; '
                                            'review priority high, CVE severity unclassified'})
    except (ImportError, OSError, ValueError, KeyError, TypeError, AttributeError, SystemError):
        skipped.append('Host package coverage incomplete: installed/security versions could not be inspected')
    return findings, skipped


def image_package_findings(now, path=None):
    live_names = path is None
    path = Path(path) if path is not None else work_dir()[0] / 'image-vulnerability-status.json'
    try:
        report = json.loads(path.read_text())
        findings = report.get('findings', [])
        if live_names:
            names = workload_display_names()
            for finding in findings:
                finding['containerDisplayNames'] = [names.get(name, name) for name in finding.get('containers', [])]
        checked = dt.datetime.fromisoformat(report['checkedAt'])
        if now - checked > dt.timedelta(hours=36) or checked > now + dt.timedelta(minutes=5):
            return findings, ['Final image vulnerability scan is stale; previous ledger retained, current coverage incomplete']
        if not report.get('complete') or report.get('errors'):
            return findings, ['Final image vulnerability scan is incomplete; inspect its private status']
        progress_path = path.with_name('image-vulnerability-progress.json')
        if progress_path.exists():
            progress = json.loads(progress_path.read_text())
            phase = progress['phase']
            if phase == 'failed' or progress.get('errors'):
                return findings, ['Latest final image scan failed; previous complete ledger retained']
            if phase == 'running':
                last = dt.datetime.fromisoformat(progress['checkedAt'])
                started = dt.datetime.fromisoformat(progress['startedAt'])
                if last > now + dt.timedelta(minutes=5) or now - last > dt.timedelta(minutes=20) or now - started > dt.timedelta(hours=2):
                    return findings, ['Final image scan is stalled or exceeded two hours; previous ledger retained']
            elif phase != 'complete':
                return findings, ['Final image scan progress is invalid; inspect its private status']
        return findings, []
    except (OSError, ValueError, KeyError, TypeError):
        return [], ['Final image vulnerability scan is missing, invalid or older than 36 hours']


def static_httpd_boundary(container, expected_root=Path('/data/coolify/proxy/error-pages'), trusted_uids=(0, 1000)):
    """This predicate covers reviewed awk/ash input paths, not httpd CVEs."""
    config = container['Config']
    if config.get('Entrypoint') or config.get('Cmd') != ['httpd', '-f', '-p', '80', '-h', '/www']:
        return False
    mounts = container['Mounts']
    if len(mounts) != 1 or mounts[0]['Type'] != 'bind' or mounts[0]['Destination'] != '/www' or mounts[0]['RW']:
        return False
    root = Path(mounts[0]['Source'])
    if root.resolve() != expected_root:
        return False
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid not in trusted_uids or info.st_mode & 0o022:
        return False
    files = list(root.iterdir())
    if not 0 < len(files) <= 256:
        return False
    for file in files:
        info = file.lstat()
        if (not re.fullmatch(r'(503|maintenance-[A-Za-z0-9_-]{1,128})\.html', file.name)
                or not stat.S_ISREG(info.st_mode) or info.st_uid not in trusted_uids
                or info.st_mode & 0o133 or info.st_size > 1048576):
            return False
    return True


def apply_image_assessments(findings, docker, now, path=None, boundary=static_httpd_boundary):
    """Keep raw findings/clocks; revalidate narrowly scoped operator reviews.

    Missing optional configuration changes nothing. A live matching review that
    expires or loses its predicate becomes incomplete coverage, never a silent
    exception. Known exploitation always bypasses an assessment.
    """
    target = Path(path or IMAGE_ASSESSMENTS)
    findings = [{k: v for k, v in f.items() if k != 'assessment'} for f in findings]
    if not target.exists():
        return findings, []
    try:
        info = target.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > 262144:
            raise ValueError('Invalid assessment file')
        if path is None and (info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600):
            raise ValueError('Unsafe assessment ownership or mode')
        data = json.loads(target.read_text())
        if data['schema'] != 1 or not isinstance(data['reviews'], list) or len(data['reviews']) > 100:
            raise ValueError('Invalid assessment schema')
        rows, seen, assigned, skipped = [dict(f) for f in findings], set(), set(), []
        for review in data['reviews']:
            identifier = review['id']
            if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,79}', identifier) or identifier in seen:
                raise ValueError('Duplicate or invalid review identity')
            seen.add(identifier)
            if review['predicate'] != 'busybox-static-httpd-awk-ash-v1':
                raise ValueError('Unsupported review predicate')
            # This predicate has been reviewed only for these three script flaws.
            if not set(review['advisories']) or not set(review['advisories']) <= {'CVE-2026-38753', 'CVE-2026-38754', 'CVE-2026-38755'}:
                raise ValueError('Advisory outside the reviewed predicate')
            if not re.fullmatch(r'sha256:[a-f0-9]{64}', review['imageId']):
                raise ValueError('Invalid image identity')
            if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', review['container']):
                raise ValueError('Invalid workload identity')
            if review['package'] != 'busybox' or not full_version(review['version']):
                raise ValueError('Unexpected package')
            bindings = {(review['container'], review['imageId'], review['package'], review['version'], advisory) for advisory in review['advisories']}
            if assigned & bindings:
                raise ValueError('Overlapping assessment bindings')
            assigned.update(bindings)
            if not all(isinstance(review[k], str) and 0 < len(review[k]) <= 1000 and not re.search(r'[\x00-\x1f\x7f]', review[k]) for k in ['owner', 'reason']):
                raise ValueError('Invalid review explanation')
            evidence = review['evidence']
            if not isinstance(evidence, list) or not 1 <= len(evidence) <= 10:
                raise ValueError('Missing evidence')
            for url in evidence:
                parsed = urlsplit(url)
                if len(url) > 1000 or parsed.scheme != 'https' or not parsed.hostname or parsed.username is not None or parsed.password is not None or re.search(r'[\x00-\x20\x7f]', url):
                    raise ValueError('Invalid evidence URL')
            checked, expires = map(dt.datetime.fromisoformat, [review['reviewedAt'], review['expiresAt']])
            if checked.tzinfo is None or expires.tzinfo is None or checked > now + dt.timedelta(minutes=5) or not dt.timedelta(0) < expires-checked <= dt.timedelta(days=7):
                raise ValueError('Invalid review lifetime')
            selected = [f for f in rows if f.get('kind') == 'image-package'
                        and f.get('name') == review['package'] and f.get('version') == review['version']
                        and f.get('id') in review['advisories'] and f.get('containers') == [review['container']]]
            if not selected:
                continue  # Resolved findings do not create stale-review alerts.
            if now >= expires:
                skipped.append('Image applicability review expired: '+identifier)
                continue
            try:
                container = json.loads(docker(['inspect', '--format', '{{json .}}', review['container']]))
                if container['Image'] != review['imageId'] or container['Name'].lstrip('/') != review['container'] or not boundary(container):
                    raise ValueError('Review boundary changed')
                docker(['exec', review['container'], '/bin/busybox', 'test', '!', '-e', '/etc/httpd.conf'])
            except (WatchError, OSError, ValueError, KeyError, TypeError):
                skipped.append('Image applicability review context changed: '+identifier)
                continue
            for finding in selected:
                if not immediate_finding(finding):
                    finding['assessment'] = {k: review[k] for k in ['id', 'owner', 'reason', 'evidence', 'reviewedAt', 'expiresAt', 'imageId', 'predicate']}
                    finding['assessment']['status'] = 'not-reachable-in-reviewed-configuration'
        return rows, skipped
    except (OSError, ValueError, KeyError, TypeError):
        return findings, ['Image applicability review configuration is invalid; raw ledger retained']


def scan(docker, services, feeds, source=COOLIFY_SOURCE, now=None, cloudflare=None, chain=read_chain, runtime=False, host_runtime=False, image_packages=False, kev=False, host_packages=False):
    now = now or dt.datetime.now(dt.timezone.utc)
    skipped = []
    containers, images = list_services(docker, services, skipped)
    groups = {}
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
    if host_runtime:
        host_rows, host_skipped = host_runtime_versions()
        skipped.extend(host_skipped)
        for spec, version in host_rows:
            groups[(spec['key'], str(version))] = {
                'service': spec['key'], 'name': spec['name'], 'version': str(version),
                'versionSource': 'host binary', 'containers': [], 'images': [], 'digests': [],
                '_version': version, '_service': spec}
            floor = parse_version(spec.get('floor', ''))
            if floor and version < floor:
                findings.append({'kind': 'host-runtime', 'service': spec['key'], 'name': spec['name'],
                                 'severity': 'high', 'version': str(version), 'fixed': str(floor),
                                 'summary': spec['name'] + ' is below the required security release ' + str(floor)})
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
                         'url': advisory.get('html_url'), 'published': (advisory.get('published_at') or '')[:10], 'cve': advisory.get('cve_id')}
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
                        'cve': entry['cve'],
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
    if image_packages:
        image_findings, image_skipped = image_package_findings(now)
        findings += image_findings
        skipped += image_skipped
    if host_packages:
        package_findings, package_skipped = host_package_findings(now)
        findings += package_findings
        skipped += package_skipped
    if kev:
        kev_state = None
        try:
            exploited, kev_state = known_exploited_catalog(feeds, now)
            for finding in findings:
                ids = {finding.get('id'), finding.get('cve'), *finding.get('aliases', [])}
                finding['knownExploited'] = bool(ids & exploited)
        except FeedError as failure:
            skipped.append(str(failure))
    if image_packages:
        findings, assessment_skipped = apply_image_assessments(findings, docker, now)
        skipped += assessment_skipped
    severity_rank = {'critical': 0, 'high': 1}
    findings.sort(key=lambda f: (f['kind'] != 'auto-update', severity_rank.get(f.get('severity'), 2), f['service']))
    notes = [g['name'] + ' publishes no advisory feed; it is compared with its latest release only.'
             for g in report_services if not g['advisorySource']]
    return safe({'host': socket.gethostname(), 'scannedAt': now.isoformat(timespec='seconds'),
                 'services': report_services, 'findings': findings, 'autoUpdate': auto_update,
                 'cloudflare': cloudflare_state, 'skipped': skipped, 'notes': notes,
                 **({'kev': kev_state} if kev else {}),
                 **({'githubFeeds':feeds.get.receipt()} if isinstance(getattr(feeds,'get',None),GithubFeedReader) else {})})


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


def advisory_id(finding):
    aliases = [finding.get('id', '')] + (finding.get('aliases') or [])
    return next(iter(sorted(a for a in aliases if a.startswith('CVE-'))), finding.get('id', 'unknown'))


def workload_display_names(docker=run_docker):
    """Read only container name and one display label, never environment/commands."""
    try:
        ids = docker(['ps', '-q']).split()
        if not ids:
            return {}
        text = docker(['inspect', '--format', '{{json .Name}}\t{{json (index .Config.Labels "coolify.serviceName")}}', *ids])
        names = {}
        for line in text.splitlines():
            raw, label = map(json.loads, line.split('\t'))
            name = raw.lstrip('/')
            if isinstance(label, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9 ._()/:-]{0,99}', label):
                names[name] = label
        return names
    except (WatchError, OSError, ValueError, TypeError):
        return {}


def immediate_finding(finding):
    if finding.get('kind') != 'image-package':
        return True
    # A scanner score alone is not a verified application exposure.
    return bool(finding.get('knownExploited') or
                (finding.get('applicability') == 'affected' and finding.get('exposure') == 'internet'))


def current_assessment(finding, now):
    review = finding.get('assessment') or {}
    try:
        return (not immediate_finding(finding) and review['status'] == 'not-reachable-in-reviewed-configuration'
                and dt.datetime.fromisoformat(review['reviewedAt']) <= now < dt.datetime.fromisoformat(review['expiresAt']))
    except (KeyError, TypeError, ValueError):
        return False


def weekly_review_key(now):
    local = now.astimezone(ZoneInfo('Australia/Sydney'))
    if local.weekday() == 0 and local.hour < 9:
        return None
    year, week, _ = local.isocalendar()
    return '%04d-W%02d' % (year, week)


def acknowledged_review_week(previous, now):
    """Count an old successful digest in its actual delivery week only."""
    if not previous.get('notifiedFingerprint') or previous.get('mailError'):
        return None
    rows, skipped, error = previous.get('findings', []), previous.get('skipped', []), previous.get('error')
    kind = 'error' if error else 'findings' if rows else 'incomplete' if skipped else None
    if prior_notification_fingerprint(previous) != notification_fingerprint(kind, rows, error, skipped):
        return None
    try:
        when = dt.datetime.fromisoformat(previous.get('lastNotifiedAt') or previous['checkedAt'])
        if when.tzinfo is None or when > now + dt.timedelta(minutes=5):
            return None
        year, week, _ = when.astimezone(ZoneInfo('Australia/Sydney')).isocalendar()
        return '%04d-W%02d' % (year, week)
    except (KeyError, ValueError, TypeError):
        return None


def weekly_package_review(findings):
    fixes, workloads, advisories, no_fix = {}, set(), set(), set()
    for finding in findings:
        names = set(finding.get('containerDisplayNames') or finding.get('containers') or [finding.get('service', 'unknown')])
        workloads.update(names)
        advisories.add(advisory_id(finding))
        if finding.get('fixed'):
            key = (finding.get('name'), finding.get('version'))
            entry = fixes.setdefault(key, {'targets':set(), 'floors':set()})
            entry['targets'].update(names)
            entry['floors'].update(version.strip() for version in finding['fixed'].split(',') if version.strip())
        else:
            no_fix.add((advisory_id(finding), finding.get('name')))
    lines = ['Weekly package review: %d workloads; %d distinct scanner advisories.' % (len(workloads), len(advisories)),
             'Next maintenance candidates (verify vendor floors, rebuild and test before deployment):']
    for (name, version), entry in sorted(fixes.items(), key=lambda item: (-len(item[1]['targets']), item[0]))[:5]:
        targets = entry['targets']
        shown = ', '.join(sorted(targets)[:3])
        if len(targets) > 3:
            shown += ' and %d more' % (len(targets)-3)
        floors = sorted(entry['floors'], key=lambda value: (parse_version(value).key() if parse_version(value) else (), value))
        fixed = ' / '.join(floors[:4]) + (' / …' if len(floors)>4 else '')
        lines.append('- %s: %s %s → reported fix floors %s' % (shown, name, version, fixed))
    if not fixes:
        lines.append('- No package fix is currently reported; vendor applicability review is needed.')
    elif len(fixes) > 5:
        lines.append('%d further package/version candidates remain in the private ledger.' % (len(fixes)-5))
    lines += ['%d advisory/package pairs have no reported fix and need vendor applicability review.' % len(no_fix),
              'Scanner matches do not establish reachable exposure. Unreviewed matches have no daily overdue reminders.']
    return lines


def package_mail_groups(findings):
    groups = {}
    for finding in findings:
        workloads = tuple(sorted(set(finding.get('containerDisplayNames') or finding.get('containers') or [finding.get('service', 'unknown image')])))
        groups.setdefault(workloads, []).append(finding)
    def priority(item):
        names, rows = item
        return (not any(r.get('knownExploited') for r in rows),
                not any(r.get('overdue') for r in rows),
                not any(r.get('severity') == 'critical' for r in rows), names)
    lines = []
    for names, rows in sorted(groups.items(), key=priority)[:MAX_MAIL_FINDINGS]:
        advisories = {advisory_id(r) for r in rows}
        fixes = {(r.get('name'), r.get('version'), r.get('fixed')) for r in rows if r.get('fixed')}
        unreviewed = {advisory_id(r) for r in rows if not r.get('fixed')}
        flags = []
        if any(r.get('knownExploited') for r in rows):
            flags.append('KNOWN EXPLOITED')
        if any(r.get('overdue') for r in rows):
            flags.append('OVERDUE')
        due = [r['dueAt'] for r in rows if r.get('dueAt')]
        if due:
            flags.append('earliest due ' + min(due))
        lines.append('- ' + ', '.join(names) + ': ' + str(len(advisories)) + ' distinct advisories; '
                     + str(len(fixes)) + ' package fixes reported; ' + str(len(unreviewed))
                     + ' advisories without a reported fix'
                     + ('; ' + '; '.join(flags) if flags else ''))
    if len(groups) > MAX_MAIL_FINDINGS:
        lines.append(str(len(groups) - MAX_MAIL_FINDINGS) + ' further workload groups retained in the private ledger.')
    return lines


def mail_body(report, error):
    if error:
        return 'The daily update watch could not finish: ' + error + '.\n' + MAIL_FOOTER
    lines = []
    if report['findings']:
        packages = [f for f in report['findings'] if f.get('kind') == 'image-package']
        direct = [f for f in report['findings'] if f.get('kind') != 'image-package']
        if direct:
            lines += ['Runtime/service advisories and configuration checks:', '']
            lines += ['- ' + ('OVERDUE: ' if f.get('overdue') else '') + f['summary']
                      + ('; due ' + f['dueAt'] if f.get('dueAt') else '') for f in direct[:MAX_MAIL_FINDINGS]]
            if len(direct) > MAX_MAIL_FINDINGS:
                lines.append(str(len(direct) - MAX_MAIL_FINDINGS) + ' further direct findings retained in the private ledger.')
        if packages:
            if report.get('weeklyPackageReview'):
                urgent = [f for f in packages if immediate_finding(f)]
                if urgent:
                    lines += ['', 'Urgent package findings:'] + package_mail_groups(urgent)
                lines += [''] + weekly_package_review([f for f in packages if not immediate_finding(f)])
            else:
                lines += ['', 'Image package matches by workload:',
                          'Vendor applicability and application reachability still need review; these are not incident counts.', '']
                lines += package_mail_groups(packages)
        lines += ['', 'Full finding ledger: /var/lib/hatchkit-backups/update-watch-status.json',
                  'Review vendor guidance and exposure, then apply compatible fixes with backup, functional checks and rollback. '
                  'Keep original deadlines; record any exception with evidence and an expiry.']
    if report['skipped']:
        lines += ['', 'Not checked this run:'] + ['- ' + s for s in report['skipped']]
    return '\n'.join(lines) + '\n' + MAIL_FOOTER


def write_status(work, state):
    path = work / STATUS_NAME
    temporary = work / (STATUS_NAME + '.tmp')
    temporary.write_text(json.dumps(state, indent=2) + '\n')
    temporary.replace(path)


def finding_identity(finding):
    """An affected package upgrade, image rebuild or rename never resets its clock."""
    service = finding.get('service')
    if finding.get('kind') == 'image-package':
        # One host-level clock per advisory/package. A new version that still
        # matches that advisory has not remediated it.
        service = 'host-image-packages'
    key = {k: finding.get(k) for k in ('kind', 'id', 'name', 'version')}
    if finding.get('kind') == 'image-package':
        key.pop('version')
    key['service'] = service
    if not finding.get('id'):
        key['summary'] = finding.get('summary')
    return hashlib.sha256(json.dumps(key, sort_keys=True).encode()).hexdigest()


def notification_fingerprint(kind, findings, error, skipped):
    """Keep action changes; ignore image/replica churn, ordering and clock ticks."""
    rows = {json.dumps({'identity': finding_identity(f),
                        **{k: f.get(k) for k in ('severity', 'fixed', 'fixState')},
                        'knownExploited': bool(f.get('knownExploited')), 'overdue': bool(f.get('overdue'))},
                       sort_keys=True) for f in findings}
    return hashlib.sha256(json.dumps([kind, sorted(rows), error, sorted(set(skipped))],
                                     sort_keys=True).encode()).hexdigest() if kind else None


def prior_notification_fingerprint(previous):
    notified = previous.get('notifiedFingerprint')
    if previous.get('notificationIdentityVersion') == 2 or not notified:
        return notified
    old_kind = ('error' if previous.get('error') else 'findings' if previous.get('findings')
                else 'incomplete' if previous.get('skipped') else None)
    old_rows = previous.get('findings') or []
    old_skips = previous.get('skipped') or []
    legacy = hashlib.sha256(json.dumps([old_kind, old_rows, previous.get('error'), old_skips],
                                      sort_keys=True).encode()).hexdigest() if old_kind else None
    # Migrate only an acknowledged exact old report. A failed delivery must
    # remain retryable, even if its last saved report contains new findings.
    if notified == legacy:
        return notification_fingerprint(old_kind, old_rows, previous.get('error'), old_skips)
    return notified


def prior_immediate_fingerprint(previous):
    acknowledged = prior_notification_fingerprint(previous)
    if previous.get('notificationIdentityVersion') == 3:
        return acknowledged
    rows, skipped, error = previous.get('findings', []), previous.get('skipped', []), previous.get('error')
    old_kind = 'error' if error else 'findings' if rows else 'incomplete' if skipped else None
    if acknowledged == notification_fingerprint(old_kind, rows, error, skipped):
        rows = [f for f in rows if immediate_finding(f)]
        kind = 'error' if error else 'findings' if rows else 'incomplete' if skipped else None
        return notification_fingerprint(kind, rows, error, skipped) if kind else None
    return acknowledged


def check(docker, services, feeds, work, config, send, now=None, source=COOLIFY_SOURCE, cloudflare=None,
          chain=read_chain, runtime=False, host_runtime=False, image_packages=False, kev=False, host_packages=False):
    """Mail new or changed abnormalities; healthy and unchanged runs stay silent."""
    now = now or dt.datetime.now(dt.timezone.utc)
    try:
        previous = json.loads((work / STATUS_NAME).read_text())
    except (OSError, ValueError):
        previous = {}
    report, error = None, None
    try:
        report = scan(docker, services, feeds, source, now, cloudflare, chain, runtime=runtime, host_runtime=host_runtime, image_packages=image_packages, kev=kev, host_packages=host_packages)
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
    first_seen = {identity: started for identity, started in (previous.get('findingFirstSeen') or {}).items()
                  if now - dt.datetime.fromisoformat(started) < dt.timedelta(days=180)}
    # Migrate clocks from earlier identity schemes without granting a fresh
    # deadline during a monitor upgrade. Prior reports already carry dueAt.
    for old in previous.get('findings', []):
        started = old.get('firstSeenAt')
        if not started and old.get('dueAt') and old.get('severity') in ('critical', 'high'):
            hours = 24 if old.get('severity') == 'critical' or old.get('knownExploited') else 72
            started = (dt.datetime.fromisoformat(old['dueAt']) - dt.timedelta(hours=hours)).isoformat(timespec='seconds')
        if started:
            identity = finding_identity(old)
            first_seen[identity] = min(first_seen.get(identity, started), started)
    old_findings = {}
    for old in previous.get('findings', []):
        identity = finding_identity(old)
        merged = dict(old)
        prior = old_findings.get(identity, {})
        # Earlier identities included the package version. When they converge,
        # preserve every exploited classification and the earliest deadline.
        if prior.get('knownExploited'):
            merged['knownExploited'] = True
        if prior.get('dueAt'):
            merged['dueAt'] = min(dt.datetime.fromisoformat(prior['dueAt']),
                                 dt.datetime.fromisoformat(old.get('dueAt', prior['dueAt']))).isoformat(timespec='seconds')
        old_findings[identity] = merged
    for finding in findings:
        identity = finding_identity(finding)
        old = old_findings.get(identity, {})
        # A failed feed or revised classification must not silently extend an
        # already established patch deadline. De-escalation needs reviewed evidence.
        if old.get('knownExploited'):
            finding['knownExploited'] = True
        started = first_seen.get(identity, now.isoformat(timespec='seconds'))
        first_seen[identity] = started
        finding['firstSeenAt'] = started
        if finding.get('severity') in ('critical', 'high'):
            hours = 24 if finding.get('severity') == 'critical' or finding.get('knownExploited') else 72
            finding['dueAt'] = (dt.datetime.fromisoformat(started) + dt.timedelta(hours=hours)).isoformat(timespec='seconds')
            if old.get('dueAt'):
                finding['dueAt'] = min(dt.datetime.fromisoformat(finding['dueAt']), dt.datetime.fromisoformat(old['dueAt'])).isoformat(timespec='seconds')
            finding['overdue'] = now >= dt.datetime.fromisoformat(finding['dueAt'])
    immediate = [f for f in findings if immediate_finding(f)]
    review = [f for f in findings if not immediate_finding(f) and not current_assessment(f, now)]
    kind = 'error' if error else 'findings' if immediate else 'incomplete' if skipped else None
    fingerprint = notification_fingerprint(kind, immediate, error, skipped)
    prior_notified = prior_immediate_fingerprint(previous)
    week = weekly_review_key(now)
    last_week = previous.get('lastWeeklyReviewKey')
    # An acknowledged old daily digest already served this week's review.
    # Upgrading the monitor must not send the same inventory again.
    if not last_week and previous.get('notificationIdentityVersion') != 3 and previous.get('checkedAt') and previous.get('notifiedFingerprint') and not previous.get('mailError'):
        last_week = acknowledged_review_week(previous, now)
    weekly_due = bool(review and week and week != last_week and not error)
    state = {'checkedAt': now.isoformat(timespec='seconds'), 'ok': not error and not findings and not skipped,
             'error': error, 'services': [{'service': s['service'], 'version': s['version'],
                                           'latest': (s['latest'] or {}).get('version')}
                                          for s in (report or {}).get('services', [])],
             'findings': findings, 'skipped': skipped, 'mailed': None, 'messageId': None,
             'notifiedFingerprint': prior_notified if kind else None,
             'notificationIdentityVersion': 3,
             'lastWeeklyReviewKey': last_week,
             'lastWeeklyReviewAt': previous.get('lastWeeklyReviewAt'),
             'unreviewedPackageMatches': len(review),
             'assessedPackageMatches': sum(current_assessment(f, now) for f in findings),
             'findingFirstSeen': first_seen}
    if kev:
        state['kev'] = (report or {}).get('kev')
    mail_error = None
    urgent_last = previous.get('lastImmediateNotifiedAt', previous.get('lastNotifiedAt'))
    overdue_reminder = any(f.get('overdue') for f in immediate) and (
        not urgent_last or now - dt.datetime.fromisoformat(urgent_last) >= dt.timedelta(hours=24))
    state['lastNotifiedAt'] = previous.get('lastNotifiedAt')
    state['lastImmediateNotifiedAt'] = urgent_last
    immediate_due = bool(kind and (fingerprint != prior_notified or overdue_reminder))
    if immediate_due or weekly_due:
        if weekly_due and not immediate_due:
            subject = '[Hatchkit] Weekly package review — ' + hostname
            state['notificationCategory'] = 'Weekly package review'
        if kind == 'findings':
            old_ids = {finding_identity(f) for f in previous.get('findings', [])}
            new_ids = {finding_identity(f) for f in immediate} - old_ids
            category = ('Initial inventory' if not previous.get('checkedAt') else
                        'New advisories' if new_ids else
                        'Overdue review' if overdue_reminder else 'Advisory changes')
            subject = '[Hatchkit] Update watch: ' + category + ('; coverage incomplete' if skipped else '') + ' — ' + hostname
            state['notificationCategory'] = category
        if immediate_due and kind == 'incomplete':
            subject = '[Hatchkit] Update watch could not check everything — ' + hostname
        body_report = dict(report, findings=immediate + (review if weekly_due else []),
                           weeklyPackageReview=weekly_due) if report else None
        body = mail_body(body_report, error)
        try:
            state['messageId'] = send(mail_settings(config), subject, body)
            state['mailed'] = kind or 'weekly-review'
            if immediate_due:
                state['notifiedFingerprint'] = fingerprint
                state['lastImmediateNotifiedAt'] = now.isoformat(timespec='seconds')
            if weekly_due:
                state['lastWeeklyReviewKey'] = week
                state['lastWeeklyReviewAt'] = now.isoformat(timespec='seconds')
            state['lastNotifiedAt'] = now.isoformat(timespec='seconds')
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
    parser.add_argument('--fresh-feeds',action='store_true',help='Bypass the one-hour GitHub response cache; still honor rate-limit backoff')
    args = parser.parse_args()
    work, config = work_dir()
    services = load(payload, 'services', SERVICES_NAME)
    cloudflare = load(payload, 'cloudflare', CLOUDFLARE_NAME)
    feeds = Feeds((payload or {}).get('feeds'))
    if args.action == 'scan':
        feeds = Feeds((payload or {}).get('feeds'), get=GithubFeedReader(work, fresh=args.fresh_feeds, readonly=True))
        report = scan(run_docker, services, feeds, cloudflare=cloudflare, runtime=True, host_runtime=True, image_packages=True, kev=True, host_packages=True)
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
                                'This is a test. The scheduled check mails when a shared service (Coolify, Traefik, '
                                'Plausible CE, Listmonk, Uptime Kuma, GlitchTip, ClickHouse) runs a version that a '
                                'high or critical upstream advisory covers, when Coolify auto-update fails, when '
                                'Cloudflare changes the IP ranges the origin firewalls allow, and when it could not '
                                'check something. Healthy and unchanged runs stay silent.\n'
                                + MAIL_FOOTER)
        print(json.dumps({'sent': True, 'messageId': message_id}))
        return
    if args.action == 'failed':
        message_id = send_email(mail_settings(config), '[Hatchkit] Update watch did not finish — ' + hostname,
                                'systemd stopped the scheduled update watch before it finished (a timeout, the memory '
                                'limit, or a crash). Nothing was checked this run.\n' + MAIL_FOOTER)
        print(json.dumps({'sent': True, 'messageId': message_id}))
        return
    refresh_host_package_indexes(work)
    feeds = Feeds((payload or {}).get('feeds'), get=GithubFeedReader(work, fresh=args.fresh_feeds))
    state, mail_error = check(run_docker, services, feeds, work, config, send_email, cloudflare=cloudflare, runtime=True, host_runtime=True, image_packages=True, kev=True, host_packages=True)
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
