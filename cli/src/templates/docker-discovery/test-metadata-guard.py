import contextlib
import importlib.util
import io
import json
from pathlib import Path
import shlex
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('guard',Path(__file__).with_name('metadata-guard.py'))
guard=importlib.util.module_from_spec(spec);spec.loader.exec_module(guard)


def table(destination, installed=False, first=True):
    rows=['-P FORWARD DROP','-N DOCKER-USER','-A FORWARD -j DOCKER-USER','-A FORWARD -j DOCKER-FORWARD']
    foreign='-A DOCKER-USER -m state --state RELATED,ESTABLISHED -j ACCEPT'
    if installed:
        rows+=['-N '+guard.CHAIN]
        anchor=shlex.join(['-A','DOCKER-USER',*guard.ANCHOR])
        rows+=([anchor,foreign]if first else[foreign,anchor])
        rows +=[shlex.join(['-A',guard.CHAIN,*r])for r in guard.expected_rules(destination)]
    else:rows.append(foreign)
    return '\n'.join(rows)+'\n'


class MetadataBoundary(unittest.TestCase):
    def test_new_guard_precedes_established_accept_without_rewriting_foreign_policy(self):
        for destination in guard.FAMILIES.values():
            state=guard.inspect_table(table(destination),destination)
            content=guard.transaction(state,destination,'apply')
            self.assertIn('-I DOCKER-USER 1 ',content)
            self.assertNotIn('ACCEPT',content)
            self.assertNotIn('-F DOCKER-USER',content)
            self.assertNotIn('OUTPUT',content)
            self.assertIn('-i docker0 -d '+destination+' -j DROP',content)
            self.assertIn('-i br+ -d '+destination+' -j DROP',content)

    def test_installed_guard_is_idempotent(self):
        for destination in guard.FAMILIES.values():
            state=guard.inspect_table(table(destination,True),destination)
            self.assertTrue(state['first'])
            self.assertIsNone(guard.transaction(state,destination,'apply'))

    def test_kernel_option_order_keeps_exact_address_interface_and_action(self):
        for destination in guard.FAMILIES.values():
            canonical=table(destination,True)
            for interface in ['docker0','br+']:
                canonical=canonical.replace('-i '+interface+' -d '+destination,'-d '+destination+' -i '+interface)
            self.assertTrue(guard.inspect_table(canonical,destination)['first'])
            for changed in [canonical.replace(destination,'192.0.2.0/24'),canonical.replace('-i br+','-i eth0'),canonical.replace('-j DROP','-j ACCEPT',1),canonical.replace('-i br+','! -i br+')]:
                with self.assertRaises(AssertionError):guard.inspect_table(changed,destination)

    def test_reorder_moves_only_our_exact_tagged_jump(self):
        destination=next(iter(guard.FAMILIES.values()))
        content=guard.transaction(guard.inspect_table(table(destination,True,False),destination),destination,'apply')
        self.assertIn('-D DOCKER-USER -m comment',content)
        self.assertIn('-I DOCKER-USER 1 ',content)
        self.assertNotIn('-F ',content)

    def test_modified_owned_chain_is_never_overwritten(self):
        destination=next(iter(guard.FAMILIES.values()))
        altered=table(destination,True).replace('-j DROP','-j ACCEPT',1)
        with self.assertRaisesRegex(AssertionError,'content changed'):
            guard.inspect_table(altered,destination)

    def test_foreign_references_and_duplicate_anchors_require_review(self):
        destination=next(iter(guard.FAMILIES.values()))
        for extra in ['-A FORWARD -j '+guard.CHAIN,shlex.join(['-A','DOCKER-USER',*guard.ANCHOR])]:
            with self.assertRaises(AssertionError):
                guard.inspect_table(table(destination,True)+extra+'\n',destination)

    def test_missing_or_bypassed_docker_hook_is_incomplete(self):
        destination=next(iter(guard.FAMILIES.values()))
        for text in [table(destination).replace('-N DOCKER-USER\n',''),
                     table(destination).replace('-A FORWARD -j DOCKER-USER','-A FORWARD -j ACCEPT\n-A FORWARD -j DOCKER-USER')]:
            with self.assertRaises(AssertionError):guard.inspect_table(text,destination)

    def tailscale_table(self, destination, installed=True, rules=None):
        rules=guard.TAILSCALE_FORWARD[destination] if rules is None else rules
        prefix='-N ts-forward\n'+''.join(shlex.join(['-A','ts-forward',*r])+'\n' for r in rules)
        text=table(destination,installed).replace('-A FORWARD -j DOCKER-USER','-A FORWARD -j ts-forward\n-A FORWARD -j DOCKER-USER')
        return prefix+text

    def test_exact_tailscale_forward_prefix_keeps_guard_effective(self):
        for destination in guard.FAMILIES.values():
            state=guard.inspect_table(self.tailscale_table(destination),destination)
            self.assertTrue(state['exists'] and state['first'])
            self.assertIsNone(guard.transaction(state,destination,'apply'))
            fresh=guard.inspect_table(self.tailscale_table(destination,False),destination)
            self.assertIn('-I DOCKER-USER 1 ',guard.transaction(fresh,destination,'apply'))

    def test_live_ip6tables_tailscale_shape_is_accepted(self):
        # Real shape, captured read-only from a Tailscale host (ip6tables -S ts-forward).
        live=('-N ts-forward\n'
              '-A ts-forward -i tailscale0 -j MARK --set-xmark 0x40000/0xff0000\n'
              '-A ts-forward -m mark --mark 0x40000/0xff0000 -j ACCEPT\n'
              '-A ts-forward -o tailscale0 -j ACCEPT\n')
        destination=guard.FAMILIES['ip6tables']
        text=self.tailscale_table(destination).split('-P FORWARD',1)[1]
        self.assertTrue(guard.inspect_table(live+'-P FORWARD'+text,destination)['first'])

    def test_changed_tailscale_rules_or_other_prefix_fail_closed(self):
        for binary,destination in guard.FAMILIES.items():
            rules=guard.TAILSCALE_FORWARD[destination]
            other=guard.TAILSCALE_FORWARD[guard.FAMILIES['ip6tables' if binary=='iptables' else 'iptables']]
            variants=[rules+[['-j','ACCEPT']],rules[:-1],list(reversed(rules)),other,
                      [r if r[-1]!='ACCEPT' or '-o' not in r else ['-o','eth0','-j','ACCEPT'] for r in rules],
                      [['-j','ACCEPT']]+rules]
            for changed in variants:
                with self.assertRaisesRegex(AssertionError,'Tailscale forwarding rules'):
                    guard.inspect_table(self.tailscale_table(destination,rules=changed),destination)
            missing=self.tailscale_table(destination).replace('-N ts-forward\n','')
            with self.assertRaisesRegex(AssertionError,'chain missing'):
                guard.inspect_table(missing,destination)
            foreign=table(destination,True).replace('-A FORWARD -j DOCKER-USER','-N ts-other\n-A FORWARD -j ts-other\n-A FORWARD -j DOCKER-USER')
            with self.assertRaisesRegex(AssertionError,'hook order'):
                guard.inspect_table(foreign,destination)
            doubled=self.tailscale_table(destination).replace('-A FORWARD -j DOCKER-USER','-A FORWARD -j ts-forward\n-A FORWARD -j DOCKER-USER')
            with self.assertRaisesRegex(AssertionError,'hook order'):
                guard.inspect_table(doubled,destination)

    def test_rollback_removes_only_owned_rules_and_reports_protection_absent(self):
        texts=[table(d,True)for d in guard.FAMILIES.values()]+[table(d)for d in guard.FAMILIES.values()]
        with tempfile.TemporaryDirectory()as directory:
            path=Path(directory)/'status.json'
            with patch.object(guard,'STATUS',path),patch.object(guard,'bridge_preflight'), \
                 patch.object(guard,'snapshot',side_effect=texts),patch.object(guard.subprocess,'run')as run, \
                 patch('sys.argv',['guard','rollback']),contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(guard.main(),0)
            report=json.loads(path.read_text())
            self.assertTrue(report['operationSucceeded'])
            self.assertTrue(report['complete'])
            self.assertFalse(report['ok'])
            self.assertEqual(len(report['findings']),2)
            for call in run.call_args_list:
                self.assertIn('--noflush',call.args[0])
                self.assertIn('-F '+guard.CHAIN,call.kwargs['input'])
                self.assertNotIn('-F DOCKER-USER',call.kwargs['input'])


if __name__=='__main__':unittest.main()
