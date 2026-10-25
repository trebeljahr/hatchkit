import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('policy',Path(__file__).parent/'src/templates/docker-discovery/container-policy.py');p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
def fixture():
 return {'Name':'/proxy','Image':'sha256:reviewed','State':{'Running':True,'Pid':123,'Health':{'Status':'healthy'}},'HostConfig':{'Memory':128,'ReadonlyRootfs':True,'SecurityOpt':['no-new-privileges:true'],'CapDrop':['ALL'],'CapAdd':None,'PortBindings':{},'Privileged':False},'Mounts':[], 'Config':{'Cmd':['--providers.docker.endpoint=tcp://discovery:2375'],'Env':['PRIVATE=must-not-leak']},'NetworkSettings':{'Networks':{'internal':{}}}}
def policy():return {'resource':'proxy','selector':{'name':'proxy'},'expected':{'Memory':128,'ReadonlyRootfs':True,'noNewPrivileges':True,'uid':65532,'imageId':'sha256:reviewed','healthy':True,'CapDrop':['ALL'],'CapAdd':[],'noPublishedPorts':True,'noHostNamespaces':True,'networks':['internal'],'noDirectDockerSocket':True,'dockerEndpoint':'tcp://discovery:2375'}}
class Policy(unittest.TestCase):
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
