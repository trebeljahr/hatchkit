#!/usr/bin/env python3
"""Explicit reviewed-state baseline, gated by package and detector review.
The resulting baseline establishes change detection; it is not proof of no compromise.
"""
import argparse,datetime as dt,hashlib,json,os,pathlib,subprocess,tempfile
p=argparse.ArgumentParser();p.add_argument('--accept-reviewed-state',action='store_true',required=True);a=p.parse_args()
os.umask(0o077)
root=pathlib.Path('/var/lib/hatchkit-security/aide-review');root.mkdir(parents=True,exist_ok=True,mode=0o700)
verify=subprocess.run(['dpkg','--verify'],capture_output=True,text=True,timeout=300)
(root/'dpkg-verify.log').write_text(verify.stdout+verify.stderr)
allowed={'/etc/security/limits.conf','/etc/ssh/ssh_config','/etc/login.defs','/etc/apparmor.d/disable'}
changes=[line for line in verify.stdout.splitlines()if line.strip()]
assert not verify.stderr and all(line.split()[-1]in allowed for line in changes),'Unreviewed package verification difference'
quick=json.loads(pathlib.Path('/var/lib/hatchkit-backups/host-integrity-quick-status.json').read_text())
checked=dt.datetime.fromisoformat(quick['checkedAt'])
expected_quick_skips={'CPU not measured: the window was under 5 s.','Sustained CPU and outbound peers use the daily full scan.'}
assert quick['ok'] and set(quick.get('skipped',[]))<=expected_quick_skips and dt.datetime.now(dt.timezone.utc)-checked<dt.timedelta(minutes=20),'Fresh clean process/file integrity check required'
policy=pathlib.Path('/etc/hatchkit-security/aide.conf').read_text()
with tempfile.TemporaryDirectory(prefix='aide-proof-',dir=str(root)) as temp:
 d=pathlib.Path(temp);fixture=d/'fixture';fixture.mkdir();f=fixture/'canary';f.write_text('before\n')
 rule=next(line for line in policy.splitlines()if line.startswith('HARDENED ='))
 cfg=d/'aide.conf';cfg.write_text('database_in=file:'+str(d/'aide.db')+'\ndatabase_out=file:'+str(d/'aide.db.new')+'\ngzip_dbout=no\nreport_url=stdout\n'+rule+'\n'+str(fixture)+' HARDENED\n')
 with (root/'fixture-init.log').open('w')as log:subprocess.run(['aide','--config='+str(cfg),'--init'],stdout=log,stderr=subprocess.STDOUT,check=True,timeout=120)
 (d/'aide.db.new').replace(d/'aide.db')
 with (root/'fixture-clean.log').open('w')as log:subprocess.run(['aide','--config='+str(cfg),'--check'],stdout=log,stderr=subprocess.STDOUT,check=True,timeout=120)
 f.write_text('after: deliberate detection proof\n')
 with (root/'fixture-changed.log').open('w')as log:changed=subprocess.run(['aide','--config='+str(cfg),'--check'],stdout=log,stderr=subprocess.STDOUT,timeout=120)
 assert 1<=changed.returncode<=7,'AIDE did not detect controlled file change'
db=pathlib.Path('/var/lib/hatchkit-security/aide/aide.db');assert not db.exists(),'Existing baseline must be reviewed separately, not overwritten'
with (root/'baseline-init.log').open('w')as log:subprocess.run(['aide','--config=/etc/hatchkit-security/aide.conf','--init'],stdout=log,stderr=subprocess.STDOUT,check=True,timeout=1800)
new=db.with_name('aide.db.new');assert new.is_file() and new.stat().st_size>0
new.replace(db)
result={'acceptedAt':dt.datetime.now(dt.timezone.utc).isoformat(),'policySHA256':hashlib.sha256(policy.encode()).hexdigest(),'databaseSHA256':hashlib.sha256(db.read_bytes()).hexdigest(),'fixtureDetectionExitCode':changed.returncode,'reviewedPackageDifferences':changes,'proofOfNoCompromise':False}
(root/'review.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result),flush=True)
subprocess.run(['systemctl','start','hatchkit-file-integrity.service'],check=True,timeout=1800)
