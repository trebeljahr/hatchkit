#!/usr/bin/env python3
"""Publish fixed health counters/timestamps. Never transmit logs, configs or records."""
import datetime as dt,json,os,pathlib,re,socket,urllib.request,sys,uuid,fcntl
WORK=pathlib.Path('/var/lib/hatchkit-backups')
QUICK_EXCLUSIONS={'CPU not measured: the window was under 5 s.','Sustained CPU and outbound peers use the daily full scan.'}

def read(name):
 try:return json.loads((WORK/name).read_text())
 except (OSError,ValueError):return {}

def simple(name,allowed_skips=(),diagnostics=None):
 row=read(name)
 if diagnostics is not None:
  skips=set(row.get('skipped',[]))-set(allowed_skips)
  diagnostics['errorType']=control_summary(row)['errorType'];diagnostics['unreviewedSkipCount']=len(skips)
  diagnostics['coverageFailures']=sorted({'container-inspection'if text.endswith('container(s) could not be read from docker inspect.')else'writable-layer'if text.endswith(': docker diff failed; writable layer not checked.')else'other-coverage'for text in skips})
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


def control_summary(row):
 return {'checkedAt':row.get('checkedAt'),'ok':row.get('ok')is True,
         'complete':row.get('complete')is True and not row.get('error'),
         'findings':len(row.get('findings')or[]),
         'errorType':row.get('error')if re.fullmatch(r'[A-Za-z]{1,80}',str(row.get('error')or''))else('OtherError'if row.get('error')else None)}

def record_receipt(attempt,payload,components,delivery):
 with (WORK/'.health-publisher-history.lock').open('a')as lock:
  fcntl.flock(lock,fcntl.LOCK_EX)
  _record_receipt(attempt,payload,components,delivery)

def _record_receipt(attempt,payload,components,delivery):
 if delivery not in {'attempted','accepted','rate-limited','failed'}:raise ValueError('Invalid delivery receipt')
 path=WORK/'health-publisher-history.json'
 try:
  if path.is_symlink()or path.stat().st_size>1024**2:raise ValueError('Invalid receipt history')
  history=json.loads(path.read_text())
 except FileNotFoundError:history={'schema':1,'attempts':[]}
 if history.get('schema')!=1 or not isinstance(history.get('attempts'),list)or len(history['attempts'])>48:raise ValueError('Invalid receipt history')
 rows=history['attempts'];matches=[r for r in rows if r.get('id')==attempt]
 stamp=dt.datetime.now(dt.timezone.utc).isoformat()
 if delivery=='attempted':
  if matches:raise ValueError('Duplicate delivery attempt')
  rows.append({'id':attempt,'attemptedAt':stamp,'delivery':delivery,'health':payload,'components':components})
 else:
  if len(matches)!=1 or matches[0]['health']!=payload or matches[0]['components']!=components:raise ValueError('Missing matching delivery attempt')
  matches[0].update(delivery=delivery,finishedAt=stamp)
 attention=history.get('attention',[])
 if not isinstance(attention,list)or len(attention)>16:raise ValueError('Invalid attention history')
 entry=next(r for r in rows if r['id']==attempt)
 if delivery=='failed'or any(r.get('ok')is not True or r.get('complete')is not True for r in payload['checks'].values()):
  attention=[r for r in attention if r.get('id')!=attempt]+[entry]
 history['attention']=attention[-16:];history['attempts']=rows[-48:]
 data=json.dumps(history,indent=2)+'\n'
 if len(data.encode())>1024**2:raise ValueError('Receipt history exceeded bound')
 temporary=path.with_name(path.name+'.tmp');temporary.write_text(data);temporary.chmod(0o600);temporary.replace(path)

def metadata(diagnostics=None):
 cfg=json.loads(pathlib.Path('/etc/hatchkit-backups/config.json').read_text())
 projects=[p['name']for p in cfg['projects']]
 process_diagnostics={}if diagnostics is not None else None
 checks={key:simple(file,exclusions,process_diagnostics if key=='process'else None) for key,file,exclusions in [
  ('process','host-integrity-quick-status.json',QUICK_EXCLUSIONS),
  ('full','host-integrity-status.json',()),('advisory','update-watch-status.json',()),
  ('files','file-integrity-status.json',())]}
 if diagnostics is not None:diagnostics['processSnapshot']={**checks['process'],**process_diagnostics}
 for flag,name,key in [('HATCHKIT_CONTAINER_POLICY_REQUIRED','container-policy-status.json','containerPolicy'),('HATCHKIT_METADATA_GUARD_REQUIRED','metadata-guard-status.json','metadataGuard'),('HATCHKIT_DATABASE_GUARD_REQUIRED','database-guard-status.json','databaseGuard'),('HATCHKIT_DATABASE_EGRESS_REQUIRED','database-egress-status.json','databaseEgress')]:
  if os.environ.get(flag)=='1':
   row=read(name)
   if diagnostics is not None:diagnostics[key]=control_summary(row)
   checks['process']=with_container_controls(checks['process'],row)
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
 components={};payload=metadata(components);data=json.dumps(payload).encode();assert len(data)<=8192
 attempt=uuid.uuid4().hex;record_receipt(attempt,payload,components,'attempted');delivery='accepted'
 req=urllib.request.Request(expected,data=data,method='POST',headers={'Authorization':'Bearer '+cfg['token'],'Content-Type':'application/json','User-Agent':'hatchkit-health-publisher/1.0'})
 try:
  with urllib.request.build_opener(NoRedirect()).open(req,timeout=20)as response:
   if response.status!=200 or not json.loads(response.read(4096)).get('accepted'):raise ValueError('Heartbeat rejected')
 except __import__('urllib.error',fromlist=['HTTPError']).HTTPError as error:
  try:
   if error.code!=429:
    record_receipt(attempt,payload,components,'failed');raise
   delivery='rate-limited'
  finally:error.close()
 except Exception:
  record_receipt(attempt,payload,components,'failed');raise
 record_receipt(attempt,payload,components,delivery)
 state={'checkedAt':dt.datetime.now(dt.timezone.utc).isoformat(),'ok':True}
 temp=WORK/'health-publisher-status.json.tmp';temp.write_text(json.dumps(state)+'\n');temp.replace(WORK/'health-publisher-status.json')
 print(json.dumps(state))
if __name__=='__main__':
 try:main()
 except Exception as e:print(json.dumps({'ok':False,'error':type(e).__name__,**({'httpStatus':e.code}if hasattr(e,'code')else{})}));sys.exit(1)
