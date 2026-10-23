#!/usr/bin/env python3
"""Publish fixed health counters/timestamps. Never transmit logs, configs or records."""
import datetime as dt,json,os,pathlib,re,socket,urllib.request,sys
WORK=pathlib.Path('/var/lib/hatchkit-backups')
QUICK_EXCLUSIONS={'CPU not measured: the window was under 5 s.','Sustained CPU and outbound peers use the daily full scan.'}

def read(name):
 try:return json.loads((WORK/name).read_text())
 except (OSError,ValueError):return {}

def simple(name,allowed_skips=()):
 row=read(name)
 return {'checkedAt':row.get('checkedAt'),'ok':row.get('ok') is True,
         'complete':bool(row.get('checkedAt')) and not row.get('error') and set(row.get('skipped',[]))<=set(allowed_skips),
         'findings':len(row.get('findings')or[])}

def aggregate(name,projects,time_key):
 rows={r.get('project'):r for r in read(name).get('results',[])}
 selected=[rows.get(project,{})for project in projects]
 times=[r[time_key]for r in selected if r.get(time_key)]
 complete=bool(selected)and len(times)==len(selected)
 return {'checkedAt':min(times)if complete else None,'ok':complete and all(r.get('ok')is True for r in selected),
         'complete':complete,'findings':sum(r.get('ok')is not True for r in selected)}

def metadata():
 cfg=json.loads(pathlib.Path('/etc/hatchkit-backups/config.json').read_text())
 projects=[p['name']for p in cfg['projects']]
 checks={key:simple(file,exclusions) for key,file,exclusions in [
  ('process','host-integrity-quick-status.json',QUICK_EXCLUSIONS),
  ('full','host-integrity-status.json',()),('advisory','update-watch-status.json',()),
  ('files','file-integrity-status.json',())]}
 advisory=read('update-watch-status.json')
 if not {'host-docker','host-containerd','host-runc','host-tailscale'}<={r.get('service')for r in advisory.get('services',[])}:
  checks['advisory']['complete']=False
 images=read('image-vulnerability-status.json')
 checks['images']={'checkedAt':images.get('checkedAt'),'ok':images.get('ok')is True,
                   'complete':images.get('complete')is True,'findings':len(images.get('findings')or[])}
 checks['backups']=aggregate('status.json',projects,'verifiedAt')
 checks['restore']=aggregate('restore-check-all.json',projects,'checkedAt')
 return {'schema':1,'checks':checks}

class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):raise ValueError('Redirect refused')

def main():
 os.umask(0o077)
 cfg=json.loads(pathlib.Path('/etc/hatchkit-security/publisher.json').read_text())
 host=socket.gethostname()
 expected='https://security-monitor.example.workers.dev/ping/'+host
 if host not in('app-vps','ops-vps')or cfg.get('url')!=expected:raise ValueError('Unexpected monitor destination')
 if not re.fullmatch(r'[A-Za-z0-9_-]{43}',cfg.get('token','')):raise ValueError('Invalid ping credential')
 data=json.dumps(metadata()).encode();assert len(data)<=8192
 req=urllib.request.Request(expected,data=data,method='POST',headers={'Authorization':'Bearer '+cfg['token'],'Content-Type':'application/json','User-Agent':'hatchkit-health-publisher/1.0'})
 try:
  with urllib.request.build_opener(NoRedirect()).open(req,timeout=20)as response:
   if response.status!=200 or not json.loads(response.read(4096)).get('accepted'):raise ValueError('Heartbeat rejected')
 except __import__('urllib.error',fromlist=['HTTPError']).HTTPError as error:
  if error.code!=429:raise
 state={'checkedAt':dt.datetime.now(dt.timezone.utc).isoformat(),'ok':True}
 temp=WORK/'health-publisher-status.json.tmp';temp.write_text(json.dumps(state)+'\n');temp.replace(WORK/'health-publisher-status.json')
 print(json.dumps(state))
if __name__=='__main__':
 try:main()
 except Exception as e:print(json.dumps({'ok':False,'error':type(e).__name__,**({'httpStatus':e.code}if hasattr(e,'code')else{})}));sys.exit(1)
