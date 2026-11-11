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
        self.assertIn(['docker', 'compose', '-f', str(fake.compose), 'up', '-d', '--no-deps', '--force-recreate', 'traefik'], fake.calls)
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


PG_OLD = 'postgres:18.6-alpine@sha256:' + 'a' * 64
PG_COMPOSE = """services:
  listmonk:
    image: 'hatchkit-security/listmonk-x:20261024'
  postgres:
    image: '%s'
    environment:
      POSTGRES_PASSWORD: SECRET_THAT_MUST_NOT_LEAK
""" % PG_OLD
PG_TAGS = [tag('18.6-alpine', digest='sha256:' + 'a' * 64), tag('18.6-alpine3.24'), tag('18.6'),
           tag('18-alpine'), tag('19.0-alpine'), tag('17.9-alpine'), tag('18.6-bookworm')]


class Postgres(unittest.TestCase):
    def test_a_rebuild_of_the_running_tag_or_a_higher_minor_of_the_major_is_picked(self):
        current, running = (18, 6), 'sha256:' + 'a' * 64
        self.assertIsNone(sp.pick_postgres(current, running, PG_TAGS))
        rebuilt = PG_TAGS + [tag('18.6-alpine', digest=DIGEST)]
        self.assertEqual(sp.pick_postgres(current, running, rebuilt[-1:])[1]['digest'], DIGEST)
        self.assertEqual(sp.pick_postgres(current, running, PG_TAGS + [tag('18.7-alpine')])[0], (18, 7))

    def plan(self, compose_text, tags, **options):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        compose = Path(folder.name, 'docker-compose.yml')
        compose.write_text(compose_text)
        target = {'name': 'listmonk-db', 'kind': 'postgres', 'container': 'postgres-x', 'compose': str(compose)}
        return sp.plan_target(target, {}, {}, NOW, CONFIG, fetch=lambda url: {'results': tags}, **options)

    def test_plan_pins_the_rebuild_by_digest_and_never_crosses_a_major(self):
        plan = self.plan(PG_COMPOSE, [tag('18.6-alpine', digest=DIGEST), tag('19.0-alpine')])
        self.assertEqual((plan['action'], plan['ref'], plan['rebuild']), ('patch', 'postgres:18.6-alpine@' + DIGEST, DIGEST))
        self.assertEqual(self.plan(PG_COMPOSE, PG_TAGS)['action'], 'none')
        with self.assertRaises(sp.PatchError):
            self.plan(PG_COMPOSE, [tag('19.0-alpine')], forced_tag='19.0-alpine')
        self.assertNotIn('SECRET', json.dumps(plan))

    def test_a_floating_or_derived_compose_image_is_refused(self):
        for ref in ('postgres:18-alpine', 'postgres:18.6-alpine', 'hatchkit-security/postgres:listmonk-18.6'):
            with self.assertRaises(sp.PatchError):
                sp.postgres_ref(PG_COMPOSE.replace(PG_OLD, ref))

    def test_canaries_must_agree(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        shapes = iter([{'listmonk': [9, 400]}, {'listmonk': [9, 399]}])
        with patch.object(sp, 'run', return_value=NS(returncode=0, stdout='', stderr='')), \
                patch.object(sp, 'volume_path', return_value=Path(folder.name)), \
                patch.object(sp, 'pg_ready', return_value=True), patch.object(sp, 'pg_shape', lambda name: next(shapes)):
            with self.assertRaisesRegex(sp.PatchError, 'differ from the old image'):
                sp.postgres_canaries({'Config': {'Env': ['POSTGRES_USER=x']}, 'HostConfig': {}}, PG_OLD,
                                     'postgres:18.6-alpine@' + DIGEST, Path(folder.name), '/var/lib/postgresql', folder.name)
        self.assertEqual(list(Path(folder.name).glob('canary.env')), [])


class Sync(unittest.TestCase):
    def test_the_script_goes_over_stdin_with_database_parts_and_standalone_rows(self):
        calls = []

        def fake_run(args, timeout=120, check=False, input=None, cwd=None):
            calls.append((args, input))
            return NS(returncode=0, stdout='[]\n', stderr='')
        sync = {'services': [{'uuid': 'u1', 'app': 'postgres', 'container': 'postgres-u1', 'kind': 'postgres',
                              'part': 'database'}], 'standalonePostgres': ['g145']}
        with patch.object(sp, 'run', fake_run):
            sp.sync_coolify(sync, False)
        (args, stdin), = calls
        self.assertEqual((args[-1], stdin), ('php', sp.SYNC_PHP))
        self.assertFalse(any('/tmp' in a for a in args))
        sent = json.loads(next(a for a in args if a.startswith('HK_ARGS='))[len('HK_ARGS='):])
        self.assertEqual((sent['services'][0]['part'], sent['services'][0]['prefix']), ('database', 'postgres:'))
        self.assertEqual(sent['standalone'][0]['uuid'], 'g145')


class Clients(unittest.TestCase):
    def test_a_prefix_finds_the_stamped_app_container(self):
        ps = NS(returncode=0, stdout='o5uf-20261106T055016\nazwms\no5uf-old-rollback\n', stderr='')
        with patch.object(sp, 'run', return_value=ps):
            self.assertEqual(sp.client_names(['o5uf-2*', 'listmonk-x']), ['o5uf-20261106T055016', 'listmonk-x'])


class FakePostgres:
    """Enough Docker for patch_postgres: compose up recreates on whatever the file names."""

    def __init__(self, folder, new_fails=False):
        self.compose = Path(folder, 'docker-compose.yml')
        self.compose.write_text(PG_COMPOSE)
        self.image = 'sha256:old'
        self.new_fails = new_fails
        self.calls = []

    def run(self, args, timeout=120, check=False, input=None, cwd=None):
        self.calls.append(args)
        if args[:2] == ['docker', 'compose']:
            self.image = 'sha256:new' if DIGEST in self.compose.read_text() else 'sha256:old'
        return NS(returncode=0, stdout='', stderr='')

    def inspect(self, name):
        ref = PG_OLD if self.image == 'sha256:old' else 'postgres:18.6-alpine@' + DIGEST
        return {'Image': self.image, 'State': {'Running': True}, 'HostConfig': {},
                'Config': {'Image': ref, 'Env': []},
                'Mounts': [{'Type': 'volume', 'Name': 'x_postgres-data', 'Destination': '/var/lib/postgresql'}]}

    def wait_healthy(self, name, image, seconds):
        return (self.image == image and not (self.new_fails and image == 'sha256:new')), {'status': 'unhealthy'}


class PostgresSwap(unittest.TestCase):
    def swap(self, **fake_options):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        fake = FakePostgres(folder.name, **fake_options)
        policy = Path(folder.name, 'policy.json')
        policy.write_text(json.dumps({'policies': [{'selector': {'name': 'postgres-x'},
                                                    'expected': {'imageId': 'sha256:old'}}]}))
        target = {'name': 'listmonk-db', 'kind': 'postgres', 'container': 'postgres-x', 'compose': str(fake.compose),
                  'project': 'x', 'composeService': 'postgres', 'clients': ['listmonk-x']}
        with patch.object(sp, 'run', fake.run), patch.object(sp, 'inspect', fake.inspect), \
                patch.object(sp, 'pull', return_value='sha256:new'), patch.object(sp, 'pg_major', return_value=18), \
                patch.object(sp, 'pg_shape', return_value={'listmonk': 9}), \
                patch.object(sp, 'postgres_canaries', return_value=[{'listmonk': [9, 4]}] * 2), \
                patch.object(sp, 'volume_path', return_value=Path(folder.name, 'vol')), \
                patch.object(sp, 'client_health', return_value={'listmonk-x': 'healthy'}), \
                patch.object(sp, 'wait_healthy', fake.wait_healthy), \
                patch.object(sp, 'SNAPSHOTS', Path(folder.name, 'snap')), patch.object(sp, 'POLICY', policy), \
                patch.object(sp, 'POLICY_RECORD', Path(folder.name, 'record.json')):
            try:
                result = sp.patch_postgres(target, 'postgres:18.6-alpine@' + DIGEST, False, lambda m: None)
            except sp.RolledBack as error:
                result = error
        return fake, policy, result

    def test_a_good_rebuild_lands_with_the_pin_and_only_the_db_service_recreated(self):
        fake, policy, result = self.swap()
        self.assertEqual((result['to'], result['clients']), ('postgres:18.6-alpine@' + DIGEST, {'listmonk-x': 'healthy'}))
        self.assertEqual(json.loads(policy.read_text())['policies'][0]['expected']['imageId'], 'sha256:new')
        self.assertIn(['docker', 'compose', '-p', 'x', '-f', str(fake.compose), 'up', '-d', '--no-deps',
                       '--force-recreate', 'postgres'], fake.calls)
        self.assertIn("hatchkit-security/listmonk-x:20261024", fake.compose.read_text())
        self.assertLess(fake.calls.index(['docker', 'stop', '-t', '120', 'postgres-x']),
                        next(i for i, c in enumerate(fake.calls) if c[:2] == ['docker', 'compose']))

    def test_an_unhealthy_new_image_rolls_back_compose_and_pin_without_touching_data(self):
        fake, policy, result = self.swap(new_fails=True)
        self.assertIsInstance(result, sp.RolledBack)
        self.assertIsNone(result.rollback_problem)
        self.assertEqual((fake.compose.read_text(), fake.image), (PG_COMPOSE, 'sha256:old'))
        self.assertEqual(json.loads(policy.read_text())['policies'][0]['expected']['imageId'], 'sha256:old')
        restores = [c for c in fake.calls if c[0] == 'rsync' and c[-1].rstrip('/').endswith('vol')]
        self.assertEqual(restores, [])


OVERLAY_REF = 'localhost/hatchkit-overlay/uptime-kuma:2.5.9-rootless-hk1'
BASE_DIGEST = 'sha256:' + 'c' * 64
OVERLAY = {'ref': OVERLAY_REF, 'n': 1, 'base': 'louislam/uptime-kuma:2.5.9-rootless@' + BASE_DIGEST,
           'baseTag': '2.5.9-rootless', 'packages': {'libbrotli1': '1.0.9-2+deb12u1', 'chromium': '156.0'}}


def string_ge(a, b):  # fixture versions are chosen so plain string order is Debian order
    return a >= b


class Overlay(unittest.TestCase):
    def compose(self, folder, ref):
        path = Path(folder) / 'docker-compose.yml'
        path.write_text("services:\n  uptime-kuma:\n    image: '%s'\n" % ref)
        return {'name': 'uptime-kuma', 'kind': 'kuma', 'compose': str(path)}

    def plan(self, tags, have, state=None, ref=OVERLAY_REF):
        with tempfile.TemporaryDirectory() as folder, patch.object(sp, 'version_ge', string_ge):
            target = self.compose(folder, ref)
            asked = []
            versions = lambda r: asked.append(r) or have
            plan = sp.plan_target(target, {'overlay': OVERLAY} if state is None else state, {}, NOW.replace(hour=14),
                                  CONFIG, fetch=lambda url: {'results': tags}, versions=versions)
            return plan, asked

    def test_an_overlay_counts_as_the_upstream_tag_it_was_built_on(self):
        text = "services:\n  uptime-kuma:\n    image: '%s'\n" % OVERLAY_REF
        self.assertEqual(sp.kuma_version(text), (2, 5, 9))
        new, old = sp.replace_image(text, 'kuma', 'louislam/uptime-kuma:2.5.10-rootless')
        self.assertEqual(old, OVERLAY_REF)
        self.assertIn("'louislam/uptime-kuma:2.5.10-rootless'", new)

    def test_the_overlay_is_never_pulled_from_a_registry(self):
        calls = []
        with patch.object(sp, 'run', side_effect=lambda args, **k: calls.append(args) or NS(returncode=0, stdout='sha256:local\n', stderr='')):
            self.assertEqual(sp.pull(OVERLAY_REF), 'sha256:local')
        self.assertFalse([c for c in calls if c[:2] == ['docker', 'pull']])
        self.assertTrue(OVERLAY_REF.startswith('localhost/'), 'a registry host, never a Docker Hub namespace')

    def test_the_dockerfile_only_upgrades_the_named_packages_and_restores_the_user(self):
        text = sp.overlay_dockerfile(OVERLAY['base'], 'node', ['chromium', 'libbrotli1'])
        lines = text.splitlines()
        self.assertEqual(lines[0], 'FROM ' + OVERLAY['base'])
        self.assertIn('--only-upgrade --no-install-recommends chromium libbrotli1', text)
        self.assertEqual(lines[-1], 'USER node')
        self.assertNotIn('upgrade -y', text.replace('--only-upgrade', ''), 'no blanket dist-upgrade')

    def test_no_newer_upstream_image_keeps_the_overlay(self):
        plan, asked = self.plan([tag('2.5.9-rootless', digest=BASE_DIGEST)], {})
        self.assertEqual((plan['action'], plan['overlay']), ('none', OVERLAY_REF))
        self.assertEqual(asked, [], 'nothing to pull when upstream has nothing new')

    def test_a_patch_release_that_still_lacks_a_fix_keeps_the_overlay(self):
        tags = [tag('2.5.9-rootless', digest=BASE_DIGEST), tag('2.5.10-rootless')]
        plan, asked = self.plan(tags, {'libbrotli1': '1.0.9-2+deb12u1', 'chromium': '155.0'})
        self.assertEqual(plan['action'], 'wait')
        self.assertIn('chromium 156.0', plan['reason'])
        self.assertEqual(asked, ['louislam/uptime-kuma:2.5.10-rootless'])

    def test_the_first_upstream_image_with_every_fix_replaces_the_overlay(self):
        tags = [tag('2.5.9-rootless', digest=BASE_DIGEST), tag('2.5.10-rootless')]
        plan, _ = self.plan(tags, {'libbrotli1': '1.0.9-2+deb12u1', 'chromium': '157.0'})
        self.assertEqual((plan['action'], plan['ref']), ('patch', 'louislam/uptime-kuma:2.5.10-rootless'))

    def test_a_rebuild_of_the_base_tag_with_the_fixes_also_replaces_it(self):
        tags = [tag('2.5.9-rootless', digest='sha256:' + 'd' * 64)]
        plan, asked = self.plan(tags, {'libbrotli1': '1.0.9-2+deb12u1', 'chromium': '156.0'})
        self.assertEqual((plan['action'], plan['ref'], plan.get('rebuild')),
                         ('patch', 'louislam/uptime-kuma:2.5.9-rootless', 'sha256:' + 'd' * 64))

    def test_a_paused_overlay_target_stays_put(self):
        tags = [tag('2.5.10-rootless')]
        plan, asked = self.plan(tags, {}, state={'overlay': OVERLAY, 'paused': True})
        self.assertEqual((plan['action'], asked), ('paused', []))

    def test_an_overlay_without_its_state_record_is_an_error_not_a_patch(self):
        with self.assertRaises(sp.PatchError):
            self.plan([tag('2.5.10-rootless')], {}, state={})

    def test_build_records_only_packages_that_really_moved(self):
        built = []
        def fake(args, **kwargs):
            out = ''
            if args[:3] == ['docker', 'image', 'inspect'] and '{{json .RepoDigests}}' in args:
                out = json.dumps(['louislam/uptime-kuma@' + BASE_DIGEST])
            elif args[:3] == ['docker', 'image', 'inspect'] and '{{.Config.User}}' in args:
                out = 'node\n'
            elif args[:3] == ['docker', 'image', 'inspect']:
                out = 'sha256:x\n'
            elif args[:2] == ['docker', 'run']:
                image = args[args.index('dpkg-query') + 1]
                rows = {'libbrotli1': '1.0.9-2+b6', 'chromium': '155.0'} if '@' in image else \
                       {'libbrotli1': '1.0.9-2+deb12u1', 'chromium': '155.0'}
                out = ''.join('%s:amd64\t%s\n' % kv for kv in rows.items())
            elif args[:2] == ['docker', 'build']:
                built.append((args, kwargs['input']))
            return NS(returncode=0, stdout=out, stderr='')
        with tempfile.TemporaryDirectory() as folder, patch.object(sp, 'run', side_effect=fake), \
                patch.object(sp, 'version_ge', string_ge):
            target = self.compose(folder, 'louislam/uptime-kuma:2.5.9-rootless')
            overlay = sp.build_overlay(target, ['libbrotli1', 'chromium'], {}, lambda m: None)
        self.assertEqual(overlay['ref'], OVERLAY_REF)
        self.assertEqual(overlay['base'], 'louislam/uptime-kuma:2.5.9-rootless@' + BASE_DIGEST)
        self.assertEqual(overlay['packages'], {'libbrotli1': '1.0.9-2+deb12u1'})
        self.assertEqual(overlay['unchanged'], ['chromium'])
        self.assertEqual(built[0][0][-1], '-', 'Dockerfile over stdin, no build context')
        self.assertTrue(built[0][1].startswith('FROM louislam/uptime-kuma:2.5.9-rootless@' + BASE_DIGEST))

    def test_landing_upstream_retires_the_overlay_and_deletes_its_image(self):
        record, removed = {'overlay': dict(OVERLAY)}, []
        with patch.object(sp, 'run', side_effect=lambda args, **k: removed.append(args)):
            sp.retire_overlay(record, {'ref': OVERLAY_REF})
            self.assertIn('overlay', record, 'landing the overlay itself retires nothing')
            sp.retire_overlay(record, {'ref': 'louislam/uptime-kuma:2.5.10-rootless'})
        self.assertNotIn('overlay', record)
        self.assertEqual(record['overlayRetired']['retiredBy'], 'louislam/uptime-kuma:2.5.10-rootless')
        self.assertEqual(removed, [['docker', 'image', 'rm', OVERLAY_REF]])

    def test_coolify_sync_accepts_the_overlay_and_upstream_but_nothing_else(self):
        import re
        pattern = re.compile(sp.SYNC_PATTERNS['kuma'].strip('/').replace('\\/', '/'))
        self.assertTrue(pattern.match(OVERLAY_REF))
        self.assertTrue(pattern.match('louislam/uptime-kuma:2.5.10-rootless'))
        self.assertFalse(pattern.match('hatchkit-overlay/uptime-kuma:2.5.9-rootless-hk1'), 'Docker Hub namespace')
        self.assertFalse(pattern.match('louislam/uptime-kuma:2.5.10'))
        self.assertEqual(sp.SYNC_PREFIXES['kuma'], ['louislam/uptime-kuma:', 'localhost/hatchkit-overlay/uptime-kuma:'])


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
