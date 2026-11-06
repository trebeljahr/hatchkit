import importlib.util,json,pathlib,tempfile,unittest,concurrent.futures,urllib.error
from unittest.mock import patch
p=pathlib.Path(__file__).parent/'src/templates/security-controller/publish-health.py'
spec=importlib.util.spec_from_file_location('pub',p);pub=importlib.util.module_from_spec(spec);spec.loader.exec_module(pub)
class PublisherBoundary(unittest.TestCase):
 def test_a_dead_or_failing_digest_is_a_coverage_failure_without_exporting_detail(self):
  now=pub.dt.datetime(2026,11,5,12,tzinfo=pub.dt.timezone.utc)
  cfg={'alerts':{'enabled':True}}
  fresh={'checkedAt':(now-pub.dt.timedelta(hours=1)).isoformat()}
  old={'checkedAt':(now-pub.dt.timedelta(hours=4)).isoformat()}
  with tempfile.TemporaryDirectory() as folder:
   module=pathlib.Path(folder)/'ops_digest.py';module.write_text('fixture')
   real=pathlib.Path
   with patch.object(pub.pathlib,'Path',side_effect=lambda v:real(module) if v=='/opt/hatchkit-backups/ops_digest.py' else real(v)):
    with patch.object(pub,'read',return_value=fresh):
     self.assertFalse(pub.digest_failing(cfg,now))
     self.assertFalse(pub.digest_failing({},now))
    with patch.object(pub,'read',return_value=old):self.assertTrue(pub.digest_failing(cfg,now))
    with patch.object(pub,'read',return_value={**fresh,'mailError':'OSError'}):self.assertTrue(pub.digest_failing(cfg,now))
    # A fresh install gets its first hourly run; an old module without a result does not.
    with patch.object(pub,'read',return_value={}):
     self.assertFalse(pub.digest_failing(cfg,pub.dt.datetime.fromtimestamp(module.stat().st_mtime,pub.dt.timezone.utc)))
     self.assertTrue(pub.digest_failing(cfg,pub.dt.datetime.fromtimestamp(module.stat().st_mtime+4*3600,pub.dt.timezone.utc)))
 def test_guard_operation_is_local_diagnostic_metadata_not_external_payload(self):
  rows={'host-integrity-quick-status.json':{'checkedAt':'2026-10-28T07:00:00Z','ok':True},
        'database-guard-status.json':{'checkedAt':'2026-10-28T07:00:00Z','ok':False,'complete':False,'error':'TimeoutExpired','failedOperation':'docker-inspect','argv':'PRIVATE_VALUE'}}
  original=pathlib.Path.read_text
  def read(path,*a,**kw):
   if str(path)=='/etc/hatchkit-backups/config.json':return json.dumps({'projects':[]})
   return original(path,*a,**kw)
  with patch.dict(pub.os.environ,{'HATCHKIT_DATABASE_GUARD_REQUIRED':'1'}),patch.object(pub,'read',side_effect=lambda n:rows.get(n,{})),patch.object(pathlib.Path,'read_text',read):
   details={};payload=pub.metadata(details)
  self.assertEqual(details['databaseGuard']['failedOperation'],'docker-inspect');self.assertFalse(payload['checks']['process']['complete'])
  self.assertNotIn('failedOperation',json.dumps(payload));self.assertNotIn('PRIVATE_VALUE',json.dumps(details))
  self.assertNotIn('failedOperation',pub.control_summary({'failedOperation':'PRIVATE_VALUE'}))
 def test_required_database_egress_cannot_disappear_or_export_private_destinations(self):
  rows={'host-integrity-quick-status.json':{'checkedAt':'2026-10-26T02:00:00Z','ok':True},
        'database-egress-status.json':{'checkedAt':'2026-10-26T01:58:00Z','ok':True,'complete':True,'destinations':['DO_NOT_EXPORT']}}
  original=pathlib.Path.read_text
  def read(path,*a,**kw):
   if str(path)=='/etc/hatchkit-backups/config.json':return json.dumps({'projects':[]})
   return original(path,*a,**kw)
  with patch.dict(pub.os.environ,{'HATCHKIT_DATABASE_EGRESS_REQUIRED':'1'}),patch.object(pub,'read',side_effect=lambda name:rows.get(name,{})),patch.object(pathlib.Path,'read_text',read):
   diagnostics={};good=pub.metadata(diagnostics)['checks']['process']
   self.assertTrue(good['ok']);self.assertEqual(good['checkedAt'],'2026-10-26T01:58:00+00:00')
   self.assertNotIn('DO_NOT_EXPORT',json.dumps(diagnostics))
   rows['database-egress-status.json']['complete']=False
   self.assertFalse(pub.metadata()['checks']['process']['ok'])
   del rows['database-egress-status.json']
   missing=pub.metadata()['checks']['process'];self.assertFalse(missing['complete']);self.assertIsNone(missing['checkedAt'])
 def test_required_metadata_guard_cannot_disappear_or_leak_detail(self):
  rows={'host-integrity-quick-status.json':{'checkedAt':'2026-10-25T02:00:00Z','ok':True},
        'container-policy-status.json':{'checkedAt':'2026-10-25T01:59:00Z','ok':True,'complete':True},
        'metadata-guard-status.json':{'checkedAt':'2026-10-25T01:58:00Z','ok':True,'complete':True,'private':'DO_NOT_EXPORT'}}
  original=pathlib.Path.read_text
  def read(path,*a,**kw):
   if str(path)=='/etc/hatchkit-backups/config.json':return json.dumps({'projects':[]})
   return original(path,*a,**kw)
  with patch.dict(pub.os.environ,{'HATCHKIT_CONTAINER_POLICY_REQUIRED':'1','HATCHKIT_METADATA_GUARD_REQUIRED':'1'}), \
       patch.object(pub,'read',side_effect=lambda name:rows.get(name,{})),patch.object(pathlib.Path,'read_text',read):
   good=pub.metadata()['checks']['process']
   self.assertTrue(good['ok']);self.assertEqual(good['checkedAt'],'2026-10-25T01:58:00+00:00')
   self.assertNotIn('DO_NOT_EXPORT',json.dumps(good))
   rows['metadata-guard-status.json'].update(ok=False,findings=[{'resource':'DO_NOT_EXPORT'}])
   self.assertFalse(pub.metadata()['checks']['process']['ok'])
   del rows['metadata-guard-status.json']
   missing=pub.metadata()['checks']['process']
   self.assertFalse(missing['complete']);self.assertIsNone(missing['checkedAt'])
 def test_required_database_guard_cannot_disappear_or_leak_detail(self):
  rows={'host-integrity-quick-status.json':{'checkedAt':'2026-10-25T02:00:00Z','ok':True},
        'container-policy-status.json':{'checkedAt':'2026-10-25T01:59:00Z','ok':True,'complete':True},
        'database-guard-status.json':{'checkedAt':'2026-10-25T01:58:00Z','ok':True,'complete':True,'private':'DO_NOT_EXPORT'}}
  original=pathlib.Path.read_text
  def read(path,*a,**kw):
   if str(path)=='/etc/hatchkit-backups/config.json':return json.dumps({'projects':[]})
   return original(path,*a,**kw)
  with patch.dict(pub.os.environ,{'HATCHKIT_CONTAINER_POLICY_REQUIRED':'1','HATCHKIT_DATABASE_GUARD_REQUIRED':'1'}), \
       patch.object(pub,'read',side_effect=lambda name:rows.get(name,{})),patch.object(pathlib.Path,'read_text',read):
   good=pub.metadata()['checks']['process']
   self.assertTrue(good['ok']);self.assertEqual(good['checkedAt'],'2026-10-25T01:58:00+00:00')
   self.assertNotIn('DO_NOT_EXPORT',json.dumps(good))
   rows['database-guard-status.json'].update(ok=False,findings=[{'resource':'DO_NOT_EXPORT'}])
   self.assertFalse(pub.metadata()['checks']['process']['ok'])
   del rows['database-guard-status.json']
   missing=pub.metadata()['checks']['process']
   self.assertFalse(missing['complete']);self.assertIsNone(missing['checkedAt'])
 def test_payload_contains_only_fixed_metadata_and_detects_missing_project(self):
  with tempfile.TemporaryDirectory()as folder:
   root=pathlib.Path(folder);data={'projects':[{'name':'one'},{'name':'two'}]}
   files={'status.json':{'results':[{'project':'one','ok':True,'verifiedAt':'2026-10-23T00:00:00Z','privateRecord':'MUST_NOT_TRANSMIT'}]},'host-integrity-quick-status.json':{'checkedAt':'2026-10-23T00:00:00Z','ok':True,'skipped':list(pub.QUICK_EXCLUSIONS),'env':'PRIVATE_SECRET'},'update-watch-status.json':{'checkedAt':'2026-10-23T00:00:00Z','ok':True,'services':[]}}
   for name,value in files.items():(root/name).write_text(json.dumps(value))
   original=pathlib.Path.read_text
   def read(path,*a,**kw):
    if str(path)=='/etc/hatchkit-backups/config.json':return json.dumps(data)
    return original(path,*a,**kw)
   with patch.object(pub,'WORK',root),patch.object(pathlib.Path,'read_text',read):payload=pub.metadata()
   text=json.dumps(payload)
   for secret in ['MUST_NOT_TRANSMIT','PRIVATE_SECRET','privateRecord','env','one','two']:self.assertNotIn(secret,text)
   self.assertTrue(payload['checks']['process']['complete'])
   self.assertFalse(payload['checks']['backups']['complete'])
   self.assertFalse(payload['checks']['advisory']['complete'])
 def test_vulnerability_counts_are_not_duplicate_external_incidents_but_failed_delivery_is(self):
  rows={
   'update-watch-status.json':{'checkedAt':'2026-10-23T00:00:00Z','ok':False,'findings':[{'private':'ledger'}],
       'services':[{'service':x}for x in ('host-docker','host-containerd','host-runc','host-tailscale')]},
   'image-vulnerability-status.json':{'checkedAt':'2026-10-23T00:00:00Z','ok':False,'complete':True,'findings':[{}],'errors':[]}}
  original=pathlib.Path.read_text
  def read(path,*a,**kw):
   if str(path)=='/etc/hatchkit-backups/config.json':return json.dumps({'projects':[]})
   return original(path,*a,**kw)
  with patch.object(pub,'read',side_effect=lambda name:rows.get(name,{})),patch.object(pathlib.Path,'read_text',read):
   good=pub.metadata();self.assertTrue(good['checks']['advisory']['ok']);self.assertTrue(good['checks']['images']['ok'])
   rows['update-watch-status.json']['mailError']='SMTPError'
   bad=pub.metadata();self.assertFalse(bad['checks']['advisory']['ok'])
   self.assertEqual(bad['checks']['advisory']['findings'],1)
 def test_image_refresh_setup_failure_and_stall_are_distinct(self):
  now=pub.dt.datetime(2026,10,23,tzinfo=pub.dt.timezone.utc)
  progress={'phase':'running','checkedAt':now.isoformat(),'startedAt':now.isoformat(),'errors':0}
  last={'checkedAt':now.isoformat(),'complete':True,'findings':[{}],'errors':[]}
  normal=pub.image_metadata(last,progress,now)
  self.assertTrue(normal['complete']);self.assertTrue(normal['ok']);self.assertEqual(normal['phase'],'refreshing')
  initial=pub.image_metadata({},progress,now)
  self.assertFalse(initial['complete']);self.assertEqual(initial['phase'],'initializing')
  failed=pub.image_metadata(last,progress|{'phase':'failed'},now)
  self.assertFalse(failed['ok']);self.assertEqual(failed['phase'],'failed')
  stalled=pub.image_metadata(last,progress,now+pub.dt.timedelta(minutes=21))
  self.assertFalse(stalled['complete']);self.assertEqual(stalled['phase'],'failed')
 def test_required_control_scan_cannot_disappear_or_reset_coverage_age(self):
  process={'checkedAt':'2026-10-23T01:00:00Z','ok':True,'complete':True,'findings':0}
  missing=pub.with_container_controls(process,{})
  self.assertFalse(missing['complete']);self.assertIsNone(missing['checkedAt'])
  control={'checkedAt':'2026-10-23T00:00:00Z','ok':True,'complete':True,'findings':[]}
  healthy=pub.with_container_controls(process,control)
  self.assertTrue(healthy['ok']);self.assertEqual(healthy['checkedAt'],'2026-10-23T00:00:00+00:00')
  control.update(ok=False,findings=[{'resource':'PRIVATE_SECRET','field':'unhealthy'}])
  failed=pub.with_container_controls(process,control)
  self.assertFalse(failed['ok']);self.assertEqual(failed['findings'],1);self.assertNotIn('PRIVATE_SECRET',json.dumps(failed))
  self.assertFalse(pub.with_container_controls(process,control|{'complete':False})['complete'])

 def test_diagnostic_components_identify_missing_guard_without_private_details(self):
  rows={'host-integrity-quick-status.json':{'checkedAt':'2026-10-25T02:00:00Z','ok':True,'skipped':['PRIVATE_CONTAINER: docker diff failed; writable layer not checked.']},'metadata-guard-status.json':{'checkedAt':'2026-10-25T01:58:00Z','ok':False,'complete':False,'error':'CalledProcessError','private':'PRIVATE_DETAIL'}}
  original=pathlib.Path.read_text
  def read(path,*a,**kw):
   if str(path)=='/etc/hatchkit-backups/config.json':return json.dumps({'projects':[]})
   return original(path,*a,**kw)
  diagnostics={}
  with patch.dict(pub.os.environ,{'HATCHKIT_METADATA_GUARD_REQUIRED':'1'}),patch.object(pub,'read',side_effect=lambda n:rows.get(n,{})),patch.object(pathlib.Path,'read_text',read):payload=pub.metadata(diagnostics)
  self.assertFalse(diagnostics['processSnapshot']['complete']);self.assertEqual(diagnostics['processSnapshot']['coverageFailures'],['writable-layer']);self.assertNotIn('PRIVATE_CONTAINER',json.dumps(diagnostics));self.assertFalse(diagnostics['metadataGuard']['complete'])
  self.assertEqual(diagnostics['metadataGuard']['errorType'],'CalledProcessError')
  self.assertNotIn('PRIVATE_DETAIL',json.dumps(diagnostics));self.assertNotIn('components',payload)
 def test_receipts_preserve_exact_failed_component_and_bound_history(self):
  with tempfile.TemporaryDirectory()as folder,patch.object(pub,'WORK',pathlib.Path(folder)):
   payload={'schema':1,'checks':{'process':{'complete':False}}};details={'containerPolicy':{'complete':False,'errorType':'CalledProcessError'}}
   for i in range(50):
    pub.record_receipt(str(i),payload,details,'attempted');pub.record_receipt(str(i),payload,details,'accepted')
   path=pub.WORK/'health-publisher-history.json';r=json.loads(path.read_text())
   self.assertEqual(len(r['attempts']),48);self.assertEqual(r['attempts'][0]['id'],'2');self.assertEqual(path.stat().st_mode&0o777,0o600)
   self.assertEqual(r['attempts'][-1]['components'],details);self.assertEqual(r['attempts'][-1]['delivery'],'accepted')
   self.assertFalse(r['attempts'][-1]['health']['checks']['process']['complete']);self.assertEqual(len(r['attention']),16)
   for i in range(50,100):
    pub.record_receipt(str(i),{'schema':1,'checks':{}},{},'attempted');pub.record_receipt(str(i),{'schema':1,'checks':{}},{},'accepted')
   final=json.loads(path.read_text());self.assertEqual(final['attention'],r['attention']);self.assertEqual(len(final['attempts']),48)
 def test_receipt_writers_do_not_lose_concurrent_attempts(self):
  with tempfile.TemporaryDirectory()as folder,patch.object(pub,'WORK',pathlib.Path(folder)):
   def record(i):
    pub.record_receipt(str(i),{'schema':1,'checks':{}},{},'attempted');pub.record_receipt(str(i),{'schema':1,'checks':{}},{},'accepted')
   with concurrent.futures.ThreadPoolExecutor(max_workers=8)as pool:list(pool.map(record,range(16)))
   rows=json.loads((pub.WORK/'health-publisher-history.json').read_text())['attempts']
   self.assertEqual({r['id']for r in rows},{str(i)for i in range(16)});self.assertTrue(all(r['delivery']=='accepted'for r in rows))
 def test_invalid_or_oversized_history_is_preserved_and_fails_closed(self):
  with tempfile.TemporaryDirectory()as folder,patch.object(pub,'WORK',pathlib.Path(folder)):
   p=pub.WORK/'health-publisher-history.json'
   for value in ['broken',json.dumps({'schema':2,'attempts':[]}), 'x'*(1024**2+1)]:
    p.write_text(value)
    with self.assertRaises(ValueError):pub.record_receipt('one',{'schema':1,'checks':{}},{},'attempted')
    self.assertEqual(p.read_text(),value)
 def test_delivery_receipts_distinguish_acceptance_rate_limit_and_failure_without_credentials(self):
  for outcome in ['accepted','rate-limited','failed']:
   with self.subTest(outcome=outcome),tempfile.TemporaryDirectory()as folder,patch.object(pub,'WORK',pathlib.Path(folder)):
    cfg={'url':'https://security-monitor.example.workers.dev/ping/ops-vps','token':'A'*43}
    original=pathlib.Path.read_text
    def read(path,*a,**kw):
     if str(path)=='/etc/hatchkit-security/publisher.json':return json.dumps(cfg)
     return original(path,*a,**kw)
    class Response:
     status=200
     def __enter__(self):return self
     def __exit__(self,*args):pass
     def read(self,*args):return b'{"accepted":true}'
    class Opener:
     def open(self,*args,**kw):
      if outcome=='rate-limited':raise urllib.error.HTTPError(cfg['url'],429,'fixture',{},None)
      if outcome=='failed':raise urllib.error.URLError('PRIVATE_PROVIDER_DETAIL')
      return Response()
    with patch.object(pathlib.Path,'read_text',read),patch.object(pub.socket,'gethostname',return_value='ops-vps'),patch.object(pub,'metadata',return_value={'schema':1,'checks':{}}),patch.object(pub.urllib.request,'build_opener',return_value=Opener()):
     if outcome=='failed':
      with self.assertRaises(urllib.error.URLError):pub.main()
     else:pub.main()
    text=(pub.WORK/'health-publisher-history.json').read_text();r=json.loads(text)['attempts'][-1]
    self.assertEqual(r['delivery'],outcome)
    for private in [cfg['token'],'PRIVATE_PROVIDER_DETAIL','Authorization',cfg['url']]:self.assertNotIn(private,text)

 def test_monitor_url_is_the_https_ping_path_for_this_host(self):
    ok='https://monitor.example.net/ping/web-1'
    self.assertEqual(pub.monitor_url(ok,'web-1'),ok)
    for bad,host in [('http://monitor.example.net/ping/web-1','web-1'),('https://monitor.example.net/ping/web-2','web-1'),
                     ('https://u:p@monitor.example.net/ping/web-1','web-1'),('https://monitor.example.net:8443/ping/web-1','web-1'),
                     ('https://monitor.example.net/ping/web-1?x=1','web-1'),('https://monitor.example.net/ping/web-1#x','web-1'),
                     ('https://monitor.example.net/ping/Web 1','Web 1'),(None,'web-1')]:
      with self.assertRaisesRegex(ValueError,'Unexpected monitor destination'):pub.monitor_url(bad,host)

if __name__=='__main__':unittest.main()
