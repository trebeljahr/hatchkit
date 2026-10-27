#!/usr/bin/env python3
"""Start only an explicitly reviewed tailnet DNS image/config; never pull or learn."""
import argparse
import http.client
import ipaddress
import json
import re
import socket
import stat
import subprocess
from pathlib import Path

CONFIG=Path('/etc/tailnet-dns/container.json')
NAME='tailnet-dns'
FIELDS=['Memory','MemorySwap','NanoCpus','PidsLimit','ReadonlyRootfs','Privileged','SecurityOpt','CapAdd','CapDrop','NetworkMode','PidMode','IpcMode','UsernsMode','PortBindings','PublishAllPorts','RestartPolicy']
class UnixConnection(http.client.HTTPConnection):
 def __init__(self):super().__init__('localhost',timeout=40)
 def connect(self):self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.sock.settimeout(self.timeout);self.sock.connect('/var/run/docker.sock')
def api(method,path,payload=None,missing=False):
 connection=UnixConnection()
 try:
  connection.request(method,path,body=json.dumps(payload).encode()if payload is not None else None,headers={'Content-Type':'application/json'})
  response=connection.getresponse();data=response.read(2*1024**2+1);assert len(data)<=2*1024**2,'Unexpected Docker metadata size'
  if missing and response.status==404:return None
  assert 200<=response.status<300,'Docker DNS operation failed'
  return json.loads(data)if data else None
 finally:connection.close()
def validate(document):
 assert document['schema']==1 and set(document)=={'schema','imageId','tailnetIp','create'}
 assert re.fullmatch(r'sha256:[a-f0-9]{64}',document['imageId'])
 assert isinstance(document['tailnetIp'],str)and ipaddress.ip_address(document['tailnetIp'])in ipaddress.ip_network('100.64.0.0/10')
 config=document['create'];host=config['HostConfig'];assert config['Image']==document['imageId']and config['User']=='65532:65532'
 assert config['Entrypoint']==['/coredns']and config['Cmd']==['-conf','/Corefile']and not config.get('Volumes')
 environment=dict(entry.split('=',1)for entry in config.get('Env',[])if '='in entry)
 assert set(environment)<={'PATH','SSL_CERT_FILE'}and len(environment)==len(config.get('Env',[]))
 if 'SSL_CERT_FILE'in environment:assert environment['SSL_CERT_FILE']=='/etc/ssl/certs/ca-certificates.crt'
 assert host['Memory']==128*1024**2 and host['MemorySwap']==256*1024**2 and host['NanoCpus']==250000000 and host['PidsLimit']==64
 assert host['ReadonlyRootfs']is True and not host.get('Privileged')and host['NetworkMode']=='bridge'and not host.get('PublishAllPorts')
 assert host.get('PidMode','')!='host'and host.get('IpcMode','')!='host'and host.get('UsernsMode','')not in {'host'}
 assert set(host.get('SecurityOpt')or[])<={'no-new-privileges','no-new-privileges:true','no-new-privileges=true'}and host.get('SecurityOpt')
 caps=lambda values:{v.removeprefix('CAP_')for v in values or[]}
 assert caps(host.get('CapDrop'))=={'ALL'}and caps(host.get('CapAdd'))=={'NET_BIND_SERVICE'}
 assert not host.get('Devices')and not host.get('DeviceRequests')and not host.get('VolumesFrom')and not host.get('Links')
 assert host.get('Binds')==['/etc/tailnet-dns/Corefile:/Corefile:ro']and not host.get('Mounts')
 assert host['RestartPolicy']=={'Name':'unless-stopped','MaximumRetryCount':0}
 expected={kind:[{'HostIp':document['tailnetIp'],'HostPort':'53'}]for kind in ['1053/tcp','1053/udp']}
 assert host['PortBindings']==expected
 assert not config.get('NetworkingConfig')or set(config['NetworkingConfig'])=={'EndpointsConfig'}and set(config['NetworkingConfig']['EndpointsConfig'])=={'bridge'}
 return document

def matches(document,row):
 assert row['Name']=='/'+NAME and row['Image']==document['imageId']
 desired=document['create'];host=row['HostConfig']
 for key in FIELDS:assert host.get(key)==desired['HostConfig'].get(key),'DNS control drift'
 for key in ['User','Env','Entrypoint','Cmd','Labels']:assert row['Config'].get(key)==desired.get(key),'DNS startup drift'
 mounts=row['Mounts'];assert len(mounts)==1 and mounts[0]['Type']=='bind'and mounts[0]['Source']=='/etc/tailnet-dns/Corefile'and mounts[0]['Destination']=='/Corefile'and mounts[0]['RW']is False
 assert set(row['NetworkSettings']['Networks'])=={'bridge'}
 return True

def main():
 parser=argparse.ArgumentParser();parser.add_argument('action',choices=['ensure','stop']);args=parser.parse_args()
 metadata=CONFIG.lstat();assert stat.S_ISREG(metadata.st_mode)and metadata.st_uid==0 and not metadata.st_mode&0o077 and metadata.st_size<=65536
 assert CONFIG.parent.stat().st_uid==0 and not CONFIG.parent.stat().st_mode&0o022
 document=validate(json.loads(CONFIG.read_text()));row=api('GET','/containers/'+NAME+'/json',missing=True)
 if args.action=='stop':
  if row:matches(document,row);api('POST','/containers/'+row['Id']+'/stop?t=10')if row['State']['Running']else None
  print(json.dumps({'ok':True,'stopped':True}));return
 addresses=json.loads(subprocess.check_output(['ip','-j','-4','address','show','dev','tailscale0'],timeout=10))
 assert document['tailnetIp']in {entry['local']for iface in addresses for entry in iface['addr_info']},'Reviewed Tailscale address absent'
 if row:matches(document,row)
 else:
  image=api('GET','/images/'+document['imageId']+'/json');assert image['Id']==document['imageId']
  created=api('POST','/containers/create?name='+NAME,document['create']);row=api('GET','/containers/'+created['Id']+'/json');matches(document,row)
 if not row['State']['Running']:api('POST','/containers/'+row['Id']+'/start')
 row=api('GET','/containers/'+NAME+'/json');matches(document,row);assert row['State']['Running']and not row['State'].get('OOMKilled')
 print(json.dumps({'ok':True,'running':True,'imageId':document['imageId'],'reviewedControlsRetained':True}))
if __name__=='__main__':main()
