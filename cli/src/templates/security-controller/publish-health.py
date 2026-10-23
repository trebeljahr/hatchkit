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

def image_metadata(images,progress,now=None):
 now=now or dt.datetime.now(dt.timezone.utc)
 row={'checkedAt':images.get('checkedAt'),'ok':images.get('complete')is True and not images.get('errors'),
      'complete':images.get('complete')is True,'findings':0,'phase':'complete'}
 if progress:
  row.update(progressAt=progress.get('checkedAt'),startedAt=progress.get('startedAt'))
  try:
   phase=progress['phase']
   if phase=='running':
    last=dt.datetime.fromisoformat(progress['checkedAt'])
    started=dt.datetime.fromisoformat(progress['startedAt'])
    if last>now+dt.timedelta(minutes=5)or started>now+dt.timedelta(minutes=5)or now-last>dt.timedelta(minutes=20)or now-started>dt.timedelta(hours=2)or progress.get('errors'):
     phase='failed'
    else:phase='refreshing'if row['complete']else'initializing'
   if phase not in('complete','refreshing','initializing'):phase='failed'
  except (KeyError,ValueError,TypeError):phase='failed'
  row['phase']=phase
  if phase in('failed','initializing'):
   row.update(ok=False,complete=False)
   if not row['checkedAt']:row['checkedAt']=progress.get('checkedAt')
 return row

def with_container_controls(process,controls):
 try:
  times=[dt.datetime.fromisoformat(row['checkedAt'].replace('Z','+00:00'))for row in(process,controls)]
  valid=all(time.tzinfo is not None for time in times)
  complete=valid and process['complete'] and controls.get('complete')is True and not controls.get('error')
  return {'checkedAt':min(times).isoformat()if valid else None,'complete':bool(complete),
          'ok':bool(complete)and process['ok']is True and controls.get('ok')is True,
          'findings':process['findings']+len(controls.get('findings')or[])}
 except(KeyError,ValueError,TypeError):
  return {'checkedAt':None,'complete':False,'ok':False,'findings':0}


def metadata():
 cfg=json.loads(pathlib.Path('/etc/hatchkit-backups/config.json').read_text())
 projects=[p['name']for p in cfg['projects']]
 checks={key:simple(file,exclusions) for key,file,exclusions in [
  ('process','host-integrity-quick-status.json',QUICK_EXCLUSIONS),
  ('full','host-integrity-status.json',()),('advisory','update-watch-status.json',()),
  ('files','file-integrity-status.json',())]}
 if os.environ.get('HATCHKIT_CONTAINER_POLICY_REQUIRED')=='1':
  checks['process']=with_container_controls(checks['process'],read('container-policy-status.json'))
 advisory=read('update-watch-status.json')
 # The host watcher/triage owns vulnerability notifications. This independent
 # monitor owns coverage and failed delivery, not a second copy of its ledger.
 checks['advisory']['ok']=checks['advisory']['complete'] and not advisory.get('mailError')
 checks['advisory']['findings']=int(bool(advisory.get('mailError')))
 if not {'host-docker','host-containerd','host-runc','host-tailscale'}<={r.get('service')for r in advisory.get('services',[])}:
  checks['advisory']['complete']=False
 images=read('image-vulnerability-status.json')
 checks['images']=image_metadata(images,read('image-vulnerability-progress.json'))
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
