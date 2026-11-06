"""The daily digest: when it sends, what it says, how big it gets, and that the Python
and Worker renderers produce the same mail."""
import base64
import datetime as dt
import email
from email import policy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE / 'src/templates/backups'))
import hatchkit_mail as mail
import ops_digest as digest

# 09:30 in Sydney on Thursday 5 November 2026.
NOW = dt.datetime(2026, 11, 4, 22, 30, tzinfo=dt.timezone.utc)
DAY = dt.timedelta(days=1)
HOST = 'fixture-vps'
SECRET = 'PRIVATE_SMTP_PASSWORD_VALUE'
ALERTS = {'enabled': True, 'to': 'owner@example.test', 'from': 'Backup <noreply@mail.example.test>',
          'smtpFile': '/etc/hatchkit-backups/alert-smtp.json', 'password': SECRET}


def package(number=1, **extra):
    return {'kind': 'image-package', 'service': 'sha256:image', 'id': 'CVE-2026-%04d' % number, 'name': 'openssl',
            'version': '3.0.13', 'fixed': '3.0.16', 'severity': 'high', 'containers': ['opaque-container-id'],
            'containerDisplayNames': ['uptime-kuma'], 'dueAt': (NOW + DAY).isoformat(timespec='seconds'),
            'overdue': False, 'summary': 'scanner match', 'environment': SECRET, **extra}


def direct(**extra):
    return {'kind': 'advisory', 'service': 'coolify', 'name': 'Coolify', 'id': 'GHSA-aaaa-bbbb-cccc', 'severity': 'critical',
            'fixed': '4.1.0', 'dueAt': (NOW - DAY).isoformat(timespec='seconds'), 'overdue': True,
            'summary': 'Coolify 4.0.0: GHSA-aaaa-bbbb-cccc critical, fixed in 4.1.0', **extra}


class DigestCase(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.work = Path(self.folder.name)
        self.units = self.work / 'units'
        self.units.mkdir()
        self.sent = []
        self.write_watch([])

    def tearDown(self):
        self.folder.cleanup()

    def write_watch(self, findings, skipped=(), **extra):
        (self.work / 'update-watch-status.json').write_text(json.dumps(
            {'checkedAt': NOW.isoformat(), 'findings': findings, 'skipped': list(skipped), 'error': None, **extra}))

    def send(self, settings, subject, body):
        self.sent.append((subject, body))
        return '<id-%d@mail.example.test>' % len(self.sent)

    def run_digest(self, now=NOW, issues=(), send=None):
        return digest.run({'alerts': ALERTS}, self.work, send or self.send, HOST, now, list(issues), self.units)


class WhenItSends(DigestCase):
    def test_healthy_days_send_nothing_and_unconfigured_hosts_do_nothing(self):
        self.run_digest()
        self.run_digest(NOW + DAY)
        self.assertEqual(self.sent, [])
        self.assertFalse(digest.run({}, self.work, self.send, HOST, NOW, [], self.units)['sent'])

    def test_one_digest_per_day_while_something_needs_the_owner(self):
        self.write_watch([direct()])
        self.run_digest()
        self.run_digest(NOW + dt.timedelta(hours=1))
        self.assertEqual(len(self.sent), 1)
        self.run_digest(NOW + DAY)
        self.assertEqual(len(self.sent), 2)

    def test_a_finding_after_the_daily_run_waits_for_the_next_day(self):
        self.run_digest()
        self.write_watch([direct()])
        self.run_digest(NOW + dt.timedelta(hours=3))
        self.assertEqual(self.sent, [])
        self.run_digest(NOW + DAY)
        self.assertEqual(len(self.sent), 1)

    def test_failed_delivery_retries_at_the_next_hour_and_records_only_the_type(self):
        self.write_watch([direct()])
        def refuse(*args):
            raise OSError('535 rejected ' + SECRET)
        with self.assertRaises(OSError):
            self.run_digest(send=refuse)
        status = (self.work / digest.STATUS_NAME).read_text()
        self.assertNotIn(SECRET, status)
        self.assertEqual(json.loads(status)['mailError'], 'OSError')
        self.run_digest(NOW + dt.timedelta(hours=1))
        self.assertEqual(len(self.sent), 1)
        self.assertNotIn('mailError', json.loads((self.work / digest.STATUS_NAME).read_text()))

    def test_raw_scanner_matches_mail_weekly_only_and_their_clock_stays_visible(self):
        self.write_watch([package(overdue=True)])
        self.run_digest()
        self.assertEqual(len(self.sent), 1)
        subject, document = self.sent[0]
        self.assertEqual(subject, '[Hatchkit] fixture-vps: 1 needs you')
        self.assertIn('(past due)', document['sections']['needs'][0]['deadline'])
        for days in (1, 2):  # Friday and Saturday
            self.run_digest(NOW + days * DAY)
        self.assertEqual(len(self.sent), 1, 'a new day or a passed deadline must not mail on its own')
        self.write_watch([package(), package(2)])
        self.run_digest(NOW + 3 * DAY)  # Sunday
        self.assertEqual(len(self.sent), 1, 'a new raw match waits for the review')
        self.run_digest(NOW + 4 * DAY)  # Monday, after 09:00 in Sydney
        self.assertEqual(len(self.sent), 2)

    def test_a_cleared_queue_sends_no_empty_weekly_mail(self):
        self.write_watch([package()])
        self.run_digest()
        self.write_watch([])
        self.run_digest(NOW + 7 * DAY)
        self.assertEqual(len(self.sent), 1)

    def test_upgrade_keeps_the_week_the_update_watch_already_reviewed(self):
        self.write_watch([package()], lastWeeklyReviewKey=digest.week_key(NOW))
        self.run_digest()
        self.assertEqual(self.sent, [])

    def test_week_turns_over_at_nine_on_monday_in_sydney(self):
        before = dt.datetime(2026, 10, 25, 21, 59, tzinfo=dt.timezone.utc)  # Monday 08:59 AEDT
        after = before + dt.timedelta(minutes=1)
        self.assertEqual(digest.week_key(before), '2026-W43')
        self.assertEqual(digest.week_key(after), '2026-W44')
        self.assertNotEqual(digest.day_key(before), digest.day_key(after))

    def test_exploited_findings_and_lost_coverage_bypass_the_weekly_gate(self):
        self.write_watch([package()], lastWeeklyReviewKey=digest.week_key(NOW))
        self.run_digest()
        self.assertEqual(self.sent, [])
        self.write_watch([package(knownExploited=True)], lastWeeklyReviewKey=digest.week_key(NOW))
        self.run_digest(NOW + DAY)
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(self.sent[0][1]['sections']['needs'][0]['flags'], ['Known exploited'])
        self.write_watch([package()], ['Image scan failed'], lastWeeklyReviewKey=digest.week_key(NOW))
        self.run_digest(NOW + 2 * DAY)
        self.assertEqual(len(self.sent), 2)
        self.assertEqual(self.sent[1][1]['sections']['unchecked'][0]['what'], 'Image scan failed')
        self.assertEqual(self.sent[1][1]['sections']['needs'], [], 'no raw inventory outside the review')

    def test_vendor_blocked_item_is_news_once_then_weekly(self):
        self.write_watch([direct(fixed=None, dueAt=None, overdue=False)], lastWeeklyReviewKey=digest.week_key(NOW))
        self.run_digest()
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(self.sent[0][0], '[Hatchkit] fixture-vps: 1 waiting')
        self.run_digest(NOW + DAY)
        self.assertEqual(len(self.sent), 1)

    def test_every_stream_reaches_the_digest(self):
        (self.work / 'host-integrity-status.json').write_text(json.dumps({'checkedAt': NOW.isoformat(), 'findings': [{'summary': 'miner pid 1'}], 'skipped': []}))
        (self.work / 'host-integrity-quick-status.json').write_text(json.dumps({'checkedAt': NOW.isoformat(), 'findings': [{'summary': 'miner pid 1'}],
            'skipped': ['Sustained CPU and outbound peers use the daily full scan.', 'plausible: docker diff failed; writable layer not checked.']}))
        (self.work / 'file-integrity-status.json').write_text(json.dumps({'checkedAt': NOW.isoformat(), 'ok': False, 'issue': 'AIDE reported changes', 'log': '/var/lib/hatchkit-security/aide/check.log'}))
        self.write_watch([direct()], ['Traefik: could not read a feed'])
        self.run_digest(issues=['demo: latest backup failed or has never completed.', 'x: registered source(s) y no longer exist. Fix: hatchkit backup sources --project x'])
        sections = self.sent[0][1]['sections']
        needs = [item['what'] for item in sections['needs']]
        self.assertEqual(needs.count('miner pid 1'), 1, 'quick and daily scans report the same finding once')
        for expected in ('Coolify 4.0.0', 'AIDE reported changes', 'demo: latest backup failed'):
            self.assertTrue(any(expected in item for item in needs), expected)
        self.assertTrue(any(item['command'] == 'hatchkit backup sources --project x' for item in sections['needs']))
        unchecked = [item['what'] for item in sections['unchecked']]
        self.assertIn('Traefik: could not read a feed', unchecked)
        self.assertIn('plausible: docker diff failed; writable layer not checked.', unchecked)
        self.assertNotIn('Sustained CPU and outbound peers use the daily full scan.', unchecked)

    def test_auto_fixes_ride_along_but_never_send_a_digest_alone(self):
        accepted = {'at': NOW.isoformat(), 'packages': ['bind9-host', 'bind9-dnsutils'],
                    'previousBaseline': '/var/lib/hatchkit-security/aide/aide.db.before-x'}
        (self.work / 'file-integrity-status.json').write_text(json.dumps(
            {'checkedAt': NOW.isoformat(), 'ok': True, 'autoAccepted': accepted}))
        self.run_digest()
        self.assertEqual(self.sent, [])
        self.write_watch([direct()])
        self.run_digest(NOW + DAY)
        fixed = self.sent[0][1]['sections']['fixed']
        self.assertIn('bind9-dnsutils', fixed[0]['what'])
        self.run_digest(NOW + 3 * DAY)
        self.assertEqual(self.sent[1][1]['sections']['fixed'], [], 'an old auto-fix is not repeated')

    def test_installed_host_updates_are_listed_as_fixed(self):
        self.write_watch([direct()], lastHostPatch={'at': NOW.isoformat(), 'patched': ['openssl', 'libssl3t64']})
        self.run_digest()
        self.assertIn('libssl3t64, openssl', self.sent[0][1]['sections']['fixed'][0]['what'])

    def test_an_auto_renewed_review_is_listed_as_fixed_once(self):
        self.write_watch([direct()], lastAutoRenewal={'at': NOW.isoformat(), 'ids': ['busybox-static-error-pages-20261113']})
        self.run_digest()
        fixed = self.sent[0][1]['sections']['fixed']
        self.assertIn('busybox-static-error-pages-20261113', fixed[0]['what'])
        self.run_digest(NOW + 2 * DAY)
        self.assertEqual(self.sent[1][1]['sections']['fixed'], [])

    def write_rebuilds(self, attempts, checked=NOW, **extra):
        (self.work / digest.REBUILD_STATUS).write_text(json.dumps(
            {'checkedAt': checked.isoformat(), 'ok': True, 'error': None, 'refused': [],
             'apps': {'ghcr.io/o/app-server': {'attempts': attempts}}, **extra}))

    def test_a_landed_rebuild_rides_along_and_never_hides_findings(self):
        landed = {'status': 'landed', 'workloads': ['app-server'], 'verifiedAt': NOW.isoformat(),
                  'fixCountBefore': 12, 'fixCountAfter': 2, 'runUrl': 'https://github.com/o/app/actions/runs/1'}
        self.write_rebuilds([landed])
        self.run_digest()
        self.assertEqual(self.sent, [], 'a rebuild alone sends no digest')
        self.write_watch([direct(), package(1, containerDisplayNames=['app-server'])])
        self.run_digest(NOW + DAY)
        sections = self.sent[0][1]['sections']
        self.assertIn('Rebuilt app-server on a fresh base image', sections['fixed'][0]['what'])
        self.assertIn('12 before, 2 after', sections['fixed'][0]['detail'])
        self.assertIn('keep their deadlines', sections['fixed'][0]['detail'])
        self.assertTrue(any('CVE-2026-0001' in row for row in self.sent[0][1]['paste']['rows']))
        self.run_digest(NOW + 2 * DAY)
        self.assertEqual(self.sent[1][1]['sections']['fixed'], [], 'an old rebuild is not repeated')

    def test_a_failed_rebuild_needs_the_owner_until_cleared(self):
        failed = {'status': 'failed', 'workloads': ['app-server'], 'reason': 'the run ended failure',
                  'runUrl': 'https://github.com/o/app/actions/runs/2'}
        self.write_rebuilds([failed])
        self.run_digest()
        item = self.sent[0][1]['sections']['needs'][0]
        self.assertIn('Automatic rebuild of app-server did not finish', item['what'])
        self.assertEqual(item['command'], digest.REBUILD_COMMAND + ' clear ghcr.io/o/app-server')
        self.write_rebuilds([dict(failed, cleared=True)])
        self.run_digest(NOW + DAY)
        self.assertEqual(len(self.sent), 1)

    def test_rebuild_config_errors_and_refusals_need_the_owner(self):
        self.write_rebuilds([], error='The rebuild config is invalid: x.',
                            refused=[{'image': 'ghcr.io/o/app-postgres', 'reason': 'looks like a database'}])
        self.run_digest()
        whats = [i['what'] for i in self.sent[0][1]['sections']['needs']]
        self.assertIn('The rebuild config is invalid: x.', whats)
        self.assertTrue(any('ghcr.io/o/app-postgres' in w for w in whats))

    def test_rebuild_timer_counts_only_when_enabled(self):
        (self.units / digest.REBUILD_TIMER).write_text('')
        self.run_digest()
        self.assertEqual(self.sent, [], 'an installed but disabled timer is not a gap')
        (self.units / 'timers.target.wants').mkdir()
        (self.units / 'timers.target.wants' / digest.REBUILD_TIMER).write_text('')
        self.write_rebuilds([], checked=NOW - dt.timedelta(hours=4))
        self.run_digest(NOW + DAY)
        self.assertEqual(self.sent[0][1]['sections']['unchecked'][0]['what'],
                         'Automatic image rebuilds have no recent result.')

    def write_patches(self, attempts, checked=NOW, kind='traefik', **extra):
        (self.work / digest.SERVICE_PATCH_STATUS).write_text(json.dumps(
            {'checkedAt': checked.isoformat(), 'error': None,
             'targets': {'traefik': {'kind': kind, 'attempts': attempts, 'lastPlan': {'action': 'none'}}}, **extra}))

    def test_a_landed_service_patch_rides_along_for_a_day(self):
        landed = {'status': 'landed', 'from': '3.7.17', 'to': '3.7.18', 'verifiedAt': NOW.isoformat(),
                  'fixes': ['GHSA-xxxx'], 'detail': {'hostsChecked': 31}}
        self.write_patches([landed])
        self.run_digest()
        self.assertEqual(self.sent, [], 'a patch alone sends no digest')
        self.write_watch([direct()])
        self.run_digest(NOW + DAY)
        item = self.sent[0][1]['sections']['fixed'][0]
        self.assertEqual(item['what'], 'Patched Traefik 3.7.17 to 3.7.18.')
        self.assertIn('Every routed hostname (31) answered', item['detail'])
        self.assertIn('Fixes GHSA-xxxx.', item['detail'])

    def test_a_rolled_back_service_patch_needs_the_owner_until_cleared(self):
        failed = {'status': 'rolled-back', 'from': '3.7.17', 'to': '3.7.18', 'error': 'routes stopped answering: a.test'}
        self.write_patches([failed])
        self.run_digest()
        item = self.sent[0][1]['sections']['needs'][0]
        self.assertEqual(item['what'], 'Automatic patch of Traefik 3.7.17 to 3.7.18 was rolled back.')
        self.assertIn('The previous version is running.', item['detail'])
        self.assertEqual(item['command'], digest.SERVICE_PATCH_COMMAND + ' clear traefik')
        self.write_patches([dict(failed, cleared='x')])
        self.run_digest(NOW + DAY)
        self.assertEqual(len(self.sent), 1)

    def test_an_operator_test_rollback_is_not_news_but_a_failed_rollback_is(self):
        self.write_patches([{'status': 'rolled-back', 'test': True, 'checksPassed': True, 'verifiedAt': NOW.isoformat()}])
        self.run_digest()
        self.assertEqual(self.sent, [])
        self.write_patches([{'status': 'rollback-failed', 'test': True, 'from': '2.5.9', 'to': '2.5.9',
                             'error': 'x', 'rollbackError': 'Kuma not healthy'}], kind='kuma')
        self.run_digest(NOW + DAY)
        item = self.sent[0][1]['sections']['needs'][0]
        self.assertIn('Uptime Kuma 2.5.9 to 2.5.9 failed and its rollback failed too', item['what'])
        self.assertIn('Check the service now', item['detail'])

    def test_a_coolify_copy_that_cannot_follow_needs_the_owner(self):
        self.write_patches([], coolifySync={'at': NOW.isoformat(), 'results': [
            {'kind': 'proxy', 'server': 'srv1', 'status': 'refused', 'reason': 'host file differs from Coolify beyond the image line'},
            {'kind': 'service', 'app': 'uptime-kuma', 'status': 'in-sync'}]})
        self.run_digest()
        whats = [i['what'] for i in self.sent[0][1]['sections']['needs']]
        self.assertEqual(whats, ["Coolify's copy of the proxy of server srv1 does not match the host: "
                                 "host file differs from Coolify beyond the image line."])

    def test_service_patch_timer_counts_only_when_enabled(self):
        (self.units / 'timers.target.wants').mkdir()
        (self.units / 'timers.target.wants' / digest.SERVICE_PATCH_TIMER).write_text('')
        self.write_patches([], checked=NOW - dt.timedelta(hours=4))
        self.run_digest()
        self.assertEqual(self.sent[0][1]['sections']['unchecked'][0]['what'],
                         'Automatic service patches have no recent result.')

    def test_a_check_gone_quiet_is_not_checked_rather_than_clean(self):
        (self.units / 'hatchkit-file-integrity.timer').write_text('')
        self.run_digest()
        self.assertEqual(self.sent[0][1]['sections']['unchecked'][0]['what'], 'File integrity check has no recent result.')
        stale = self.work / 'update-watch-status.json'
        stale.write_text(json.dumps({'checkedAt': (NOW - dt.timedelta(hours=9)).isoformat(), 'findings': []}))
        (self.units / 'hatchkit-update-watch.timer').write_text('')
        self.run_digest(NOW + DAY)
        self.assertTrue(any(i['what'] == 'Update watch has no recent result.' for i in self.sent[1][1]['sections']['unchecked']))


class WhatItSays(DigestCase):
    def rendered(self, findings, issues=(), skipped=()):
        self.write_watch(findings, skipped)
        self.run_digest(issues=issues)
        subject, document = self.sent[-1]
        text, html = mail.render(document)
        return subject, document, text, html

    def test_sections_are_ordered_and_empty_ones_are_omitted(self):
        _, _, text, html = self.rendered([direct(), direct(fixed=None, id='GHSA-wait', summary='vendor wait')], skipped=['Traefik: feed'])
        order = [text.index(label) for label in ('Needs you', 'Waiting on vendor', 'Not checked')]
        self.assertEqual(order, sorted(order))
        self.assertNotIn('Fixed automatically', text)
        self.assertNotIn('Fixed automatically', html)
        self.assertLess(html.index('Needs you'), html.index('Waiting on vendor'))

    def test_fixed_section_renders_when_a_sender_fills_it(self):
        text, html = mail.render({'title': 'x', 'sections': {'needs': [{'what': 'n'}], 'fixed': [{'what': 'f'}]}})
        self.assertLess(text.index('Needs you'), text.index('Fixed automatically'))
        self.assertIn('Fixed automatically', html)

    def test_items_say_what_happened_the_deadline_and_one_command(self):
        _, document, text, _ = self.rendered([direct()])
        item = document['sections']['needs'][0]
        self.assertEqual(item['command'], 'hatchkit host updates --host fixture-vps --json')
        self.assertIn('(past due)', item['deadline'])
        self.assertIn('Run: hatchkit host updates --host fixture-vps --json', text)
        self.assertIn('Deadline: ', text)

    def test_wording_is_factual_and_html_has_no_remote_requests(self):
        _, _, text, html = self.rendered([package(knownExploited=True, overdue=True)])
        for shouty in ('KNOWN EXPLOITED', 'OVERDUE', 'URGENT', '!'):
            self.assertNotIn(shouty, text)
        self.assertIn('Known exploited', text)
        self.assertNotIn('http://', html)
        self.assertNotIn('https://', html)
        self.assertEqual(html.count('<img '), 1)
        self.assertIn('src="cid:hatchkit-icon"', html)
        self.assertNotIn('<a ', html)
        self.assertIn('prefers-color-scheme:dark', html)

    def test_html_escapes_finding_text(self):
        _, _, _, html = self.rendered([direct(summary='<script>alert(1)</script> & co')])
        self.assertNotIn('<script>', html)
        self.assertIn('&lt;script&gt;', html)

    def test_copy_section_aggregates_and_names_host_ledger_flags_and_deadlines(self):
        rows = [package(1, containers=['a'], containerDisplayNames=['kuma'], knownExploited=True),
                package(1, containers=['b'], containerDisplayNames=['plausible'], version='3.0.14'),
                package(2, fixed=None, severity='critical')]
        _, document, text, html = self.rendered(rows)
        paste = text[text.index(mail.PASTE_START):text.index(mail.PASTE_END)]
        self.assertIn('Help me fix these Hatchkit findings.', paste)
        self.assertIn('Host: fixture-vps', paste)
        self.assertIn('Ledger: ' + digest.LEDGER, paste)
        self.assertIn('Image package rows in ledger: 3, grouped here into 2 lines', paste)
        self.assertIn('hatchkit host updates --host fixture-vps --json', paste)
        line = next(row for row in paste.splitlines() if row.startswith('- CVE-2026-0001'))
        self.assertIn('openssl 3.0.13, 3.0.14', line)
        self.assertIn('fixed 3.0.16', line)
        self.assertIn('kuma, plausible', line)
        self.assertIn('known exploited', line)
        self.assertIn('| due ', line)
        self.assertIn('no fix reported', next(row for row in paste.splitlines() if row.startswith('- CVE-2026-0002')))
        self.assertIn('Copy for an LLM', html)
        self.assertIn('<pre ', html)

    def test_copy_section_uses_named_fields_only(self):
        (self.work / 'alert-smtp.json').write_text(json.dumps({'password': SECRET}))
        _, _, text, html = self.rendered([package(), direct(environment=SECRET)])
        self.assertNotIn(SECRET, text + html)
        self.assertNotIn('opaque-container-id', text)
        self.assertNotIn('smtp', text.lower().replace('it holds no secrets, smtp details', ''))
        status = (self.work / digest.STATUS_NAME).read_text()
        self.assertNotIn(SECRET, status)
        self.assertNotIn('CVE-', status, 'the digest state does not copy the ledger')

    def test_large_ledger_stays_under_gmail_clipping_with_an_honest_remainder(self):
        rows = [package(n % 900, name='package-with-long-name-%d' % (n % 400), containers=['c%d' % (n % 40)],
                        containerDisplayNames=['workload-with-a-long-name-%d' % (n % 40)])
                for n in range(2600)]
        rows += [direct(id='GHSA-%d' % n, summary='A long direct finding summary ' * 12) for n in range(120)]
        _, document, text, html = self.rendered(rows, issues=['backup issue %d' % n for n in range(40)])
        self.assertLess(len(html.encode()), 102 * 1024)
        self.assertLessEqual(len(html.encode()), mail.HTML_LIMIT)
        self.assertRegex(text, r'\n\d+ more grouped lines are in the ledger: ' + digest.LEDGER)
        self.assertRegex(text, r'\n\d+ more in the copy section below\.')
        left = int(text.split(' more grouped lines are in the ledger')[0].rsplit('\n', 1)[1])
        shown = sum(1 for line in text.split(mail.PASTE_START)[1].splitlines() if line.startswith('- '))
        total = sum(1 for row in document['paste']['rows'] if row.startswith('- '))
        self.assertEqual(shown + left, total, 'shown and left out add up')
        self.assertIn('Image package rows in ledger: 2600', text)

    def test_digest_subject_states_the_state(self):
        subject, _, _, _ = self.rendered([direct(), direct(id='GHSA-2', summary='second'), direct(fixed=None, id='GHSA-3', summary='third')])
        self.assertEqual(subject, '[Hatchkit] fixture-vps: 2 need you, 1 waiting')


class Message(unittest.TestCase):
    def setUp(self):
        self.message = mail.build_message(ALERTS, '[Hatchkit] host: 1 needs you', {
            'title': 'Daily digest', 'host': 'host', 'sections': {'needs': [{'what': 'Größe changed', 'command': 'x'}]}})
        self.parsed = email.message_from_bytes(self.message.as_bytes(), policy=policy.default)

    def test_structure_is_alternative_text_then_related_html_and_icon(self):
        self.assertEqual(self.parsed.get_content_type(), 'multipart/alternative')
        text, related = self.parsed.get_payload()
        self.assertEqual(text.get_content_type(), 'text/plain')
        self.assertIn('Größe changed', text.get_content())
        self.assertEqual(related.get_content_type(), 'multipart/related')
        html, icon = related.get_payload()
        self.assertEqual(html.get_content_type(), 'text/html')
        self.assertIn('Größe changed', html.get_content())
        self.assertEqual(icon.get_content_type(), 'image/png')
        self.assertEqual(icon['Content-ID'], '<hatchkit-icon>')
        self.assertEqual(icon.get_content_disposition(), 'inline')
        self.assertTrue(icon.get_content().startswith(b'\x89PNG'))
        self.assertLess(len(icon.get_content()), 4096)

    def test_identity_headers(self):
        self.assertEqual(self.parsed['From'], 'Hatchkit Alerts <noreply@mail.example.test>')
        self.assertEqual(self.parsed['Auto-Submitted'], 'auto-generated')
        self.assertIn('[Hatchkit]', self.parsed['Subject'])
        self.assertTrue(self.parsed['Message-ID'].endswith('@mail.example.test>'))
        self.assertNotIn(SECRET, self.message.as_string())

    def test_plain_text_senders_get_the_shared_look(self):
        message = mail.build_message(ALERTS, '[Hatchkit] Old sender', 'plain body\n')
        self.assertEqual(message.get_content_type(), 'multipart/alternative')
        self.assertIn('Old sender', message.get_payload()[0].get_content())
        self.assertIn('plain body', message.get_payload()[0].get_content())


class Parity(unittest.TestCase):
    """A shared look is only true while both renderers agree."""

    DOCS = [
        {'title': 'VPS monitor', 'sections': {'needs': [{'what': 'a <b> & "c" \'d\'', 'command': 'x'}]}, 'footer': ['one', 'two']},
        {'title': 'Daily digest', 'host': 'h', 'intro': 'Hello\n\nthere', 'ledger': '/l',
         'sections': {'needs': [{'what': 'é' * 500, 'detail': 'long ' * 100, 'flags': ['Known exploited', 'x'], 'deadline': 'd', 'command': 'c'}] * 45,
                      'fixed': [{'what': 'f'}], 'waiting': [{'what': 'w'}], 'unchecked': [{'what': 'u'}]},
         'notes': ['n1', 'n2'],
         'paste': {'instruction': 'i', 'meta': ['Host: h'], 'ledger': '/l', 'rows': ['## heading'] + ['- ' + 'ü' * 200] * 400}},
        {'title': 'Empty'},
    ]

    def test_python_and_worker_render_the_same_bytes(self):
        script = ("import {renderMail} from './src/templates/security-controller/mail-core.mjs';"
                  "let input='';for await(const c of process.stdin)input+=c;"
                  "console.log(JSON.stringify(JSON.parse(input).map(renderMail)));")
        result = subprocess.run(['node', '--input-type=module', '-e', script], input=json.dumps(self.DOCS), text=True,
                                capture_output=True, cwd=HERE, check=True)
        for document, rendered in zip(self.DOCS, json.loads(result.stdout)):
            text, html = mail.render(document)
            self.assertEqual(text, rendered['text'])
            self.assertEqual(html, rendered['html'])

    def test_worker_message_parses_like_the_host_message(self):
        script = ("import {renderMail,rawMessage} from './src/templates/security-controller/mail-core.mjs';"
                  "process.stdout.write(rawMessage({from:'security@example.com',to:'o@example.test',subject:'[Hatchkit] x',"
                  "...renderMail({title:'Größe',sections:{needs:[{what:'Größe',command:'c'}]}})}));")
        raw = subprocess.run(['node', '--input-type=module', '-e', script], capture_output=True, cwd=HERE, check=True).stdout
        parsed = email.message_from_bytes(raw, policy=policy.default)
        self.assertEqual(parsed['From'], 'Hatchkit Alerts <security@example.com>')
        self.assertEqual(parsed['Auto-Submitted'], 'auto-generated')
        self.assertTrue(parsed['Message-ID'].endswith('@example.com>'))
        text, related = parsed.get_payload()
        self.assertIn('Größe', text.get_content())
        html, icon = related.get_payload()
        self.assertIn('cid:hatchkit-icon', html.get_content())
        self.assertIn('Größe', html.get_content())
        self.assertEqual(icon.get_content(), base64.b64decode(mail.ICON_PNG))

    def test_palette_comes_from_the_docs_theme(self):
        logo = (HERE.parent / 'docs/public/img/favicon.svg').read_text()
        self.assertIn('#818cf8', logo, 'the icon tile is the brand tile')
        css = (HERE.parent / 'docs/app/global.css').read_text()
        self.assertIn('oklch(58% 0.18 270)', css)  # LIGHT primary #526ee3
        self.assertIn('oklch(78% 0.13 270)', css)  # DARK primary #97b3ff


if __name__ == '__main__':
    unittest.main()
