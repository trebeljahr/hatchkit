"""Automatic Traefik / Uptime Kuma patch releases: what may be patched and when, the
compose edit, the policy pin and its file-integrity record, and the swap with its
rollback against a fake Docker. The live canary/rollback proof is recorded in
cli/src/templates/update-watch/README.md.
"""
import datetime as dt
import hashlib
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace as NS
import unittest
from unittest.mock import patch

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE / 'src/templates/update-watch'))
sp = __import__('service-patches')

NOW = dt.datetime(2026, 11, 7, 3, 30, tzinfo=dt.timezone.utc)
OLD_DAY = '2026-11-01T10:00:00Z'
CONFIG = {'window': [3, 5], 'minAgeHours': 24}
DIGEST = 'sha256:' + 'b' * 64


def tag(name, updated=OLD_DAY, digest=DIGEST):
    return {'name': name, 'digest': digest, 'last_updated': updated}


TRAEFIK_TAGS = [tag('v3.7.17'), tag('v3.7.18'), tag('v3.7.19-rc1'), tag('v3.8.0'), tag('3.7.20'), tag('v3.7.2')]
KUMA_TAGS = [tag('2.5.9-rootless'), tag('2.5.10'), tag('2.5.10-rootless'), tag('2.5.11-slim-rootless'), tag('2.6.0-rootless')]

PROXY = """name: coolify-proxy
services:
  traefik:
    container_name: coolify-proxy
    image: 'traefik@sha256:%s'
    command:
      - '--providers.docker.password=SECRET_THAT_MUST_NOT_LEAK'
  hatchkit-docker-discovery:
    image: 'hatchkit-security/docker-discovery:20261023'
""" % ('a' * 64)


class Versions(unittest.TestCase):
    def test_only_a_higher_patch_of_the_same_minor_and_variant_is_picked(self):
        version, picked = sp.pick_patch('traefik', (3, 7, 17), TRAEFIK_TAGS)
        self.assertEqual((version, picked['name']), ((3, 7, 18), 'v3.7.18'))
        version, picked = sp.pick_patch('kuma', (2, 5, 9), KUMA_TAGS)
        self.assertEqual(picked['name'], '2.5.10-rootless', 'never the non-rootless or slim variant')
        self.assertIsNone(sp.pick_patch('traefik', (3, 7, 18), TRAEFIK_TAGS), 'no minor jump, no rc')
        self.assertIsNone(sp.pick_patch('kuma', (2, 5, 10), KUMA_TAGS))

    def test_advisories_are_matched_to_a_same_minor_fix(self):
        ledger = {'findings': [
            {'kind': 'advisory', 'service': 'traefik', 'version': '3.7.17', 'id': 'GHSA-1', 'fixed': '3.6.30, 3.7.18'},
            {'kind': 'advisory', 'service': 'traefik', 'version': '3.7.17', 'id': 'GHSA-2', 'fixed': '3.8.1'},
            {'kind': 'advisory', 'service': 'coolify', 'version': '4.6.0', 'id': 'GHSA-3', 'fixed': '4.6.1'},
            {'kind': 'image-package', 'service': 'traefik', 'id': 'CVE-1'}]}
        rows = sp.advisories_for(ledger, 'traefik', (3, 7, 17))
        self.assertEqual(rows, [{'id': 'GHSA-1', 'severity': None, 'fixedIn': (3, 7, 18)},
                                {'id': 'GHSA-2', 'severity': None, 'fixedIn': None}])

    def test_an_advisory_fix_goes_at_once_a_plain_patch_waits_for_age_and_window(self):
        candidate = ((3, 7, 18), tag('v3.7.18', updated='2026-11-07T01:00:00Z'))
        advisory = [{'id': 'GHSA-1', 'severity': 'high', 'fixedIn': (3, 7, 18)}]
        afternoon = NOW.replace(hour=14)
        self.assertEqual(sp.decide('traefik', (3, 7, 17), candidate, advisory, {}, afternoon, CONFIG)[:2],
                         ('patch', 'fixes GHSA-1'))
        self.assertEqual(sp.decide('traefik', (3, 7, 17), candidate, [], {}, NOW, CONFIG)[0], 'wait', 'too new')
        aged = ((3, 7, 18), tag('v3.7.18'))
        self.assertEqual(sp.decide('traefik', (3, 7, 17), aged, [], {}, afternoon, CONFIG)[0], 'wait', 'outside window')
        self.assertEqual(sp.decide('traefik', (3, 7, 17), aged, [], {}, NOW, CONFIG)[0], 'patch')
        self.assertEqual(sp.decide('traefik', (3, 7, 17), aged, advisory, {'paused': True}, NOW, CONFIG)[0], 'paused')
        self.assertEqual(sp.decide('traefik', (3, 7, 17), None, advisory, {}, NOW, CONFIG)[0], 'none')

    def test_plan_pins_traefik_by_digest_and_refuses_a_forced_minor_jump(self):
        target = {'name': 'traefik', 'kind': 'traefik', 'container': 'coolify-proxy'}
        page = {'results': TRAEFIK_TAGS, 'next': None}
        with patch.object(sp, 'traefik_version', return_value=(3, 7, 17)):
            plan = sp.plan_target(target, {}, {}, NOW, CONFIG, fetch=lambda url: page)
            self.assertEqual(plan['ref'], 'traefik:v3.7.18@' + DIGEST)
            self.assertEqual(plan['action'], 'patch')
            with self.assertRaises(sp.PatchError):
                sp.plan_target(target, {}, {}, NOW, CONFIG, forced_tag='v3.8.0', fetch=lambda url: page)
            forced = sp.plan_target(target, {}, {}, NOW, CONFIG, forced_tag='v3.7.17', fetch=lambda url: page)
            self.assertEqual((forced['action'], forced['candidate']), ('patch', '3.7.17'))


class Compose(unittest.TestCase):
    def test_only_the_one_image_line_changes(self):
        new, old = sp.replace_image(PROXY, 'traefik', 'traefik:v3.7.18@' + DIGEST)
        self.assertEqual(old, 'traefik@sha256:' + 'a' * 64)
        changed = [(a, b) for a, b in zip(PROXY.splitlines(), new.splitlines()) if a != b]
        self.assertEqual(changed, [("    image: 'traefik@sha256:%s'" % ('a' * 64), "    image: 'traefik:v3.7.18@%s'" % DIGEST)])
        kuma = "services:\n  uptime-kuma:\n    image: 'louislam/uptime-kuma:2.5.9-rootless'\n"
        self.assertEqual(sp.kuma_version(kuma), (2, 5, 9))
        with self.assertRaises(sp.PatchError):
            sp.replace_image(PROXY + "  other:\n    image: traefik:v3\n", 'traefik', 'x')

    def test_regressions_count_only_hosts_that_answered_before(self):
        before = {'a.test': '200', 'b.test': '503', 'c.test': '302', 'd.test': '404'}
        after = {'a.test': '000', 'b.test': '503', 'c.test': '302', 'd.test': '502'}
        self.assertEqual(sp.regressions(before, after), ['a.test', 'd.test'])

    def test_policy_pin_moves_and_records_the_exact_hash_file_integrity_accepts(self):
        with tempfile.TemporaryDirectory() as folder:
            policy, record = Path(folder, 'container-policy.json'), Path(folder, 'record.json')
            policy.write_text(json.dumps({'schema': 2, 'policies': [
                {'resource': 'traefik', 'selector': {'name': 'coolify-proxy'}, 'expected': {'imageId': 'sha256:old'}},
                {'resource': 'kuma', 'selector': {'name': 'uptime-kuma-x'}, 'expected': {'uid': 1000}}]}))
            before, changed = sp.policy_pin('coolify-proxy', 'sha256:new', policy, record)
            self.assertTrue(changed)
            saved = json.loads(record.read_text())
            self.assertEqual(saved['sha256'], hashlib.sha256(policy.read_bytes()).hexdigest())
            self.assertEqual(json.loads(policy.read_text())['policies'][0]['expected']['imageId'], 'sha256:new')
            self.assertEqual(sp.policy_pin('uptime-kuma-x', 'sha256:new', policy, record)[1], False, 'no pin, no write')
            sp.write_policy(before, policy, record)
            self.assertEqual(json.loads(record.read_text())['sha256'], hashlib.sha256(before.encode()).hexdigest())


class FakeProxy:
    """Enough Docker for patch_traefik: compose up recreates, network connect reattaches."""

    def __init__(self, folder, new_routes_fail=False):
        self.compose = Path(folder, 'docker-compose.yml')
        self.compose.write_text(PROXY)
        self.networks = {'coolify', 'hatchkit-docker-discovery', 'app-1', 'app-2'}
        self.image = 'sha256:old'
        self.new_routes_fail = new_routes_fail
        self.calls = []

    def run(self, args, timeout=120, check=False, input=None, cwd=None):
        self.calls.append(args)
        if args[:2] == ['docker', 'compose']:
            self.image = 'sha256:new' if 'v3.7.18' in self.compose.read_text() else 'sha256:old'
            self.networks = {'coolify', 'hatchkit-docker-discovery'}  # the trap: runtime networks are gone
        elif args[:3] == ['docker', 'network', 'connect']:
            self.networks.add(args[3])
        return NS(returncode=0, stdout='', stderr='')

    def inspect(self, name):
        return {'Image': self.image, 'NetworkSettings': {'Networks': {n: {} for n in self.networks}},
                'Config': {}, 'Mounts': []}

    def statuses(self, hosts, fetch=None):
        ok = self.networks >= {'app-1', 'app-2'} and not (self.new_routes_fail and self.image == 'sha256:new')
        return {h: '200' if ok else '000' for h in hosts}


class Swap(unittest.TestCase):
    def swap(self, **fake_options):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        fake = FakeProxy(folder.name, **fake_options)
        policy = Path(folder.name, 'policy.json')
        policy.write_text(json.dumps({'policies': [{'selector': {'name': 'coolify-proxy'},
                                                    'expected': {'imageId': 'sha256:old'}}]}))
        target = {'name': 'traefik', 'kind': 'traefik', 'container': 'coolify-proxy', 'compose': str(fake.compose)}
        with patch.object(sp, 'run', fake.run), patch.object(sp, 'inspect', fake.inspect), \
                patch.object(sp, 'statuses', fake.statuses), patch.object(sp, 'pull', return_value='sha256:new'), \
                patch.object(sp, 'traefik_canary'), patch.object(sp, 'routed_hosts', return_value=['a.test', 'b.test']), \
                patch.object(sp, 'wait_healthy', lambda name, image, seconds: (fake.image == image, {})), \
                patch.object(sp, 'SNAPSHOTS', Path(folder.name, 'snap')), patch.object(sp, 'POLICY', policy), \
                patch.object(sp, 'POLICY_RECORD', Path(folder.name, 'record.json')), patch.object(sp.time, 'sleep'):
            try:
                result = sp.patch_traefik(target, 'traefik:v3.7.18@' + DIGEST, False, lambda m: None)
            except sp.RolledBack as error:
                result = error
        return fake, policy, result

    def test_a_good_patch_reconnects_the_app_networks_and_moves_the_pin(self):
        fake, policy, result = self.swap()
        self.assertEqual(result['to'], 'traefik:v3.7.18@' + DIGEST)
        self.assertEqual(fake.image, 'sha256:new')
        self.assertLessEqual({'app-1', 'app-2'}, fake.networks)
        self.assertEqual(json.loads(policy.read_text())['policies'][0]['expected']['imageId'], 'sha256:new')
        self.assertIn(['docker', 'compose', '-f', str(fake.compose), 'up', '-d', '--no-deps', 'traefik'], fake.calls)
        self.assertTrue(list(Path(fake.compose.parent, 'backups').glob('docker-compose.before-service-patch-*.yml')))

    def test_failing_routes_roll_back_compose_image_and_pin(self):
        fake, policy, result = self.swap(new_routes_fail=True)
        self.assertIsInstance(result, sp.RolledBack)
        self.assertIn('routes stopped answering: a.test, b.test', result.reason)
        self.assertIsNone(result.rollback_problem)
        self.assertEqual(fake.compose.read_text(), PROXY)
        self.assertEqual(fake.image, 'sha256:old')
        self.assertLessEqual({'app-1', 'app-2'}, fake.networks)
        self.assertEqual(json.loads(policy.read_text())['policies'][0]['expected']['imageId'], 'sha256:old')


class State(unittest.TestCase):
    def test_failures_pause_but_a_passing_operator_test_does_not(self):
        state = {}
        sp.record_attempt(state, 'traefik', {'status': 'rolled-back', 'test': True, 'checksPassed': True})
        self.assertFalse(state['targets']['traefik'].get('paused'))
        sp.record_attempt(state, 'traefik', {'status': 'rollback-failed', 'test': True})
        self.assertTrue(state['targets']['traefik']['paused'])
        state = {}
        sp.record_attempt(state, 'kuma', {'status': 'canary-failed'})
        self.assertTrue(state['targets']['kuma']['paused'])
        for _ in range(15):
            sp.record_attempt(state, 'kuma', {'status': 'landed'})
        self.assertEqual(len(state['targets']['kuma']['attempts']), 10)

    def test_no_secret_reaches_the_output_of_a_plan(self):
        target = {'name': 'traefik', 'kind': 'traefik', 'container': 'coolify-proxy'}
        with patch.object(sp, 'traefik_version', return_value=(3, 7, 17)):
            plan = sp.plan_target(target, {}, {}, NOW, CONFIG, fetch=lambda url: {'results': TRAEFIK_TAGS})
        self.assertNotIn('SECRET', json.dumps(plan))


if __name__ == '__main__':
    unittest.main(verbosity=1)
