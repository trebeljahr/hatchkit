"""Update watch: the version matcher against a snapshot of the real feeds, the
scan against a fake Docker CLI, the Coolify upgrade logs, and the timer's mail.

The fixture host is the shared Coolify host as found on 2026-10-18: Plausible
CE v3.0.1 (taken over through GHSA-mhcv-h7gf-57cf), Coolify 4.0.0-beta.469,
Traefik 3.6.12 behind the floating tag v3.6, Listmonk v6.0.0 and Uptime Kuma
2.2.1 behind the floating tag 2. Each must be flagged with its advisory. The
versions they run after the 2026-10-18/19 upgrades must flag nothing.

test-support/update-watch-feeds-2026-10-19.json is GitHub's, GitLab's and
Cloudflare's answers on 2026-10-19, trimmed to the fields the matcher reads.
DEDICATED_CHAIN is what `iptables -S HATCHKIT-CF` / `ip6tables -S HATCHKIT-CF`
printed on dedicated-vps that day.
"""
import datetime as dt
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE / 'src/templates/update-watch'))
uw = __import__('update-watch')

SERVICES = json.loads((HERE / 'src/templates/update-watch/update-watch-services.json').read_text())
CLOUDFLARE = json.loads((HERE / 'src/templates/update-watch/update-watch-cloudflare.json').read_text())
FEEDS = json.loads((HERE / 'test-support/update-watch-feeds-2026-10-19.json').read_text())
BY_KEY = {s['key']: s for s in SERVICES}
SECRET = 'SECRET_VALUE_THAT_MUST_NOT_LEAK'
NOW = dt.datetime(2026, 10, 19, 6, 0, tzinfo=dt.timezone.utc)


def offline(url):
    raise AssertionError('unexpected network read: ' + url)


def flagged(key, version):
    """GHSA ids of the high/critical advisories covering `version`, and the unreadable ones."""
    service = BY_KEY[key]
    feeds = uw.Feeds(FEEDS, get=offline)
    v = uw.Version(version)
    hits, unknown = [], []
    released = None
    for advisory in feeds.json(uw.advisories_url(service['github'])):
        if advisory['severity'] not in uw.FLAGGED or advisory.get('withdrawn_at'):
            continue
        covered = uw.covers(v, advisory, service)
        if covered is None:
            released = released or uw.release_date(feeds, service['github'], v)
            covered = uw.covers(v, advisory, service, released)
        if covered is None:
            unknown.append(advisory['ghsa_id'])
        elif covered:
            hits.append(advisory['ghsa_id'])
    return hits, unknown


class Versions(unittest.TestCase):
    def test_ordering(self):
        V = uw.Version
        self.assertLess(V('4.0.0-beta.469'), V('4.0.0-beta.470'))
        self.assertLess(V('4.0.0-beta.469'), V('4.0.0'))
        self.assertLess(V('4.0.0'), V('4.4.6'))
        self.assertLess(V('v4.0.0-beta.420.6'), V('4.0.0-beta.420.7'))
        self.assertLess(V('v3.7.0-ea.1'), V('v3.7.0-rc.1'))
        self.assertLess(V('v3.5.0-rc2'), V('v3.5.0-rc.3'))
        self.assertLess(V('2.0.0-beta.2'), V('2.0.0'))
        self.assertEqual(V('v3.7.15'), V('3.7.15'))
        self.assertEqual(V('24.12.6.70-alpine'), V('24.12.6.70'))
        self.assertEqual(V('v23.8.15.35-lts'), V('23.8.15.35'))
        self.assertEqual(V('3'), V('3.0.0'))
        self.assertLess(V('24.12.5.65'), V('24.12.6.70'))

    def test_full_version_means_one_release(self):
        for floating in ('v3.6', '2', 'latest', '24.12-alpine', 'main', None):
            self.assertIsNone(uw.full_version(floating), floating)
        for exact in ('v3.7.15', '4.0.0-beta.469', '24.12.6.70-alpine', '6.2.6'):
            self.assertIsNotNone(uw.full_version(exact), exact)

    def test_ranges_as_advisories_write_them(self):
        def inside(text, version):
            alternatives = uw.parse_range(text)
            return any(all(uw.satisfies(uw.Version(version), c) for c in alt) for alt in alternatives)
        # one window
        self.assertTrue(inside('>= v3.7.0-ea.1, <= v3.7.14', '3.7.14'))
        self.assertFalse(inside('>= v3.7.0-ea.1, <= v3.7.14', '3.7.15'))
        self.assertTrue(inside('>=3 and < 3.2.1', '3.0.1'))
        self.assertFalse(inside('>=3 and < 3.2.1', '3.2.1'))
        self.assertTrue(inside('>= 2.0.0 && <= 2.1.3 ', '2.1.0'))
        self.assertTrue(inside('≤ 5.1.0 ', '5.1.0'))
        self.assertTrue(inside('4.0.0 - 5.0.1', '4.5.0'))
        self.assertFalse(inside('4.0.0 - 5.0.1', '5.0.2'))
        self.assertTrue(inside('> 4.1.0', '6.0.0'))
        # one bound per branch, and plain lists
        self.assertTrue(inside('<= v2.11.42, <= v3.6.13, <= v3.7.0-rc.1', '3.6.12'))
        self.assertTrue(inside('2.0.0-beta.0, 2.0.0-beta.1', '2.0.0-beta.1'))
        self.assertFalse(inside('2.0.0-beta.0, 2.0.0-beta.1', '2.0.0-beta.2'))
        self.assertTrue(inside('v4.0.0-beta.420.6', '4.0.0-beta.420.6'))
        self.assertTrue(inside('*', '9.9.9'))
        # no versions at all
        self.assertIsNone(uw.parse_range('latest'))
        self.assertIsNone(uw.parse_range(''))
        self.assertIsNone(uw.parse_range('every version before the fix'))

    def test_patched_release_on_its_branch_is_not_covered(self):
        traefik = BY_KEY['traefik']
        per_branch = {'vulnerabilities': [{'package': {'ecosystem': 'go', 'name': 'Traefik'},
                                           'vulnerable_version_range': '<= v2.11.42, <= v3.6.13, <= v3.7.0-rc.1',
                                           'patched_versions': 'v2.11.43, v3.6.14, v3.7.0-rc.2'}]}
        self.assertTrue(uw.covers(uw.Version('3.6.12'), per_branch, traefik))
        # 3.6.20 is under the 3.7.0-rc.1 bound, but it is past its own branch's fix
        self.assertFalse(uw.covers(uw.Version('3.6.20'), per_branch, traefik))
        self.assertEqual(uw.fixed_in(uw.Version('3.6.12'), per_branch, traefik), '3.6.14')
        open_ended = {'vulnerabilities': [{'package': {'ecosystem': 'go', 'name': 'knadh/listmonk'},
                                           'vulnerable_version_range': '>= v4.1.0', 'patched_versions': 'v6.1.0'}]}
        self.assertTrue(uw.covers(uw.Version('6.0.0'), open_ended, BY_KEY['listmonk']))
        self.assertFalse(uw.covers(uw.Version('6.2.0'), open_ended, BY_KEY['listmonk']))

    def test_entries_about_other_packages_are_ignored(self):
        go = {'vulnerabilities': [{'package': {'ecosystem': 'go', 'name': 'The Go Programming Language'},
                                   'vulnerable_version_range': '< 9.0.0', 'patched_versions': '9.0.0'}]}
        self.assertFalse(uw.covers(uw.Version('3.6.12'), go, BY_KEY['traefik']))
        cloud = {'vulnerabilities': [{'package': {'ecosystem': 'clickhouse cloud', 'name': 'ClickHouse Cloud'},
                                      'vulnerable_version_range': '< v99.1', 'patched_versions': 'v99.2'}]}
        self.assertFalse(uw.covers(uw.Version('24.12.6.70'), cloud, BY_KEY['clickhouse']))
        dockge = {'vulnerabilities': [{'package': {'ecosystem': 'docker', 'name': 'louislam/dockge'},
                                       'vulnerable_version_range': '<= 9.3.2', 'patched_versions': '9.3.3'}]}
        self.assertFalse(uw.covers(uw.Version('2.2.1'), dockge, BY_KEY['uptime-kuma']))

    def test_latest_range_decided_by_release_date(self):
        advisory = {'published_at': '2025-09-09T18:07:48Z', 'vulnerabilities': [
            {'package': {'ecosystem': 'go', 'name': ''}, 'vulnerable_version_range': 'latest', 'patched_versions': ''}]}
        listmonk = BY_KEY['listmonk']
        self.assertIsNone(uw.covers(uw.Version('5.0.0'), advisory, listmonk))
        self.assertTrue(uw.covers(uw.Version('5.0.0'), advisory, listmonk, '2025-05-01T00:00:00Z'))
        self.assertFalse(uw.covers(uw.Version('6.0.0'), advisory, listmonk, '2026-01-02T17:51:28Z'))


class Feeds2026(unittest.TestCase):
    """The audit's versions against GitHub's advisories as published on 2026-10-19."""

    def test_versions_found_on_2026_10_18_are_flagged(self):
        cases = {
            ('plausible', 'v3.0.1'): {'GHSA-mhcv-h7gf-57cf'},
            ('coolify', '4.0.0-beta.469'): {'GHSA-9pp4-wcmj-rq73', 'GHSA-w8wm-r924-f65v'},
            ('traefik', '3.6.12'): {'GHSA-w4v4-9rw7-5326', 'GHSA-v67p-phpq-fc8x', 'GHSA-f52w-8j3h-j724',
                                    'GHSA-ww7c-q3mv-xx22'},
            ('listmonk', 'v6.0.0'): {'GHSA-h5j9-cvrw-v5qh'},
            ('uptime-kuma', '2.2.1'): {'GHSA-wf2j-5mc7-5c4w'},
        }
        for (key, version), expected in cases.items():
            hits, unknown = flagged(key, version)
            self.assertLessEqual(expected, set(hits), (key, version, hits))
            self.assertEqual(unknown, [], (key, version))
        # The audit counted 29 Coolify advisories of every severity; 16 are high
        # or critical, among them the three criticals and the CSRF account takeover.
        coolify = set(flagged('coolify', '4.0.0-beta.469')[0])
        self.assertEqual(len(coolify), 16)
        self.assertLessEqual({'GHSA-652w-qv22-2r7c', 'GHSA-mw6q-2hmg-mhxv', 'GHSA-725v-f5gh-22q9',
                              'GHSA-389w-cc6x-wr2m', 'GHSA-46hp-7m8g-7622', 'GHSA-rh5x-qx77-fq9v'}, coolify)

    def test_versions_after_the_upgrades_flag_nothing(self):
        for key, version in (('plausible', 'v3.2.1'), ('coolify', '4.4.6'), ('traefik', 'v3.7.15'),
                             ('listmonk', 'v6.2.0'), ('uptime-kuma', '2.5.6'), ('clickhouse', '24.12.6.70-alpine')):
            self.assertEqual(flagged(key, version), ([], []), (key, version))

    def test_fixed_versions(self):
        feeds = uw.Feeds(FEEDS, get=offline)
        def fixed(key, version, ghsa):
            service = BY_KEY[key]
            advisory = next(a for a in feeds.json(uw.advisories_url(service['github'])) if a['ghsa_id'] == ghsa)
            return uw.fixed_in(uw.Version(version), advisory, service)
        self.assertEqual(fixed('plausible', '3.0.1', 'GHSA-mhcv-h7gf-57cf'), '3.2.1')
        self.assertEqual(fixed('traefik', '3.6.12', 'GHSA-w4v4-9rw7-5326'), '3.7.13')
        self.assertEqual(fixed('uptime-kuma', '2.2.1', 'GHSA-wf2j-5mc7-5c4w'), '2.5.4')
        self.assertEqual(fixed('coolify', '4.0.0-beta.469', 'GHSA-9pp4-wcmj-rq73'), '4.0.0-beta.470')


DEDICATED_CHAIN = {
    'iptables': '-N HATCHKIT-CF\n' + ''.join('-A HATCHKIT-CF -s %s -j ACCEPT\n' % c for c in (
        '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
        '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
        '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22')) + '-A HATCHKIT-CF -j DROP\n',
    'ip6tables': '-N HATCHKIT-CF\n' + ''.join('-A HATCHKIT-CF -s %s -j ACCEPT\n' % c for c in (
        '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32',
        '2a06:98c0::/29', '2c0f:f248::/32')) + '-A HATCHKIT-CF -j DROP\n',
}


def no_chain(binary):
    return None  # shared-vps: Hetzner's firewall filters 80/443, not iptables


def cloudflare_answer(etag, add=(), drop=()):
    answer = json.loads(json.dumps(FEEDS[uw.CLOUDFLARE_IPS]))
    answer['result']['etag'] = etag
    for cidr in add:
        answer['result']['ipv4_cidrs' if ':' not in cidr else 'ipv6_cidrs'].append(cidr)
    for cidr in drop:
        for family in ('ipv4_cidrs', 'ipv6_cidrs'):
            if cidr in answer['result'][family]:
                answer['result'][family].remove(cidr)
    return answer


class Cloudflare(unittest.TestCase):
    def check(self, answer=None, chain=DEDICATED_CHAIN.get, get=offline):
        feeds = dict(FEEDS)
        if answer is not None:
            feeds[uw.CLOUDFLARE_IPS] = answer
        return uw.cloudflare_check(uw.Feeds(feeds, get=get), CLOUDFLARE, chain)

    def test_pinned_snapshot_is_the_2026_10_19_answer(self):
        live = FEEDS[uw.CLOUDFLARE_IPS]['result']
        self.assertEqual(CLOUDFLARE['etag'], '38f79d050aa027e3be3865e495dcc9bc')
        self.assertEqual((CLOUDFLARE['ipv4'], CLOUDFLARE['ipv6']), (live['ipv4_cidrs'], live['ipv6_cidrs']))

    def test_unchanged_ranges_and_matching_chain_raise_nothing(self):
        state, findings = self.check()
        self.assertEqual(findings, [])
        self.assertEqual(state['etag'], CLOUDFLARE['etag'])
        self.assertEqual(state['chain'], {'name': 'HATCHKIT-CF', 'families': ['ipv4', 'ipv6'], 'missing': [],
                                          'extra': []})
        state, findings = self.check(chain=no_chain)
        self.assertEqual((findings, state['chain']), ([], None))

    def test_changed_etag_is_flagged_with_what_changed(self):
        answer = cloudflare_answer('5e1a8d1e0c3f4b2a9d7c6e5f4a3b2c1d', add=('198.51.100.0/22', '2001:db8::/32'),
                                   drop=('131.0.72.0/22',))
        state, findings = self.check(answer)
        ranges = next(f for f in findings if f['kind'] == 'cloudflare-ranges')
        self.assertEqual((ranges['etag'], ranges['pinnedEtag']),
                         ('5e1a8d1e0c3f4b2a9d7c6e5f4a3b2c1d', '38f79d050aa027e3be3865e495dcc9bc'))
        self.assertEqual(ranges['added'], ['198.51.100.0/22', '2001:db8::/32'])
        self.assertEqual(ranges['removed'], ['131.0.72.0/22'])
        self.assertIn('drops traffic from the new edges', ranges['summary'])
        # dedicated-vps still allows only the old list: the new edges are dropped there
        chain = next(f for f in findings if f['kind'] == 'cloudflare-chain')
        self.assertEqual(chain['missing'], ['198.51.100.0/22', '2001:db8::/32'])
        self.assertEqual(chain['extra'], ['131.0.72.0/22'])
        # shared-vps has no chain; the etag alone raises it there
        state, findings = self.check(answer, chain=no_chain)
        self.assertEqual([f['kind'] for f in findings], ['cloudflare-ranges'])

    def test_new_etag_with_the_same_ranges_still_raises(self):
        state, findings = self.check(cloudflare_answer('0' * 32))
        self.assertEqual([f['kind'] for f in findings], ['cloudflare-ranges'])
        self.assertIn('added none; removed none', findings[0]['summary'])

    def test_chain_that_drifted_on_its_own(self):
        rules = dict(DEDICATED_CHAIN)
        rules['iptables'] = rules['iptables'].replace('-A HATCHKIT-CF -s 104.24.0.0/14 -j ACCEPT\n', '')
        rules['iptables'] += '-A HATCHKIT-CF -s 203.0.113.0/24 -j ACCEPT\n'
        _, findings = self.check(chain=rules.get)
        self.assertEqual(len(findings), 1)
        self.assertEqual((findings[0]['missing'], findings[0]['extra']), (['104.24.0.0/14'], ['203.0.113.0/24']))

    def test_unreadable_answer_is_not_clean(self):
        def unreachable(url):
            raise uw.FeedError('could not read ' + url)
        feeds = {k: v for k, v in FEEDS.items() if k != uw.CLOUDFLARE_IPS}
        state, findings = uw.cloudflare_check(uw.Feeds(feeds, get=unreachable), CLOUDFLARE, DEDICATED_CHAIN.get)
        self.assertEqual(findings, [])
        self.assertIn('could not read https://api.cloudflare.com/client/v4/ips', state['error'])
        state, _ = self.check({'success': False, 'result': None})
        self.assertEqual(state['error'], 'unexpected answer from https://api.cloudflare.com/client/v4/ips')
        report = uw.scan(FakeDocker([]), SERVICES, uw.Feeds(feeds, get=unreachable), '/nonexistent', NOW,
                         CLOUDFLARE, DEDICATED_CHAIN.get)
        self.assertIn('Cloudflare IP ranges: could not read', report['skipped'][0])


class FakeDocker:
    """`docker ps/inspect/image inspect/exec` answers for a list of containers."""

    def __init__(self, containers, execs=None):
        self.containers = containers
        self.execs = execs or {}
        self.calls = []

    def __call__(self, args, timeout=60):
        self.calls.append(args)
        if args[0] == 'ps':
            return '\n'.join(c['id'] for c in self.containers) + '\n'
        if args[0] == 'inspect':
            ids = args[3:]
            return ''.join('%s\t%s\t%s\n' % (json.dumps('/' + c['name']), json.dumps(c['ref']), json.dumps(c['image']))
                           for c in self.containers if c['id'] in ids)
        if args[:2] == ['image', 'inspect']:
            seen, out = set(), ''
            for c in self.containers:
                if c['image'] in args[4:] and c['image'] not in seen:
                    seen.add(c['image'])
                    out += '%s\t%s\t%s\n' % (json.dumps(c['image']), json.dumps(c.get('config')),
                                             json.dumps(c.get('digests', [])))
            return out
        if args[0] == 'exec':
            answer = self.execs.get((args[1], args[2]))
            if answer is None:
                raise uw.WatchError('docker exec failed')
            return answer
        raise AssertionError(args)


def container(name, ref, labels=None, env=(), cid=None):
    cid = cid or name.encode().hex()[:12]
    return {'id': cid, 'name': name, 'ref': ref, 'image': 'sha256:' + (name.encode().hex() * 8)[:64],
            'config': {'Labels': labels, 'Env': ['PATH=/usr/bin', 'DATABASE_URL=' + SECRET, *env],
                       'Cmd': ['--password', SECRET]},
            'digests': [ref.split(':')[0] + '@sha256:' + '1' * 64]}


OLD_HOST = [
    container('coolify', 'docker.io/coollabsio/coolify:4.0.0-beta.469',
              labels={'org.opencontainers.image.version': 'v4.5.1-30387987399'}),
    container('coolify-proxy', 'traefik:v3.6', labels={'org.opencontainers.image.version': 'v3.6.12'}),
    container('plausible-c8378br07og1w4ta45uxh57l', 'ghcr.io/plausible/community-edition:v3.0.1',
              labels={'org.opencontainers.image.version': 'v3.0.1'}),
    container('plausible-events-db-c8378', 'clickhouse/clickhouse-server:24.12-alpine',
              labels={'com.clickhouse.build.version': '24.12.6.70-alpine'}),
    container('listmonk-x', 'listmonk/listmonk:v6.0.0', labels={'org.opencontainers.image.version': '6.0.0'}),
    container('uptime-kuma-y', 'louislam/uptime-kuma:2', labels={'org.opencontainers.image.source': 'x'}),
    container('web-g', 'glitchtip/glitchtip:v6', labels=None, env=('GLITCHTIP_VERSION=6.2.6',)),
    container('worker-g', 'glitchtip/glitchtip:v6', labels=None, env=('GLITCHTIP_VERSION=6.2.6',)),
    container('app-1234', '81bd698b4594'),
    container('postgres-1', 'postgres:16-alpine'),
]
OLD_EXECS = {('uptime-kuma-y', 'node'): '2.2.1\n'}

NEW_HOST = [
    container('coolify', 'docker.io/coollabsio/coolify:4.4.6'),
    container('coolify-proxy', 'traefik:v3.7.15', labels={'org.opencontainers.image.version': 'v3.7.15'}),
    container('plausible-q', 'ghcr.io/plausible/community-edition:v3.2.1',
              labels={'org.opencontainers.image.version': 'v3.2.1'}),
    container('plausible-events-db-q', 'clickhouse/clickhouse-server:24.12-alpine',
              labels={'com.clickhouse.build.version': '24.12.6.70-alpine'}),
    container('listmonk-x', 'listmonk/listmonk:v6.2.0', labels={'org.opencontainers.image.version': '6.2.0'}),
    container('uptime-kuma-y', 'louislam/uptime-kuma:2.5.6'),
    container('web-g', 'glitchtip/glitchtip:6.2.6', labels=None),
]


def failed_log(day, error='Error response from daemon: toomanyrequests: retry-after: 1.03ms'):
    return ('Coolify Upgrade Log\nStarted: 2026-10-%02d 00:00:12\nTarget Version: 4.4.6\nHelper Version: 1.0.12\n'
            'Registry URL: ghcr.io\n[2026-10-%02d 00:00:13] Merging .env.production values into .env\n'
            'APP_KEY=%s\n%s\n[2026-10-%02d 00:00:18] ERROR: Failed to pull ghcr.io/coollabsio/coolify:4.4.6\n'
            % (day, day, SECRET, error, day))


OK_LOG = ('Coolify Upgrade Log\nStarted: 2026-10-18 22:22:50\nTarget Version: 4.4.6\nRegistry URL: docker.io\n'
          '[2026-10-18 22:23:36] Coolify upgrade completed successfully\n')


class Scan(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.source = Path(self.tmp.name) / 'source'
        self.source.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def scan(self, host, execs=None, feeds=None, source=None):
        return uw.scan(FakeDocker(host, execs), SERVICES, uw.Feeds(FEEDS if feeds is None else feeds, get=offline),
                       str(source or self.source), NOW)

    def test_old_host_is_flagged_per_service(self):
        for day in range(9, 19):
            (self.source / ('upgrade-2026-10-%02d-00-00-12.log' % day)).write_text(failed_log(day))
        report = self.scan(OLD_HOST, OLD_EXECS)
        text = json.dumps(report)
        self.assertNotIn(SECRET, text)
        services = {s['service']: s for s in report['services']}
        self.assertEqual(set(services), {'coolify', 'traefik', 'plausible', 'clickhouse', 'listmonk',
                                         'uptime-kuma', 'glitchtip'})
        # the Coolify image's own label is its PHP base image's; the tag is Coolify's
        self.assertEqual(services['coolify']['version'], '4.0.0-beta.469')
        self.assertEqual(services['coolify']['versionSource'], 'tag')
        self.assertEqual((services['traefik']['version'], services['traefik']['floatingTag']), ('3.6.12', 'v3.6'))
        self.assertEqual((services['uptime-kuma']['version'], services['uptime-kuma']['floatingTag']), ('2.2.1', '2'))
        self.assertTrue(services['uptime-kuma']['versionSource'].startswith('binary'))
        self.assertEqual(services['glitchtip']['containers'], ['web-g', 'worker-g'])
        self.assertEqual(services['glitchtip']['versionSource'], 'image env GLITCHTIP_VERSION')
        self.assertIsNone(services['glitchtip']['advisorySource'])
        ids = {(f['service'], f.get('id')) for f in report['findings']}
        for expected in (('plausible', 'GHSA-mhcv-h7gf-57cf'), ('coolify', 'GHSA-9pp4-wcmj-rq73'),
                         ('coolify', 'GHSA-w8wm-r924-f65v'), ('traefik', 'GHSA-w4v4-9rw7-5326'),
                         ('listmonk', 'GHSA-h5j9-cvrw-v5qh'), ('uptime-kuma', 'GHSA-wf2j-5mc7-5c4w')):
            self.assertIn(expected, ids)
        self.assertFalse(any(f['service'] in ('clickhouse', 'glitchtip') for f in report['findings']))
        plausible = next(f for f in report['findings'] if f.get('id') == 'GHSA-mhcv-h7gf-57cf')
        self.assertEqual((plausible['severity'], plausible['fixed'], plausible['latest']), ('critical', '3.2.1', '3.2.1'))
        self.assertIn('plausible-c8378br07og1w4ta45uxh57l', plausible['summary'])
        # the failing auto-update comes first, with its streak
        auto = report['findings'][0]
        self.assertEqual(auto['kind'], 'auto-update')
        self.assertIn('10 run(s) in a row since 2026-10-09 00:00:12', auto['summary'])
        self.assertIn('toomanyrequests', auto['summary'])
        self.assertEqual(report['skipped'], [])

    def test_new_host_flags_nothing(self):
        (self.source / 'upgrade-2026-10-18-00-00-12.log').write_text(failed_log(18))
        (self.source / 'upgrade-2026-10-18-22-22-50.log').write_text(OK_LOG)
        report = self.scan(NEW_HOST)
        self.assertEqual(report['findings'], [])
        self.assertEqual(report['skipped'], [])
        self.assertTrue(report['autoUpdate']['ok'])
        self.assertEqual(report['autoUpdate']['failedRuns'], 0)
        latest = {s['service']: s['latest']['version'] for s in report['services']}
        self.assertEqual(latest['glitchtip'], '6.2.6')
        self.assertEqual(latest['clickhouse'], '26.7.34.3-stable')
        self.assertEqual(report['notes'], ['GlitchTip publishes no advisory feed; it is compared with its latest release only.'])

    def test_host_without_coolify_source(self):
        report = self.scan(NEW_HOST[1:], source=Path(self.tmp.name) / 'missing')
        self.assertIsNone(report['autoUpdate'])

    def test_unresolved_version_and_feed_errors_are_not_clean(self):
        host = [container('uptime-kuma-y', 'louislam/uptime-kuma:2')]
        report = self.scan(host, execs={})
        self.assertEqual(report['services'], [])
        self.assertIn('does not name a release', report['skipped'][0])

        def limited(url):
            raise uw.FeedError('GitHub API rate limit reached for this address; it resets at 07:00 UTC')
        report = uw.scan(FakeDocker(NEW_HOST[1:2]), SERVICES, uw.Feeds({}, get=limited), str(self.source), NOW)
        self.assertEqual(report['findings'], [])
        self.assertIn('Traefik: GitHub API rate limit reached', report['skipped'][0])

    def test_running_upgrade_is_not_a_failure(self):
        log = self.source / 'upgrade-2026-10-19-05-59-00.log'
        log.write_text('Coolify Upgrade Log\nStarted: 2026-10-19 05:59:00\nTarget Version: 4.4.7\n')
        os.utime(log, (NOW.timestamp() - 60, NOW.timestamp() - 60))
        state = uw.coolify_auto_update(str(self.source), NOW)
        self.assertTrue(state['ok'] and state['running'])
        os.utime(log, (NOW.timestamp() - 7200, NOW.timestamp() - 7200))
        state = uw.coolify_auto_update(str(self.source), NOW)
        self.assertFalse(state['ok'])
        self.assertEqual(state['error'], 'the log ends before the upgrade completed')

    def test_attacker_chosen_strings_are_escaped(self):
        advisory_feeds = dict(FEEDS)
        url = uw.advisories_url('plausible/analytics')
        advisory_feeds[url] = [dict(a, summary='RCE\x1b[2J\x07') for a in FEEDS[url]]
        report = self.scan([OLD_HOST[2]], feeds=advisory_feeds)
        self.assertNotIn('\x1b', json.dumps(report, ensure_ascii=False))
        self.assertIn('RCE\\x1b[2J\\x07', report['findings'][0]['summary'])


class HttpFeeds(unittest.TestCase):
    def test_pages_follow_link_next(self):
        pages = {
            'https://x/a?per_page=100': ([{'n': 1}], '<https://x/a?page=2>; rel="next", <https://x/a?page=2>; rel="last"'),
            'https://x/a?page=2': ([{'n': 2}], '<https://x/a?per_page=100>; rel="first"'),
        }
        feeds = uw.Feeds({}, get=lambda url: pages[url])
        self.assertEqual(feeds.json('https://x/a?per_page=100', pages=True), [{'n': 1}, {'n': 2}])

    def test_rate_limit_message(self):
        import urllib.error
        from email.message import Message
        headers = Message()
        headers['X-RateLimit-Remaining'] = '0'
        headers['X-RateLimit-Reset'] = str(int(NOW.timestamp()) + 3600)
        error = urllib.error.HTTPError('https://api.github.com/x', 403, 'rate limited', headers, None)
        with patch('urllib.request.urlopen', side_effect=error):
            with self.assertRaises(uw.FeedError) as caught:
                uw.http_get('https://api.github.com/repos/a/b/security-advisories?per_page=100')
        self.assertIn('rate limit', str(caught.exception))
        self.assertIn('07:00 UTC', str(caught.exception))


class Check(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.work = Path(self.tmp.name)
        self.source = self.work / 'source'
        self.source.mkdir()
        smtp = self.work / 'smtp.json'
        smtp.write_text('{}')
        smtp.chmod(0o600)
        self.config = {'alerts': {'enabled': True, 'to': 'ops@example.com', 'from': 'backup@example.com',
                                  'smtpFile': str(smtp)}}
        self.sent = []

    def tearDown(self):
        self.tmp.cleanup()

    def send(self, settings, subject, body):
        self.sent.append((settings, subject, body))
        return '<id-%d@example.com>' % len(self.sent)

    def run_check(self, host, execs=None, feeds=FEEDS, get=offline):
        return uw.check(FakeDocker(host, execs), SERVICES, uw.Feeds(feeds, get=get), self.work, self.config,
                        self.send, NOW, str(self.source))

    def test_cloudflare_change_is_mailed(self):
        feeds = dict(FEEDS)
        feeds[uw.CLOUDFLARE_IPS] = cloudflare_answer('1' * 32, add=('198.51.100.0/22',))
        state, _ = uw.check(FakeDocker(NEW_HOST), SERVICES, uw.Feeds(feeds, get=offline), self.work, self.config,
                            self.send, NOW, str(self.source), CLOUDFLARE, DEDICATED_CHAIN.get)
        self.assertEqual(state['mailed'], 'findings')
        body = self.sent[-1][2]
        self.assertIn('Cloudflare changed its IP ranges (etag ' + '1' * 32, body)
        self.assertIn('Chain HATCHKIT-CF on this host does not match', body)
        state, _ = uw.check(FakeDocker(NEW_HOST), SERVICES, uw.Feeds(FEEDS, get=offline), self.work, self.config,
                            self.send, NOW, str(self.source), CLOUDFLARE, DEDICATED_CHAIN.get)
        self.assertEqual(state['mailed'], 'recovery')

    def test_findings_mail_every_run_then_recovery_once(self):
        state, error = self.run_check(OLD_HOST, OLD_EXECS)
        self.assertIsNone(error)
        self.assertEqual(state['mailed'], 'findings')
        settings, subject, body = self.sent[-1]
        self.assertIn('Update watch:', subject)
        self.assertEqual(settings['from'], 'Hatchkit Update Watch <backup@example.com>')
        self.assertIn('GHSA-mhcv-h7gf-57cf critical, fixed in 3.2.1', body)
        self.assertNotIn(SECRET, body)
        stored = json.loads((self.work / uw.STATUS_NAME).read_text())
        self.assertFalse(stored['ok'])
        self.run_check(OLD_HOST, OLD_EXECS)
        self.assertEqual(len(self.sent), 2)
        state, _ = self.run_check(NEW_HOST)
        self.assertEqual(state['mailed'], 'recovery')
        self.assertTrue(state['ok'])
        state, _ = self.run_check(NEW_HOST)
        self.assertIsNone(state['mailed'])
        self.assertEqual(len(self.sent), 3)

    def test_incomplete_run_mails_what_it_could_not_check(self):
        def unreachable(url):
            raise uw.FeedError('could not read ' + url.split('?')[0])
        state, _ = self.run_check(NEW_HOST[1:2], feeds={}, get=unreachable)
        self.assertFalse(state['ok'])
        self.assertEqual(state['mailed'], 'incomplete')
        subject, body = self.sent[-1][1:]
        self.assertIn('could not check everything', subject)
        self.assertIn('Not checked this run:', body)
        self.assertIn('Traefik: could not read https://api.github.com/repos/traefik/traefik/', body)

    def test_failed_scan_mails_the_safe_reason_only(self):
        def broken(args, timeout=60):
            raise RuntimeError('docker said ' + SECRET)
        state, _ = uw.check(broken, SERVICES, uw.Feeds(FEEDS, get=offline), self.work, self.config, self.send, NOW,
                            str(self.source))
        self.assertEqual(state['error'], 'RuntimeError')
        self.assertNotIn(SECRET, self.sent[-1][2])

    def test_mail_failure_is_recorded_without_its_message(self):
        def refuse(settings, subject, body):
            raise OSError('535 auth failed for ' + SECRET)
        state, error = uw.check(FakeDocker(OLD_HOST, OLD_EXECS), SERVICES, uw.Feeds(FEEDS, get=offline), self.work,
                                self.config, refuse, NOW, str(self.source))
        self.assertEqual(state['mailError'], 'OSError')
        self.assertIsNotNone(error)

    def test_unconfigured_mail_is_a_safe_error(self):
        self.config = {}
        state, error = self.run_check(OLD_HOST, OLD_EXECS)
        self.assertIn('backup alert mail is not configured', state['mailError'])
        self.assertIsNotNone(error)


class RuntimeSecurityTests(unittest.TestCase):
    def test_node_release_floor_covers_eol_and_prereleases(self):
        for value in ['18.20.8','20.20.2','22.23.3','24.22.0','26.12.0','24.22.1-rc.1','invalid']:
            self.assertTrue(uw.vulnerable_node(value),value)
        for value in ['22.23.4','24.22.1','26.12.1','24.23.0']:
            self.assertFalse(uw.vulnerable_node(value),value)

    def test_custom_image_keeps_original_advisory_identity(self):
        fake=FakeDocker([container('kuma','hatchkit-security/kuma:20261023')])
        def docker(args,**kwargs):
            result=fake(args,**kwargs)
            return result.rstrip()+'\t'+json.dumps('louislam/uptime-kuma:2.5.6')+'\n' if args[0]=='inspect' else result
        found,_=uw.list_services(docker,SERVICES)
        self.assertEqual(found[0]['tag'],'2.5.6')
        self.assertEqual(found[0]['service']['key'],'uptime-kuma')

    def test_bundled_store_is_checked_even_when_system_store_passes(self):
        def docker(args,**kwargs):
            if args[0]=='ps':return 'id'
            if args[0]=='inspect':return '/app'
            if args[0]=='exec' and args[2]=='node':return '24.22.1'
            if args[0]=='exec' and args[2]=='sh':return '/app/lib/castore-1.0.16/priv/cacerts.pem'
            if args[0]=='exec' and args[2]=='cat':return 'old' if '/app/lib/'in args[3] else 'new'
            raise uw.WatchError('absent')
        with patch.object(uw,'distrusted_roots',side_effect=lambda pem:['emSign ECC Root CA - G3'] if pem=='old' else []):
            findings,skipped=uw.runtime_trust(docker)
        self.assertEqual(skipped,[])
        self.assertEqual(len(findings),1)
        self.assertIn('castore',findings[0]['summary'])

    def test_malformed_trust_data_is_incomplete_not_clean(self):
        def docker(args,**kwargs):
            if args[0]=='ps':return 'id'
            if args[0]=='inspect':return '/app'
            if args[0]=='exec' and args[2]=='cat':return 'not a certificate'
            raise uw.WatchError('absent')
        findings,skipped=uw.runtime_trust(docker)
        self.assertFalse(findings)
        self.assertEqual(len(skipped),1)


if __name__ == '__main__':
    unittest.main()
