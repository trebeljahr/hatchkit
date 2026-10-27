import importlib.util
from pathlib import Path
import unittest
import json
import struct
import tempfile
import contextlib
import io
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('policy',Path(__file__).parent/'src/templates/docker-discovery/container-policy.py');p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
def fixture():
 return {'Name':'/proxy','Image':'sha256:reviewed','State':{'Running':True,'Pid':123,'Health':{'Status':'healthy'}},'HostConfig':{'Memory':128,'ReadonlyRootfs':True,'SecurityOpt':['no-new-privileges:true'],'CapDrop':['ALL'],'CapAdd':None,'PortBindings':{},'Privileged':False},'Mounts':[], 'Config':{'Cmd':['--providers.docker.endpoint=tcp://discovery:2375'],'Env':['PRIVATE=must-not-leak']},'NetworkSettings':{'Networks':{'internal':{}}}}
def policy():return {'resource':'proxy','selector':{'name':'proxy'},'expected':{'Memory':128,'ReadonlyRootfs':True,'noNewPrivileges':True,'uid':65532,'imageId':'sha256:reviewed','healthy':True,'CapDrop':['ALL'],'CapAdd':[],'noPublishedPorts':True,'noHostNamespaces':True,'networks':['internal'],'noDirectDockerSocket':True,'dockerEndpoint':'tcp://discovery:2375'}}
class Policy(unittest.TestCase):
 def test_mongo_cache_drift_is_checked_with_fake_credentials_only(self):
  d=fixture();d['Id']='synthetic-container';d['Image']='sha256:'+'a'*64;rule=policy();rule['expected'].update(imageId=d['Image'],mongoCacheMaxBytes=536870912)
  check=lambda value:p.evaluate([d],[rule],lambda pid:{'uid':65532,'nnp':1},lambda cid:value)
  self.assertEqual(check(536870912),[])
  self.assertIn('mongoCacheMaxBytes',[x['field']for x in check(3*1024**3)])
  with self.assertRaisesRegex(RuntimeError,'synthetic failure'):
   p.evaluate([d],[rule],lambda pid:{'uid':65532,'nnp':1},lambda cid:(_ for _ in ()).throw(RuntimeError('synthetic failure')))
 def test_mongo_cache_requires_typed_limit_and_exact_image_even_if_missing(self):
  for value in [None,True,0,-1,'512m',2**50]:
   rule=policy();rule['expected']['mongoCacheMaxBytes']=value
   with self.subTest(value=value),self.assertRaises(ValueError):p.evaluate([], [rule])
  rule=policy();rule['expected']['mongoCacheMaxBytes']=536870912
  with self.assertRaises(ValueError):p.evaluate([], [rule])
 def test_mongo_cache_inspector_does_not_expose_credentials_or_diagnostics(self):
  class Result:
   returncode=0;stdout='{"bytes":536870912}';stderr='must-not-leak'
  with patch.object(p.subprocess,'run',return_value=Result())as run:
   self.assertEqual(p.mongo_cache_max('synthetic-container'),536870912)
   args=run.call_args.args[0]
   self.assertEqual(args,['docker','exec','-i','synthetic-container','mongosh','--quiet','--norc','--file','/dev/stdin'])
   self.assertIn('process.env.MONGO_INITDB_ROOT_PASSWORD',run.call_args.kwargs['input'])
   Result.returncode=1
   with self.assertRaisesRegex(RuntimeError,'^Mongo cache inspection failed$'):p.mongo_cache_max('synthetic-container')
  for output in ['{"bytes":true}','{"bytes":"536870912"}','{"bytes":0}','{"bytes":536870912,"unexpected":"must-not-leak"}','must-not-leak']:
   Result.returncode=0;Result.stdout=output
   with patch.object(p.subprocess,'run',return_value=Result()),self.assertRaisesRegex(RuntimeError,'^Mongo cache inspection returned invalid metadata$'):p.mongo_cache_max('synthetic-container')
 def test_cache_inspection_failure_makes_full_report_incomplete_without_leaking(self):
  d=fixture();d['Id']='synthetic-container';d['Image']='sha256:'+'a'*64
  rule=policy();rule['expected']={'imageId':d['Image'],'mongoCacheMaxBytes':536870912}
  class Failed:
   returncode=1;stdout='must-not-leak';stderr='must-not-leak'
  with tempfile.TemporaryDirectory()as directory:
   config=Path(directory)/'config.json';status=Path(directory)/'status.json'
   config.write_text(json.dumps({'schema':2,'policies':[rule]}))
   output=io.StringIO()
   with patch.object(p,'CONFIG',config),patch.object(p,'STATUS',status),patch.object(p.subprocess,'check_output',side_effect=['synthetic-container',json.dumps([d])]),patch.object(p.subprocess,'run',return_value=Failed()),contextlib.redirect_stdout(output):
    self.assertEqual(p.main(),1)
   report=json.loads(status.read_text())
   self.assertFalse(report['complete']);self.assertFalse(report['ok']);self.assertEqual(report['error'],'RuntimeError')
   self.assertNotIn('must-not-leak',status.read_text()+output.getvalue())
 def test_database_protocol_checks_require_exact_image_and_never_probe_foreign_bytes(self):
  d=fixture();d['Id']='synthetic-container';d['Image']='sha256:'+'a'*64
  rule=policy();rule['expected']={'imageId':d['Image'],'databaseReady':'postgres'}
  self.assertEqual(p.evaluate([d],[rule],database_probe=lambda cid,engine:engine=='postgres'),[])
  self.assertEqual(p.evaluate([d],[rule],database_probe=lambda cid,engine:False),[{'resource':'proxy','field':'databaseReady'}])
  d['Image']='sha256:'+'b'*64
  with patch.object(p,'database_ready',side_effect=AssertionError('Do not probe foreign image')):
   self.assertEqual({v['field']for v in p.evaluate([d],[rule],database_probe=lambda *a:(_ for _ in ()).throw(AssertionError('foreign probe')))},{'reviewedImage','databaseReady'})
  for invalid in [None,True,'mongo','']:
   rule['expected']['databaseReady']=invalid
   with self.subTest(invalid=invalid),self.assertRaises(ValueError):p.evaluate([], [rule])
  rule['expected']={'databaseReady':'valkey'}
  with self.assertRaises(ValueError):p.evaluate([], [rule])
 def test_database_protocol_inspection_never_exports_diagnostics(self):
  class Result:
   returncode=0;stdout='1\n';stderr='must-not-leak'
  for engine,reply in [('postgres','1'),('valkey','PONG'),('redis','PONG')]:
   Result.returncode=0;Result.stdout=reply+'\n'
   with patch.object(p.subprocess,'run',return_value=Result())as run:
    self.assertTrue(p.database_ready('synthetic-container',engine))
    self.assertEqual(run.call_args.args[0][:5],['docker','exec','synthetic-container','sh','-c'])
    self.assertEqual(run.call_args.kwargs['timeout'],15)
    if engine=='redis':
     self.assertIn('REDISCLI_AUTH="$REDIS_PASSWORD"',run.call_args.args[0][-1])
   for returncode,output in [(1,reply),(0,'must-not-leak')]:
    Result.returncode=returncode;Result.stdout=output
    with patch.object(p.subprocess,'run',return_value=Result()),self.assertRaisesRegex(RuntimeError,'^Database readiness inspection failed$'):p.database_ready('synthetic-container',engine)
 def dns_policy(self):return {'address':'100.64.0.10','port':53,'name':'fixture.invalid','answer':'100.64.0.10'}
 def test_dns_policy_refuses_public_destinations_and_malformed_fields(self):
  valid=self.dns_policy();self.assertTrue(p.valid_dns_policy(valid))
  for key,value in [('address','8.8.8.8'),('address','::1'),('address',1681915914),('answer','192.0.2.1'),('port',True),('port',0),('port',65536),('name','bad..name'),('name','bad..'),('name','bad_name'),('name','a'*64+'.invalid')]:
   changed=dict(valid);changed[key]=value
   with self.subTest(key=key,value=value):self.assertFalse(p.valid_dns_policy(changed))
  d=fixture();d['Image']='sha256:'+'a'*64;rule=policy();rule['expected']={'imageId':d['Image'],'dnsReady':valid}
  self.assertEqual(p.evaluate([d],[rule],dns_probe=lambda _:True),[])
  self.assertEqual(p.evaluate([d],[rule],dns_probe=lambda _:False),[{'resource':'proxy','field':'dnsReady'}])
  d['Image']='sha256:'+'b'*64
  self.assertEqual({f['field']for f in p.evaluate([d],[rule],dns_probe=lambda _:(_ for _ in ()).throw(AssertionError('foreign probe')))},{'reviewedImage','dnsReady'})
 def test_dns_parser_rejects_malformed_or_wrong_transaction_packets(self):
  question=b'\x07fixture\x07invalid\0'+struct.pack('!HH',1,1)
  record=b'\xc0\x0c'+struct.pack('!HHIH',1,1,60,4)+bytes([100,64,0,10])
  packet=struct.pack('!6H',123,0x8500,1,1,0,0)+question+record
  self.assertEqual(p.dns_packet(packet,123),{'rcode':0,'addresses':['100.64.0.10']})
  for invalid in [packet[:11],packet[:-1],struct.pack('!6H',123,0x8700,1,1,0,0)+question+record,struct.pack('!6H',123,0x8500,1,33,0,0)+question+record,struct.pack('!6H',123,0x8500,1,1,0,0)+question+b'\xff\xff'+record[2:]]:
   with self.assertRaises(ValueError):p.dns_packet(invalid,123)
  with self.assertRaises(ValueError):p.dns_packet(packet,124)
 def test_dns_readiness_checks_both_transports_and_hides_diagnostics(self):
  with patch.object(p,'dns_query',return_value={'rcode':0,'addresses':['100.64.0.10']})as query:
   self.assertTrue(p.dns_ready(self.dns_policy()));self.assertEqual([c.kwargs['transport']for c in query.call_args_list],['udp','tcp'])
  for value in [{'rcode':5,'addresses':[]},{'rcode':0,'addresses':['100.64.0.11']}]:
   with patch.object(p,'dns_query',return_value=value),self.assertRaisesRegex(RuntimeError,'^DNS readiness inspection failed$'):p.dns_ready(self.dns_policy())
  with patch.object(p,'dns_query',side_effect=TimeoutError('must-not-leak')),self.assertRaisesRegex(RuntimeError,'^DNS readiness inspection failed$'):p.dns_ready(self.dns_policy())
 def test_reviewed_port_bindings_detect_public_exposure_or_added_protocols(self):
  d=fixture();rule=policy();rule['expected']={'PortBindings':{'1053/udp':[{'HostIp':'100.64.0.10','HostPort':'53'}]}}
  d['HostConfig']['PortBindings']=rule['expected']['PortBindings']
  self.assertEqual(p.evaluate([d],[rule]),[])
  d['HostConfig']['PortBindings']={'1053/udp':[{'HostIp':'0.0.0.0','HostPort':'53'}]}
  self.assertEqual(p.evaluate([d],[rule]),[{'resource':'proxy','field':'PortBindings'}])
  rule['expected']['PortBindings']=None
  with self.assertRaises(ValueError):p.evaluate([], [rule])
 def test_readonly_mounts_must_really_be_readonly(self):
  d=fixture();d['Mounts']=[{'Type':'bind','Source':'/synthetic','Destination':'/www','RW':False}]
  rule=policy();rule['expected']['readOnlyMountDestinations']=['/www']
  check=lambda:p.evaluate([d],[rule],lambda pid:{'uid':65532,'nnp':1})
  self.assertEqual(check(),[])
  d['Mounts'][0]['RW']=True;self.assertIn('readOnlyMounts',[x['field']for x in check()])
  del d['Mounts'][0]['RW'];self.assertIn('readOnlyMounts',[x['field']for x in check()])
  for invalid in ['/www',['/www','/www'],['relative'],[None]]:
   rule['expected']['readOnlyMountDestinations']=invalid
   with self.assertRaises(ValueError):p.evaluate([], [rule])
 def test_unknown_security_fields_fail_instead_of_silently_passing(self):
  for containers in [[fixture()],[]]:
   rule=policy();rule['expected']['PidsLimits']=256
   with self.assertRaisesRegex(ValueError,'Unsupported reviewed control'):
    p.evaluate(containers,[rule],lambda pid:{'uid':65532,'nnp':1})
 def test_discovery_pair_checks_authentication_without_reporting_values(self):
  token='a'*43;a=fixture();b=fixture();a['Name']='/client';b['Name']='/broker'
  a['Config']['Cmd']=['--providers.docker.username=discovery','--providers.docker.password='+token]
  b['Config']['Env']=['DISCOVERY_TOKEN='+token]
  pair={'client':'client','broker':'broker'}
  self.assertTrue(p.discovery_pair([a,b],pair))
  b['Config']['Env']=['DISCOVERY_TOKEN='+'b'*43];self.assertFalse(p.discovery_pair([a,b],pair))
  self.assertFalse(p.discovery_pair([a],pair))
 def check(self,d):return p.evaluate([d],[policy()],lambda pid:{'uid':65532,'nnp':1})
 def test_reviewed_controls_pass_without_exporting_environment(self):self.assertEqual(self.check(fixture()),[])
 def test_socket_reintroduction_is_detected_even_at_another_destination(self):
  d=fixture();d['Mounts']=[{'Type':'bind','Source':'/var/run/docker.sock','Destination':'/renamed.sock'}]
  self.assertIn('directDockerSocket',[x['field']for x in self.check(d)])
 def test_daemon_access_through_a_parent_directory_is_denied(self):
  d=fixture();d['Mounts']=[{'Type':'bind','Source':'/var/run','Destination':'/host-run'}]
  self.assertIn('directDockerSocket',[x['field']for x in self.check(d)])
 def test_temporary_filesystem_is_not_mistaken_for_a_host_root_mount(self):
  d=fixture();d['Mounts']=[{'Type':'tmpfs','Source':'','Destination':'/tmp'}]
  self.assertEqual(self.check(d),[])
 def test_changed_endpoint_health_privileges_or_limits_are_visible(self):
  d=fixture();d['Config']['Env']+=['DOCKER_HOST=unix:///different.sock'];d['State']['Health']['Status']='unhealthy';d['HostConfig']['Memory']=0;d['HostConfig']['Privileged']=True
  self.assertEqual({x['field']for x in self.check(d)},{'discoveryEndpoint','health','Memory','hostPrivileges'})
 def test_missing_or_added_network_is_detected(self):
  d=fixture();d['NetworkSettings']['Networks']['public']={}
  self.assertIn('isolatedNetworks',[x['field']for x in self.check(d)])
  self.assertEqual(p.evaluate([],[policy()]),[{'resource':'proxy','field':'missingContainer'}])
 def test_rolling_app_replicas_must_all_meet_the_reviewed_policy(self):
  a=fixture();b=fixture();a['Name']='/abcdefghijklmnopqrstuv-old';b['Name']='/abcdefghijklmnopqrstuv-new';b['HostConfig']['Memory']=0
  rule=policy();rule['selector']={'prefix':'abcdefghijklmnopqrstuv-'}
  self.assertIn('Memory',[x['field']for x in p.evaluate([a,b],[rule],lambda pid:{'uid':65532,'nnp':1})])
 def test_temporary_filesystem_sizes_and_modes_normalize_without_ignoring_restrictions(self):
  d=fixture();rule=policy();rule['expected']['Tmpfs']={'/tmp':'rw,nosuid,nodev,noexec,size=32m,mode=1777'}
  d['HostConfig']['Tmpfs']={'/tmp':'nosuid,nodev,noexec,size=33554432,mode=01777'}
  check=lambda:p.evaluate([d],[rule],lambda pid:{'uid':65532,'nnp':1})
  self.assertEqual(check(),[])
  for actual in [{}, {'/tmp':'nosuid,nodev,size=32m,mode=1777'}, {'/tmp':'nosuid,nodev,noexec,size=64m,mode=1777'}, {'/tmp':'nosuid,nodev,noexec,size=32m,mode=777'}, {'/tmp':'nosuid,nodev,noexec,size=32m,mode=1777','/extra':'size=1m'}]:
   d['HostConfig']['Tmpfs']=actual
   self.assertIn('temporaryFilesystems',[x['field']for x in check()])
 def test_duplicate_or_invalid_tmpfs_options_fail_closed(self):
  for value in ['size=32m,size=64m','size=unlimited','mode=999']:
   with self.assertRaises(ValueError):p.tmpfs_options(value)

if __name__=='__main__':unittest.main()
