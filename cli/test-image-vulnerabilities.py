#!/usr/bin/env python3
import contextlib,datetime as dt,copy,importlib.util,io,json,pathlib,subprocess,tempfile,unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('iv',pathlib.Path(__file__).parent/'src/templates/update-watch/image-vulnerabilities.py')
iv=importlib.util.module_from_spec(spec);spec.loader.exec_module(iv)
NOW=dt.datetime.now(dt.timezone.utc)
DB={'schemaVersion':'v6.1.10','from':'https://vendor.example/db?checksum=sha256:test','built':NOW.isoformat(),'valid':True}
def report(image='sha256:1'):
 return {'matches':[{'vulnerability':{'id':'CVE-test','severity':'High'},'artifact':{'name':'pkg','version':'1'}}],
         'source':{'target':{'userInput':image}},'descriptor':{'name':'grype','version':'0.121.0','timestamp':NOW.isoformat(),'db':{'status':DB.copy()}}}
class ImageScanTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.temp.name)
  self.patches=[patch.object(iv,'WORK',self.root),patch.object(iv,'REPORTS',self.root/'reports'),patch.object(iv,'SCRATCH',self.root/'tmp')]
  for p in self.patches:p.start()
 def tearDown(self):
  for p in reversed(self.patches):p.stop()
  self.temp.cleanup()
 def test_vulnerability_deduplication_retains_fix_and_cve_aliases(self):
  match={'vulnerability':{'id':'GHSA-test','severity':'Critical','fix':{'state':'fixed','versions':['2.0']}},'artifact':{'name':'lib','version':'1.0'},'relatedVulnerabilities':[{'id':'CVE-2026-1'}]}
  rows=iv.summarize({'matches':[match,match,{'vulnerability':{'severity':'Low'},'artifact':{}}]},'sha256:abc',['web','worker'])
  self.assertEqual(len(rows),1);self.assertEqual(rows[0]['aliases'],['CVE-2026-1']);self.assertEqual(rows[0]['containers'],['web','worker']);self.assertEqual(rows[0]['fixed'],'2.0')
 def test_failure_diagnostics_remain_private_and_disk_workspace_is_used(self):
  result=subprocess.CompletedProcess([],23,'','PRIVATE_TEST_VALUE')
  with patch.object(iv.subprocess,'run',return_value=result)as run:
   with self.assertRaises(iv.CommandError)as raised:iv.command(['scanner'])
  self.assertNotIn('PRIVATE_TEST_VALUE',str(raised.exception));self.assertEqual(pathlib.Path(raised.exception.diagnostic).read_text(),'PRIVATE_TEST_VALUE')
  self.assertEqual(run.call_args.kwargs['env']['TMPDIR'],str(self.root/'tmp'))
 def test_partial_inventory_is_incomplete_and_preserves_other_findings(self):
  def command(argv,timeout=600):
   if argv[:2]==['docker','ps']:return 'a b'
   if argv[:2]==['docker','inspect']:return '"one"\t"sha256:1"\n"two"\t"sha256:2"'
   if argv[1:3]==['db','update']:
    self.assertEqual(json.loads((self.root/'image-vulnerability-progress.json').read_text())['phase'],'running');self.assertFalse((self.root/'image-vulnerability-status.json').exists());return ''
   if argv[1:3]==['db','status']:return json.dumps(DB)
   if argv[1]=='version':return json.dumps({'version':'0.121.0'})
   if argv[1]=='docker:sha256:2':raise iv.CommandError('grype',1,'private.stderr')
   pathlib.Path(argv[-1]).write_text(json.dumps(report()));return ''
  with patch.object(iv,'command',side_effect=command),contextlib.redirect_stdout(io.StringIO()):result=iv.scan()
  self.assertFalse(result['complete']);self.assertEqual(len(result['findings']),1);self.assertEqual(result['errors'][0]['exitCode'],1)
 def test_cache_requires_same_image_scanner_database_and_fresh_provenance(self):
  valid=report();self.assertTrue(iv.usable_report(valid,'sha256:1',DB,'0.121.0',NOW))
  for image,db,version,now in [('sha256:2',DB,'0.121.0',NOW),('sha256:1',DB|{'built':(NOW-dt.timedelta(hours=1)).isoformat()},'0.121.0',NOW),('sha256:1',DB,'new-scanner',NOW),('sha256:1',DB,'0.121.0',NOW+dt.timedelta(hours=25)),('sha256:1',DB|{'valid':False},'0.121.0',NOW)]:
   self.assertFalse(iv.usable_report(valid,image,db,version,now))
  for mutation in ['future','missing','empty','bad-db']:
   bad=copy.deepcopy(valid)
   if mutation=='future':bad['descriptor']['timestamp']=(NOW+dt.timedelta(minutes=6)).isoformat()
   elif mutation=='missing':del bad['source']
   elif mutation=='empty':bad['descriptor']['version']=''
   else:bad['descriptor']['db']['status']['valid']=False
   self.assertFalse(iv.usable_report(bad,'sha256:1',DB,'0.121.0',NOW))
 def test_cached_inventory_uses_current_container_names_and_detects_deployment_race(self):
  reports=self.root/'reports';reports.mkdir();(reports/'1.json').write_text(json.dumps(report()))
  calls=[]
  def command(argv,timeout=600):
   calls.append(argv)
   if argv[1:3]==['db','update']:return ''
   if argv[1:3]==['db','status']:return json.dumps(DB)
   if argv[1]=='version':return json.dumps({'version':'0.121.0'})
   raise AssertionError('Cached image must not be rescanned')
  with patch.object(iv,'running_images',side_effect=[{'sha256:1':['new-container']},{'sha256:2':['new-container']}]),patch.object(iv,'command',side_effect=command),contextlib.redirect_stdout(io.StringIO()):result=iv.scan()
  self.assertEqual(result['findings'][0]['containers'],['new-container'])
  self.assertTrue(result['images'][0]['cached']);self.assertFalse(result['complete'])
  self.assertIn('inventory changed',result['errors'][0]['error'])
 def test_failed_attempt_retains_last_complete_ledger_and_explicit_failed_progress(self):
  old={'checkedAt':NOW.isoformat(),'ok':False,'complete':True,'findings':[{'id':'old-risk'}]}
  path=self.root/'image-vulnerability-status.json';path.write_text(json.dumps(old))
  with patch.object(iv,'scan',side_effect=RuntimeError('scanner failed')),contextlib.redirect_stdout(io.StringIO()):self.assertEqual(iv.main([]),1)
  self.assertEqual(json.loads(path.read_text()),old)
  self.assertFalse(json.loads((self.root/'image-vulnerability-attempt.json').read_text())['complete'])
  self.assertEqual(json.loads((self.root/'image-vulnerability-progress.json').read_text())['phase'],'failed')
 def test_completed_attempt_replaces_ledger_only_after_success(self):
  complete={'checkedAt':NOW.isoformat(),'ok':True,'complete':True,'findings':[],'errors':[],'images':[]}
  with patch.object(iv,'scan',return_value=complete),contextlib.redirect_stdout(io.StringIO()):self.assertEqual(iv.main([]),0)
  self.assertEqual(json.loads((self.root/'image-vulnerability-status.json').read_text()),complete)
  self.assertEqual(json.loads((self.root/'image-vulnerability-progress.json').read_text())['phase'],'complete')
 def current(self):
  return {'checkedAt':NOW.isoformat(),'ok':False,'complete':True,'errors':[],
          'images':[{'image':'sha256:1','containers':['worker','web'],'scannedAt':NOW.isoformat()}],'database':DB.copy()}
 def test_current_inventory_with_findings_needs_no_repeat_scan(self):
  current=self.current()
  self.assertFalse(iv.needs_refresh(current,current,{'sha256:1':['web','worker']},NOW))
 def test_deployments_renames_and_removed_images_refresh_the_ledger(self):
  current=self.current()
  for images in [{'sha256:2':['web','worker']},{'sha256:1':['new-web','worker']},{}]:
   self.assertTrue(iv.needs_refresh(current,current,images,NOW))
 def test_daily_database_refresh_and_old_cached_reports_cannot_be_deferred_by_renames(self):
  current=self.current();images={'sha256:1':['web','worker']}
  self.assertTrue(iv.needs_refresh(current,current,images,NOW+dt.timedelta(hours=23)))
  for mutate in [lambda r:r['images'][0].update(scannedAt=(NOW-dt.timedelta(hours=24)).isoformat()),
                 lambda r:r.update(database=DB|{'valid':False}),
                 lambda r:r.update(database=DB|{'built':(NOW-dt.timedelta(days=6)).isoformat()}),
                 lambda r:r.update(checkedAt=(NOW+dt.timedelta(minutes=6)).isoformat()),
                 lambda r:r.update(images=r['images']*2)]:
   bad=copy.deepcopy(current);mutate(bad);self.assertTrue(iv.needs_refresh(bad,current,images,NOW))
 def test_failed_or_missing_attempt_and_malformed_ledger_require_retry(self):
  current=self.current();images={'sha256:1':['web','worker']}
  for attempt in [{},current|{'complete':False},current|{'errors':['failed']}]:
   self.assertTrue(iv.needs_refresh(current,attempt,images,NOW))
  for bad in [{},current|{'images':None},current|{'images':[{'image':'sha256:1','containers':'web'}]}]:
   self.assertTrue(iv.needs_refresh(bad,current,images,NOW))
 def test_refresh_condition_skips_without_scanning_writing_or_sending(self):
  current=self.current()
  for name in ['image-vulnerability-status.json','image-vulnerability-attempt.json']:(self.root/name).write_text(json.dumps(current))
  before={p.name:p.read_bytes()for p in self.root.iterdir()}
  with patch.object(iv,'running_images',return_value={'sha256:1':['web','worker']}),patch.object(iv,'scan')as scan,contextlib.redirect_stdout(io.StringIO()):
   self.assertEqual(iv.main(['--needs-refresh']),1);scan.assert_not_called()
  self.assertEqual(before,{p.name:p.read_bytes()for p in self.root.iterdir()})
 def test_refresh_condition_fails_visibly_when_runtime_inspection_breaks(self):
  output=io.StringIO()
  with patch.object(iv,'running_images',side_effect=RuntimeError('PRIVATE_TEST_VALUE')),contextlib.redirect_stdout(output):
   self.assertEqual(iv.main(['--needs-refresh']),255)
  self.assertNotIn('PRIVATE_TEST_VALUE',output.getvalue());self.assertIn('RuntimeError',output.getvalue())
if __name__=='__main__':unittest.main()
