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
