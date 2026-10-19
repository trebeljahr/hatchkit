#!/usr/bin/env python3
"""Hatchkit host integrity check: read-only signs of a compromised container.

On 2026-10-18 a cryptominer was found by accident in the Plausible
container on the shared Coolify host. It had run for days at 80-95 % of
one core and nothing alerted. Each detector here would have named it:

  deleted-binary      a process whose /proc/<pid>/exe ends in "(deleted)"
  unexpected-process  a container process that does not run a binary its image
                      ships (on disk, not in the writable layer, not on a
                      volume), or runs one under a name neither the binary nor
                      the image family explains
  temp-file           a new file in /tmp, /var/tmp or /dev/shm of a container,
                      or a process that runs a binary from one of them
  cpu                 a container above 50 % of one core over the window
  outbound-peer       an outbound TCP peer outside private ranges and
                      Cloudflare, connected in at least half of the samples
                      (one a minute; both ends of a shorter window)

It only reads. It never prints environment values, command lines or file
contents: a report holds container names, images, process names,
executable paths, file paths, CPU percentages and peer addresses, with
control characters escaped (process and file names are attacker-chosen).

  scan [--cpu-window S] [--only GLOB]   print the report as JSON
  check   scan over one hour, mail the findings through the backup-alert
          SMTP and record the result (what the daily timer runs)
  failed  mail that a check did not finish (systemd OnFailure)
  test    send a test mail

Site exceptions live in /etc/hatchkit-backups/host-integrity.json (see
SITE_KEYS). Every finding carries the exact entry that would allow it.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import datetime as dt
from email.utils import formataddr, parseaddr
from fnmatch import fnmatch
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import sys
import time

TEMP_DIRS = ('/tmp', '/var/tmp', '/dev/shm')
SITE_FILE = '/etc/hatchkit-backups/host-integrity.json'
BACKUP_CONFIG = '/etc/hatchkit-backups/config.json'
STATUS_NAME = 'host-integrity-status.json'
TIMER = 'hatchkit-host-integrity.timer'
SERVICE = 'hatchkit-host-integrity.service'
CPU_LIMIT = 50.0
CPU_MIN_WINDOW = 5  # a shorter delta is noise
CHECK_WINDOW = 3600
SAMPLE_EVERY = 60  # seconds between outbound-peer samples inside the window
COMM_MAX = 15  # the kernel truncates /proc/<pid>/comm to 15 characters
MAX_PER_CONTAINER = 20  # listed one by one; the rest are named in one overflow finding
SITE_KEYS = {
    'processes': 'map of container-name or image glob -> process names ("prefix*" allowed)',
    'tempFiles': 'list of path globs (never hides an executable)',
    'peers': 'list of CIDRs, for every container',
    'peerContainers': 'list of container-name or image globs whose outbound peers are not checked',
    'cpuLimits': 'map of container-name or image glob -> percent of one core',
}

# Shells, init shims and the clients healthchecks run, in any image.
BASE_PROCESSES = ('sh', 'bash', 'dash', 'ash', 'tini', 'dumb-init', 'docker-init', 'gosu',
                  'su-exec', 'curl', 'wget', 'sleep', 'timeout', 'cat', 'test')

# What each image family runs under names its binaries do not carry (Node
# renames its main thread, Next.js and Postgres retitle themselves). A family
# applies when its pattern matches the image reference, when the container's
# entrypoint or command starts with one of its `argv0` names, or when one of
# the container's processes runs an `argv0` binary from the image (an app
# image whose entrypoint is a wrapper, or one Coolify built under a random
# name). `exes` allows a process by its executable's path instead of its name.
FAMILIES = (
    {'image': r'(^|/)(node|bun)([:@]|$)|uptime-kuma|soketi|coolify-realtime',
     'argv0': ('node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'tsx', 'dotenvx', 'drain-entrypoin'),
     'names': ('node', 'MainThread', 'next-server*', 'npm*', 'npx', 'pnpm*', 'yarn*', 'bun',
               'tsx', 'esbuild', 'dotenvx', 'docker-entrypoi', 'drain-entrypoin')},
    {'image': r'postgres|postgis|timescale|pgvector', 'argv0': ('postgres',),
     'names': ('postgres', 'pg_isready', 'psql', 'pg_dump', 'pg_dumpall', 'docker-entrypoi')},
    {'image': r'(^|/)mongo([:@]|$)|mongodb', 'argv0': ('mongod',),
     'names': ('mongod', 'mongosh*', 'mongo', 'mongodump', 'numactl', 'docker-entrypoi')},
    {'image': r'redis|valkey|keydb', 'argv0': ('redis-server', 'valkey-server'),
     'names': ('redis-server', 'redis-cli', 'valkey-server', 'valkey-cli', 'docker-entrypoi')},
    {'image': r'clickhouse', 'argv0': (), 'names': ('clickhouse*', 'entrypoint.sh')},
    {'image': r'plausible', 'argv0': (),
     'names': ('beam.smp', 'epmd', 'erl_child_setup', 'inet_gethost', 'heart', 'run_erl',
               'entrypoint.sh')},
    {'image': r'traefik', 'argv0': ('traefik',), 'names': ('traefik',)},
    {'image': r'listmonk', 'argv0': ('listmonk',), 'names': ('listmonk',)},
    {'image': r'uptime-kuma', 'argv0': (),
     'names': ('uptime-kuma', 'mariadbd', 'nscd', 'cloudflared', 'healthcheck')},
    # Coolify runs on s6-overlay, whose execline helpers live under /package/admin.
    {'image': r'coollabsio/coolify(:|@|$)', 'argv0': (),
     'names': ('php*', 'nginx', 's6-*', 'ssh', 'ssh-agent', 'crond', 'git'),
     'exes': ('/package/admin/*',)},
    {'image': r'coolify-realtime|soketi', 'argv0': (), 'names': ('soketi*',)},
    {'image': r'coolify-sentinel', 'argv0': (), 'names': ('sentinel',)},
    {'image': r'mariadb|mysql', 'argv0': (), 'names': ('mariadbd', 'mysqld', 'healthcheck.sh')},
    {'image': r'glitchtip', 'argv0': (), 'names': ('python*', 'uwsgi', 'celery', 'granian', 'gunicorn')},
)
# Build containers run whatever a build needs; the other detectors still apply.
UNCHECKED_PROCESS_IMAGES = (r'coollabsio/coolify-helper', r'moby/buildkit')

TEMP_FILES = (
    '/tmp/hatchkit-drain.pid',  # hatchkit's drain entrypoint
    '/tmp/mongodb-*.sock',      # mongod's Unix socket
    '/tmp/.mongodb/*',          # mongosh's logs and config when HOME is /tmp
    '/tmp/users.xml',           # ClickHouse entrypoint's generated users file
    '/dev/shm/PostgreSQL.*',    # Postgres dynamic shared memory
)

PRIVATE_NETS = tuple(ipaddress.ip_network(n) for n in (
    '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
    '192.168.0.0/16', '::/128', '::1/128', 'fc00::/7', 'fe80::/10'))
# https://www.cloudflare.com/ips-v4 and /ips-v6 (2026-10-19). Apps reach R2,
# Workers and every proxied hostname here, so these are not reported, and
# neither is anything an attacker fronts with Cloudflare.
CLOUDFLARE_NETS = tuple(ipaddress.ip_network(n) for n in (
    '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
    '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
    '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
    '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32',
    '2a06:98c0::/29', '2c0f:f248::/32'))
# On the host itself, a binary an upgrade replaced keeps running until its
# service restarts (apt), and a snap refresh moves it to a new revision.
HOST_UPGRADE_PREFIXES = ('/usr/', '/bin/', '/sbin/', '/lib/', '/lib64/', '/opt/', '/snap/')

# Only the first word of the entrypoint and command: later words can hold
# passwords (redis-server --requirepass …), so they never reach this process.
INSPECT = ('{{json .Id}}\t{{json .Name}}\t{{json .Config.Image}}\t{{.State.Pid}}\t'
           '{{if .Config.Entrypoint}}{{json (index .Config.Entrypoint 0)}}{{else}}null{{end}}\t'
           '{{if .Config.Cmd}}{{json (index .Config.Cmd 0)}}{{else}}null{{end}}\t'
           '{{json .HostConfig.NetworkMode}}')
DELETED = ' (deleted)'
# runc re-executes itself from a memfd for the moment it takes to start a
# container process (every exec and healthcheck). Only that moment is exempt:
# a process under that name that lives longer is reported.
RUNC_CLONE = re.compile(r'^/memfd:runc_cloned')
RUNC_MAX_AGE = 60
DOCKER_INIT = '/sbin/docker-init'  # Docker bind-mounts its init here for --init


class IntegrityError(Exception):
    """An error whose message is safe to print and mail."""


def run_docker(args):
    try:
        done = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=120)
    except (subprocess.SubprocessError, OSError):
        raise IntegrityError('docker ' + args[0] + ' failed') from None
    # `docker inspect` of several ids exits 1 when one of them stopped since
    # `docker ps`, and still prints the others.
    if done.returncode != 0 and not (args[0] == 'inspect' and done.stdout.strip()):
        raise IntegrityError('docker ' + args[0] + ' failed')
    return done.stdout


class Host:
    """Where the collectors read. Tests point it at a fixture tree."""

    def __init__(self, proc='/proc', cgroup='/sys/fs/cgroup', docker=run_docker,
                 sleep=time.sleep, clock=time.monotonic):
        self.proc = Path(proc)
        self.cgroup = Path(cgroup)
        self.docker = docker
        self.sleep = sleep
        self.clock = clock


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


# --- collectors -------------------------------------------------------------

def list_containers(host, only=None):
    """Running containers, and how many `docker inspect` rows could not be read."""
    ids = host.docker(['ps', '-q', '--no-trunc']).split()
    if not ids:
        return [], 0
    containers, unreadable = [], 0
    for line in host.docker(['inspect', '--type', 'container', '--format', INSPECT, *ids]).splitlines():
        fields = line.split('\t')
        try:
            if len(fields) != 7:
                raise ValueError(line)
            cid, name, image = json.loads(fields[0]), json.loads(fields[1]), json.loads(fields[2])
            pid = int(fields[3])
            argv0 = [os.path.basename(v)[:COMM_MAX] for v in (json.loads(fields[4]), json.loads(fields[5]))
                     if isinstance(v, str) and v]
            network = json.loads(fields[6]) or ''
        except ValueError:
            unreadable += 1
            continue
        name = name.lstrip('/')
        if pid <= 0 or (only and not fnmatch(name, only)):
            continue
        containers.append({'id': cid, 'name': name, 'image': image or '', 'pid': pid,
                           'argv0': argv0, 'network': network})
    return containers, unreadable


CGROUP_ID = re.compile(r'docker[-/]([0-9a-f]{64})')


def container_id(cgroup_text):
    match = CGROUP_ID.search(cgroup_text)
    return match.group(1) if match else None


def read_uptime(host):
    try:
        return float((host.proc / 'uptime').read_text().split()[0])
    except (OSError, ValueError, IndexError):
        return None


def process_age(host, entry, uptime):
    """Seconds since the process started, or None."""
    try:
        fields = (entry / 'stat').read_text().rsplit(')', 1)[1].split()
        return uptime - int(fields[19]) / os.sysconf('SC_CLK_TCK')
    except (OSError, ValueError, IndexError, TypeError):
        return None


def read_processes(host):
    uptime = read_uptime(host)
    processes = []
    for entry in host.proc.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            comm = (entry / 'comm').read_text().rstrip('\n')
            cgroup = (entry / 'cgroup').read_text()
            exe = os.readlink(entry / 'exe')
        except OSError:
            continue  # a kernel thread, or the process exited
        processes.append({'pid': int(entry.name), 'comm': comm, 'exe': exe,
                          'container': container_id(cgroup), 'age': process_age(host, entry, uptime)})
    return sorted(processes, key=lambda p: p['pid'])


def cpu_usage_usec(host, pid):
    """Cumulative CPU of the cgroup that holds `pid`, in microseconds."""
    try:
        lines = (host.proc / str(pid) / 'cgroup').read_text().splitlines()
    except OSError:
        return None
    for line in lines:
        hierarchy, controllers, path = (line.split(':', 2) + ['', ''])[:3]
        try:
            if hierarchy == '0' and controllers == '':
                for row in (host.cgroup / path.lstrip('/') / 'cpu.stat').read_text().splitlines():
                    if row.startswith('usage_usec '):
                        return int(row.split()[1])
            elif 'cpuacct' in controllers.split(','):
                for mount in ('cpu,cpuacct', 'cpuacct'):
                    usage = host.cgroup / mount / path.lstrip('/') / 'cpuacct.usage'
                    if usage.exists():
                        return int(usage.read_text()) // 1000
        except (OSError, ValueError):
            continue
    return None


def decode_address(text, v6):
    raw, port = text.split(':')
    data = bytes.fromhex(raw)
    # /proc/net/tcp prints each 32-bit word in host (little-endian) order.
    data = b''.join(data[i:i + 4][::-1] for i in range(0, len(data), 4))
    ip = ipaddress.IPv6Address(data) if v6 else ipaddress.IPv4Address(data)
    if v6 and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip, int(port, 16)


def parse_tcp(text, v6=False):
    """Rows of /proc/<pid>/net/tcp[6]: (state, local ip, local port, remote ip, remote port, inode)."""
    rows = []
    for line in text.splitlines()[1:]:
        fields = line.split()
        if len(fields) < 10:
            continue
        try:
            lip, lport = decode_address(fields[1], v6)
            rip, rport = decode_address(fields[2], v6)
        except ValueError:
            continue
        rows.append((fields[3], lip, lport, rip, rport, fields[9]))
    return rows


def outbound(rows):
    """Established connections whose local port is not a listener: this side dialled out."""
    listening = {row[2] for row in rows if row[0] == '0A'}
    return {(str(row[1]), row[2], str(row[3]), row[4]): row[5]
            for row in rows if row[0] == '01' and row[2] not in listening}


def netns(host, pid):
    try:
        return os.readlink(host.proc / str(pid) / 'ns' / 'net')
    except OSError:
        return None


def on_host_network(host, containers):
    host_ns = netns(host, 1)
    return [c for c in containers if c['network'] == 'host' or netns(host, c['pid']) == host_ns]


def peer_sample(host, containers):
    """Outbound connections per container network namespace. The host's own is skipped."""
    host_ns = netns(host, 1)
    sample = {}
    for container in containers:
        ns = netns(host, container['pid'])
        if not ns or ns == host_ns or container['network'] == 'host':
            continue
        if ns not in sample:
            rows = []
            for name, v6 in (('tcp', False), ('tcp6', True)):
                try:
                    rows += parse_tcp((host.proc / str(container['pid']) / 'net' / name).read_text(), v6)
                except OSError:
                    pass
            sample[ns] = {'containers': [], 'connections': outbound(rows)}
        sample[ns]['containers'].append(container)
    return sample


def docker_diff(host, container):
    """Paths the writable layer added or changed; None when Docker cannot say."""
    try:
        text = host.docker(['diff', container['id']])
    except IntegrityError:
        return None
    paths = []
    for line in text.splitlines():
        kind, _, path = line.partition(' ')
        if kind in ('A', 'C'):
            paths.append(path)
    return paths


def mount_points(host, pid):
    """Every mount point inside the container, `/` included."""
    try:
        lines = (host.proc / str(pid) / 'mountinfo').read_text().splitlines()
    except OSError:
        return []
    points = []
    for line in lines:
        fields = line.split()
        if len(fields) > 4:
            point = re.sub(r'\\([0-7]{3})', lambda m: chr(int(m.group(1), 8)), fields[4])
            if point not in points:
                points.append(point)
    return points


def walk_files(root, limit=200):
    found = []
    for directory, dirs, files in os.walk(root):
        dirs.sort()
        for name in sorted(files):
            found.append(os.path.join(directory, name))
            if len(found) >= limit:
                return found
    return found


# --- detectors (pure, over collected data) ----------------------------------

def label(container):
    return container['name'] if container else 'host'


def image_glob(image):
    """`ghcr.io/x/app:sha` -> `ghcr.io/x/app*`, stable across deploys."""
    base = image.split('@')[0]
    if ':' in base.rsplit('/', 1)[-1]:
        base = base.rsplit(':', 1)[0]
    return base + '*'


def name_glob(name):
    """Coolify names app containers `<uuid>-<deploy time>`, the time as digits
    (`-211834526961`) or as YYYYMMDDTHHMMSS (`-20261018T233753`): keep the uuid."""
    match = re.match(r'^(.+)-(?:\d{9,}|\d{8}T\d{6})$', name)
    return match.group(1) + '-*' if match else name


def site_globs_match(globs, container):
    return any(fnmatch(container['name'], g) or fnmatch(container['image'], g) for g in globs)


def name_allowed(comm, names):
    for name in names:
        if name.endswith('*'):
            if comm.startswith(name[:-1][:COMM_MAX]):
                return True
        elif comm == name[:COMM_MAX]:
            return True
    return False


def under_temp(path):
    return any(path.startswith(d + '/') for d in TEMP_DIRS)


def under_mount(path, mounts):
    return any(m != '/' and (path == m or path.startswith(m.rstrip('/') + '/')) for m in mounts)


def from_image(process, layer, mounts):
    """The binary came with the image: still on disk, outside the temp dirs, not
    added or changed in the writable layer (None: Docker could not list it),
    and not on a volume or bind mount."""
    exe = process['exe']
    if exe.endswith(DELETED) or under_temp(exe) or (layer is not None and exe in layer):
        return False
    return exe == DOCKER_INIT or not under_mount(exe, mounts)


def young_runc(process):
    return (RUNC_CLONE.match(process['exe']) is not None and process.get('age') is not None
            and process['age'] < RUNC_MAX_AGE)


def runtime_binaries(processes, layer, mounts):
    """Basenames of the image binaries a container runs."""
    return {os.path.basename(p['exe'])[:COMM_MAX] for p in processes if from_image(p, layer, mounts)}


def allowed_processes(container, processes, site, layer=None, mounts=()):
    """(names, executable-path globs, site names) the container may run."""
    names = set(BASE_PROCESSES) | set(container['argv0'])
    exes, site_names = set(), set()
    running = runtime_binaries(processes, layer, mounts)
    for family in FAMILIES:
        if (re.search(family['image'], container['image'], re.I)
                or set(family['argv0']) & (set(container['argv0']) | running)):
            names |= set(family['names'])
            exes |= set(family.get('exes', ()))
    for glob, extra in site.get('processes', {}).items():
        if site_globs_match([glob], container):
            site_names |= set(extra)
    return names, exes, site_names


def strip_deleted(exe):
    return exe[:-len(DELETED)] if exe.endswith(DELETED) else exe


def overflow(detector, container, image, what, items):
    """One finding that names everything past the per-container list."""
    return {'detector': detector, 'container': container, 'image': image, 'overflow': len(items),
            'summary': container + ': ' + str(len(items)) + ' more ' + what + ': ' + ', '.join(items[:50])
                       + (', …' if len(items) > 50 else '')}


def deleted_binaries(processes, containers, replaced):
    """`replaced(process, path)`: a file exists at the binary's path again."""
    by_id = {c['id']: c for c in containers}
    findings, notes = [], []
    for process in processes:
        if not process['exe'].endswith(DELETED) or young_runc(process):
            continue
        container = by_id.get(process['container'])
        if process['container'] and not container:
            continue  # a container that is not running any more
        path = strip_deleted(process['exe'])
        if (not process['container'] and path.startswith(HOST_UPGRADE_PREFIXES)
                and (path.startswith('/snap/') or replaced(process, path))):
            notes.append('host: ' + process['comm'] + ' (pid ' + str(process['pid']) + ') still runs the old '
                         + path + ' after an upgrade; restart it to load the new one.')
            continue
        findings.append({
            'detector': 'deleted-binary', 'container': container and container['name'],
            'image': container and container['image'], 'pid': process['pid'], 'process': process['comm'],
            'exe': process['exe'],
            'summary': label(container) + ': process ' + process['comm'] + ' (pid ' + str(process['pid'])
                       + ') runs ' + path + ', which was deleted from disk',
        })
    return findings, notes


def unexpected_processes(processes, containers, site, layers=None, mounts=None):
    """`layers`: container id -> paths `docker diff` lists (None when unknown).
    `mounts`: container id -> mount points."""
    layers, mounts = layers or {}, mounts or {}
    findings, notes = [], []
    by_container = {}
    for process in processes:
        by_container.setdefault(process['container'], []).append(process)
    for container in containers:
        if any(re.search(p, container['image'], re.I) for p in UNCHECKED_PROCESS_IMAGES):
            notes.append(container['name'] + ': build container, process names not checked.')
            continue
        own = by_container.get(container['id'], [])
        layer, points = layers.get(container['id']), mounts.get(container['id'], ())
        names, exes, site_names = allowed_processes(container, own, site, layer, points)
        odd = {}
        for process in own:
            exe = process['exe']
            if young_runc(process):
                continue
            # The site file is the operator's word, but never for a deleted
            # binary or one in a temp dir.
            if not exe.endswith(DELETED) and not under_temp(exe) and name_allowed(process['comm'], site_names):
                continue
            # Every built-in allowance vouches only for a binary the image ships.
            if from_image(process, layer, points) and (
                    any(fnmatch(process['exe'], g) for g in exes)
                    or name_allowed(process['comm'], names)
                    or os.path.basename(process['exe'])[:COMM_MAX].startswith(process['comm'])):
                continue
            odd.setdefault(process['comm'], []).append(process)
        listed = sorted(odd.items())
        for comm, group in listed[:MAX_PER_CONTAINER]:
            pids = [p['pid'] for p in group]
            paths = sorted({strip_deleted(p['exe']) for p in group})
            findings.append({
                'detector': 'unexpected-process', 'container': container['name'], 'image': container['image'],
                'process': comm, 'pids': pids, 'exe': paths[0],
                'summary': container['name'] + ': unexpected process ' + comm + ' (pid '
                           + ', '.join(map(str, pids[:5])) + '; ' + ', '.join(paths[:3]) + ') for image '
                           + container['image'],
                'allow': {'processes': {image_glob(container['image']): [comm]}},
            })
        if len(listed) > MAX_PER_CONTAINER:
            findings.append(overflow('unexpected-process', container['name'], container['image'],
                                     'unexpected process names', [c for c, _ in listed[MAX_PER_CONTAINER:]]))
    return findings, notes


def executable(mode):
    return stat.S_ISREG(mode) and bool(mode & 0o111)


def temp_files(containers, files, processes, site):
    """`files`: container id -> [(path, stat-like dict)] already filtered to temp dirs."""
    allowed = TEMP_FILES + tuple(site.get('tempFiles', ()))
    by_id = {c['id']: c for c in containers}
    findings = []
    for container in containers:
        # An executable is reported even under an allowed name.
        hits = [(p, s) for p, s in files.get(container['id'], [])
                if executable(s['mode']) or not any(fnmatch(p, g) for g in allowed)]
        hits.sort(key=lambda hit: not executable(hit[1]['mode']))
        for path, info in hits[:MAX_PER_CONTAINER]:
            runnable = executable(info['mode'])
            findings.append({
                'detector': 'temp-file', 'container': container['name'], 'image': container['image'],
                'path': path, 'size': info['size'], 'modified': info['modified'], 'executable': runnable,
                'summary': container['name'] + ': new ' + ('executable ' if runnable else '') + 'file ' + path
                           + ' (' + str(info['size']) + ' bytes, modified ' + info['modified'] + ')',
                **({} if runnable else {'allow': {'tempFiles': [path]}}),
            })
        if len(hits) > MAX_PER_CONTAINER:
            findings.append(overflow('temp-file', container['name'], container['image'], 'new files',
                                     [p for p, _ in hits[MAX_PER_CONTAINER:]]))
    for process in processes:
        path = strip_deleted(process['exe'])
        if not under_temp(path):
            continue
        container = by_id.get(process['container'])
        if process['container'] and not container:
            continue
        findings.append({
            'detector': 'temp-file', 'container': container and container['name'],
            'image': container and container['image'], 'path': path, 'pid': process['pid'],
            'process': process['comm'], 'executable': True,
            'summary': label(container) + ': process ' + process['comm'] + ' (pid ' + str(process['pid'])
                       + ') runs a binary from a temp dir: ' + process['exe'],
        })
    return findings


def cpu_limit(container, site):
    limit = CPU_LIMIT
    for glob, value in site.get('cpuLimits', {}).items():
        if site_globs_match([glob], container):
            limit = max(limit, float(value))
    return limit


def cpu_percentages(containers, before, after, seconds):
    """(container id -> percent of one core, names not measured)."""
    usage, unmeasured = {}, []
    for container in containers:
        a, b = before.get(container['id']), after.get(container['id'])
        if a is None or b is None or b < a or seconds <= 0:
            unmeasured.append(container['name'])  # started or restarted inside the window
            continue
        usage[container['id']] = (b - a) / (seconds * 1e6) * 100
    return usage, unmeasured


def cpu_hogs(containers, usage, seconds, site):
    findings = []
    for container in containers:
        percent = usage.get(container['id'])
        limit = cpu_limit(container, site)
        if percent is None or percent <= limit:
            continue
        findings.append({
            'detector': 'cpu', 'container': container['name'], 'image': container['image'],
            'percent': round(percent, 1), 'windowSeconds': round(seconds), 'limit': limit,
            'summary': container['name'] + ': ' + str(round(percent)) + ' % of one core averaged over '
                       + duration(seconds) + ' (limit ' + str(round(limit)) + ' %)',
            # This container only, and only once you know which process it is.
            'allow': {'cpuLimits': {name_glob(container['name']): int(math.ceil((percent + 10) / 10) * 10)}},
        })
    return findings


def duration(seconds):
    return str(round(seconds / 60)) + ' min' if seconds >= 120 else str(round(seconds)) + ' s'


def peer_allowed(ip, site):
    ip = ipaddress.ip_address(ip)
    nets = PRIVATE_NETS + CLOUDFLARE_NETS + tuple(ipaddress.ip_network(n, strict=False) for n in site.get('peers', ()))
    return ip.is_multicast or any(ip.version == n.version and ip in n for n in nets)


def outbound_peers(samples, seconds, site, owner):
    """Remote ip:port a namespace was connected to in at least half of the
    samples (and at least two): a pool or C2 connection, held or re-dialled.
    `owner(containers, inode)` -> (pid, comm) or None."""
    findings, notes = [], []
    need = max(2, math.ceil(len(samples) / 2))
    spaces = {}
    for sample in samples:
        spaces.update(sample)  # the latest container list of each namespace
    for ns, entry in sorted(spaces.items()):
        containers = entry['containers']
        names = ', '.join(c['name'] for c in containers)
        if any(site_globs_match(site.get('peerContainers', ()), c) for c in containers):
            notes.append(names + ': outbound peers not checked (peerContainers).')
            continue
        seen, inodes = {}, {}
        for sample in samples:
            remotes = {}
            for key, inode in sorted(sample.get(ns, {}).get('connections', {}).items()):
                if not peer_allowed(key[2], site):
                    remotes.setdefault((key[2], key[3]), inode)
            for remote, inode in remotes.items():
                seen[remote] = seen.get(remote, 0) + 1
                inodes[remote] = inode
        hits = sorted(remote for remote, count in seen.items() if count >= need)
        for ip, port in hits[:MAX_PER_CONTAINER]:
            who = owner(containers, inodes[(ip, port)])
            findings.append({
                'detector': 'outbound-peer', 'container': names, 'image': containers[0]['image'],
                'peer': ip + ':' + str(port), 'pid': who and who[0], 'process': who and who[1],
                'summary': names + ': outbound TCP connection to ' + ip + ':' + str(port)
                           + (' from ' + who[1] + ' (pid ' + str(who[0]) + ')' if who else '') + ', open in '
                           + str(seen[(ip, port)]) + ' of ' + str(len(samples)) + ' samples over ' + duration(seconds),
                'allow': {'peers': [ip + ('/32' if ':' not in ip else '/128')]},
            })
        if len(hits) > MAX_PER_CONTAINER:
            findings.append(overflow('outbound-peer', names, containers[0]['image'], 'outbound peers',
                                     [ip + ':' + str(port) for ip, port in hits[MAX_PER_CONTAINER:]]))
    return findings, notes


# --- scan -------------------------------------------------------------------

def temp_file_stats(host, container, paths):
    root = host.proc / str(container['pid']) / 'root'
    rows = []
    for path in paths:
        try:
            info = os.lstat(root / path.lstrip('/'))
        except OSError:
            continue  # removed since `docker diff` listed it
        if stat.S_ISDIR(info.st_mode):
            continue  # its files are listed on their own
        modified = dt.datetime.fromtimestamp(info.st_mtime, dt.timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
        rows.append((path, {'size': info.st_size, 'mode': info.st_mode, 'modified': modified}))
    return rows


def collect_layers(host, containers):
    """Container id -> writable-layer paths (None when Docker could not list them)."""
    with ThreadPoolExecutor(max_workers=8) as pool:
        diffs = list(pool.map(lambda c: docker_diff(host, c), containers))
    layers, skipped = {}, []
    for container, paths in zip(containers, diffs):
        if paths is None:
            skipped.append(container['name'] + ': docker diff failed; writable layer not checked.')
        layers[container['id']] = None if paths is None else set(paths)
    return layers, skipped


def collect_temp_files(host, containers, layers, mounts):
    files = {}
    for container in containers:
        paths = [p for p in layers.get(container['id']) or () if under_temp(p)]
        root = host.proc / str(container['pid']) / 'root'
        # A temp dir that is its own mount (tmpfs, a volume) is not in the
        # layer; every file there is new.
        for directory in TEMP_DIRS:
            if directory in mounts.get(container['id'], ()):
                for full in walk_files(root / directory.lstrip('/')):
                    paths.append('/' + os.path.relpath(full, root))
        files[container['id']] = temp_file_stats(host, container, sorted(set(paths)))
    return files


def socket_owner(host, processes):
    def owner(containers, inode):
        ids = {c['id'] for c in containers}
        target = 'socket:[' + inode + ']'
        for process in processes:
            if process['container'] not in ids:
                continue
            try:
                fds = list((host.proc / str(process['pid']) / 'fd').iterdir())
            except OSError:
                continue
            for fd in fds:
                try:
                    if os.readlink(fd) == target:
                        return process['pid'], process['comm']
                except OSError:
                    continue
        return None
    return owner


def replaced_on_disk(host):
    def replaced(process, path):
        return os.path.lexists(host.proc / str(process['pid']) / 'root' / path.lstrip('/'))
    return replaced


def scan(host, window, site, only=None):
    started = host.clock()
    first, _ = list_containers(host, only)
    cpu_before = {c['id']: cpu_usage_usec(host, c['pid']) for c in first}
    samples = [peer_sample(host, first)]
    while True:
        remaining = window - (host.clock() - started)
        if remaining <= 0:
            break
        host.sleep(min(SAMPLE_EVERY, remaining))
        if window - (host.clock() - started) > 0:
            samples.append(peer_sample(host, first))
    elapsed = host.clock() - started
    containers, unreadable = list_containers(host, only)
    cpu_after = {c['id']: cpu_usage_usec(host, c['pid']) for c in containers}
    samples.append(peer_sample(host, containers))
    processes = read_processes(host)
    if only:
        ids = {c['id'] for c in containers}
        processes = [p for p in processes if p['container'] in ids]
    mounts = {c['id']: mount_points(host, c['pid']) for c in containers}
    layers, skipped = collect_layers(host, containers)
    if unreadable:
        skipped.append(str(unreadable) + ' container(s) could not be read from docker inspect.')
    files = collect_temp_files(host, containers, layers, mounts)
    usage, unmeasured = cpu_percentages(containers, cpu_before, cpu_after, elapsed)
    cpu = []
    if elapsed < CPU_MIN_WINDOW:
        skipped.append('CPU not measured: the window was under ' + str(CPU_MIN_WINDOW) + ' s.')
    else:
        cpu = cpu_hogs(containers, usage, elapsed, site)
        if unmeasured:
            skipped.append('CPU not measured (started or restarted inside the window): ' + ', '.join(unmeasured))
    hosted = on_host_network(host, containers)
    if hosted:
        skipped.append('Outbound peers not checked (host network): ' + ', '.join(c['name'] for c in hosted))

    deleted, deleted_notes = deleted_binaries(processes, containers, replaced_on_disk(host))
    odd, odd_notes = unexpected_processes(processes, containers, site, layers, mounts)
    peers, peer_notes = outbound_peers(samples, elapsed, site, socket_owner(host, processes))
    findings = deleted + odd + temp_files(containers, files, processes, site) + cpu + peers
    names = {c['id']: c['name'] for c in containers}
    top = sorted(usage.items(), key=lambda item: -item[1])[:5] if elapsed >= CPU_MIN_WINDOW else []
    return safe({
        'host': socket.gethostname(),
        'scannedAt': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),
        'cpuWindowSeconds': round(elapsed),
        'cpuLimit': CPU_LIMIT,
        'containers': len(containers),
        'processes': len(processes),
        'cpuTop': [{'container': names[cid], 'percent': round(p, 1)} for cid, p in top],
        'outboundConnections': sum(len(ns['connections']) for ns in samples[-1].values()),
        'networkNamespaces': len(samples[-1]),
        'peerSamples': len(samples),
        'findings': findings,
        'skipped': skipped,
        'notes': deleted_notes + odd_notes + peer_notes,
    })


# --- site config, status, mail ----------------------------------------------

def read_site(path=SITE_FILE):
    path = Path(path)
    if not path.exists():
        return {}
    try:
        site = json.loads(path.read_text())
    except ValueError:
        raise IntegrityError(str(path) + ' is not valid JSON') from None
    if not isinstance(site, dict):
        raise IntegrityError(str(path) + ' must hold a JSON object')
    for key, value in site.items():
        if key not in SITE_KEYS:
            raise IntegrityError(str(path) + ': unknown key ' + json.dumps(key) + '; known: ' + ', '.join(SITE_KEYS))
        expect = dict if key in ('processes', 'cpuLimits') else list
        if not isinstance(value, expect):
            raise IntegrityError(str(path) + ': ' + key + ' must be a ' + SITE_KEYS[key])
    for cidr in site.get('peers', ()):
        try:
            ipaddress.ip_network(cidr, strict=False)
        except ValueError:
            raise IntegrityError(str(path) + ': peers entry ' + json.dumps(cidr) + ' is not a CIDR') from None
    return site


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
        raise IntegrityError('backup alert mail is not configured (hatchkit backup alerts)')
    settings['from'] = formataddr(('Hatchkit Host Check', parseaddr(settings['from'])[1]))
    return settings


MAIL_FOOTER = ('\nInspect: hatchkit host integrity --json\n'
               'Server logs: journalctl -u ' + SERVICE + '\n'
               'Server access remains Tailscale-only.\n')


def not_checked(report):
    skipped = (report or {}).get('skipped') or []
    return ['', 'Not checked this run:'] + ['- ' + s for s in skipped] if skipped else []


def mail_body(report, error):
    if error:
        lines = ['The daily host integrity check could not finish: ' + error + '.']
    else:
        lines = [str(len(report['findings'])) + ' finding(s) on ' + str(report['containers'])
                 + ' running containers (CPU averaged over ' + duration(report['cpuWindowSeconds']) + '):', '']
        lines += ['- ' + f['summary'] for f in report['findings']]
        lines += not_checked(report)
        lines += ['', 'Before you stop or delete anything, save the evidence: docker top <container> '
                  '-eo pid,ppid,etime,comm, docker diff <container>, and cp /proc/<pid>/exe for each named pid.',
                  'If a finding is expected and you know what causes it, add its "allow" entry from',
                  '`hatchkit host integrity --json` to ' + SITE_FILE + '.']
    return '\n'.join(lines) + '\n' + MAIL_FOOTER


def write_status(work, state):
    path = work / STATUS_NAME
    temporary = work / (STATUS_NAME + '.tmp')
    temporary.write_text(json.dumps(state, indent=2) + '\n')
    temporary.replace(path)


def utc_now():
    return dt.datetime.now(dt.timezone.utc)


def check(host, work, config, send, clock=utc_now, window=CHECK_WINDOW):
    """One timer run. Mails findings, a failed run, and the first clean run after either."""
    started = clock()
    try:
        previous = json.loads((work / STATUS_NAME).read_text())
    except (OSError, ValueError):
        previous = {}
    report, error = None, None
    try:
        report = scan(host, window, read_site())
    except IntegrityError as failure:
        error = str(failure)
    except Exception as failure:  # never echo a message that might carry host data
        error = type(failure).__name__
    # The scan takes the whole window: the result is from when it ends, and
    # doctor's staleness check reads checkedAt.
    finished = clock()
    findings = report['findings'] if report else []
    hostname = socket.gethostname()
    kind, subject = None, None
    if error:
        kind, subject = 'error', '[Hatchkit] Host integrity check failed — ' + hostname
    elif findings:
        kind, subject = 'findings', ('[Hatchkit] Host integrity: ' + str(len(findings)) + ' finding'
                                     + ('' if len(findings) == 1 else 's') + ' — ' + hostname)
    elif previous.get('findings') or previous.get('error'):
        kind, subject = 'recovery', '[Hatchkit] Host integrity clear — ' + hostname
    state = {'checkedAt': finished.isoformat(timespec='seconds'),
             'startedAt': started.isoformat(timespec='seconds'), 'ok': not error and not findings,
             'error': error, 'containers': report and report['containers'],
             'cpuWindowSeconds': report and report['cpuWindowSeconds'], 'findings': findings[:50],
             'skipped': (report or {}).get('skipped', []), 'mailed': None, 'messageId': None}
    mail_error = None
    if kind:
        if kind == 'recovery':
            body = '\n'.join(['Every checked container passed every detector.'] + not_checked(report)) + '\n' + MAIL_FOOTER
        else:
            body = mail_body(report, error)
        try:
            state['messageId'] = send(mail_settings(config), subject, body)
            state['mailed'] = kind
        except Exception as failure:  # SMTP errors may echo login details; keep the type only
            mail_error = failure if isinstance(failure, IntegrityError) else type(failure).__name__
            state['mailError'] = str(mail_error)
    write_status(work, state)
    return state, mail_error


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['scan', 'check', 'failed', 'test'])
    parser.add_argument('--cpu-window', type=int, default=10)
    parser.add_argument('--only')
    args = parser.parse_args()
    if not 0 <= args.cpu_window <= CHECK_WINDOW:
        raise IntegrityError('--cpu-window must be between 0 and ' + str(CHECK_WINDOW) + ' seconds')
    work, config = work_dir()
    if args.action == 'scan':
        report = scan(Host(), args.cpu_window, read_site(), args.only)
        report['siteFile'] = SITE_FILE if Path(SITE_FILE).exists() else None
        report['timer'] = timer_state(work)
        print(json.dumps(report))
        return
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from alerts import send_email
    work.mkdir(mode=0o700, parents=True, exist_ok=True)
    hostname = socket.gethostname()
    if args.action == 'test':
        message_id = send_email(mail_settings(config), '[Hatchkit] Host integrity alert test — ' + hostname,
                                'Host integrity alerts are configured for this address.\n\n'
                                'This is a test. The daily check mails when a process runs a deleted binary, a container '
                                'runs a process its image does not explain, a new file appears in /tmp, /var/tmp or /dev/shm '
                                'of a container, a container uses more than 50 % of one core over an hour, or a container '
                                'keeps an outbound connection outside private ranges and Cloudflare. The first clean run '
                                'after findings sends one all-clear.\n' + MAIL_FOOTER)
        print(json.dumps({'sent': True, 'messageId': message_id}))
        return
    if args.action == 'failed':
        message_id = send_email(mail_settings(config), '[Hatchkit] Host integrity check did not finish — ' + hostname,
                                'systemd stopped the daily host integrity check before it finished (a timeout, the '
                                'memory limit, or a crash). Nothing was checked this run.\n' + MAIL_FOOTER)
        print(json.dumps({'sent': True, 'messageId': message_id}))
        return
    state, mail_error = check(Host(), work, config, send_email)
    print(json.dumps({'ok': state['ok'], 'findings': len(state['findings']), 'error': state['error'],
                      'mailed': state['mailed'], 'mailError': state.get('mailError')}))
    # A failed scan that was mailed is recorded, not a unit failure: the
    # OnFailure mail is for runs that end before they can mail themselves.
    if mail_error:
        sys.exit(1)


if __name__ == '__main__':
    try:
        main()
    except IntegrityError as error:
        print(json.dumps({'ok': False, 'error': str(error)}))
        sys.exit(1)
    except Exception as error:
        print(json.dumps({'ok': False, 'error': type(error).__name__}))
        sys.exit(1)
