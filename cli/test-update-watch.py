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
import io
import os
from pathlib import Path
import sys
import tempfile
import tarfile
from types import SimpleNamespace as NS
import unittest
from unittest.mock import patch

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE / 'src/templates/update-watch'))
sys.path.insert(0, str(HERE / 'src/templates/backups'))
from hatchkit_mail import text_of
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


class FailureRouting(unittest.TestCase):
    def test_failure_handlers_name_the_actual_producer_without_claiming_zero_checks(self):
        for unit, expected in [(uw.SERVICE, 'update watch did not finish'),
                               ('hatchkit-image-vulnerabilities.service', 'final image scan did not finish')]:
            with self.subTest(unit=unit), tempfile.TemporaryDirectory() as directory:
                sent = []
                config = {'alerts': {'enabled': True, 'to': 'fixture@example.test',
                                     'from': 'fixture@example.test', 'smtpFile': 'fixture-only'}}
                def send(settings, subject, body):
                    sent.append((subject, body))
                    return 'fixture-message'
                with patch.object(uw, 'work_dir', return_value=(Path(directory), config)), \
                     patch.object(uw.socket, 'gethostname', return_value='fixture-host'), \
                     patch.object(sys, 'argv', ['update-watch.py', 'failed', '--failed-unit', unit]), \
                     patch.dict(sys.modules, {'alerts': NS(send_email=send)}), \
                     __import__('contextlib').redirect_stdout(io.StringIO()):
                    uw.main({'services': SERVICES, 'cloudflare': CLOUDFLARE})
                    if unit != uw.SERVICE:  # one failed image scan is retried, not mailed
                        self.assertEqual(sent, [])
                        uw.main({'services': SERVICES, 'cloudflare': CLOUDFLARE})
                        uw.main({'services': SERVICES, 'cloudflare': CLOUDFLARE})
                self.assertEqual(len(sent), 1)
                subject, body = sent[0]
                self.assertEqual(subject, '[Hatchkit] fixture-host: ' + expected)
                body = text_of(body)
                self.assertIn('journalctl -u ' + unit, body)
                self.assertNotIn('Nothing was checked', body)
                if unit != uw.SERVICE:
                    self.assertIn('previous complete image ledger', body)
                    self.assertIn('15 minutes', body)
                    self.assertIn('twice in a row', body)
                    self.assertNotIn('journalctl -u ' + uw.SERVICE, body)

    def test_a_complete_image_scan_ends_the_failure_streak(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            t0 = dt.datetime(2026, 11, 6, 3, tzinfo=dt.timezone.utc)
            self.assertFalse(uw.image_failure_due(work, t0))
            (work / 'image-vulnerability-status.json').write_text(json.dumps(
                {'checkedAt': (t0 + dt.timedelta(minutes=10)).isoformat()}))
            self.assertFalse(uw.image_failure_due(work, t0 + dt.timedelta(minutes=20)))
            self.assertTrue(uw.image_failure_due(work, t0 + dt.timedelta(minutes=35)))
            self.assertFalse(uw.image_failure_due(work, t0 + dt.timedelta(minutes=50)))

    def test_unknown_failure_origin_cannot_enter_the_message(self):
        with self.assertRaisesRegex(uw.WatchError, '^Failure notification origin is not recognized$'):
            uw.failure_notice('fixture-host', SECRET)


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
    def test_persisted_state_keeps_feed_retrieval_proof_without_sending_mail(self):
        receipt={'maximumCacheAgeSeconds':3600,'cacheHits':12,'networkReads':0,'oldestRetrievedAt':NOW.isoformat()}
        with patch.object(uw,'scan',return_value={'services':[],'findings':[],'skipped':[],'githubFeeds':receipt}):
            state,_=uw.check(None,[],None,self.work,self.config,self.send,NOW)
        self.assertEqual(state['githubFeeds'],receipt)
        self.assertEqual(json.loads((self.work/uw.STATUS_NAME).read_text())['githubFeeds'],receipt)
        self.assertEqual(self.sent,[])
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

    def urgent(self, **extra):
        return {'kind': 'image-package', 'service': 'image', 'id': 'CVE-2026-1234', 'name': 'pkg', 'version': '1',
                'fixed': '1.1', 'severity': 'high', 'containers': ['app'], 'knownExploited': True,
                'summary': 'scanner match', **extra}

    def check_rows(self, rows, when, skipped=(), send=None):
        with patch.object(uw, 'scan', side_effect=lambda *a, **k: {'services': [], 'findings': [dict(r) for r in rows], 'skipped': list(skipped)}):
            return uw.check(None, [], None, self.work, self.config, send or self.send, when)[0]

    def test_cloudflare_change_waits_for_the_digest_and_stays_in_the_ledger(self):
        feeds = dict(FEEDS)
        feeds[uw.CLOUDFLARE_IPS] = cloudflare_answer('1' * 32, add=('198.51.100.0/22',))
        state, _ = uw.check(FakeDocker(NEW_HOST), SERVICES, uw.Feeds(feeds, get=offline), self.work, self.config,
                            self.send, NOW, str(self.source), CLOUDFLARE, DEDICATED_CHAIN.get)
        self.assertIsNone(state['mailed'])
        self.assertEqual(self.sent, [])
        summaries = ' '.join(f['summary'] for f in state['findings'])
        self.assertIn('Cloudflare changed its IP ranges (etag ' + '1' * 32, summaries)
        self.assertIn('Chain HATCHKIT-CF on this host does not match', summaries)

    def test_direct_findings_are_recorded_without_immediate_mail_and_green_clears(self):
        state, error = self.run_check(OLD_HOST, OLD_EXECS)
        self.assertIsNone(error)
        self.assertIsNone(state['mailed'])
        self.assertEqual(self.sent, [])
        stored = json.loads((self.work / uw.STATUS_NAME).read_text())
        self.assertFalse(stored['ok'])
        self.assertIn('GHSA-mhcv-h7gf-57cf critical, fixed in 3.2.1', json.dumps(stored['findings']))
        self.assertNotIn(SECRET, json.dumps(stored))
        state, _ = self.run_check(NEW_HOST)
        self.assertIsNone(state['mailed'])
        self.assertTrue(state['ok'])

    def test_incomplete_run_records_what_it_could_not_check_for_the_digest(self):
        def unreachable(url):
            raise uw.FeedError('could not read ' + url.split('?')[0])
        state, _ = self.run_check(NEW_HOST[1:2], feeds={}, get=unreachable)
        self.assertFalse(state['ok'])
        self.assertIsNone(state['mailed'])
        self.assertEqual(self.sent, [])
        self.assertIn('Traefik: could not read https://api.github.com/repos/traefik/traefik/', json.dumps(state['skipped']))

    def test_new_known_exploited_finding_mails_once_and_recurrence_and_failure_retry(self):
        rows = [self.urgent()]
        first = self.check_rows(rows, NOW)
        self.assertEqual(first['mailed'], 'findings')
        subject, body = self.sent[-1][1:]
        self.assertEqual(subject, '[Hatchkit] ' + uw.socket.gethostname() + ': new urgent finding')
        text = text_of(body)
        self.assertIn('Known exploited', text)
        self.assertIn('Deadline: ', text)
        self.assertIn('Fix reported: 1.1', text)
        self.assertNotIn('KNOWN EXPLOITED', text)
        self.assertNotIn('OVERDUE', text)
        # Unchanged, overdue and changed repeats belong to the digest.
        self.check_rows(rows, NOW + dt.timedelta(hours=1))
        self.assertTrue(self.check_rows(rows, NOW + dt.timedelta(hours=25))['findings'][0]['overdue'])
        self.check_rows([self.urgent(fixed='1.2')], NOW + dt.timedelta(hours=26))
        self.assertEqual(len(self.sent), 1)
        self.check_rows([], NOW + dt.timedelta(hours=27))
        self.check_rows(rows, NOW + dt.timedelta(hours=28))
        self.assertEqual(len(self.sent), 2)
        self.check_rows([], NOW + dt.timedelta(hours=29))
        def refuse(*args):
            raise OSError('private SMTP details')
        failed = self.check_rows(rows, NOW + dt.timedelta(hours=30), send=refuse)
        self.assertEqual(failed['mailError'], 'OSError')
        self.assertNotIn('private SMTP', json.dumps(failed))
        self.check_rows(rows, NOW + dt.timedelta(hours=31))
        self.assertEqual(len(self.sent), 3)

    def test_only_critical_explicitly_affected_internet_exposure_bypasses_the_digest(self):
        row = self.urgent(knownExploited=False, applicability='affected', exposure='internet')
        self.check_rows([dict(row, severity='high')], NOW)
        self.check_rows([dict(row, severity='critical', applicability=None)], NOW + dt.timedelta(hours=1))
        self.assertEqual(self.sent, [])
        self.assertEqual(self.check_rows([dict(row, severity='critical')], NOW + dt.timedelta(hours=2))['mailed'], 'findings')
        self.assertIn('Explicitly affected internet exposure', text_of(self.sent[-1][2]))

    def test_exploitation_appearing_on_an_old_finding_is_new_and_keeps_its_clock(self):
        row = self.urgent(knownExploited=False, severity='high')
        first = self.check_rows([row], NOW)
        self.assertEqual(self.sent, [])
        later = self.check_rows([dict(row, knownExploited=True)], NOW + dt.timedelta(hours=2))
        self.assertEqual(later['mailed'], 'findings')
        self.assertEqual(later['findings'][0]['firstSeenAt'], first['findings'][0]['firstSeenAt'])

    def test_failed_scan_mails_once_with_the_safe_reason_only(self):
        def broken(args, timeout=60):
            raise RuntimeError('docker said ' + SECRET)
        check = lambda: uw.check(broken, SERVICES, uw.Feeds(FEEDS, get=offline), self.work, self.config, self.send, NOW,
                                 str(self.source))[0]
        state = check()
        self.assertEqual((state['error'], state['mailed']), ('RuntimeError', 'error'))
        self.assertNotIn(SECRET, text_of(self.sent[-1][2]))
        self.assertEqual(self.sent[-1][1], '[Hatchkit] ' + uw.socket.gethostname() + ': update watch failed')
        check()
        self.assertEqual(len(self.sent), 1)

    def test_scan_crash_does_not_reannounce_an_acknowledged_urgent_finding(self):
        rows = [self.urgent()]
        self.check_rows(rows, NOW)
        with patch.object(uw, 'scan', side_effect=RuntimeError('crash')):
            uw.check(None, [], None, self.work, self.config, self.send, NOW + dt.timedelta(hours=1))
        self.check_rows(rows, NOW + dt.timedelta(hours=2))
        self.assertEqual(len(self.sent), 2)  # the urgent mail and the crash mail

    def test_mail_failure_is_recorded_without_its_message(self):
        def refuse(settings, subject, body):
            raise OSError('535 auth failed for ' + SECRET)
        state = self.check_rows([self.urgent()], NOW, send=refuse)
        self.assertEqual(state['mailError'], 'OSError')
        self.assertNotIn(SECRET, json.dumps(state))

    def test_old_state_migrates_without_resending_an_acknowledged_urgent_finding(self):
        row = self.urgent()
        previous = {'checkedAt': NOW.isoformat(), 'findings': [row], 'skipped': [], 'error': None,
                    'notificationIdentityVersion': 3, 'notifiedFingerprint': 'accepted',
                    'lastWeeklyReviewKey': '2026-W43', 'lastWeeklyReviewAt': NOW.isoformat()}
        (self.work / uw.STATUS_NAME).write_text(json.dumps(previous))
        current = self.check_rows([row], NOW + dt.timedelta(hours=1))
        self.assertIsNone(current['mailed'])
        self.assertEqual(self.sent, [])
        self.assertEqual(current['lastWeeklyReviewKey'], '2026-W43')
        (self.work / uw.STATUS_NAME).write_text(json.dumps({**previous, 'mailError': 'OSError'}))
        self.assertEqual(self.check_rows([row], NOW + dt.timedelta(hours=2))['mailed'], 'findings')

    def test_overdue_clock_keeps_running_without_a_repeat_mail(self):
        rows = [{'kind': 'advisory', 'service': 'host-docker', 'id': 'GHSA-test', 'severity': 'critical', 'summary': 'A real test finding'}]
        self.assertFalse(self.check_rows(rows, NOW)['findings'][0]['overdue'])
        self.assertTrue(self.check_rows(rows, NOW + dt.timedelta(hours=24))['findings'][0]['overdue'])
        self.assertEqual(self.sent, [])

    def test_large_ledger_and_image_rebuild_preserve_all_deadlines(self):
        rows = [{'kind':'image-package','service':'sha256:old','id':'CVE-'+str(n),
                 'name':'pkg','version':'1.0','containers':['app-20261023T010000'],
                 'severity':'critical','summary':'fixed available'} for n in range(250)]
        first = self.check_rows(rows, NOW)
        self.assertEqual(len(first['findings']),250)
        self.assertEqual(len(first['findingFirstSeen']),250)
        for r in rows:
            r['service']='sha256:new';r['containers']=['app-20261024T010000']
        rebuilt = self.check_rows(rows, NOW+dt.timedelta(hours=24))
        self.assertEqual(len(rebuilt['findings']),250)
        self.assertTrue(all(r['overdue']for r in rebuilt['findings']))
        self.assertEqual(first['findingFirstSeen'],rebuilt['findingFirstSeen'])
        self.assertEqual(self.sent, [])

    def test_still_affected_package_upgrade_keeps_clock(self):
        row={'kind':'image-package','service':'old-image','id':'CVE-2026-test','name':'mariadb-server',
             'version':'10.11.14','severity':'high','containers':['kuma'],'summary':'scanner match'}
        first = self.check_rows([row], NOW)
        row.update(version='10.11.19',service='new-image')
        later = self.check_rows([row], NOW+dt.timedelta(hours=73))
        self.assertEqual(later['findings'][0]['version'],'10.11.19')
        self.assertEqual(later['findings'][0]['firstSeenAt'],first['findings'][0]['firstSeenAt'])
        self.assertEqual(later['findings'][0]['dueAt'],first['findings'][0]['dueAt'])
        self.assertTrue(later['findings'][0]['overdue'])

    def test_version_identity_migration_merges_exploitation_and_earliest_deadline(self):
        base={'kind':'image-package','service':'image','id':'CVE-2026-test','name':'pkg',
              'severity':'high','summary':'scanner match'}
        older={**base,'version':'1','knownExploited':True,'firstSeenAt':(NOW-dt.timedelta(hours=80)).isoformat(),
               'dueAt':(NOW-dt.timedelta(hours=56)).isoformat()}
        newer={**base,'version':'2','firstSeenAt':(NOW-dt.timedelta(hours=10)).isoformat(),
               'dueAt':(NOW+dt.timedelta(hours=62)).isoformat()}
        for order in [[older,newer],[newer,older]]:
            self.work.joinpath(uw.STATUS_NAME).write_text(json.dumps({'findings':order,'findingFirstSeen':{}}))
            with patch.object(uw,'scan',return_value={'services':[],'findings':[{**base,'version':'3'}],'skipped':[]}):
                current,_=uw.check(None,[],None,self.work,self.config,self.send,NOW)
            found=current['findings'][0]
            self.assertTrue(found['knownExploited']);self.assertTrue(found['overdue'])
            self.assertEqual(dt.datetime.fromisoformat(found['firstSeenAt']),NOW-dt.timedelta(hours=80))
            self.assertLessEqual(dt.datetime.fromisoformat(found['dueAt']),dt.datetime.fromisoformat(older['dueAt']))

    def test_name_lookup_reads_only_a_display_label(self):
        calls=[]
        def docker(argv):
            calls.append(argv)
            return 'id' if argv==['ps','-q'] else '"/opaque-id"\t"chess-server"\n"/other"\t"bad\\nlabel"'
        self.assertEqual(uw.workload_display_names(docker),{'opaque-id':'chess-server'})
        self.assertEqual(calls[1],['inspect','--format','{{json .Name}}\t{{json (index .Config.Labels "coolify.serviceName")}}','id'])

    def test_rebuild_and_replica_changes_keep_the_clock(self):
        rows=[{'kind':'image-package','service':'sha256:old','id':'CVE-2026-1234',
               'name':'pkg','version':'1','severity':'high','summary':'test','fixed':None,
               'containers':['app-old']}]
        first = self.check_rows(rows, NOW)
        rows[0]['service']='sha256:new';rows[0]['containers']=['app-renamed','another-replica']
        rows.append(dict(rows[0]))
        self.check_rows(rows, NOW+dt.timedelta(hours=1))
        for row in rows:row['fixed']='1.1'
        later = self.check_rows(rows, NOW+dt.timedelta(hours=2))
        self.assertEqual(first['findings'][0]['dueAt'],later['findings'][0]['dueAt'])
        self.assertEqual(self.sent,[])

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
        self.assertEqual(len(self.sent),1)

    def test_vendor_review_priority_has_24_hour_deadline_without_claiming_exploitation(self):
        row={'kind':'advisory','service':'host-tailscale','id':'TS-2026-014','name':'Tailscale',
             'version':'1.104.2','severity':'high','vendorSeverity':'unclassified','patchWithinHours':24,'summary':'Synthetic notice'}
        with patch.object(uw,'scan',return_value={'services':[],'findings':[dict(row)],'skipped':[]}):
            first,_=uw.check(None,[],None,self.work,self.config,self.send,NOW)
            again,_=uw.check(None,[],None,self.work,self.config,self.send,NOW+dt.timedelta(hours=1))
        self.assertEqual(dt.datetime.fromisoformat(first['findings'][0]['dueAt']),NOW+dt.timedelta(hours=24))
        self.assertEqual(first['findings'][0]['dueAt'],again['findings'][0]['dueAt'])
        self.assertFalse(first['findings'][0].get('knownExploited'))

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
        with patch.object(uw, 'scan', return_value={'services': [], 'findings': [self.urgent()], 'skipped': []}):
            state, error = uw.check(None, [], None, self.work, self.config, self.send, NOW)
        self.assertIn('backup alert mail is not configured', state['mailError'])
        self.assertIsNotNone(error)


class RuntimeSecurityTests(unittest.TestCase):
    def test_node_release_floor_covers_eol_and_prereleases(self):
        for value in ['18.20.8','20.20.2','22.23.3','24.22.0','26.12.0','24.22.1-rc.1','invalid']:
            self.assertTrue(uw.vulnerable_node(value),value)
        for value in ['22.23.4','24.22.1','26.12.1','24.23.0']:
            self.assertFalse(uw.vulnerable_node(value),value)

    def test_custom_image_keeps_original_advisory_identity(self):
        fake=FakeDocker([container('kuma','localhost/hatchkit-security/kuma:20261023')])
        def docker(args,**kwargs):
            result=fake(args,**kwargs)
            return result.rstrip()+'\t'+json.dumps('louislam/uptime-kuma:2.5.6')+'\n' if args[0]=='inspect' else result
        found,_=uw.list_services(docker,SERVICES)
        self.assertEqual(found[0]['tag'],'2.5.6')
        self.assertEqual(found[0]['service']['key'],'uptime-kuma')

    def test_nested_derived_origin_is_visible_as_lost_coverage(self):
        row=container('kuma','localhost/hatchkit-security/kuma:2')
        fake=FakeDocker([row])
        def docker(args,**kwargs):
            result=fake(args,**kwargs)
            return result.rstrip()+'\t'+json.dumps('localhost/hatchkit-security/kuma:1')+'\n' if args[0]=='inspect' else result
        skipped=[]
        found,_=uw.list_services(docker,SERVICES,skipped)
        self.assertEqual(found,[])
        self.assertIn('unresolved derived-image provenance',skipped[0])
        self.assertNotIn(SECRET,json.dumps(skipped))

    def test_baked_upstream_survives_container_recreation(self):
        row=container('kuma','localhost/hatchkit-security/kuma:2',labels={'io.hatchkit.security.original-image':'louislam/uptime-kuma:2.5.6'})
        skipped=[]
        found,_=uw.list_services(FakeDocker([row]),SERVICES,skipped)
        self.assertEqual(found[0]['service']['key'],'uptime-kuma')
        self.assertEqual(skipped,[])

    def test_a_service_patches_overlay_keeps_its_upstream_advisories(self):
        row=container('kuma','localhost/hatchkit-overlay/uptime-kuma:2.5.9-rootless-hk1',
                      labels={'io.hatchkit.overlay.base':'louislam/uptime-kuma:2.5.9-rootless@sha256:'+'c'*64})
        skipped=[]
        found,_=uw.list_services(FakeDocker([row]),SERVICES,skipped)
        self.assertEqual((found[0]['service']['key'],found[0]['tag']),('uptime-kuma','2.5.9-rootless'))
        self.assertEqual(skipped,[])

    def test_a_local_image_under_a_free_docker_hub_namespace_is_reported(self):
        row=container('kuma','hatchkit-security/kuma:2',labels={'io.hatchkit.security.original-image':'louislam/uptime-kuma:2.5.6'})
        skipped=[]
        found,_=uw.list_services(FakeDocker([row]),SERVICES,skipped)
        self.assertEqual(found[0]['service']['key'],'uptime-kuma','coverage itself still resolves')
        self.assertEqual(len(skipped),1)
        self.assertIn('free Docker Hub namespace',skipped[0])
        self.assertIn('localhost/hatchkit-security/kuma:2',skipped[0])

    def test_resolved_database_origin_is_not_missing_vendor_coverage(self):
        row=container('postgres','localhost/hatchkit-security/postgres:20261023',labels={'io.hatchkit.security.original-image':'postgres:16-alpine'})
        skipped=[]
        found,_=uw.list_services(FakeDocker([row]),SERVICES,skipped)
        self.assertEqual(found,[])
        self.assertEqual(skipped,[])

    def test_conflicting_origins_fail_coverage_instead_of_choosing_one(self):
        row=container('kuma','localhost/hatchkit-security/kuma:2',labels={'io.hatchkit.security.original-image':'louislam/uptime-kuma:2.5.6'})
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
            if args[0]=='inspect':return 'true' if args[2]=='{{.State.Running}}' else '/app'
            if args[0]=='exec' and args[2]=='node':return '24.22.1'
            if args[0]=='exec' and args[2]=='sh':return '/app/lib/castore-1.0.16/priv/cacerts.pem'
            if args[0]=='exec' and args[2]=='cat':return 'old' if '/app/lib/'in args[3] else 'new'
            raise uw.WatchError('absent')
        with patch.object(uw,'distrusted_roots',side_effect=lambda pem:['emSign ECC Root CA - G3'] if pem=='old' else []):
            findings,skipped=uw.runtime_trust(docker,lambda cid,path:docker(['exec',cid,'cat',path]))
        self.assertEqual(skipped,[])
        self.assertEqual(len(findings),1)
        self.assertIn('castore',findings[0]['summary'])

    def test_malformed_trust_data_is_incomplete_not_clean(self):
        def docker(args,**kwargs):
            if args[0]=='ps':return 'id'
            if args[0]=='inspect':return 'true' if args[2]=='{{.State.Running}}' else '/app'
            if args[0]=='exec' and args[2]=='cat':return 'not a certificate'
            raise uw.WatchError('absent')
        findings,skipped=uw.runtime_trust(docker,lambda cid,path:docker(['exec',cid,'cat',path]))
        self.assertFalse(findings)
        self.assertEqual(len(skipped),1)


class PhpRuntimeCoverage(unittest.TestCase):
    def docker(self, versions):
        def run(args, **kwargs):
            value = versions.get(args[2])
            if value is None:
                raise uw.WatchError(SECRET)
            self.assertEqual(args[3], '-v')
            self.assertEqual(kwargs['timeout'], 15)
            return value
        return run

    def test_fixed_supported_branches_and_fpm_are_measured(self):
        for version in ('8.2.35', '8.3.36', '8.4.27', '8.5.12', '8.4.28'):
            with self.subTest(version=version):
                rows, skipped = uw.php_runtime_trust(self.docker({'php': 'PHP ' + version + ' (cli)',
                    'php-fpm': 'PHP ' + version + ' (fpm-fcgi)'}), 'id', 'coolify')
                self.assertEqual((rows, skipped), ([], []))

    def test_fpm_cannot_hide_behind_patched_cli(self):
        for version in ('8.2.34', '8.3.35', '8.4.26', '8.5.11'):
            with self.subTest(version=version):
                rows, skipped = uw.php_runtime_trust(self.docker({'php': 'PHP 8.4.27 (cli)',
                    'php-fpm': 'PHP ' + version + ' (fpm-fcgi)'}), 'id', 'coolify')
                self.assertEqual(skipped, [])
                self.assertEqual(len(rows), 1)
                self.assertEqual(rows[0]['kind'], 'php-runtime')
                self.assertEqual(rows[0]['patchWithinHours'], 24)
                self.assertIn('php-fpm', rows[0]['summary'])

    def test_known_controller_requires_both_probes_without_raw_errors(self):
        rows, skipped = uw.php_runtime_trust(self.docker({'php': 'PHP 8.4.27 (cli)'}), 'id', 'coolify')
        self.assertEqual(rows, [])
        self.assertEqual(len(skipped), 1)
        self.assertNotIn(SECRET, str(skipped))
        self.assertEqual(uw.php_runtime_trust(self.docker({}), 'id', 'unrelated'), ([], []))

    def test_still_affected_upgrade_preserves_advisory_identity(self):
        rows = [uw.php_runtime_trust(self.docker({'php-fpm': 'PHP ' + version + ' (fpm-fcgi)'}),
                'id', 'app')[0][0] for version in ('8.4.25', '8.4.26')]
        self.assertEqual(uw.finding_identity(rows[0]), uw.finding_identity(rows[1]))

    def test_unknown_backport_branch_and_malformed_versions_require_review(self):
        for banner in ('PHP 8.6.0 (cli)', 'PHP 8.1.35 (cli)', 'PHP 8.4.27RC1 (cli)', SECRET):
            rows, skipped = uw.php_runtime_trust(self.docker({'php': banner}), 'id', 'app')
            self.assertEqual(rows, [])
            self.assertEqual(len(skipped), 1)
            self.assertNotIn(SECRET, str(skipped))


class CertificateArchiveCoverage(unittest.TestCase):
    PATH='/etc/ssl/certs/ca-certificates.crt'
    def archive(self,kind=tarfile.REGTYPE,name='ca-certificates.crt',target='',payload=b'synthetic-public-PEM',extra=False):
        output=io.BytesIO()
        with tarfile.open(fileobj=output,mode='w')as tar:
            member=tarfile.TarInfo(name);member.type=kind;member.linkname=target
            member.size=len(payload)if kind==tarfile.REGTYPE else 0
            tar.addfile(member,io.BytesIO(payload)if member.size else None)
            if extra:tar.addfile(tarfile.TarInfo('unexpected'))
        return output.getvalue()
    def test_exact_regular_public_file_is_read_without_extraction(self):
        self.assertEqual(uw.ca_from_archive(self.archive(),self.PATH),'synthetic-public-PEM')
    def test_other_entries_links_compression_size_and_truncation_are_rejected(self):
        for data in [self.archive(kind=tarfile.LNKTYPE,target='/secret'),self.archive(kind=tarfile.DIRTYPE),self.archive(name='../ca-certificates.crt'),self.archive(extra=True),self.archive(payload=b'a'*(uw.CA_MAX_BYTES+1)),self.archive()[:520],b'not a tar',b'x'*(uw.CA_ARCHIVE_MAX_BYTES+1)]:
            with self.subTest(size=len(data)),self.assertRaisesRegex(uw.WatchError,'^Certificate archive inspection failed$'):uw.ca_from_archive(data,self.PATH)
    def test_symlink_is_never_followed_and_only_public_alias_metadata_is_retained(self):
        for target,expected in [('certs/ca-certificates.crt',self.PATH),('/run/secrets/'+SECRET,None)]:
            data=self.archive(kind=tarfile.SYMTYPE,name='cert.pem',target=target)
            with self.assertRaises(uw.CertificateAlias)as error:uw.ca_from_archive(data,'/etc/ssl/cert.pem')
            self.assertEqual(error.exception.target,expected);self.assertNotIn(SECRET,str(error.exception))
    def test_unknown_paths_never_reach_the_daemon(self):
        for path in ['/run/secrets/'+SECRET,'/etc/passwd','/app/lib/../../secret','/app/.venv/lib/python3.12/site-packages/certifi/../../secret']:
            with patch.object(uw.http.client,'HTTPConnection',side_effect=AssertionError('No daemon access')):
                with self.assertRaises(uw.WatchError):uw.container_ca_bundle('a'*64,path)
        for cid in ['foreign-name','/../../secret','a'*65]:
            with self.assertRaises(uw.WatchError):uw.container_ca_bundle(cid,self.PATH)
    def test_daemon_bounds_and_errors_never_export_response_bodies(self):
        class Response:
            status=200;length=None
            def __init__(self,data):self.body=io.BytesIO(data)
            def getheader(self,key):return self.length
            def read1(self,count):return self.body.read(count)
        class Connection:
            response=None;closed=False;requests=[]
            def __init__(self,*args,**kwargs):self.sock=None
            def request(self,*args):self.requests.append(args)
            def getresponse(self):return self.response
            def close(self):Connection.closed=True
        with patch.object(uw.http.client,'HTTPConnection',Connection):
            Connection.response=Response(self.archive());self.assertEqual(uw.container_ca_bundle('a'*64,self.PATH),'synthetic-public-PEM');self.assertTrue(Connection.closed)
            for status,length,data in [(403,None,SECRET.encode()),(200,str(uw.CA_ARCHIVE_MAX_BYTES+1),b''),(200,None,b'x'*(uw.CA_ARCHIVE_MAX_BYTES+1)),(200,'invalid',b'')]:
                Connection.response=Response(data);Connection.response.status=status;Connection.response.length=length
                with self.subTest(status=status,length=length),self.assertRaises(uw.WatchError)as error:uw.container_ca_bundle('a'*64,self.PATH)
                self.assertNotIn(SECRET,str(error.exception));self.assertTrue(Connection.closed)
            Connection.response=Response(SECRET.encode());Connection.response.status=404
            self.assertIsNone(uw.container_ca_bundle('a'*64,self.PATH))
    def docker(self,args,**kwargs):
        if args[0]=='ps':return 'a'*64
        if args[0]=='inspect':return 'true' if args[2]=='{{.State.Running}}' else '/minimal-image'
        raise uw.WatchError('No executable in minimal image')
    def test_minimal_image_without_shell_or_cat_still_exposes_bad_root(self):
        reads=[]
        def reader(cid,path):reads.append(path);return 'public PEM' if path==self.PATH else None
        with patch.object(uw,'distrusted_roots',return_value=['emSign ECC Root CA - G3']):findings,skipped=uw.runtime_trust(self.docker,reader)
        self.assertFalse(skipped);self.assertEqual(len(findings),1);self.assertEqual(findings[0]['kind'],'certificate-trust');self.assertEqual(reads,list(uw.SYSTEM_CA_PATHS))
    def test_unreadable_archive_and_unresolved_alias_are_incomplete(self):
        for exception in [uw.WatchError(SECRET),uw.CertificateAlias(None)]:
            def reader(cid,path):
                if path==self.PATH:raise exception
                return None
            findings,skipped=uw.runtime_trust(self.docker,reader);self.assertFalse(findings);self.assertEqual(len(skipped),1);self.assertNotIn(SECRET,str(skipped))
    def test_public_alias_requires_independent_regular_target_and_unknown_discovery_is_not_read(self):
        paths=[]
        def reader(cid,path):
            paths.append(path)
            if path=='/etc/ssl/cert.pem':raise uw.CertificateAlias(self.PATH)
            return 'public PEM'
        def docker(args,**kwargs):
            if args[:3]==['exec','a'*64,'python3']:return '/run/secrets/'+SECRET
            return self.docker(args,**kwargs)
        with patch.object(uw,'distrusted_roots',return_value=[]):findings,skipped=uw.runtime_trust(docker,reader)
        self.assertFalse(findings);self.assertEqual(len(skipped),1);self.assertNotIn(SECRET,str(skipped));self.assertEqual(paths,list(uw.SYSTEM_CA_PATHS))


class InfrastructureRuntimeVersions(unittest.TestCase):
    def test_required_probe_wins_over_tag_and_failure_never_falls_back(self):
        image={'labels':{},'env':[]};row={'name':'synthetic','tag':'9.9.9'}
        for key,answer,expected in [('coredns','CoreDNS-1.15.0\nlinux/amd64,go1.27.3,synthetic\n','1.15.0'),('sentinel','1.1.2','1.1.2')]:
            service=BY_KEY[key];self.assertTrue(service['requireProbe'])
            value,source=uw.resolve_version(lambda args,**kwargs:answer,row,image,service)
            self.assertEqual(str(value),expected);self.assertTrue(source.startswith('runtime probe '))
            self.assertEqual(uw.resolve_version(lambda args,**kwargs:SECRET,row,image,service),(None,None))
            def failed(*args,**kwargs):raise uw.WatchError(SECRET)
            self.assertEqual(uw.resolve_version(failed,row,image,service),(None,None))
    def test_runtime_version_discovery_reads_only_documented_fixed_targets(self):
        self.assertEqual(BY_KEY['coredns']['probe']['argv'],['/coredns','-version'])
        self.assertEqual(BY_KEY['sentinel']['probe']['argv'],['curl','--fail','--silent','--show-error','--max-time','5','http://127.0.0.1:8888/api/version'])
        self.assertEqual(BY_KEY['sentinel']['env'],[])


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
            result=uw.scan(FakeDocker([]),[],feed,now=NOW,source=root,image_packages=True,kev=True)
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


class TailscaleVendorCoverage(unittest.TestCase):
    now = dt.datetime(2026, 10, 29, tzinfo=dt.timezone.utc)

    def xml(self, extra=''):
        items = ''.join('<item><title>TS-2026-%03d</title><link>https://tailscale.com/security-bulletins/#ts-2026-%03d</link>'
                        '<pubDate>Mon, 26 Oct 2026 00:00:00 GMT</pubDate><description>'
                        '&lt;p&gt;Description: Synthetic vendor condition.&lt;/p&gt;'
                        '&lt;p&gt;This vulnerability is fixed in Tailscale version 1.104.4 or newer.&lt;/p&gt;'
                        '</description></item>' % (n, n) for n in range(14, 18))
        return ('<rss><channel>' + items + extra + '</channel></rss>').encode()

    def test_vendor_feed_flags_old_runtime_even_when_github_has_no_advisories(self):
        data = uw.tailscale_rss(self.xml())
        rows, skipped = uw.tailscale_bulletin_findings(uw.Feeds({uw.TAILSCALE_BULLETINS:data}, get=offline), uw.Version('1.104.2'), self.now)
        self.assertEqual({r['id'] for r in rows}, {'TS-2026-%03d' % n for n in range(14, 18)})
        self.assertEqual(skipped, [])
        self.assertTrue(all(r['vendorSeverity'] == 'unclassified' and r['patchWithinHours'] == 24
                            and r['applicability'] == 'review-required' and not r.get('knownExploited') for r in rows))
        self.assertEqual(uw.tailscale_bulletin_findings(uw.Feeds({uw.TAILSCALE_BULLETINS:data}, get=offline), uw.Version('1.104.4'), self.now), ([], []))

    def test_scan_checks_vendor_source_and_missing_source_is_incomplete(self):
        spec = next(s for s in uw.HOST_RUNTIMES if s['key'] == 'host-tailscale')
        data = {uw.latest_url(spec['github']):{'tag_name':'v1.104.4'}, uw.advisories_url(spec['github']):[],
                uw.TAILSCALE_BULLETINS:uw.tailscale_rss(self.xml())}
        with tempfile.TemporaryDirectory() as root, patch.object(uw, 'host_runtime_versions', return_value=([(spec, uw.Version('1.104.2'))], [])):
            report = uw.scan(FakeDocker([]), [], uw.Feeds(data, get=offline), source=root, now=self.now, host_runtime=True)
            self.assertEqual(len([r for r in report['findings'] if r.get('id', '').startswith('TS-')]), 4)
            del data[uw.TAILSCALE_BULLETINS]
            report = uw.scan(FakeDocker([]), [], uw.Feeds(data, get=lambda url: (_ for _ in ()).throw(uw.FeedError('unavailable'))), source=root, now=self.now, host_runtime=True)
            self.assertTrue(any('Tailscale vendor bulletins' in row for row in report['skipped']))

    def test_unsafe_truncated_duplicate_or_wrong_origin_rss_fails(self):
        good = self.xml()
        for raw in (b'<!DOCTYPE rss [<!ENTITY x "bad">]>' + good, b'x' * (1024**2 + 1), good[:-10],
                    good.replace(b'TS-2026-017', b'TS-2026-016'), good.replace(b'https://tailscale.com/', b'https://example.com/')):
            with self.subTest(raw=raw[:40]), self.assertRaises(uw.FeedError):
                uw.tailscale_rss(raw)

    def test_unknown_future_notice_wording_remains_visible_and_future_dates_fail(self):
        data = uw.tailscale_rss(self.xml())
        row = dict(data['bulletins'][0], id='TS-2026-018', url='https://tailscale.com/security-bulletins/#ts-2026-018', description='New vendor format requires review.')
        data['bulletins'].append(row)
        rows, skipped = uw.tailscale_bulletin_findings(uw.Feeds({uw.TAILSCALE_BULLETINS:data}, get=offline), uw.Version('1.104.4'), self.now)
        self.assertEqual(rows, [])
        self.assertIn('TS-2026-018', skipped[0])
        row['publishedAt'] = (self.now + dt.timedelta(days=1)).isoformat()
        with self.assertRaises(uw.FeedError):
            uw.tailscale_bulletin_findings(uw.Feeds({uw.TAILSCALE_BULLETINS:data}, get=offline), uw.Version('1.104.4'), self.now)

    def test_vendor_source_uses_bounded_one_hour_cache_without_timestamp_extension(self):
        calls = []
        clock = [self.now]
        def get(url):
            calls.append(url)
            return uw.tailscale_rss(self.xml()), ''
        with tempfile.TemporaryDirectory() as work:
            reader = uw.GithubFeedReader(work, get=get, clock=lambda:clock[0])
            reader.blocked_until = self.now + dt.timedelta(hours=2)
            reader(uw.TAILSCALE_BULLETINS)
            clock[0] += dt.timedelta(minutes=59)
            reader(uw.TAILSCALE_BULLETINS)
            self.assertEqual(len(calls), 1)
            clock[0] += dt.timedelta(minutes=2)
            reader(uw.TAILSCALE_BULLETINS)
            self.assertEqual(len(calls), 2)

    def test_still_affected_tailscale_update_does_not_reset_vendor_notice_identity(self):
        row={'kind':'advisory','service':'host-tailscale','id':'TS-2026-014','name':'Tailscale','version':'1.104.2'}
        self.assertEqual(uw.finding_identity(row),uw.finding_identity(row|{'version':'1.104.3'}))

    def test_rss_limit_does_not_truncate_larger_cisa_catalog(self):
        data=json.dumps({'padding':'x'*(1024**2+1)}).encode()
        response=io.BytesIO(data)
        response.headers={}
        with patch.object(uw.urllib.request,'urlopen',return_value=response):
            result,_=uw.http_get(uw.KEV_MIRROR_URL)
        self.assertEqual(len(result['padding']),1024**2+1)
        for url,size in [(uw.TAILSCALE_BULLETINS,1024**2+1),(uw.KEV_MIRROR_URL,8*1024**2+1)]:
            response=io.BytesIO(b'x'*size)
            response.headers={}
            with self.subTest(url=url),patch.object(uw.urllib.request,'urlopen',return_value=response),self.assertRaises(uw.FeedError):
                uw.http_get(url)


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

    def test_apt_failure_keeps_bounded_private_tail_and_safe_action(self):
        work=Path(self.temp.name)
        def run(argv,**kwargs):
            kwargs['stdout'].write(b'x'*100000+b'\nCertificate verification failed: '+SECRET.encode())
            self.assertEqual(kwargs['stderr'],uw.subprocess.STDOUT)
            return NS(returncode=100)
        state=uw.refresh_host_package_indexes(work,run=run,now=NOW)
        private=work/'host-package-refresh.private.log'
        self.assertEqual(state['failureCategory'],'certificate-verification')
        self.assertIn('keep TLS verification enabled',state['action'])
        self.assertNotIn(SECRET,json.dumps(state))
        self.assertEqual(private.stat().st_size,65536)
        self.assertEqual(private.stat().st_mode & 0o777,0o600)
        self.assertTrue(state['diagnostic']['truncated'])
        self.assertIn(SECRET.encode(),private.read_bytes())
        self.assertEqual(list(work.glob('.apt-refresh-diagnostic-*')),[])
        good=uw.refresh_host_package_indexes(work,run=lambda *a,**k:NS(returncode=0),now=NOW)
        self.assertTrue(good['ok']);self.assertNotIn('failureCategory',good)

    def test_apt_diagnostic_replaces_symlink_without_writing_its_target(self):
        work=Path(self.temp.name);target=work/'synthetic-secret';target.write_text(SECRET)
        (work/'host-package-refresh.private.log').symlink_to(target)
        def run(argv,**kwargs):
            kwargs['stdout'].write(b'Temporary failure resolving repository')
            raise uw.subprocess.TimeoutExpired('apt-get',300)
        state=uw.refresh_host_package_indexes(work,run=run,now=NOW)
        self.assertEqual(state['failureCategory'],'name-resolution')
        self.assertFalse((work/'host-package-refresh.private.log').is_symlink())
        self.assertEqual(target.read_text(),SECRET)

    def test_apt_categories_and_state_never_copy_untrusted_output_into_mail(self):
        cases=[(b'NO_PUBKEY private-key-label','repository-authentication'),
               (b'Could not connect to private-url','network-connection'),
               (b'Could not get lock /private/path','lock-contention'),
               (SECRET.encode(),'unknown')]
        for output,expected in cases:
            self.assertEqual(uw.apt_failure_category(output),expected)
        self.path.write_text(json.dumps({'checkedAt':NOW.isoformat(),'ok':False,
            'failureCategory':'untrusted-private-category','action':SECRET}))
        self.assertNotIn(SECRET,json.dumps(self.inspect()[1]))
        self.path.write_text(json.dumps({'checkedAt':NOW.isoformat(),'ok':False,
            'failureCategory':'certificate-verification','action':SECRET}))
        message=json.dumps(self.inspect()[1])
        self.assertIn('keep TLS verification enabled',message);self.assertNotIn(SECRET,message)


class HostSecurityAutoPatch(unittest.TestCase):
    def pkg(self, name, blocked=False):
        return {'kind': 'host-package', 'service': 'host-os', 'name': name, 'id': 'ubuntu-security:' + name,
                'fixed': '2', 'severity': 'high', 'blockedByPolicy': blocked, 'summary': name}

    def test_upgrade_runs_in_its_own_transient_unit_and_skips_pinned_packages(self):
        calls = []
        def run(argv, **kwargs):
            calls.append(argv)
            return uw.subprocess.CompletedProcess(argv, 0, '', '')
        result = uw.apply_host_security_updates([self.pkg('openssl'), self.pkg('pinned', blocked=True)], run=run)
        self.assertEqual(result, {'packages': ['openssl'], 'outcome': 'finished'})
        self.assertEqual(calls[0][:2], ['systemd-run', '--unit=' + uw.HOST_UPGRADE_UNIT])
        self.assertIn('--wait', calls[0])
        self.assertEqual(calls[0][-1], '/usr/bin/unattended-upgrade')
        self.assertIsNone(uw.apply_host_security_updates([self.pkg('pinned', blocked=True)], run=run))
        def slow(argv, **kwargs):
            raise uw.subprocess.TimeoutExpired(argv, 600)
        self.assertEqual(uw.apply_host_security_updates([self.pkg('openssl')], run=slow)['outcome'], 'still running')
        self.assertEqual(uw.apply_host_security_updates([self.pkg('openssl')], run=lambda a, **k: uw.subprocess.CompletedProcess(a, 1))['outcome'], 'failed')

    def test_scan_reports_only_what_the_upgrade_left(self):
        before = [self.pkg('openssl'), self.pkg('curl')]
        after = [self.pkg('curl')]
        with patch.object(uw, 'host_package_findings', side_effect=[(before, []), (after, [])]), \
             patch.object(uw, 'list_services', return_value=([], {})):
            report = uw.scan(None, [], None, now=NOW, host_packages=True, patch_host=True,
                             patcher=lambda f: {'packages': ['curl', 'openssl'], 'outcome': 'finished'})
        self.assertEqual([f['name'] for f in report['findings']], ['curl'])
        self.assertEqual((report['hostPatch']['patched'], report['hostPatch']['remaining']), (['openssl'], ['curl']))
        with patch.object(uw, 'host_package_findings', return_value=(before, [])), \
             patch.object(uw, 'list_services', return_value=([], {})):
            report = uw.scan(None, [], None, now=NOW, host_packages=True,
                             patcher=lambda f: self.fail('patching is opt-in'))
        self.assertNotIn('hostPatch', report)

    def test_check_keeps_the_patch_record_and_surfaces_a_failure(self):
        with tempfile.TemporaryDirectory() as folder:
            work = Path(folder)
            smtp = work / 'smtp.json'; smtp.write_text('{}'); smtp.chmod(0o600)
            config = {'alerts': {'enabled': True, 'to': 'o@example.com', 'from': 'b@example.com', 'smtpFile': str(smtp)}}
            def report(patch_record, rows):
                return lambda *a, **k: {'services': [], 'findings': rows, 'skipped': [], 'hostPatch': patch_record}
            done = {'packages': ['openssl'], 'outcome': 'finished', 'patched': ['openssl'], 'remaining': [], 'at': NOW.isoformat()}
            with patch.object(uw, 'scan', side_effect=report(done, [])):
                state, _ = uw.check(None, [], None, work, config, lambda *a: 'id', NOW)
            self.assertEqual(state['lastHostPatch']['patched'], ['openssl'])
            self.assertTrue(state['ok'])
            failed = {'packages': ['curl'], 'outcome': 'failed', 'patched': [], 'remaining': ['curl'], 'at': NOW.isoformat()}
            with patch.object(uw, 'scan', side_effect=report(failed, [self.pkg('curl')])):
                state, _ = uw.check(None, [], None, work, config, lambda *a: 'id', NOW)
            self.assertEqual(state['lastHostPatch']['patched'], ['openssl'], 'the last success is kept')
            self.assertIn('Automatic host security upgrade failed', ' '.join(state['skipped']))
            self.assertFalse(state['ok'])


class GithubFeedCache(unittest.TestCase):
    URL='https://api.github.com/repos/example/service/security-advisories?per_page=100&state=published'
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.work=Path(self.temp.name);self.now=NOW;self.calls=[]
    def get(self,url):
        self.calls.append(url);return [{'ghsa_id':'GHSA-fixture'}],''
    def reader(self,**kwargs):
        return uw.GithubFeedReader(self.work,get=kwargs.pop('get',self.get),clock=lambda:self.now,**kwargs)
    def path(self,reader):
        return reader.directory/(uw.hashlib.sha256(self.URL.encode()).hexdigest()+'.feed.json')
    def test_cache_survives_processes_without_renewing_retrieval_time(self):
        first=self.reader();self.assertEqual(first(self.URL)[0][0]['ghsa_id'],'GHSA-fixture')
        self.now+=dt.timedelta(minutes=59)
        second=self.reader();second(self.URL)
        self.assertEqual(len(self.calls),1);self.assertEqual(second.hits,1)
        self.assertEqual(second.receipt()['oldestRetrievedAt'],NOW.isoformat())
        self.assertEqual(self.path(first).stat().st_mode&0o777,0o600)
        self.now+=dt.timedelta(minutes=1)
        def failed(url):raise uw.FeedError('fixture outage')
        with self.assertRaises(uw.FeedError):self.reader(get=failed)(self.URL)
        self.assertEqual(json.loads(self.path(first).read_text())['retrievedAt'],NOW.isoformat())
    def test_primary_backoff_survives_processes_and_fresh_cannot_bypass_it(self):
        until=self.now+dt.timedelta(minutes=40)
        def limited(url):self.calls.append(url);raise uw.FeedRateLimit(until)
        with self.assertRaises(uw.FeedRateLimit):self.reader(get=limited)(self.URL)
        with self.assertRaises(uw.FeedRateLimit):self.reader(fresh=True)(self.URL)
        self.assertEqual(len(self.calls),1)
        self.now=until
        self.reader()(self.URL);self.assertEqual(len(self.calls),2)
    def test_fresh_bypasses_success_cache_and_unchanged_calls_do_not(self):
        self.reader()(self.URL);self.reader()(self.URL)
        self.assertEqual(len(self.calls),1)
        self.now+=dt.timedelta(minutes=1)
        self.reader(fresh=True)(self.URL)
        self.assertEqual(len(self.calls),2)
    def test_future_wrong_url_and_unsafe_file_are_not_trusted(self):
        reader=self.reader();reader(self.URL);path=self.path(reader)
        original=json.loads(path.read_text())
        for change in [{'retrievedAt':(NOW+dt.timedelta(seconds=1)).isoformat()},{'url':'https://api.github.com/repos/other/service/releases/latest'},{'retrievedAt':NOW.replace(tzinfo=None).isoformat()}]:
            path.write_text(json.dumps({**original,**change}));path.chmod(0o600)
            self.reader()(self.URL)
        path.chmod(0o644);self.reader()(self.URL)
        self.assertEqual(len(self.calls),5)
        secret=self.work/'synthetic-secret';secret.write_text(SECRET)
        path.unlink();path.symlink_to(secret);self.reader()(self.URL)
        self.assertEqual(secret.read_text(),SECRET);self.assertFalse(path.is_symlink())
    def test_cache_is_bounded_and_other_hosts_are_not_cached(self):
        reader=self.reader();reader.MAX_ENTRIES=2
        for n in range(3):reader(self.URL+'&page='+str(n))
        self.assertEqual(len(list(reader.directory.glob('*.feed.json'))),2)
        reader.MAX_BYTES=100
        reader(self.URL+'&page=large')
        self.assertEqual(len(list(reader.directory.glob('*.feed.json'))),2)
        reader('https://example.test/public-feed');reader('https://example.test/public-feed')
        self.assertEqual(len(self.calls),6)
    def test_paginated_feeds_keep_individual_provenance_and_link(self):
        following=self.URL+'&page=2'
        def get(url):
            self.calls.append(url)
            return ([{'page':1}],'<'+following+'>; rel="next"')if url==self.URL else([{'page':2}],'')
        feeds=uw.Feeds(get=self.reader(get=get))
        self.assertEqual(feeds.json(self.URL,pages=True),[{'page':1},{'page':2}])
        self.assertEqual(uw.Feeds(get=self.reader(get=get)).json(self.URL,pages=True),[{'page':1},{'page':2}])
        self.assertEqual(self.calls,[self.URL,following])

    def test_read_only_scan_creates_no_files_and_still_backs_off_in_memory(self):
        until=self.now+dt.timedelta(minutes=40)
        def limited(url):self.calls.append(url);raise uw.FeedRateLimit(until)
        reader=self.reader(get=limited,readonly=True)
        for url in [self.URL,self.URL+'&page=2']:
            with self.assertRaises(uw.FeedRateLimit):reader(url)
        self.assertEqual(len(self.calls),1);self.assertFalse(reader.directory.exists())
        self.reader()(self.URL)
        existing=self.path(self.reader());original=existing.read_bytes()
        self.reader(readonly=True,fresh=True)(self.URL)
        self.assertEqual(existing.read_bytes(),original)


if __name__ == '__main__':
    unittest.main()
