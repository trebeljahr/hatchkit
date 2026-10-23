import importlib.util,json,pathlib,tempfile,unittest
from unittest.mock import patch
p=pathlib.Path(__file__).parent/'src/templates/security-controller/publish-health.py'
spec=importlib.util.spec_from_file_location('pub',p);pub=importlib.util.module_from_spec(spec);spec.loader.exec_module(pub)
class PublisherBoundary(unittest.TestCase):
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
if __name__=='__main__':unittest.main()
