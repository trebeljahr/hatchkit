import importlib.util
from pathlib import Path
import unittest
import json,subprocess,tempfile
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('guard',Path(__file__).parent/'src/templates/docker-discovery/database-guard.py');g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)

class GuardTests(unittest.TestCase):
 def test_timeout_retries_a_fresh_complete_inventory_once(self):
  responses=[subprocess.CompletedProcess([],0,'stale\n',''),subprocess.TimeoutExpired(['docker','inspect','PRIVATE_VALUE'],25),
             subprocess.CompletedProcess([],0,'fresh\n',''),subprocess.CompletedProcess([],0,'[{"Id":"fresh"}]','')]
  with patch.object(g.subprocess,'run',side_effect=responses)as run:
   rows,retries=g.read_inventory()
  self.assertEqual(rows,[{'Id':'fresh'}]);self.assertEqual(retries,1)
  self.assertEqual([c.args[0]for c in run.call_args_list],[['docker','ps','-q'],['docker','inspect','stale'],['docker','ps','-q'],['docker','inspect','fresh']])
 def test_repeated_inventory_timeouts_remain_failures_with_bounded_calls(self):
  with patch.object(g.subprocess,'run',side_effect=subprocess.TimeoutExpired(['PRIVATE_VALUE'],25))as run:
   with self.assertRaises(subprocess.TimeoutExpired)as caught:g.read_inventory()
  self.assertEqual(run.call_count,2);self.assertEqual(caught.exception.operation,'docker-list')
 def test_writes_are_never_retried_and_operation_diagnostics_are_fixed(self):
  with patch.object(g.subprocess,'run',side_effect=subprocess.TimeoutExpired(['nft','PRIVATE_VALUE'],25))as run:
   with self.assertRaises(subprocess.TimeoutExpired)as caught:g.run(['nft','-j','-f','-'],input='PRIVATE_VALUE')
  self.assertEqual(run.call_count,1);self.assertEqual(caught.exception.operation,'firewall-write')
  with tempfile.TemporaryDirectory()as folder,patch.object(g,'STATUS',Path(folder)/'status.json'),patch.object(g,'cycle',side_effect=caught.exception):
   report=g.once(True)
  self.assertFalse(report['ok']);self.assertFalse(report['complete']);self.assertEqual(report['error'],'TimeoutExpired')
  self.assertEqual(report['failedOperation'],'firewall-write');self.assertNotIn('PRIVATE_VALUE',json.dumps(report))
 def test_non_timeout_inventory_failures_are_not_retried(self):
  with patch.object(g.subprocess,'run',side_effect=subprocess.CalledProcessError(1,['PRIVATE_VALUE']))as run:
   with self.assertRaises(subprocess.CalledProcessError):g.read_inventory()
  self.assertEqual(run.call_count,1)
 def test_explicit_database_destinations_on_every_proxy_interface(self):
  def row(name,ip):return {'Name':'/'+name,'State':{'Running':True},'NetworkSettings':{'Networks':{'app':{'IPAddress':ip,'GlobalIPv6Address':''}}}}
  rows=[row('proxy','172.20.0.2'),row('database','172.20.0.3'),row('application','172.20.0.4')]
  self.assertEqual(g.topology({'schema':1,'proxy':'proxy','databases':['database']},rows,{'app':'veth123','other':'veth456'}),[(4,'veth123','172.20.0.3'),(4,'veth456','172.20.0.3')])
  with self.assertRaises(AssertionError):g.topology({'schema':1,'proxy':'proxy','databases':['missing']},rows,{})
 def test_unknown_policy_and_non_list_databases_fail_closed(self):
  for config in [{'schema':1,'proxy':'proxy','databases':['db'],'allow':True},{'schema':True,'proxy':'proxy','databases':['db']},{'schema':1,'proxy':'proxy','databases':'db'}]:
   with self.assertRaises(AssertionError):g.topology(config,[],{})
 def test_new_managed_database_invalidates_coverage_without_auto_expanding_scope(self):
  def row(name,ip,kind=None):return {'Name':'/'+name,'State':{'Running':True},'Config':{'Labels':{'coolify.type':kind}},'NetworkSettings':{'Networks':{'app':{'IPAddress':ip,'GlobalIPv6Address':''}}}}
  rows=[row('proxy','172.20.0.2'),row('database','172.20.0.3','database')]
  config={'schema':1,'proxy':'proxy','databases':['database'],'requireManagedDatabaseCoverage':True}
  self.assertEqual(g.topology(config,rows,{'app':'veth123'}),[(4,'veth123','172.20.0.3')])
  rows.append(row('unreviewed','172.20.0.4','database'))
  with self.assertRaisesRegex(AssertionError,'outside the reviewed boundary'):g.topology(config,rows,{'app':'veth123'})
  self.assertEqual(config['databases'],['database'])
  config['requireManagedDatabaseCoverage']='true'
  with self.assertRaises(AssertionError):g.topology(config,rows,{'app':'veth123'})
 def test_ingress_rules_do_not_trust_packet_source_addresses(self):
  rows=g.wanted([(4,'veth123','172.20.0.3'),(6,'veth123','fd00::3')])
  self.assertEqual(rows[1]['chain']['dev'],'veth123');self.assertEqual(rows[1]['chain']['hook'],'ingress')
  expressions=[row['rule']['expr']for row in rows if 'rule'in row]
  self.assertEqual([x[0]['match']['left']['payload']['field']for x in expressions],['daddr','daddr'])
  self.assertEqual([x[-1]for x in expressions],[{'drop':None},{'drop':None}])
 def test_atomic_replacement_never_flushes_foreign_rules(self):
  import json
  rows=g.wanted([(4,'veth123','172.20.0.3')]);commands=json.loads(g.transaction(rows,rows))['nftables']
  self.assertEqual(commands[0],{'delete':{'table':{'family':'netdev','name':g.TABLE}}})
  self.assertTrue(all(set(c)<={'add','delete'}for c in commands));self.assertNotIn('flush',g.transaction(rows,rows))
 def test_only_handles_are_ignored_not_changed_security_semantics(self):
  rows=g.wanted([(4,'veth123','172.20.0.3')]);actual=[{k:{**__import__('copy').deepcopy(v),'handle':i}for k,v in row.items()}for i,row in enumerate(rows)]
  self.assertEqual(g.normalize_table({'nftables':[{'metainfo':{}},*actual]}),rows)
  actual[-1]['rule']['expr'][-1]={'accept':None}
  self.assertNotEqual(g.normalize_table({'nftables':actual}),rows)
  with self.assertRaises(AssertionError):g.normalize_table({'nftables':[{'set':{}}]})

 def test_device_loss_allows_only_the_kernel_removed_chain_and_its_rules(self):
  rules=g.wanted([(4,'veth123','172.20.0.3'),(4,'veth456','172.20.0.3')])
  pruned=g.after_device_loss(rules,{'veth456'})
  self.assertEqual([r['chain']['dev']for r in pruned if 'chain'in r],['veth456'])
  self.assertEqual([r['rule']['chain']for r in pruned if 'rule'in r],['proxy1'])
  self.assertEqual(g.after_device_loss(rules,set()),[rules[0]])

 def test_global_chain_declaration_order_is_not_rule_order(self):
  rows=g.wanted([(4,'veth123','172.20.0.3'),(4,'veth123','172.20.0.4'),(4,'veth456','172.20.0.3')])
  interleaved=[rows[0],rows[1],*rows[3:5],rows[2],rows[5]]
  self.assertEqual(g.normalize_table({'nftables':interleaved}),rows)
  reordered=[*rows[:3],rows[4],rows[3],rows[5]]
  self.assertNotEqual(g.normalize_table({'nftables':reordered}),rows)

if __name__=='__main__':unittest.main()
