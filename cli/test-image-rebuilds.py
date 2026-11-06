#!/usr/bin/env python3
"""Automatic base-image rebuilds: opt-in, rate limits, the stateful refusal, the run
lifecycle, and that nothing here edits the ledger or carries package data off the host."""
import copy
import datetime as dt
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('rebuilds', HERE / 'src/templates/update-watch/image-rebuilds.py')
rb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rb)

NOW = dt.datetime(2026, 11, 6, 12, 0, tzinfo=dt.timezone.utc)
HOUR = dt.timedelta(hours=1)
IMAGE = 'ghcr.io/owner/app-server'
OTHER = 'ghcr.io/owner/other-server'


def config(*apps, **extra):
    return {'version': 1, 'apps': list(apps) or [app()], **extra}


def app(image=IMAGE, repo='owner/app', **extra):
    return {'image': image, 'repo': repo, 'workflow': 'base-refresh.yml', 'ref': 'main', **extra}


def container(name='app-abc', image_id='sha256:old', repository=IMAGE, mounts=()):
    return {'name': name, 'imageId': image_id, 'repository': repository, 'mounts': list(mounts)}


def row(number=1, image_id='sha256:old', due=NOW + 24 * HOUR, fixed='8.14.1-2+deb13u2', name='curl', **extra):
    return {**extra, 'kind': 'image-package', 'service': image_id, 'id': 'CVE-2026-%04d' % number, 'name': name,
            'version': '8.14.1-2', 'fixed': fixed, 'severity': 'high', 'containers': ['app-abc'],
            'dueAt': due.isoformat(), 'environment': 'PRIVATE_VALUE'}


def ledger(*rows, checked=NOW - HOUR):
    return {'checkedAt': checked.isoformat(), 'findings': list(rows)}


def scan(*images, checked):
    return {'complete': True, 'checkedAt': checked.isoformat(),
            'images': [{'image': i, 'scannedAt': checked.isoformat()} for i in images]}


class FakeGitHub:
    def __init__(self, runs=(), run=None, fail=None):
        self.calls, self.runs, self.run, self.fail = [], list(runs), run, fail

    def __call__(self, method, path, body=None):
        self.calls.append((method, path, copy.deepcopy(body)))
        if self.fail:
            raise rb.GitHubError(method + ' ' + path, self.fail)
        if method == 'POST':
            return {}
        if '/runs?' in path:
            return {'workflow_runs': self.runs}
        return self.run or {}


def run_pass(previous=None, inventory=None, led=None, gh=None, now=NOW, cfg=None, sc=None, token='t', dry_run=False):
    return rb.run_pass(now, cfg or config(), token, [container()] if inventory is None else inventory,
                       ledger(row()) if led is None else led, sc, previous, gh or FakeGitHub(), dry_run=dry_run)


class ConfigTests(unittest.TestCase):
    def test_malformed_config_is_an_error_not_an_empty_list(self):
        for raw in (None, {}, {'version': 2, 'apps': []}, {'version': 1, 'apps': [{'image': 'docker.io/x'}]},
                    config(app(), app()), config(app(extra=1)), config(maxDispatchesPerDay=50),
                    config(app(inputs={'a': 1})), config(app(ref='../main'))):
            with self.assertRaises(rb.ConfigError):
                rb.load_config(raw)

    def test_databases_are_refused_whatever_the_config_says(self):
        apps, refused, _ = rb.load_config(config(app('ghcr.io/owner/app-postgres'), app('ghcr.io/owner/plausible-db'),
                                                 app('ghcr.io/owner/game-redis'), app()))
        self.assertEqual([a['image'] for a in apps], [IMAGE])
        self.assertEqual(len(refused), 3)

    def test_interval_cannot_go_below_twelve_hours(self):
        apps, _, per_day = rb.load_config(config(app(minIntervalHours=1)))
        self.assertEqual(apps[0]['interval'], 12 * HOUR)
        self.assertEqual(per_day, rb.DEFAULT_PER_DAY)

    def test_invalid_config_dispatches_nothing_and_says_why(self):
        gh = FakeGitHub()
        state = run_pass(cfg={'version': 1}, gh=gh)
        self.assertFalse(state['ok'])
        self.assertIn('config is invalid', state['error'])
        self.assertEqual(gh.calls, [])


class InventoryTests(unittest.TestCase):
    def test_repository_strips_tag_and_digest_but_keeps_registry_port(self):
        self.assertEqual(rb.repository_of('ghcr.io/o/r:live'), 'ghcr.io/o/r')
        self.assertEqual(rb.repository_of('ghcr.io/o/r@sha256:abc'), 'ghcr.io/o/r')
        self.assertEqual(rb.repository_of('registry:5000/o/r'), 'registry:5000/o/r')

    def test_inspect_reads_only_names_images_and_mounts(self):
        line = '\t'.join(json.dumps(v) for v in ('/app-abc', 'sha256:old', 'ghcr.io/owner/app-server:live',
                                                 [{'Type': 'volume', 'RW': True, 'Destination': '/data'}]))
        calls = []

        def docker(argv):
            calls.append(argv)
            return 'id1\n' if argv[0] == 'ps' else line + '\n'
        found = rb.containers(docker)
        self.assertEqual(found[0]['repository'], IMAGE)
        self.assertEqual(found[0]['mounts'], [{'type': 'volume', 'rw': True, 'destination': '/data'}])
        self.assertNotIn('Env', ' '.join(calls[1]))


class PlanTests(unittest.TestCase):
    def test_dispatches_the_owning_workflow_without_package_data(self):
        gh = FakeGitHub()
        state = run_pass(cfg=config(app(inputs={'operation': 'base-refresh'})), gh=gh)
        method, path, body = gh.calls[-1]
        self.assertEqual((method, path), ('POST', '/repos/owner/app/actions/workflows/base-refresh.yml/dispatches'))
        self.assertEqual(body, {'ref': 'main', 'inputs': {'operation': 'base-refresh'}})
        attempt = state['apps'][IMAGE]['attempts'][-1]
        self.assertEqual(attempt['status'], 'dispatched')
        self.assertEqual(attempt['imageIdsBefore'], ['sha256:old'])
        self.assertEqual(attempt['fixCountBefore'], 1)
        self.assertEqual(attempt['workloads'], ['app-abc'])
        state = run_pass(led=ledger(row(containerDisplayNames=['app-server'])))
        self.assertEqual(state['apps'][IMAGE]['attempts'][-1]['workloads'], ['app-server'])
        self.assertNotIn('PRIVATE_VALUE', json.dumps(state))

    def test_not_running_unopted_or_unfixable_images_are_left_alone(self):
        for inventory, led in (([], ledger(row())), ([container(repository=OTHER)], ledger(row())),
                               ([container()], ledger(row(fixed=None))), ([container(image_id='sha256:new')], ledger(row()))):
            gh = FakeGitHub()
            run_pass(inventory=inventory, led=led, gh=gh)
            self.assertEqual(gh.calls, [], inventory)

    def test_writable_mounts_mean_stateful_and_are_refused(self):
        gh = FakeGitHub()
        state = run_pass(inventory=[container(mounts=[{'type': 'volume', 'rw': True, 'destination': '/data'}])], gh=gh)
        self.assertEqual(gh.calls, [])
        self.assertIn('writable mounts', state['decisions'][0]['reason'])
        gh = FakeGitHub()
        run_pass(inventory=[container(mounts=[{'type': 'bind', 'rw': False, 'destination': '/certs'}])], gh=gh)
        self.assertEqual(gh.calls[-1][0], 'POST')

    def test_one_dispatch_per_pass_earliest_deadline_first(self):
        cfg = config(app(), app(OTHER, 'owner/other'))
        inventory = [container(), container('other-1', 'sha256:o', OTHER)]
        led = ledger(row(1, due=NOW + 48 * HOUR), row(2, 'sha256:o', due=NOW + HOUR))
        gh = FakeGitHub()
        state = run_pass(cfg=cfg, inventory=inventory, led=led, gh=gh)
        self.assertEqual([c for c in gh.calls if c[0] == 'POST'][0][1], '/repos/owner/other/actions/workflows/base-refresh.yml/dispatches')
        self.assertEqual({d['image']: d['action'] for d in state['decisions']}, {IMAGE: 'skip', OTHER: 'dispatch'})

    def test_daily_cap_counts_every_app(self):
        cfg = config(app(), app(OTHER, 'owner/other'), maxDispatchesPerDay=1)
        previous = {'apps': {OTHER: {'attempts': [{'dispatchedAt': (NOW - 2 * HOUR).isoformat(), 'status': 'landed',
                                                   'verifiedAt': (NOW - HOUR).isoformat()}]}}}
        gh = FakeGitHub()
        state = run_pass(previous, cfg=cfg, gh=gh)
        self.assertEqual(gh.calls, [])
        self.assertIn('daily limit', state['decisions'][0]['reason'])

    def test_interval_and_same_fixes_pause(self):
        landed = {'dispatchedAt': (NOW - 30 * HOUR).isoformat(), 'status': 'landed', 'verifiedAt': (NOW - 29 * HOUR).isoformat(),
                  'fixesAfter': [['CVE-2026-0001', 'curl']]}
        gh = FakeGitHub()
        state = run_pass({'apps': {IMAGE: {'attempts': [landed]}}}, gh=gh)
        self.assertEqual(gh.calls, [])
        self.assertIn('waiting for the base image', state['decisions'][0]['reason'])
        # A new fix appears: rebuild again.
        gh = FakeGitHub()
        run_pass({'apps': {IMAGE: {'attempts': [landed]}}}, led=ledger(row(1), row(2)), gh=gh)
        self.assertEqual(gh.calls[-1][0], 'POST')
        # A week later the same leftovers are tried once more.
        gh = FakeGitHub()
        run_pass({'apps': {IMAGE: {'attempts': [landed]}}}, gh=gh, now=NOW + 7 * 24 * HOUR,
                 led=ledger(row(), checked=NOW + 7 * 24 * HOUR - HOUR))
        self.assertEqual(gh.calls[-1][0], 'POST')
        recent = dict(landed, dispatchedAt=(NOW - 2 * HOUR).isoformat(), fixesAfter=[])
        gh = FakeGitHub()
        state = run_pass({'apps': {IMAGE: {'attempts': [recent]}}}, gh=gh)
        self.assertIn('less than 24 hours', state['decisions'][0]['reason'])

    def test_stale_ledger_or_missing_token_dispatches_nothing(self):
        gh = FakeGitHub()
        state = run_pass(led=ledger(row(), checked=NOW - 30 * HOUR), gh=gh)
        self.assertFalse(state['ok'])
        self.assertEqual(gh.calls, [])
        state = run_pass(token=None, gh=gh)
        self.assertIn('token', state['error'])
        self.assertEqual(gh.calls, [])

    def test_plan_mode_writes_nothing_and_calls_nothing(self):
        gh = FakeGitHub()
        state = run_pass(gh=gh, token=None, dry_run=True)
        self.assertEqual(gh.calls, [])
        self.assertEqual(state['decisions'][0]['action'], 'dispatch')
        self.assertEqual(state['apps'][IMAGE]['attempts'], [])

    def test_dispatch_error_keeps_only_the_status(self):
        state = run_pass(gh=FakeGitHub(fail=404))
        attempt = state['apps'][IMAGE]['attempts'][-1]
        self.assertEqual(attempt['status'], 'dispatch-failed')
        self.assertIn('HTTP 404', attempt['reason'])


class LifecycleTests(unittest.TestCase):
    def dispatched(self):
        return run_pass()

    def test_failed_run_pauses_until_cleared(self):
        state = self.dispatched()
        run = {'id': 7, 'html_url': 'https://github.com/owner/app/actions/runs/7', 'created_at': NOW.isoformat()}
        state = run_pass(state, gh=FakeGitHub(runs=[run], run={'status': 'completed', 'conclusion': 'failure'}),
                         now=NOW + HOUR, led=ledger(row(), checked=NOW))
        attempt = state['apps'][IMAGE]['attempts'][-1]
        self.assertEqual((attempt['status'], attempt['runId']), ('failed', 7))
        later = NOW + 48 * HOUR
        gh = FakeGitHub()
        state = run_pass(state, gh=gh, now=later, led=ledger(row(), checked=later - HOUR))
        self.assertEqual([c for c in gh.calls if c[0] == 'POST'], [])
        self.assertIn('paused', state['decisions'][0]['reason'])
        self.assertTrue(rb.clear(state, IMAGE, later))
        gh = FakeGitHub()
        run_pass(state, gh=gh, now=later, led=ledger(row(), checked=later - HOUR))
        self.assertEqual(gh.calls[-1][0], 'POST')

    def test_success_counts_only_once_the_host_runs_and_scanned_a_new_image(self):
        state = self.dispatched()
        run = {'id': 9, 'html_url': 'u', 'created_at': NOW.isoformat(), 'status': 'completed', 'conclusion': 'success',
               'updated_at': (NOW + HOUR).isoformat()}
        gh = FakeGitHub(runs=[run], run=run)
        # Run done, host still on the old image: wait.
        state = run_pass(state, gh=gh, now=NOW + 90 * rb.dt.timedelta(minutes=1), led=ledger(row(), checked=NOW))
        self.assertEqual(state['apps'][IMAGE]['attempts'][-1]['status'], 'succeeded')
        # New image running but not scanned yet: wait.
        new = [container(image_id='sha256:new')]
        state = run_pass(state, gh=gh, inventory=new, now=NOW + 2 * HOUR, led=ledger(row(), checked=NOW),
                         sc=scan('sha256:old', checked=NOW))
        self.assertEqual(state['apps'][IMAGE]['attempts'][-1]['status'], 'succeeded')
        # Scanned after the run: landed, with what the rebuild left behind.
        led = ledger(row(1), row(2, 'sha256:new'), checked=NOW + 3 * HOUR)
        state = run_pass(state, gh=gh, inventory=new, now=NOW + 3 * HOUR, led=led, sc=scan('sha256:new', checked=NOW + 3 * HOUR))
        attempt = state['apps'][IMAGE]['attempts'][-1]
        self.assertEqual((attempt['status'], attempt['fixCountBefore'], attempt['fixCountAfter']), ('landed', 1, 1))
        self.assertEqual(attempt['fixesAfter'], [['CVE-2026-0002', 'curl']])

    def test_success_that_never_lands_pauses(self):
        state = self.dispatched()
        run = {'id': 9, 'html_url': 'u', 'created_at': NOW.isoformat(), 'status': 'completed', 'conclusion': 'success',
               'updated_at': NOW.isoformat()}
        state = run_pass(state, gh=FakeGitHub(runs=[run], run=run), now=NOW + 3 * HOUR, led=ledger(row(), checked=NOW))
        self.assertEqual(state['apps'][IMAGE]['attempts'][-1]['status'], 'not-landed')

    def test_a_run_that_never_appears_fails(self):
        state = self.dispatched()
        state = run_pass(state, gh=FakeGitHub(), now=NOW + HOUR, led=ledger(row(), checked=NOW))
        self.assertEqual(state['apps'][IMAGE]['attempts'][-1]['status'], 'failed')

    def test_ledger_is_never_written(self):
        with tempfile.TemporaryDirectory() as temp:
            work = Path(temp)
            led = ledger(row())
            (work / rb.LEDGER_NAME).write_text(json.dumps(led))
            (work / rb.CONFIG.name).write_text(json.dumps(config()))
            (work / 'token').write_text('t')
            with patch.object(rb, 'WORK', work), patch.object(rb, 'CONFIG', work / rb.CONFIG.name), \
                    patch.object(rb, 'TOKEN', work / 'token'), patch.object(rb, 'containers', return_value=[container()]), \
                    patch.object(rb, 'github', return_value={}), patch.object(rb, 'now_utc', return_value=NOW), \
                    patch('sys.stdout'):
                rb.main(['run'])
            self.assertEqual(json.loads((work / rb.LEDGER_NAME).read_text()), led)
            self.assertEqual(json.loads((work / rb.STATE_NAME).read_text())['apps'][IMAGE]['attempts'][-1]['status'], 'dispatched')


if __name__ == '__main__':
    unittest.main()
