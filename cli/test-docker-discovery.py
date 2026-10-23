import base64,importlib.util,json
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('discovery',Path(__file__).parent/'src/templates/docker-discovery/discovery.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
SECRET='synthetic-sensitive-canary'
class Discovery(unittest.TestCase):
 def test_service_local_auth_is_required_and_compared_without_decoding_input(self):
  token='a'*43;header='Basic '+base64.b64encode(('discovery:'+token).encode()).decode()
  self.assertTrue(m.authorized(header,token));self.assertFalse(m.authorized(header,'b'*43))
  for invalid in ['',None,'Basic malformed','Basic '+('a'*10000)]:self.assertFalse(m.authorized(invalid,token))
  self.assertFalse(m.authorized(header,None))
 def test_allowlist_only_matches_the_provider_requests(self):
  for path in ['/_ping','/v1.51/_ping','/version','/v1.51/containers/json?all=1','/v1.51/containers/abc123/json','/events?filters={}']:
   self.assertIsNotNone(m.route('GET',path),path)
  self.assertEqual(m.route('HEAD','/_ping'),('ping','/_ping'))
 def test_mutations_archive_exec_logs_and_encoded_paths_are_denied(self):
  for method in ['POST','PUT','PATCH','DELETE','CONNECT']:
   self.assertIsNone(m.route(method,'/v1.51/containers/create'))
  for path in ['/containers/id/archive?path=/etc/shadow','/containers/id/logs','/containers/id/exec','/images/json','/volumes','/info','/networks','//host/containers/json','http://host/containers/json','/containers/%2e%2e/json','/containers/../archive','/containers/id/json#fragment']:
   self.assertIsNone(m.route('GET',path),path)
 def test_sensitive_inspect_fields_and_health_output_never_reach_client(self):
  original={'Id':'abc','Name':'/app','Config':{'Env':['KEY='+SECRET],'Cmd':[SECRET],'Labels':{'private':SECRET,'traefik.enable':'true','com.docker.compose.project':'project'}},
   'HostConfig':{'NetworkMode':'private','Binds':[SECRET]},'Mounts':[{'Source':SECRET}],
   'State':{'Status':'running','Health':{'Status':'healthy','Log':[{'Output':SECRET}]}},
   'NetworkSettings':{'Ports':{'80/tcp':None},'Networks':{'private':{'NetworkID':'network','IPAddress':'172.22.0.2','GlobalIPv6Address':'','Private':SECRET}}}}
  before=json.dumps(original,sort_keys=True);result=m.sanitize('inspect',original)
  self.assertNotIn(SECRET,json.dumps(result));self.assertEqual(json.dumps(original,sort_keys=True),before)
  self.assertEqual(result['State']['Health'],{'Status':'healthy'});self.assertEqual(result['Config']['Labels']['traefik.enable'],'true')
  self.assertEqual(result['NetworkSettings']['Ports'],{'80/tcp':None})
 def test_container_list_exposes_only_ids(self):
  self.assertEqual(m.sanitize('list',[{'Id':'id','Env':[SECRET],'Labels':{'secret':SECRET}}]),[{'Id':'id'}])
 def test_events_strip_attributes_and_unneeded_actions(self):
  result=m.event({'Type':'container','Action':'start','Actor':{'ID':'abc123','Attributes':{'secret':SECRET}},'time':123,'timeNano':123000000000})
  self.assertNotIn(SECRET,json.dumps(result));self.assertEqual(result['Action'],'start')
  self.assertIsNone(m.event({'Type':'container','Action':'exec_create','Actor':{'ID':'abc123'}}))
  self.assertIsNone(m.event({'Type':'image','Action':'start','Actor':{'ID':'abc123'}}))
 def test_query_cannot_request_size_traversal_or_historical_event_data(self):
  self.assertEqual(m.route('GET','/v1.51/containers/abc123/json?size=1'),('inspect','/v1.51/containers/abc123/json'))
  self.assertEqual(m.route('GET','/events?since=0'),('events','/events'))

if __name__=='__main__':unittest.main()
