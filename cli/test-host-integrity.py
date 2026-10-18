"""Host integrity detectors against fixture /proc trees and a fake Docker CLI.

The compromised fixture is the 2026-10-18 Plausible miner: `linuxsys` run
from a deleted /tmp binary inside the Plausible container, 90 % of a core,
holding a connection to 103.189.234.47:80. Each detector must name it. The
clean fixture is what the shared Coolify host runs on a good day; it must
raise nothing.
"""
import datetime as dt
import ipaddress
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent / 'src/templates/host-integrity'))
hi = __import__('host-integrity')

SECRET = 'SECRET_VALUE_THAT_MUST_NOT_LEAK'
UPTIME = 900000.0


def encode(ip, port):
    """An address as /proc/net/tcp prints it: 32-bit words in little-endian order."""
    packed = ipaddress.ip_address(ip).packed
    return ''.join(packed[i:i + 4][::-1].hex().upper() for i in range(0, len(packed), 4)) + ':%04X' % port


def tcp_table(rows, v6=False):
    lines = ['  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode']
    for i, (state, local, remote, inode) in enumerate(rows):
        lines.append('%4d: %s %s %s 00000000:00000000 00:00000000 00000000  1000        0 %s 1 0000000000000000 20 4 0 10 -1'
                     % (i, encode(*local), encode(*remote), state, inode))
    return '\n'.join(lines) + '\n'


class Fixture:
    """A fake host: /proc, /sys/fs/cgroup and the Docker CLI's answers."""

    def __init__(self, root):
        self.root = Path(root)
        self.proc = self.root / 'proc'
        self.cgroup = self.root / 'cgroup'
        self.containers = []
        self.diffs = {}
        self.usage = {}
        self.ticks = []  # callbacks run when the scan sleeps through its window
        self.now = 0.0
        self.proc.mkdir(parents=True)
        (self.proc / 'uptime').write_text('%.2f 0.00\n' % UPTIME)
        self.process(1, 'systemd', '/usr/lib/systemd/systemd', netns='net:[1]')

    def container(self, name, image, pid, argv0=('node',), network='bridge', netns=None):
        cid = (name.encode().hex() * 64)[:64]
        self.containers.append({'id': cid, 'name': name, 'image': image, 'pid': pid, 'argv0': list(argv0),
                                'network': network})
        self.usage[cid] = 1_000_000
        self.diffs[cid] = ''
        return cid

    def process(self, pid, comm, exe, cid=None, netns=None, tcp=None, tcp6=None, fds=None, mounts=None, files=None,
                age=86400, volumes=()):
        base = self.proc / str(pid)
        (base / 'ns').mkdir(parents=True)
        (base / 'net').mkdir()
        (base / 'fd').mkdir()
        (base / 'root').mkdir()
        (base / 'comm').write_text(comm + '\n')
        start = int((UPTIME - age) * os.sysconf('SC_CLK_TCK'))
        (base / 'stat').write_text(str(pid) + ' (' + comm + ') ' + ' '.join(['S'] + ['0'] * 18 + [str(start)]) + ' 0 0\n')
        path = '/system.slice/docker-' + cid + '.scope' if cid else '/system.slice/ssh.service'
        (base / 'cgroup').write_text('0::' + path + '\n')
        (base / 'environ').write_text('DATABASE_URL=' + SECRET + '\0')
        (base / 'cmdline').write_text(comm + '\0--password\0' + SECRET + '\0')
        os.symlink(exe, base / 'exe')
        os.symlink(netns or ('net:[' + str(pid) + ']' if cid else 'net:[1]'), base / 'ns' / 'net')
        (base / 'net' / 'tcp').write_text(tcp or tcp_table([]))
        (base / 'net' / 'tcp6').write_text(tcp6 or tcp_table([], v6=True))
        for fd, inode in (fds or {}).items():
            os.symlink('socket:[' + inode + ']', base / 'fd' / str(fd))
        lines = ['22 1 0:21 / / rw,relatime - overlay overlay rw']
        for point in mounts or ():
            lines.append('23 22 0:22 / ' + point + ' rw,nosuid,nodev - tmpfs shm rw,size=65536k')
        for point in volumes:
            lines.append('24 22 8:1 /var/lib/docker/volumes/v/_data ' + point + ' rw,relatime - ext4 /dev/sda1 rw')
        (base / 'mountinfo').write_text('\n'.join(lines) + '\n')
        for name, content in (files or {}).items():
            target = base / 'root' / name.lstrip('/')
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content)
        if cid:
            stat = self.cgroup / path.lstrip('/')
            stat.mkdir(parents=True, exist_ok=True)
            self.write_usage(cid)

    def write_usage(self, cid):
        path = self.cgroup / ('system.slice/docker-' + cid + '.scope') / 'cpu.stat'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('usage_usec %d\nuser_usec 0\nsystem_usec 0\n' % self.usage[cid])

    def burn(self, cid, percent):
        """Make `cid` use `percent` of one core while the scan sleeps."""
        def tick(seconds):
            self.usage[cid] += int(seconds * 1e6 * percent / 100)
            self.write_usage(cid)
        self.ticks.append(tick)

    def docker(self, args):
        if args[0] == 'ps':
            return '\n'.join(c['id'] for c in self.containers) + '\n'
        if args[0] == 'inspect':
            assert '.Config.Env' not in args[4] and 'index .Config.Cmd 0' in args[4]
            lines = []
            for c in self.containers:
                if c['id'] not in args[5:]:
                    continue
                first = (c['argv0'] + [None, None])[:2]
                lines.append('\t'.join([json.dumps(c['id']), json.dumps('/' + c['name']), json.dumps(c['image']),
                                        str(c['pid']), json.dumps(first[0]), json.dumps(first[1]),
                                        json.dumps(c['network'])]))
            return '\n'.join(lines) + '\n'
        if args[0] == 'diff':
            return self.diffs[args[1]]
        raise AssertionError(args)

    def sleep(self, seconds):
        for tick in self.ticks:
            tick(seconds)
        self.now += seconds

    def host(self):
        return hi.Host(proc=self.proc, cgroup=self.cgroup, docker=self.docker, sleep=self.sleep,
                       clock=lambda: self.now)


def clean_host(fx):
    """What the shared Coolify host runs on a good day."""
    app = fx.container('o5ufcrdu6ur673asft5hw1tt-205657666842', 'ghcr.io/trebeljahr/asteroid-game-server:live', 100,
                       argv0=('docker-entrypoi', 'node'))
    fx.process(100, 'MainThread', '/usr/local/bin/node', app, mounts=['/dev/shm'], tcp=tcp_table([
        ('0A', ('0.0.0.0', 3000), ('0.0.0.0', 0), '500'),
        ('01', ('10.0.1.7', 3000), ('10.0.1.2', 51234), '501'),       # Traefik -> app, inbound
        ('01', ('10.0.1.7', 40100), ('10.0.1.9', 27017), '502'),      # app -> its Mongo
        ('01', ('10.0.1.7', 40200), ('104.16.132.229', 443), '503'),  # app -> R2 (Cloudflare)
    ]), files={'/tmp/hatchkit-drain.pid': '100'})
    fx.process(101, 'sh', '/bin/busybox', app)
    fx.diffs[app] = 'C /tmp\nA /tmp/hatchkit-drain.pid\nC /app\nA /app/.next/cache/x\n'
    # A Next.js server started through hatchkit's drain entrypoint and dotenvx.
    coll = fx.container('bbu24hzgels1n2m1sznx3fdu-211834526961', 'ghcr.io/trebeljahr/collection-of-beauty:latest', 110,
                        argv0=('drain-entrypoin', 'dotenvx'))
    fx.process(110, 'MainThread', '/usr/local/bin/node', coll)
    fx.process(111, 'next-server (v1', '/usr/local/bin/node', coll)
    pg = fx.container('postgres-yxhctpxl6dqfhs3vpacg5it2', 'postgres:18-alpine', 200, argv0=('docker-entrypoi', 'postgres'))
    fx.process(200, 'postgres', '/usr/local/bin/postgres', pg, mounts=['/dev/shm'], volumes=['/var/lib/postgresql/data'],
               files={'/dev/shm/PostgreSQL.1804289383': ''})
    fx.process(201, 'postgres', '/usr/local/bin/postgres', pg)
    mongo = fx.container('x3rnoe4qdk846u4q3wjw2fw0', 'mongo', 300, argv0=('docker-entrypoi', 'mongod'))
    fx.process(300, 'mongod', '/usr/bin/mongod', mongo, files={
        '/tmp/mongodb-27017.sock': '', '/tmp/.mongodb/mongosh/6ac2da7b92ea5bb330bfd5ef_log': 'x'})
    fx.process(301, 'mongosh mongodb', '/usr/bin/mongosh', mongo)
    fx.diffs[mongo] = 'C /tmp\nA /tmp/mongodb-27017.sock\nA /tmp/.mongodb\nA /tmp/.mongodb/mongosh\n' \
                      'A /tmp/.mongodb/mongosh/6ac2da7b92ea5bb330bfd5ef_log\n'
    ch = fx.container('plausible-events-db-c8378br07og1w4ta45uxh57l', 'clickhouse/clickhouse-server:24.12-alpine', 400,
                      argv0=('entrypoint.sh',))
    fx.process(400, 'clickhouse-serv', '/usr/bin/clickhouse', ch, files={'/tmp/users.xml': '<x/>'})
    fx.diffs[ch] = 'C /tmp\nA /tmp/users.xml\n'
    coolify = fx.container('coolify', 'ghcr.io/coollabsio/coolify:latest', 500, argv0=('init',))
    fx.process(500, 's6-svscan', '/package/admin/s6-2.13.1.0/command/s6-svscan', coolify)
    fx.process(501, 'foreground', '/package/admin/execline-2.9.7.0/command/execline', coolify)
    fx.process(502, 'php-fpm8.4', '/usr/sbin/php-fpm8.4', coolify)
    fx.process(503, 'nginx', '/usr/sbin/nginx', coolify)
    fx.process(504, 'php', '/usr/bin/php8.4', coolify)
    fx.process(505, 'runc:[2:INIT]', '/memfd:runc_cloned:/proc/self/exe (deleted)', coolify, age=0.2)
    rt = fx.container('coolify-realtime', 'ghcr.io/coollabsio/coolify-realtime:1.0.11', 600, argv0=('sh',))
    fx.process(600, 'soketi-server', '/usr/local/bin/node', rt)
    kuma = fx.container('uptime-kuma-v1l81eqaeaslqftatbzh5cga-120931250733', 'louislam/uptime-kuma:2', 700,
                        argv0=('/usr/bin/dumb-init',))
    fx.process(700, 'dumb-init', '/usr/bin/dumb-init', kuma)
    fx.process(701, 'node', '/usr/local/bin/node', kuma)
    fx.process(702, 'mariadbd', '/usr/sbin/mariadbd', kuma)
    proxy = fx.container('coolify-proxy', 'traefik:v3.6', 800, argv0=('/entrypoint.sh', 'traefik'))
    fx.process(800, 'traefik', '/usr/local/bin/traefik', proxy, tcp=tcp_table([
        ('0A', ('0.0.0.0', 443), ('0.0.0.0', 0), '800'),
        ('01', ('10.0.1.2', 443), ('162.158.10.20', 61000), '801'),   # Cloudflare edge -> Traefik
    ]), tcp6=tcp_table([('01', ('::ffff:10.0.1.2', 50000), ('::ffff:10.0.1.7', 3000), '802')], v6=True))
    helper = fx.container('t32me46x1jskszs4ame0cavg', 'ghcr.io/coollabsio/coolify-helper:1.0.12', 900, argv0=('bash',))
    fx.process(900, 'nixpacks', '/usr/bin/nixpacks', helper)
    # A host daemon still on its pre-upgrade binary: a note, not a finding.
    fx.process(50, 'systemd-logind', '/usr/lib/systemd/systemd-logind (deleted)',
               files={'/usr/lib/systemd/systemd-logind': 'new'})
    for c in fx.containers:
        fx.burn(c['id'], 3)


def compromised_host(fx):
    """The 2026-10-18 Plausible container: a miner beside beam.smp."""
    cid = fx.container('plausible-c8378br07og1w4ta45uxh57l', 'ghcr.io/plausible/community-edition:v3.0.1', 1000,
                       argv0=('/entrypoint.sh', 'run'))
    tcp = tcp_table([
        ('0A', ('0.0.0.0', 8000), ('0.0.0.0', 0), '1100'),
        ('01', ('10.0.2.5', 8000), ('10.0.2.1', 40000), '1101'),
        ('01', ('10.0.2.5', 45678), ('103.189.234.47', 80), '1102'),   # the pool connection
    ])
    fx.process(1000, 'beam.smp', '/app/erts-15.2/bin/beam.smp', cid, netns='net:[1000]', tcp=tcp)
    fx.process(1001, 'erl_child_setup', '/app/erts-15.2/bin/erl_child_setup', cid, netns='net:[1000]')
    fx.process(1002, 'linuxsys', '/tmp/.x/linuxsys (deleted)', cid, netns='net:[1000]', fds={7: '1102'})
    fx.diffs[cid] = 'C /tmp\nA /tmp/.x\nA /tmp/.x/config.json\n'
    (fx.proc / '1000' / 'root' / 'tmp' / '.x').mkdir(parents=True)
    (fx.proc / '1000' / 'root' / 'tmp' / '.x' / 'config.json').write_text('{}')
    fx.burn(cid, 90)
    return cid


class Detectors(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.fx = Fixture(self.directory.name)

    def tearDown(self):
        self.directory.cleanup()

    def scan(self, window=60, site=None):
        return hi.scan(self.fx.host(), window, site or {})

    def test_clean_host_raises_nothing(self):
        clean_host(self.fx)
        report = self.scan(3600)
        self.assertEqual(report['findings'], [])
        self.assertEqual(report['containers'], 10)
        self.assertEqual(report['cpuWindowSeconds'], 3600)
        self.assertEqual(report['outboundConnections'], 3)
        self.assertEqual(report['peerSamples'], 61)
        self.assertEqual(report['skipped'], [])
        self.assertTrue(any('systemd-logind' in n and 'restart' in n for n in report['notes']))
        self.assertTrue(any('coolify-helper' in n or 'build container' in n for n in report['notes']))
        self.assertNotIn(SECRET, json.dumps(report))

    def test_plausible_miner_is_named_by_every_detector(self):
        clean_host(self.fx)
        compromised_host(self.fx)
        report = self.scan(3600)
        self.assertNotIn(SECRET, json.dumps(report))
        by = {}
        for finding in report['findings']:
            self.assertEqual(finding['container'], 'plausible-c8378br07og1w4ta45uxh57l', finding)
            by.setdefault(finding['detector'], []).append(finding)
        self.assertEqual(sorted(by), ['cpu', 'deleted-binary', 'outbound-peer', 'temp-file', 'unexpected-process'])
        self.assertEqual(by['deleted-binary'][0]['pid'], 1002)
        self.assertIn('/tmp/.x/linuxsys, which was deleted', by['deleted-binary'][0]['summary'])
        self.assertEqual([f['process'] for f in by['unexpected-process']], ['linuxsys'])
        self.assertEqual(by['unexpected-process'][0]['allow'],
                         {'processes': {'ghcr.io/plausible/community-edition*': ['linuxsys']}})
        self.assertEqual(sorted(f['path'] for f in by['temp-file']), ['/tmp/.x/config.json', '/tmp/.x/linuxsys'])
        self.assertEqual(round(by['cpu'][0]['percent']), 90)
        self.assertIn('averaged over 60 min', by['cpu'][0]['summary'])
        peer = by['outbound-peer'][0]
        self.assertEqual((peer['peer'], peer['pid'], peer['process']), ('103.189.234.47:80', 1002, 'linuxsys'))

    def test_renamed_sleep_from_var_tmp(self):
        """The acceptance case: cp sleep /var/tmp/x; /var/tmp/x &; rm /var/tmp/x."""
        cid = self.fx.container('integrity-proof', 'alpine:3.20', 2000, argv0=('sh',))
        self.fx.process(2000, 'sh', '/bin/busybox', cid)
        self.fx.process(2001, 'x', '/var/tmp/x (deleted)', cid)
        self.fx.diffs[cid] = 'C /var/tmp\n'
        found = sorted({f['detector'] for f in self.scan(0)['findings']})
        self.assertEqual(found, ['deleted-binary', 'temp-file', 'unexpected-process'])

    def test_deleted_binary_rules(self):
        cid = self.fx.container('app', 'node:22', 10)
        runc = '/memfd:runc_cloned:/proc/self/exe (deleted)'
        processes = [
            {'pid': 1, 'comm': 'a', 'exe': '/memfd:payload (deleted)', 'container': cid},
            {'pid': 2, 'comm': 'runc:[2:INIT]', 'exe': runc, 'container': cid, 'age': 0.3},
            {'pid': 3, 'comm': 'sshd', 'exe': '/usr/sbin/sshd (deleted)', 'container': None},
            {'pid': 4, 'comm': 'x', 'exe': '/home/x/x (deleted)', 'container': None},
            {'pid': 5, 'comm': 'gone', 'exe': '/tmp/gone (deleted)', 'container': 'f' * 64},
            # A fileless miner under runc's memfd name, alive past the moment runc needs.
            {'pid': 6, 'comm': 'runc:[2:INIT]', 'exe': runc, 'container': cid, 'age': 3600},
            # Inside a container, a file written back at the path does not explain it away.
            {'pid': 7, 'comm': 'x', 'exe': '/usr/bin/x (deleted)', 'container': cid},
            {'pid': 8, 'comm': 'snapd', 'exe': '/snap/snapd/21759/usr/lib/snapd/snapd (deleted)', 'container': None},
        ]
        findings, notes = hi.deleted_binaries(processes, self.fx.containers, lambda p, path: p['pid'] in (3, 7))
        self.assertEqual([f['pid'] for f in findings], [1, 4, 6, 7])
        self.assertEqual(findings[1]['container'], None)
        self.assertIn('host: process x (pid 4) runs /home/x/x', findings[1]['summary'])
        self.assertEqual([n.split(':')[1].split()[0] for n in notes], ['sshd', 'snapd'])

    def test_unexpected_process_allowlist_sources(self):
        def odd(image, argv0, comms, exe='/usr/bin/{}', site=None, layer=(), mounts=('/',), age=None):
            container = {'id': 'c', 'name': 'n', 'image': image, 'argv0': list(argv0)}
            processes = [{'pid': i, 'comm': c, 'exe': exe.format(c), 'container': 'c', 'age': age}
                         for i, c in enumerate(comms)]
            layers = {'c': None if layer is None else set(layer)}
            found = hi.unexpected_processes(processes, [container], site or {}, layers, {'c': list(mounts)})[0]
            return [f.get('process') or f['summary'] for f in found]
        # A binary the writable layer added, under a name nothing explains.
        self.assertEqual(odd('postgres:16', ['postgres'], ['postgres', 'pg_isready', 'xmrig'],
                             layer={'/usr/bin/xmrig'}), ['xmrig'])
        # Family by the binary a process runs: an app image Coolify named at random.
        self.assertEqual(odd('l8kc0w0:abc', ['bash'], ['MainThread', 'next-server (v1', 'node']), [])
        # ... but not by a binary that runs from a temp dir.
        self.assertEqual(odd('l8kc0w0:abc', ['bash'], ['node'], exe='/tmp/{}'), ['node'])
        self.assertEqual(odd('mongo', ['docker-entrypoi'], ['mongod', 'mongosh mongodb']), [])
        added = {'/usr/bin/worker'}
        self.assertEqual(odd('ghcr.io/x/app:1', ['app'], ['app', 'worker'], layer=added), ['worker'])
        self.assertEqual(odd('ghcr.io/x/app:1', ['app'], ['worker'], layer=added,
                             site={'processes': {'ghcr.io/x/app*': ['worker']}}), [])
        self.assertEqual(odd('ghcr.io/x/app:1', ['app'], ['worker'], layer=added, site={'processes': {'n': ['work*']}}), [])
        self.assertEqual(odd('ghcr.io/x/app:1', ['app'], ['worker'], exe='/tmp/{}',
                             site={'processes': {'n': ['worker']}}), ['worker'])
        self.assertEqual(odd('ghcr.io/coollabsio/coolify:latest', ['init'], ['foreground'],
                             exe='/package/admin/execline-2.9.7.0/command/execline'), [])
        self.assertEqual(odd('ghcr.io/coollabsio/coolify:latest', ['init'], ['foreground'], exe='/usr/local/bin/x',
                             layer={'/usr/local/bin/x'}), ['foreground'])
        self.assertEqual(odd('ghcr.io/coollabsio/coolify-helper:1', ['bash'], ['anything']), [])
        # A binary the image ships, run under its own name (minio, weed, ...).
        self.assertEqual(odd('sha256:14ce', ['docker-entrypoi'], ['minio'], layer=set()), [])
        # ... unless the writable layer added or changed it,
        self.assertEqual(odd('sha256:14ce', ['docker-entrypoi'], ['minio'], layer={'/usr/bin/minio'}), ['minio'])
        # ... it runs under another name, Docker could not list the layer, or it is gone.
        self.assertEqual(odd('sha256:14ce', ['docker-entrypoi'], ['kworker'], exe='/usr/bin/minio', layer=set()), ['kworker'])
        self.assertEqual(odd('sha256:14ce', ['docker-entrypoi'], ['minio'], layer=None), [])  # layer unknown: name rules only
        self.assertEqual(odd('sha256:14ce', ['x'], ['linuxsys'], exe='/usr/bin/{} (deleted)', layer=set()), ['linuxsys'])
        self.assertEqual(odd('sha256:14ce', ['x'], ['linuxsys'], exe='/tmp/{}', layer=set()), ['linuxsys'])
        # An allowed name vouches only for a binary from the image: not one on a volume,
        self.assertEqual(odd('mongo', ['mongod'], ['mongod'], exe='/data/db/{}', mounts=('/', '/data/db')), ['mongod'])
        self.assertEqual(odd('mongo', ['mongod'], ['mongod', 'docker-init'], exe='/sbin/{}', mounts=('/', '/sbin/docker-init')), [])
        # ... nor one the writable layer added under an allowed path.
        self.assertEqual(odd('ghcr.io/coollabsio/coolify:latest', ['init'], ['foreground'],
                             exe='/package/admin/{}', layer={'/package/admin/foreground'}), ['foreground'])
        # `python` from `sh -c "python …"` runs /usr/local/bin/python3.12.
        self.assertEqual(odd('ghcr.io/x/api:1', ['sh'], ['python'], exe='/usr/local/bin/python3.12'), [])
        # runc's memfd init is exempt only for its first moments.
        runc = '/memfd:runc_cloned:/proc/self/exe (deleted)'
        self.assertEqual(odd('redis:7', ['redis-server'], ['runc:[2:INIT]'], exe=runc, age=0.5), [])
        self.assertEqual(odd('redis:7', ['redis-server'], ['runc:[2:INIT]'], exe=runc, age=900), ['runc:[2:INIT]'])
        self.assertEqual(odd('redis:7', ['redis-server'], ['runc:[2:INIT]'], exe=runc), ['runc:[2:INIT]'])
        # Decoys do not push the miner out of the report.
        decoys = ['aa%02d' % i for i in range(21)] + ['linuxsys']
        found = odd('ghcr.io/x/app:1', ['app'], decoys, exe='/tmp/{}')
        self.assertEqual(len(found), hi.MAX_PER_CONTAINER + 1)
        self.assertIn('2 more unexpected process names: aa20, linuxsys', found[-1])
        self.assertEqual(hi.image_glob('host:5000/team/app:sha'), 'host:5000/team/app*')
        self.assertEqual(hi.image_glob('mongo'), 'mongo*')
        self.assertEqual(hi.image_glob('ghcr.io/x/app@sha256:ab'), 'ghcr.io/x/app*')

    def test_temp_files(self):
        cid = self.fx.container('app', 'node:22', 10)
        stat = {'size': 3, 'mode': 0o100644, 'modified': '2026-10-19 05:00 UTC'}
        exe = dict(stat, mode=0o100755)
        files = {cid: [('/tmp/hatchkit-drain.pid', stat), ('/var/tmp/payload', exe), ('/dev/shm/sem.x', stat),
                       ('/tmp/report.csv', stat)]}
        sock = dict(stat, mode=0o140755)  # mongod's socket has execute bits; it is not a program
        files[cid] += [('/tmp/users.xml', exe), ('/tmp/mongodb-27017.sock', sock)]
        findings = hi.temp_files(self.fx.containers, files, [], {'tempFiles': ['/tmp/*.csv']})
        self.assertEqual([(f['path'], f['executable']) for f in findings],
                         [('/var/tmp/payload', True), ('/tmp/users.xml', True), ('/dev/shm/sem.x', False)])
        self.assertIn('new executable file /var/tmp/payload', findings[0]['summary'])
        self.assertNotIn('allow', findings[0])  # an executable gets no exception
        self.assertEqual(findings[2]['allow'], {'tempFiles': ['/dev/shm/sem.x']})
        many = {cid: [('/tmp/f%02d' % i, stat) for i in range(25)]}
        listed = hi.temp_files(self.fx.containers, many, [], {})
        self.assertEqual(len(listed), hi.MAX_PER_CONTAINER + 1)
        self.assertEqual(listed[-1]['overflow'], 5)
        ran = hi.temp_files(self.fx.containers, {}, [{'pid': 9, 'comm': 'node', 'exe': '/dev/shm/node', 'container': cid}],
                            {'tempFiles': ['/dev/shm/*']})
        self.assertEqual([f['pid'] for f in ran], [9])  # the allowlist never hides a running binary

    def test_temp_files_collected_from_layer_and_tmpfs(self):
        cid = self.fx.container('app', 'node:22', 10)
        self.fx.process(10, 'node', '/usr/local/bin/node', cid, mounts=['/dev/shm'],
                        files={'/tmp/a/b.sh': 'x', '/dev/shm/m': 'y', '/var/tmp/old': 'z'})
        self.fx.diffs[cid] = 'C /tmp\nA /tmp/a\nA /tmp/a/b.sh\nC /var\nC /var/tmp\nA /var/tmp/gone\nD /var/tmp/old\n'
        layers, notes = hi.collect_layers(self.fx.host(), self.fx.containers)
        self.assertEqual(notes, [])
        self.assertIn('/var', layers[cid])
        mounts = {cid: hi.mount_points(self.fx.host(), 10)}
        self.assertEqual(mounts[cid], ['/', '/dev/shm'])
        files = hi.collect_temp_files(self.fx.host(), self.fx.containers, layers, mounts)
        self.assertEqual([p for p, _ in files[cid]], ['/dev/shm/m', '/tmp/a/b.sh'])

    def test_cpu(self):
        a = self.fx.container('busy', 'ghcr.io/x/busy:1', 10)
        b = self.fx.container('restarted', 'redis:7', 11)
        c = self.fx.container('new', 'redis:7', 12)
        d = self.fx.container('expected', 'ghcr.io/x/encoder:3', 13)
        usage, unmeasured = hi.cpu_percentages(self.fx.containers, {a: 0, b: 9e9, d: 0},
                                               {a: 3600 * 0.6e6, b: 1, c: 5, d: 3600 * 0.8e6}, 3600)
        self.assertEqual(sorted(usage), sorted([a, d]))
        self.assertEqual(unmeasured, ['restarted', 'new'])
        findings = hi.cpu_hogs(self.fx.containers, usage, 3600, {'cpuLimits': {'ghcr.io/x/encoder*': 90}})
        self.assertEqual([(f['container'], f['percent']) for f in findings], [('busy', 60.0)])
        self.assertEqual(findings[0]['allow'], {'cpuLimits': {'busy': 70}})
        self.assertEqual(hi.name_glob('bbu24hzgels1n2m1sznx3fdu-211834526961'), 'bbu24hzgels1n2m1sznx3fdu-*')
        self.assertIn('60 % of one core averaged over 60 min (limit 50 %)', findings[0]['summary'])

    def test_cgroup_v1_usage(self):
        cid = self.fx.container('v1', 'redis:7', 10)
        self.fx.process(10, 'redis-server', '/usr/local/bin/redis-server', cid)
        (self.fx.proc / '10' / 'cgroup').write_text('12:cpu,cpuacct:/docker/' + cid + '\n4:memory:/docker/' + cid + '\n')
        usage = self.fx.cgroup / 'cpu,cpuacct' / 'docker' / cid / 'cpuacct.usage'
        usage.parent.mkdir(parents=True)
        usage.write_text('7000000\n')
        self.assertEqual(hi.cpu_usage_usec(self.fx.host(), 10), 7000)
        self.assertEqual(hi.container_id('12:cpu,cpuacct:/docker/' + cid), cid)

    def test_outbound_peer_rules(self):
        c = {'id': 'c', 'name': 'app', 'image': 'ghcr.io/x/app:1', 'pid': 1}
        k = {'id': 'k', 'name': 'uptime-kuma', 'image': 'louislam/uptime-kuma:2', 'pid': 2}
        def sample(*conns, kuma=True):
            out = {'n1': {'containers': [c], 'connections': {key: inode for key, inode in conns}}}
            if kuma:
                out['n2'] = {'containers': [k], 'connections': {('10.0.0.6', 40000, '9.9.9.9', 443): '3'}}
            return out
        held = (('10.0.0.5', 40000, '8.8.8.8', 853), '1')
        cloudflare = (('10.0.0.5', 40003, '104.18.1.1', 443), '5')
        six = (('10.0.0.5', 40004, '2a01:4f8::1', 443), '6')
        samples = [
            sample(held, cloudflare, six, (('10.0.0.5', 40001, '1.2.3.4', 443), '2')),
            # A pool client that re-dials: a new local port each time.
            sample(held, cloudflare, six, (('10.0.0.5', 41000, '103.189.234.47', 80), '7')),
            sample(held, six, (('10.0.0.5', 41001, '103.189.234.47', 80), '8')),
            sample(held, six, (('10.0.0.5', 40002, '5.6.7.8', 443), '4'), (('10.0.0.5', 41002, '103.189.234.47', 80), '9')),
        ]
        findings, notes = hi.outbound_peers(samples, 180, {'peerContainers': ['uptime-kuma*']},
                                            lambda cs, inode: (7, 'node') if inode == '1' else None)
        self.assertEqual([f['peer'] for f in findings], ['103.189.234.47:80', '2a01:4f8::1:443', '8.8.8.8:853'])
        self.assertIn('open in 3 of 4 samples over 3 min', findings[0]['summary'])
        self.assertEqual(findings[2]['process'], 'node')
        self.assertEqual(findings[1]['allow'], {'peers': ['2a01:4f8::1/128']})
        self.assertEqual(notes, ['uptime-kuma: outbound peers not checked (peerContainers).'])
        # Two samples (a short window): only what is open at both ends.
        short, _ = hi.outbound_peers(samples[2:], 10, {}, lambda cs, inode: None)
        self.assertEqual([f['peer'] for f in short if f['container'] == 'app'],
                         ['103.189.234.47:80', '2a01:4f8::1:443', '8.8.8.8:853'])
        site = {'peers': ['8.8.8.0/24', '2a01:4f8::/32', '103.189.234.0/24'], 'peerContainers': ['louislam/*']}
        self.assertEqual(hi.outbound_peers(samples, 180, site, lambda cs, inode: None)[0], [])

    def test_tcp_parsing(self):
        rows = hi.parse_tcp(tcp_table([('0A', ('0.0.0.0', 80), ('0.0.0.0', 0), '9'),
                                       ('01', ('172.18.0.4', 33000), ('103.189.234.47', 80), '10')]))
        self.assertEqual(rows[1][1:5], (ipaddress.ip_address('172.18.0.4'), 33000, ipaddress.ip_address('103.189.234.47'), 80))
        self.assertEqual(hi.outbound(rows), {('172.18.0.4', 33000, '103.189.234.47', 80): '10'})
        six = hi.parse_tcp(tcp_table([('01', ('::ffff:172.18.0.4', 1), ('::ffff:1.2.3.4', 2), '1'),
                                      ('01', ('2a01:4f8::2', 3), ('2606:4700::1', 443), '2')], v6=True), v6=True)
        self.assertEqual([str(r[3]) for r in six], ['1.2.3.4', '2606:4700::1'])
        self.assertTrue(hi.peer_allowed('2606:4700::1', {}))
        self.assertTrue(hi.peer_allowed('100.117.14.6', {}))
        self.assertFalse(hi.peer_allowed('103.189.234.47', {}))

    def test_host_network_and_shared_netns(self):
        a = self.fx.container('host-net', 'ghcr.io/x/a:1', 10, network='host')
        b = self.fx.container('b', 'ghcr.io/x/b:1', 11)
        c = self.fx.container('c', 'ghcr.io/x/c:1', 12, network='container:b')
        self.fx.process(10, 'node', '/usr/local/bin/node', a, netns='net:[1]')
        self.fx.process(11, 'node', '/usr/local/bin/node', b, netns='net:[77]')
        self.fx.process(12, 'node', '/usr/local/bin/node', c, netns='net:[77]')
        sample = hi.peer_sample(self.fx.host(), self.fx.containers)
        self.assertEqual(list(sample), ['net:[77]'])
        self.assertEqual([x['name'] for x in sample['net:[77]']['containers']], ['b', 'c'])
        report = self.scan(0)
        self.assertIn('Outbound peers not checked (host network): host-net', report['skipped'])
        self.assertIn('CPU not measured: the window was under 5 s.', report['skipped'])

    def test_attacker_chosen_names_are_escaped(self):
        cid = self.fx.container('app', 'alpine:3.20', 10, argv0=('sh',))
        self.fx.process(10, 'x\x1b[2Jok', '/var/tmp/x\nFAKE LINE (deleted)', cid)
        text = json.dumps(self.scan(0))
        self.assertNotIn('\\u001b', text)
        self.assertIn('x\\\\x1b[2Jok', text)
        self.assertIn('/var/tmp/x\\\\x0aFAKE LINE', text)

    def test_site_file_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'host-integrity.json'
            self.assertEqual(hi.read_site(path), {})
            for content, message in (('[', 'not valid JSON'), ('[]', 'JSON object'), ('{"proc": {}}', 'unknown key'),
                                     ('{"peers": {}}', 'must be a'), ('{"peers": ["nope"]}', 'not a CIDR')):
                path.write_text(content)
                with self.assertRaisesRegex(hi.IntegrityError, message):
                    hi.read_site(path)
            path.write_text('{"peers": ["8.8.8.8"], "processes": {"x*": ["y"]}}')
            self.assertEqual(hi.read_site(path)['peers'], ['8.8.8.8'])


class Check(unittest.TestCase):
    """The timer run: what it mails and records."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.work = Path(self.directory.name)
        self.config = {'alerts': {'enabled': True, 'to': 'owner@example.test', 'from': 'Hatchkit Backups <backup@example.test>',
                                  'smtpFile': '/etc/hatchkit-backups/alert-smtp.json'}}
        self.sent = []

    def tearDown(self):
        self.directory.cleanup()

    def send(self, settings, subject, body):
        self.sent.append((settings, subject, body))
        return '<id-%d>' % len(self.sent)

    def run_check(self, scan=None, error=None, send=None):
        def fake(host, window, site, only=None):
            if error:
                raise error
            return scan
        with patch.object(hi, 'scan', side_effect=fake), patch.object(hi, 'read_site', return_value={}):
            return hi.check(None, self.work, self.config, send or self.send, now=dt.datetime(2026, 10, 19, 5, tzinfo=dt.timezone.utc))

    def report(self, findings):
        return {'containers': 31, 'cpuWindowSeconds': 3600, 'findings': findings}

    def test_findings_mail_then_recovery_once(self):
        finding = {'detector': 'cpu', 'container': 'plausible', 'summary': 'plausible: 90 % of one core averaged over 60 min'}
        state, error = self.run_check(self.report([finding]))
        self.assertEqual((state['mailed'], state['ok'], error), ('findings', False, None))
        settings, subject, body = self.sent[0]
        self.assertEqual(settings['from'], 'Hatchkit Host Check <backup@example.test>')
        self.assertIn('Host integrity: 1 finding', subject)
        self.assertIn('- plausible: 90 % of one core', body)
        self.assertIn('hatchkit host integrity --json', body)
        status = json.loads((self.work / hi.STATUS_NAME).read_text())
        self.assertEqual(status['findings'], [finding])
        self.run_check(self.report([finding]))
        self.assertEqual(len(self.sent), 2)  # every daily run with findings mails
        state, _ = self.run_check(self.report([]))
        self.assertEqual(state['mailed'], 'recovery')
        self.assertIn('clear', self.sent[2][1])
        state, _ = self.run_check(self.report([]))
        self.assertEqual((state['mailed'], len(self.sent)), (None, 3))

    def test_failed_scan_mails_the_safe_reason_only(self):
        state, _ = self.run_check(error=hi.IntegrityError('docker ps failed'))
        self.assertEqual((state['mailed'], state['error']), ('error', 'docker ps failed'))
        self.assertIn('could not finish: docker ps failed', self.sent[0][2])
        state, _ = self.run_check(error=RuntimeError('token=' + SECRET))
        self.assertEqual(state['error'], 'RuntimeError')
        self.assertNotIn(SECRET, json.dumps(self.sent) + (self.work / hi.STATUS_NAME).read_text())

    def test_mail_failure_is_recorded_without_its_message(self):
        def broken(settings, subject, body):
            raise OSError('535 auth failed for user AKIA' + SECRET)
        state, error = self.run_check(self.report([{'detector': 'cpu', 'container': 'x', 'summary': 'x'}]), send=broken)
        self.assertEqual((state['mailed'], state['mailError'], error), (None, 'OSError', 'OSError'))
        self.assertNotIn(SECRET, (self.work / hi.STATUS_NAME).read_text())

    def test_unconfigured_mail_is_a_safe_error(self):
        self.config = {}
        state, error = self.run_check(self.report([{'detector': 'cpu', 'container': 'x', 'summary': 'x'}]))
        self.assertIn('backup alert mail is not configured', state['mailError'])
        self.assertIsNotNone(error)


if __name__ == '__main__':
    unittest.main()
