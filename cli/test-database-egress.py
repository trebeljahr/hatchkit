import copy,subprocess
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('egress',Path(__file__).parent/'src/templates/docker-discovery/database-egress.py')
g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
CONFIG={'schema':1,'databases':[{'container':'db','clients':['app']}]}
def row(name,address):
    return {'Name':'/'+name,'Id':name+'-id','State':{'Running':True,'StartedAt':'original'},'NetworkSettings':{'Networks':{'private':{'IPAddress':address,'GlobalIPv6Address':''}}}}
def rows():return [row('db','172.20.0.2'),row('app','172.20.0.3'),row('unrelated','172.20.0.4')]

class Egress(unittest.TestCase):
    def test_read_failure_keeps_egress_incomplete_with_safe_operation_only(self):
        error=subprocess.TimeoutExpired(['PRIVATE_VALUE'],25);error.operation='docker-inspect'
        with tempfile.TemporaryDirectory()as folder,patch.object(g,'STATUS',Path(folder)/'status.json'),patch.object(g,'cycle',side_effect=error):
            report=g.once(True)
        self.assertFalse(report['ok']);self.assertFalse(report['complete'])
        self.assertEqual(report['error'],'TimeoutExpired');self.assertEqual(report['failedOperation'],'docker-inspect')
        self.assertNotIn('PRIVATE_VALUE',json.dumps(report))
    def test_only_reviewed_peers_get_destination_rules(self):
        entries,stamp,summary=g.topology(CONFIG,rows(),{'db':{'private':'veth123'}})
        self.assertEqual(entries,[('veth123',('172.20.0.3',))]);self.assertEqual(summary['allowedPeerAddresses'],1)
        rules=g.wanted(entries)
        expressions=[r['rule']['expr']for r in rules if'rule'in r]
        self.assertEqual(expressions[0][0]['match']['right'],'arp')
        self.assertEqual(expressions[1][0]['match']['right'],'172.20.0.3')
        self.assertEqual(expressions[-1],[{'drop':None}])
        self.assertNotIn('saddr',json.dumps(expressions));self.assertNotIn('172.20.0.4',json.dumps(expressions))
    def test_missing_app_removes_its_permission_and_remains_incomplete(self):
        entries,stamp,summary=g.topology(CONFIG,rows()[:1],{'db':{'private':'veth123'}})
        self.assertEqual(entries,[('veth123',())]);self.assertEqual(summary['missingClients'],1)
        self.assertEqual(len([r for r in g.wanted(entries)if'rule'in r]),2)
    def test_missing_database_has_no_invented_interface(self):
        entries,stamp,summary=g.topology(CONFIG,rows()[1:],{})
        self.assertEqual(entries,[]);self.assertEqual(summary['missingDatabases'],1)
        self.assertEqual(g.wanted(entries),[{'table':{'family':'netdev','name':g.TABLE}}])
    def test_database_cross_access_duplicates_and_unknown_fields_are_refused(self):
        bad=[{'schema':True,'databases':CONFIG['databases']},{**CONFIG,'allowAll':True},
            {'schema':1,'databases':[{'container':'db','clients':['db']}]},
            {'schema':1,'databases':[{'container':'db','clients':['app','app']}]},
            {'schema':1,'databases':[{'container':'db;command','clients':['app']}]}]
        for config in bad:
            with self.assertRaises(AssertionError):g.validate(config)
    def test_new_ipv6_and_changed_client_network_fail_closed(self):
        for target in [0,1]:
            changed=rows();changed[target]['NetworkSettings']['Networks']['private']['GlobalIPv6Address']='fd00::2'
            with self.assertRaises(AssertionError):g.topology(CONFIG,changed,{'db':{'private':'veth123'}})
        changed=rows();changed[1]['NetworkSettings']['Networks']={'other':changed[1]['NetworkSettings']['Networks']['private']}
        with self.assertRaises(AssertionError):g.topology(CONFIG,changed,{'db':{'private':'veth123'}})
    def test_every_database_interface_is_guarded_even_without_clients(self):
        changed=rows();changed[0]['NetworkSettings']['Networks']['other']={'IPAddress':'172.21.0.2','GlobalIPv6Address':''}
        entries,stamp,summary=g.topology(CONFIG,changed,{'db':{'private':'veth123','other':'veth456'}})
        self.assertEqual(entries,[('veth123',('172.20.0.3',)),('veth456',())])
    def test_transactions_and_verification_preserve_security_semantics(self):
        expected=g.wanted([('veth123',('172.20.0.3',))])
        changed=copy.deepcopy(expected);changed[-1]['rule']['expr']=[{'accept':None}]
        self.assertNotEqual(g.owned.normalize_table({'nftables':changed}),expected)
        transaction=json.loads(g.owned.transaction(expected,expected))
        self.assertEqual(transaction['nftables'][0],{'delete':{'table':{'family':'netdev','name':g.TABLE}}})
        self.assertNotIn('flush',json.dumps(transaction))
    def test_error_report_cannot_echo_private_exception_text(self):
        with tempfile.TemporaryDirectory()as folder,patch.object(g,'STATUS',Path(folder)/'status.json'),patch.object(g,'cycle',side_effect=RuntimeError('synthetic-private')):
            report=g.once(True)
            self.assertFalse(report['ok']);self.assertFalse(report['complete'])
            self.assertNotIn('synthetic-private',json.dumps(report))
if __name__=='__main__':unittest.main()
