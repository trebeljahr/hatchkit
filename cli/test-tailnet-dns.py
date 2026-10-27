import copy
import contextlib
import io
import json
import stat
from types import SimpleNamespace
from unittest.mock import patch
import importlib.util
from pathlib import Path
import unittest
s=importlib.util.spec_from_file_location('dns',Path(__file__).parent/'src/templates/docker-discovery/tailnet-dns.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
def fixture():
 ip='100.64.0.10';image='sha256:'+'a'*64
 return {'schema':1,'imageId':image,'tailnetIp':ip,'create':{'Image':image,'User':'65532:65532','Entrypoint':['/coredns'],'Cmd':['-conf','/Corefile'],'Env':['SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt'],'Labels':{},'HostConfig':{'Memory':128*1024**2,'MemorySwap':256*1024**2,'NanoCpus':250000000,'PidsLimit':64,'ReadonlyRootfs':True,'Privileged':False,'NetworkMode':'bridge','SecurityOpt':['no-new-privileges:true'],'CapDrop':['ALL'],'CapAdd':['NET_BIND_SERVICE'],'Binds':['/etc/tailnet-dns/Corefile:/Corefile:ro'],'PortBindings':{k:[{'HostIp':ip,'HostPort':'53'}]for k in ['1053/tcp','1053/udp']},'RestartPolicy':{'Name':'unless-stopped','MaximumRetryCount':0}}}}
class Launcher(unittest.TestCase):
 def test_reviewed_document_is_not_mutated(self):
  d=fixture();saved=copy.deepcopy(d);self.assertEqual(m.validate(d),saved);self.assertEqual(d,saved)
 def test_public_bind_or_changed_privileges_are_refused(self):
  changes=[('ReadonlyRootfs',False),('Privileged',True),('NetworkMode','host'),('PidMode','host'),('IpcMode','host'),('UsernsMode','host'),('PublishAllPorts',True),('Memory',0),('PidsLimit',-1),('CapAdd',['SYS_ADMIN']),('SecurityOpt',['seccomp=unconfined']),('Devices',[{'PathOnHost':'/dev/sda'}]),('Binds',['/etc:/Corefile:ro']),('PortBindings',{'1053/udp':[{'HostIp':'0.0.0.0','HostPort':'53'}]})]
  for key,value in changes:
   d=fixture();d['create']['HostConfig'][key]=value
   with self.subTest(key=key),self.assertRaises(AssertionError):m.validate(d)
  d=fixture();d['tailnetIp']='192.0.2.1'
  with self.assertRaises(AssertionError):m.validate(d)
 def test_foreign_image_user_command_or_environment_is_refused(self):
  for key,value in [('Image','sha256:'+'b'*64),('User','root'),('Cmd',['-conf','/unreviewed']),('Env',['TOKEN=synthetic']),('Volumes',{'/data':{}})]:
   d=fixture();d['create'][key]=value
   with self.subTest(key=key),self.assertRaises(AssertionError):m.validate(d)
 def test_runtime_drift_is_not_learned_or_overwritten(self):
  d=fixture();row={'Name':'/tailnet-dns','Image':d['imageId'],'Config':d['create'],'HostConfig':d['create']['HostConfig'],'Mounts':[{'Type':'bind','Source':'/etc/tailnet-dns/Corefile','Destination':'/Corefile','RW':False}],'NetworkSettings':{'Networks':{'bridge':{}}}}
  self.assertTrue(m.matches(d,row))
  for key,value in [('Image','foreign'),('Name','/foreign'),('Mounts',[dict(row['Mounts'][0],RW=True)]),('NetworkSettings',{'Networks':{'extra':{}}}),('HostConfig',dict(row['HostConfig'],PidsLimit=0))]:
   changed=copy.deepcopy(row);changed[key]=value
   with self.subTest(key=key),self.assertRaises(AssertionError):m.matches(d,changed)
class MissingContainer(unittest.TestCase):
 def config(self,d):
  class Config:
   parent=SimpleNamespace(stat=lambda:SimpleNamespace(st_uid=0,st_mode=0o755))
   def lstat(self):return SimpleNamespace(st_mode=stat.S_IFREG|0o600,st_uid=0,st_size=1000)
   def read_text(self):return json.dumps(d)
  return Config()
 def row(self,d,running):return {'Id':'synthetic-id','Name':'/tailnet-dns','Image':d['imageId'],'Config':d['create'],'HostConfig':d['create']['HostConfig'],'Mounts':[{'Type':'bind','Source':'/etc/tailnet-dns/Corefile','Destination':'/Corefile','RW':False}],'NetworkSettings':{'Networks':{'bridge':{}}},'State':{'Running':running,'OOMKilled':False}}
 def test_missing_container_is_recreated_from_only_the_pinned_document(self):
  d=fixture();calls=[];responses=[None,{'Id':d['imageId']},{'Id':'synthetic-id'},self.row(d,False),None,self.row(d,True)]
  def api(*args,**kwargs):calls.append((args,kwargs));return responses.pop(0)
  address=json.dumps([{'addr_info':[{'local':'100.64.0.10'}]}]).encode()
  with patch.object(m,'CONFIG',self.config(d)),patch.object(m,'api',side_effect=api),patch.object(m.subprocess,'check_output',return_value=address),patch('sys.argv',['dns','ensure']),contextlib.redirect_stdout(io.StringIO()):m.main()
  self.assertEqual([call[0][:2]for call in calls],[('GET','/containers/tailnet-dns/json'),('GET','/images/'+d['imageId']+'/json'),('POST','/containers/create?name=tailnet-dns'),('GET','/containers/synthetic-id/json'),('POST','/containers/synthetic-id/start'),('GET','/containers/tailnet-dns/json')])
  self.assertEqual(calls[2][0][2],d['create']);self.assertFalse(responses)
 def test_unknown_existing_image_or_absent_tailnet_address_is_never_replaced(self):
  d=fixture();row=self.row(d,True);row['Image']='foreign'
  for address,result in [('100.64.0.10',row),('192.0.2.1',None)]:
   with patch.object(m,'CONFIG',self.config(d)),patch.object(m,'api',return_value=result)as api,patch.object(m.subprocess,'check_output',return_value=json.dumps([{'addr_info':[{'local':address}]}]).encode()),patch('sys.argv',['dns','ensure']),self.assertRaises(AssertionError):m.main()
   self.assertTrue(all(call.args[0]=='GET'for call in api.call_args_list))
if __name__=='__main__':unittest.main()
