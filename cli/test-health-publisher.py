import importlib.util,json,pathlib,tempfile,unittest
from unittest.mock import patch
p=pathlib.Path(__file__).parent/'src/templates/security-controller/publish-health.py'
spec=importlib.util.spec_from_file_location('pub',p);pub=importlib.util.module_from_spec(spec);spec.loader.exec_module(pub)
class PublisherBoundary(unittest.TestCase):
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

if __name__=='__main__':unittest.main()
