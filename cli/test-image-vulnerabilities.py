#!/usr/bin/env python3
import contextlib,importlib.util,io,json,pathlib,subprocess,tempfile,unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('iv',pathlib.Path(__file__).parent/'src/templates/update-watch/image-vulnerabilities.py')
iv=importlib.util.module_from_spec(spec);spec.loader.exec_module(iv)
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
    self.assertFalse(json.loads((self.root/'image-vulnerability-status.json').read_text())['complete']);return ''
   if argv[1:3]==['db','status']:return '{}'
   if argv[1]=='docker:sha256:2':raise iv.CommandError('grype',1,'private.stderr')
   pathlib.Path(argv[-1]).write_text(json.dumps({'matches':[{'vulnerability':{'id':'CVE-test','severity':'High'},'artifact':{'name':'pkg','version':'1'}}],'source':{'type':'image'}}));return ''
  with patch.object(iv,'command',side_effect=command),contextlib.redirect_stdout(io.StringIO()):report=iv.scan()
  self.assertFalse(report['complete']);self.assertEqual(len(report['findings']),1);self.assertEqual(report['errors'][0]['exitCode'],1)
if __name__=='__main__':unittest.main()
