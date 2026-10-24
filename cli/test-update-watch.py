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
printed on app-vps that day.
"""
import datetime as dt
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace as NS
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
    return None  # ops-vps: Hetzner's firewall filters 80/443, not iptables


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
        # app-vps still allows only the old list: the new edges are dropped there
        chain = next(f for f in findings if f['kind'] == 'cloudflare-chain')
        self.assertEqual(chain['missing'], ['198.51.100.0/22', '2001:db8::/32'])
        self.assertEqual(chain['extra'], ['131.0.72.0/22'])
        # ops-vps has no chain; the etag alone raises it there
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
        self.assertIsNone(state['mailed'])

    def test_changed_findings_mail_and_green_runs_stay_silent(self):
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
        self.assertEqual(len(self.sent), 1)
        state, _ = self.run_check(NEW_HOST)
        self.assertIsNone(state['mailed'])
        self.assertTrue(state['ok'])
        state, _ = self.run_check(NEW_HOST)
        self.assertIsNone(state['mailed'])
        self.assertEqual(len(self.sent), 1)

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

    def test_recurrence_and_mail_failure_retry(self):
        self.run_check(OLD_HOST, OLD_EXECS)
        self.run_check(NEW_HOST)
        self.run_check(OLD_HOST, OLD_EXECS)
        self.assertEqual(len(self.sent), 2)
        self.run_check(NEW_HOST)
        def refuse(*args):
            raise OSError('private SMTP details')
        uw.check(FakeDocker(OLD_HOST, OLD_EXECS), SERVICES, uw.Feeds(FEEDS, get=offline), self.work,
                 self.config, refuse, NOW, str(self.source))
        self.run_check(OLD_HOST, OLD_EXECS)
        self.assertEqual(len(self.sent), 3)

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

    def test_overdue_finding_alerts_once_after_its_deadline(self):
        def report():
            return {'services': [], 'findings': [{'kind': 'advisory', 'service': 'host-docker',
                    'id': 'GHSA-test', 'severity': 'critical', 'summary': 'A real test finding'}], 'skipped': []}
        def check(when):
            with patch.object(uw, 'scan', side_effect=lambda *a, **kw: report()):
                return uw.check(None, [], None, self.work, self.config, self.send, when)[0]
        self.assertFalse(check(NOW)['findings'][0]['overdue'])
        check(NOW + dt.timedelta(hours=1))
        self.assertEqual(len(self.sent), 1)
        self.assertTrue(check(NOW + dt.timedelta(hours=24))['findings'][0]['overdue'])
        self.assertEqual(len(self.sent), 2)
        check(NOW + dt.timedelta(hours=25))
        self.assertEqual(len(self.sent), 2)

    def test_large_ledger_and_image_rebuild_preserve_all_deadlines(self):
        rows = [{'kind':'image-package','service':'sha256:old','id':'CVE-'+str(n),
                 'name':'pkg','version':'1.0','containers':['app-20261023T010000'],
                 'severity':'critical','summary':'fixed available'} for n in range(250)]
        def check(when):
            with patch.object(uw,'scan',side_effect=lambda *a,**kw:{'services':[], 'findings':[dict(r)for r in rows], 'skipped':[]}):
                return uw.check(None,[],None,self.work,self.config,self.send,when)[0]
        first=check(NOW)
        self.assertEqual(len(first['findings']),250)
        self.assertEqual(len(first['findingFirstSeen']),250)
        self.assertIn('250 distinct scanner advisories',self.sent[-1][2])
        self.assertIn('Full finding ledger:',self.sent[-1][2])
        for r in rows:
            r['service']='sha256:new';r['containers']=['app-20261024T010000']
        rebuilt=check(NOW+dt.timedelta(hours=24))
        self.assertTrue(all(r['overdue']for r in rebuilt['findings']))
        self.assertEqual(first['findingFirstSeen'],rebuilt['findingFirstSeen'])
        sent=len(self.sent);check(NOW+dt.timedelta(hours=25));self.assertEqual(len(self.sent),sent)
        check(NOW+dt.timedelta(hours=48));self.assertEqual(len(self.sent),sent)
        check(NOW+dt.timedelta(days=7));self.assertEqual(len(self.sent),sent+1)

    def test_weekly_unreviewed_digest_stays_quiet_on_daily_overdue_and_new_matches(self):
        rows=[{'kind':'image-package','service':'image','id':'CVE-2026-test','name':'zlib','version':'1',
               'fixed':'2','severity':'critical','containers':['opaque-id'],
               'containerDisplayNames':['example-site'],'summary':'scanner match'}]
        def check(when,skipped=()):
            with patch.object(uw,'scan',side_effect=lambda *a,**k:{'services':[],'findings':[dict(r) for r in rows],'skipped':list(skipped)}):
                return uw.check(None,[],None,self.work,self.config,self.send,when)[0]
        first=check(NOW)
        self.assertEqual(first['mailed'],'weekly-review')
        self.assertIn('Weekly package review',self.sent[-1][1])
        self.assertIn('example-site: zlib 1 → 2',self.sent[-1][2])
        self.assertNotIn('opaque-id',self.sent[-1][2]);self.assertNotIn('OVERDUE',self.sent[-1][2])
        rows.append({**rows[0],'id':'CVE-2026-another'})
        later=check(NOW+dt.timedelta(days=1))
        self.assertTrue(later['findings'][0]['overdue']);self.assertEqual(len(self.sent),1)
        check(NOW+dt.timedelta(days=6));self.assertEqual(len(self.sent),1)
        check(NOW+dt.timedelta(days=7));self.assertEqual(len(self.sent),2)
        check(NOW+dt.timedelta(days=7,hours=4));self.assertEqual(len(self.sent),2)
        rows.clear();check(NOW+dt.timedelta(days=14));self.assertEqual(len(self.sent),2)

    def test_exploitation_and_lost_coverage_bypass_weekly_gate_without_repeating_raw_inventory(self):
        row={'kind':'image-package','service':'image','id':'CVE-2026-test','name':'pkg','version':'1',
             'severity':'critical','containers':['app'],'summary':'scanner match'}
        def check(when,skipped=()):
            with patch.object(uw,'scan',side_effect=lambda *a,**k:{'services':[],'findings':[dict(row)],'skipped':list(skipped)}):
                return uw.check(None,[],None,self.work,self.config,self.send,when)[0]
        check(NOW)
        check(NOW+dt.timedelta(hours=1),['Image scan failed'])
        self.assertEqual(len(self.sent),2);self.assertIn('could not check everything',self.sent[-1][1])
        self.assertNotIn('scanner match',self.sent[-1][2])
        row['knownExploited']=True
        urgent=check(NOW+dt.timedelta(hours=2))
        self.assertEqual(urgent['mailed'],'findings');self.assertEqual(len(self.sent),3)
        self.assertIn('KNOWN EXPLOITED',self.sent[-1][2])
        check(NOW+dt.timedelta(hours=3));self.assertEqual(len(self.sent),3)

    def test_failed_weekly_delivery_retries_without_advancing_week(self):
        row={'kind':'image-package','service':'image','id':'CVE-test','name':'pkg','version':'1','severity':'high','summary':'test'}
        with patch.object(uw,'scan',side_effect=lambda *a,**k:{'services':[],'findings':[dict(row)],'skipped':[]}):
            failed,error=uw.check(None,[],None,self.work,self.config,lambda *a:(_ for _ in ()).throw(OSError(SECRET)),NOW)
            self.assertIsNotNone(error);self.assertIsNone(failed['lastWeeklyReviewKey'])
            self.assertNotIn(SECRET,json.dumps(failed))
            sent,error=uw.check(None,[],None,self.work,self.config,self.send,NOW+dt.timedelta(hours=1))
            self.assertIsNone(error);self.assertEqual(sent['mailed'],'weekly-review')
            self.assertIsNotNone(sent['lastWeeklyReviewKey'])

    def test_old_acknowledged_daily_digest_migrates_without_an_extra_inventory_mail(self):
        row={'kind':'image-package','service':'image','id':'CVE-test','name':'pkg','version':'1','severity':'critical','summary':'test'}
        previous={'checkedAt':NOW.isoformat(),'findings':[row],'skipped':[],'error':None,
                  'notificationIdentityVersion':2,'lastNotifiedAt':NOW.isoformat(),
                  'notifiedFingerprint':uw.notification_fingerprint('findings',[row],None,[])}
        (self.work/uw.STATUS_NAME).write_text(json.dumps(previous))
        with patch.object(uw,'scan',return_value={'services':[],'findings':[dict(row)],'skipped':[]}):
            current,_=uw.check(None,[],None,self.work,self.config,self.send,NOW+dt.timedelta(hours=25))
        self.assertIsNone(current['mailed']);self.assertEqual(self.sent,[])
        self.assertEqual(current['lastWeeklyReviewKey'],uw.weekly_review_key(NOW))

    def test_week_boundary_uses_sydney_and_name_lookup_reads_only_a_display_label(self):
        before=dt.datetime(2026,10,25,21,59,tzinfo=dt.timezone.utc) # Monday 08:59 AEDT
        after=before+dt.timedelta(minutes=1)
        self.assertIsNone(uw.weekly_review_key(before));self.assertEqual(uw.weekly_review_key(after),'2026-W44')
        calls=[]
        def docker(argv):
            calls.append(argv)
            return 'id' if argv==['ps','-q'] else '"/opaque-id"\t"chess-server"\n"/other"\t"bad\\nlabel"'
        self.assertEqual(uw.workload_display_names(docker),{'opaque-id':'chess-server'})
        self.assertEqual(calls[1],['inspect','--format','{{json .Name}}\t{{json (index .Config.Labels "coolify.serviceName")}}','id'])

    def test_package_mail_groups_replicas_aliases_fixes_and_urgent_workloads(self):
        row={'kind':'image-package','service':'sha256:old','id':'GHSA-test',
             'aliases':['CVE-2026-1234'],'name':'pkg','version':'1','fixed':'1.1',
             'severity':'high','containers':['web','worker'],'summary':'package match'}
        rows=[dict(row),{**row,'id':'CVE-2026-1234','aliases':[]},
              {**row,'containers':['urgent'],'knownExploited':True,'overdue':True,'fixed':None}]
        body=uw.mail_body({'findings':rows,'skipped':[]},None)
        self.assertLess(body.index('- urgent:'),body.index('- web, worker:'))
        self.assertIn('web, worker: 1 distinct advisories; 1 package fixes reported',body)
        self.assertIn('KNOWN EXPLOITED; OVERDUE',body)
        self.assertIn('applicability and application reachability still need review',body)

    def test_subject_distinguishes_inventory_new_overdue_and_changed_findings(self):
        rows=[{'kind':'advisory','service':'host-docker','id':'GHSA-test','severity':'critical','summary':'test'}]
        def check(when):
            with patch.object(uw,'scan',side_effect=lambda *a,**kw:{'services':[],'findings':[dict(r)for r in rows],'skipped':[]}):
                return uw.check(None,[],None,self.work,self.config,self.send,when)[0]
        self.assertEqual(check(NOW)['notificationCategory'],'Initial inventory')
        self.assertEqual(check(NOW+dt.timedelta(hours=24))['notificationCategory'],'Overdue review')
        rows[0]['fixed']='1.1'
        self.assertEqual(check(NOW+dt.timedelta(hours=25))['notificationCategory'],'Advisory changes')
        rows.append({**rows[0],'id':'GHSA-another'})
        self.assertEqual(check(NOW+dt.timedelta(hours=26))['notificationCategory'],'New advisories')

    def test_rebuild_and_replica_changes_are_quiet_but_a_new_fix_is_actionable(self):
        rows=[{'kind':'image-package','service':'sha256:old','id':'CVE-2026-1234',
               'name':'pkg','version':'1','severity':'high','summary':'test','fixed':None,
               'containers':['app-old']}]
        def check(when):
            with patch.object(uw,'scan',side_effect=lambda *a,**kw:{'services':[], 'findings':[dict(r)for r in rows], 'skipped':[]}):
                return uw.check(None,[],None,self.work,self.config,self.send,when)[0]
        first=check(NOW)
        rows[0]['service']='sha256:new';rows[0]['containers']=['app-renamed','another-replica']
        rows.append(dict(rows[0]))
        check(NOW+dt.timedelta(hours=1));self.assertEqual(len(self.sent),1)
        for row in rows:row['fixed']='1.1'
        check(NOW+dt.timedelta(hours=2));self.assertEqual(len(self.sent),1)
        self.assertEqual(first['findings'][0]['dueAt'],check(NOW+dt.timedelta(hours=3))['findings'][0]['dueAt'])

    def test_unavailable_exploitation_feed_cannot_extend_existing_urgent_deadline(self):
        row={'kind':'image-package','service':'image','id':'CVE-2026-1234','name':'pkg',
             'version':'1','severity':'high','summary':'test','knownExploited':True}
        with patch.object(uw,'scan',return_value={'services':[],'findings':[dict(row)],'skipped':[]}):
            first,_=uw.check(None,[],None,self.work,self.config,self.send,NOW)
        row.pop('knownExploited')
        with patch.object(uw,'scan',return_value={'services':[],'findings':[dict(row)],'skipped':['CISA unavailable']}):
            next_run,_=uw.check(None,[],None,self.work,self.config,self.send,NOW+dt.timedelta(hours=1))
        self.assertTrue(next_run['findings'][0]['knownExploited'])
        self.assertEqual(first['findings'][0]['dueAt'],next_run['findings'][0]['dueAt'])

    def test_notification_identity_upgrade_does_not_resend_acknowledged_ledger(self):
        row={'kind':'image-package','service':'image','id':'CVE-2026-1234','name':'pkg',
             'version':'1','severity':'high','summary':'test'}
        with patch.object(uw,'scan',side_effect=lambda *a,**kw:{'services':[],'findings':[dict(row)],'skipped':[]}):
            first,_=uw.check(None,[],None,self.work,self.config,self.send,NOW)
            first.pop('notificationIdentityVersion')
            first['notifiedFingerprint']=__import__('hashlib').sha256(json.dumps(['findings',first['findings'],None,[]],sort_keys=True).encode()).hexdigest()
            (self.work/uw.STATUS_NAME).write_text(json.dumps(first))
            uw.check(None,[],None,self.work,self.config,self.send,NOW+dt.timedelta(hours=1))
        self.assertEqual(len(self.sent),1)

    def test_monitor_upgrade_migrates_legacy_deadline_without_resetting_it(self):
        old={'kind':'image-package','service':'sha256:old','id':'CVE-old','name':'pkg',
             'version':'1','containers':['old-name'],'severity':'critical','summary':'test',
             'dueAt':NOW.isoformat()}
        (self.work / uw.STATUS_NAME).write_text(json.dumps({'findings':[old],
            'findingFirstSeen':{'legacy-image-identity':(NOW-dt.timedelta(hours=24)).isoformat()}}))
        current={**old,'service':'sha256:rebuilt','containers':['new-name']}
        current.pop('dueAt')
        with patch.object(uw,'scan',return_value={'findings':[current],'services':[],'skipped':[]}):
            state,_=uw.check(None,[],None,self.work,self.config,self.send,NOW)
        self.assertTrue(state['findings'][0]['overdue'])
        self.assertEqual(dt.datetime.fromisoformat(state['findings'][0]['dueAt']),NOW)

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

    def test_nested_derived_origin_is_visible_as_lost_coverage(self):
        row=container('kuma','hatchkit-security/kuma:2')
        fake=FakeDocker([row])
        def docker(args,**kwargs):
            result=fake(args,**kwargs)
            return result.rstrip()+'\t'+json.dumps('hatchkit-security/kuma:1')+'\n' if args[0]=='inspect' else result
        skipped=[]
        found,_=uw.list_services(docker,SERVICES,skipped)
        self.assertEqual(found,[])
        self.assertIn('unresolved derived-image provenance',skipped[0])
        self.assertNotIn(SECRET,json.dumps(skipped))

    def test_baked_upstream_survives_container_recreation(self):
        row=container('kuma','hatchkit-security/kuma:2',labels={'io.hatchkit.security.original-image':'louislam/uptime-kuma:2.5.6'})
        skipped=[]
        found,_=uw.list_services(FakeDocker([row]),SERVICES,skipped)
        self.assertEqual(found[0]['service']['key'],'uptime-kuma')
        self.assertEqual(skipped,[])

    def test_resolved_database_origin_is_not_missing_vendor_coverage(self):
        row=container('postgres','hatchkit-security/postgres:20261023',labels={'io.hatchkit.security.original-image':'postgres:16-alpine'})
        skipped=[]
        found,_=uw.list_services(FakeDocker([row]),SERVICES,skipped)
        self.assertEqual(found,[])
        self.assertEqual(skipped,[])

    def test_conflicting_origins_fail_coverage_instead_of_choosing_one(self):
        row=container('kuma','hatchkit-security/kuma:2',labels={'io.hatchkit.security.original-image':'louislam/uptime-kuma:2.5.6'})
        fake=FakeDocker([row])
        def docker(args,**kwargs):
            result=fake(args,**kwargs)
            return result.rstrip()+'\t'+json.dumps('listmonk/listmonk:v6.2.0')+'\n' if args[0]=='inspect' else result
        skipped=[]
        found,_=uw.list_services(docker,SERVICES,skipped)
        self.assertEqual(found,[])
        self.assertIn('conflicting upstream provenance',skipped[0])

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


class HostRuntimeCoverage(unittest.TestCase):
    def test_versions_are_collected_by_fixed_commands_and_fail_closed(self):
        answers = {'docker': '29.9.2\n', 'containerd': 'containerd containerd v2.4.2 hash',
                   'runc': 'runc version 1.5.2\n', 'tailscale': '1.104.2\n'}
        rows, skipped = uw.host_runtime_versions(lambda argv: answers[argv[0]])
        self.assertEqual([str(v) for _, v in rows], ['29.9.2', '2.4.2', '1.5.2', '1.104.2'])
        self.assertEqual(skipped, [])
        rows, skipped = uw.host_runtime_versions(lambda argv: 'unreadable')
        self.assertEqual(rows, [])
        self.assertEqual(len(skipped), 4)

    def test_image_scan_staleness_and_errors_are_not_clean(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'images.json'
            findings, skipped = uw.image_package_findings(NOW, path)
            self.assertEqual(len(skipped), 1)
            path.write_text(json.dumps({'checkedAt': NOW.isoformat(), 'complete': True, 'findings': []}))
            self.assertEqual(uw.image_package_findings(NOW, path), ([], []))
            self.assertTrue(uw.image_package_findings(NOW + dt.timedelta(hours=37), path)[1])
            path.write_text(json.dumps({'checkedAt': NOW.isoformat(), 'complete': False,
                                       'errors': ['image unavailable'], 'findings': []}))
            self.assertTrue(uw.image_package_findings(NOW, path)[1])

    def test_normal_image_refresh_retains_findings_while_failure_or_stall_loses_coverage(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'images.json'
            rows=[{'id':'existing-risk'}]
            path.write_text(json.dumps({'checkedAt':NOW.isoformat(),'complete':True,'findings':rows}))
            progress=path.with_name('image-vulnerability-progress.json')
            fresh={'phase':'running','checkedAt':NOW.isoformat(),'startedAt':NOW.isoformat(),'errors':0}
            progress.write_text(json.dumps(fresh))
            self.assertEqual(uw.image_package_findings(NOW,path),(rows,[]))
            self.assertEqual(uw.image_package_findings(NOW+dt.timedelta(minutes=21),path)[0],rows)
            self.assertIn('stalled',uw.image_package_findings(NOW+dt.timedelta(minutes=21),path)[1][0])
            progress.write_text(json.dumps(fresh|{'phase':'failed'}))
            self.assertIn('failed',uw.image_package_findings(NOW,path)[1][0])
            self.assertEqual(uw.image_package_findings(NOW,path)[0],rows)

    def test_cisa_matches_aliases_and_missing_feed_fails_visible(self):
        rows=[{'kind':'image-package','service':'image','id':'GHSA-test','aliases':['CVE-2026-1234'],
               'name':'pkg','version':'1','severity':'high','summary':'test'}]
        with tempfile.TemporaryDirectory()as root, patch.object(uw,'image_package_findings',return_value=(rows,[])):
            feed=uw.Feeds({uw.KEV_URL:{'dateReleased':NOW.isoformat(),'count':1,'vulnerabilities':[{'cveID':'CVE-2026-1234'}]}},get=offline)
            result=uw.scan(FakeDocker([]),[],feed,source=root,image_packages=True,kev=True)
            self.assertTrue(result['findings'][0]['knownExploited'])
            feed=uw.Feeds({},get=lambda url: (_ for _ in ()).throw(uw.FeedError('feed unavailable')))
            result=uw.scan(FakeDocker([]),[],feed,source=root,kev=True)
            self.assertTrue(any('CISA' in s for s in result['skipped']))

    def test_cisa_official_mirror_preserves_coverage_when_primary_is_blocked(self):
        catalog={'dateReleased':NOW.isoformat(),'count':1,'vulnerabilities':[{'cveID':'CVE-2026-1234'}]}
        calls=[]
        def get(url):
            calls.append(url)
            if url==uw.KEV_URL:raise uw.FeedError('HTTP 403')
            return catalog,''
        identifiers,metadata=uw.known_exploited_catalog(uw.Feeds(get=get),NOW)
        self.assertEqual(identifiers,{'CVE-2026-1234'})
        self.assertEqual(calls,[uw.KEV_URL,uw.KEV_MIRROR_URL])
        self.assertEqual(metadata['source'],uw.KEV_MIRROR_URL)

    def test_invalid_stale_future_or_truncated_cisa_data_cannot_clear_coverage_gap(self):
        good={'dateReleased':NOW.isoformat(),'count':1,'vulnerabilities':[{'cveID':'CVE-2026-1234'}]}
        bad=[good|{'count':0},good|{'count':True},good|{'count':2},
             good|{'vulnerabilities':[{'cveID':'not-a-CVE'}]},
             good|{'dateReleased':(NOW-dt.timedelta(days=15)).isoformat()},
             good|{'dateReleased':(NOW+dt.timedelta(minutes=6)).isoformat()},
             good|{'dateReleased':'2026-10-19T00:00:00'},
             good|{'vulnerabilities':None},{}]
        for catalog in bad:
            with self.subTest(catalog=catalog),self.assertRaises(uw.FeedError):
                uw.known_exploited_catalog(uw.Feeds({uw.KEV_URL:catalog,uw.KEV_MIRROR_URL:catalog}),NOW)

    def test_host_docker_advisory_is_checked_even_without_app_services(self):
        spec = uw.HOST_RUNTIMES[0]
        feeds = uw.Feeds({uw.latest_url(spec['github']): {'tag_name': 'v29.9.2'},
                         uw.advisories_url(spec['github']): [{
                             'ghsa_id': 'GHSA-test', 'severity': 'high', 'summary': 'Host escape',
                             'vulnerabilities': [{'package': {'name': 'Docker Engine'},
                                                  'vulnerable_version_range': '< 29.5.1',
                                                  'patched_versions': '29.5.1'}]}]}, get=offline)
        with tempfile.TemporaryDirectory() as root, patch.object(uw, 'host_runtime_versions',
                return_value=([(spec, uw.Version('29.3.0'))], [])):
            report = uw.scan(FakeDocker([]), [], feeds, source=root, host_runtime=True)
        self.assertTrue(any(f.get('id') == 'GHSA-test' for f in report['findings']))
        self.assertTrue(any(f['kind'] == 'host-runtime' for f in report['findings']))
        self.assertEqual(report['services'][0]['versionSource'], 'host binary')


class HostPackageCoverage(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'host-package-refresh.json'
        self.path.write_text(json.dumps({'checkedAt':NOW.isoformat(),'ok':True,'error':None}))
        self.source = NS(dist='noble-security',is_trusted=True)

    def inspect(self, packages=(), **kwargs):
        return uw.host_package_findings(NOW,cache=packages,sources=[self.source],refresh_path=self.path,
            distro={'ID':'ubuntu','VERSION_CODENAME':'noble'},compare=lambda a,b:(int(a)>int(b))-(int(a)<int(b)),**kwargs)

    def package(self, installed='1',candidate='3',versions=None):
        origin=lambda archive,trusted=True: NS(origin='Ubuntu',archive=archive,trusted=trusted)
        return NS(fullname='zlib1g:amd64',is_installed=True,installed=NS(version=installed),
            candidate=NS(version=candidate),versions=versions or [
                NS(version='3',origins=[origin('noble-updates')]),
                NS(version='2',origins=[origin('noble-security')])])

    def test_security_version_hidden_by_newer_updates_candidate_is_still_reported(self):
        rows,skips=self.inspect([self.package()])
        self.assertEqual(skips,[])
        self.assertEqual(rows[0]['fixed'],'2')
        self.assertEqual(rows[0]['candidate'],'3')
        self.assertFalse(rows[0]['blockedByPolicy'])
        self.assertEqual(rows[0]['vendorSeverity'],'unclassified')

    def test_pinning_cannot_hide_an_available_security_fix(self):
        rows,_=self.inspect([self.package(candidate='1')])
        self.assertTrue(rows[0]['blockedByPolicy'])

    def test_patched_or_untrusted_versions_do_not_create_security_findings(self):
        self.assertEqual(self.inspect([self.package(installed='2')]),([],[]))
        p=self.package(versions=[NS(version='2',origins=[NS(origin='Ubuntu',archive='noble-security',trusted=False)])])
        self.assertEqual(self.inspect([p]),([],[]))

    def test_missing_failed_stale_and_future_refreshes_never_show_complete_coverage(self):
        self.path.unlink();self.assertTrue(self.inspect()[1])
        for proof in [{'checkedAt':NOW.isoformat(),'ok':False},
                      {'checkedAt':(NOW-dt.timedelta(hours=9)).isoformat(),'ok':True},
                      {'checkedAt':(NOW+dt.timedelta(minutes=6)).isoformat(),'ok':True},
                      {'checkedAt':NOW.replace(tzinfo=None).isoformat(),'ok':True}]:
            self.path.write_text(json.dumps(proof));self.assertTrue(self.inspect()[1])

    def test_disabled_or_untrusted_security_source_is_a_coverage_gap(self):
        self.source.is_trusted=False
        self.assertTrue(self.inspect()[1])
        self.source.is_trusted=True;self.source.dist='noble-updates'
        self.assertTrue(self.inspect()[1])

    def test_refresh_only_updates_indexes_and_never_leaks_error_output(self):
        calls=[]
        def run(argv,**kwargs):
            calls.append(argv)
            self.assertEqual(kwargs['timeout'],300)
            return NS(returncode=100,stderr=SECRET)
        state=uw.refresh_host_package_indexes(Path(self.temp.name),run=run,now=NOW)
        self.assertFalse(state['ok']);self.assertNotIn(SECRET,json.dumps(state))
        self.assertEqual(calls[0][-1],'update')
        self.assertIn('APT::Update::Error-Mode=any',calls[0])
        self.assertNotIn('install',calls[0])
        self.assertFalse(uw.refresh_host_package_indexes(Path(self.temp.name),
            run=lambda *a,**k:(_ for _ in ()).throw(uw.subprocess.TimeoutExpired('apt-get',300)),now=NOW)['ok'])
        self.assertTrue(uw.refresh_host_package_indexes(Path(self.temp.name),run=lambda *a,**k:NS(returncode=0),now=NOW)['ok'])


if __name__ == '__main__':
    unittest.main()
