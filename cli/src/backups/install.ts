import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { backupCredentials, backupHostExec, backupProvider } from "./provider.js";

// The payload travels only over Tailscale SSH stdin. Secrets never become argv,
// application env variables, provider metadata, or generated project files.
const INSTALL = `import fcntl,json,os,pathlib,subprocess,sys,tempfile
os.umask(0o077)
payload=json.load(sys.stdin)
root=pathlib.Path('/etc/hatchkit-backups')
root.mkdir(mode=0o700,exist_ok=True)
with (root/'.register.lock').open('w') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX)
 config_path=root/'config.json'
 config=json.loads(config_path.read_text()) if config_path.exists() else {'repositoryBase':payload['repositoryBase'],'credentialsFile':str(root/'credentials.json'),'passwordFile':str(root/'password'),'projects':[]}
 if config['repositoryBase']!=payload['repositoryBase'] or config['credentialsFile']!=str(root/'credentials.json') or config['passwordFile']!=str(root/'password'):
  raise SystemExit('Existing backup location differs; no credentials were changed')
 credentials=payload['credentials']
 password_path=root/'password'
 if password_path.exists() and password_path.read_text().strip()!=credentials['password']:
  raise SystemExit('Recovery password differs; existing backup access was preserved')
 with tempfile.TemporaryDirectory(prefix='hatchkit-backup-install-') as temp:
  temp=pathlib.Path(temp)
  for name,content in payload['files'].items():
   if name not in ('alerts.py','hatchkit-backup-alerts.service','hatchkit-backup-alerts.timer','runner.py','register.py','restore-check.py','recovery.py','install.sh','hatchkit-backups.service','hatchkit-backups.timer'):
    raise SystemExit('Unexpected installer file')
   (temp/name).write_text(content)
  (temp/'config.json').write_text(config_path.read_text() if config_path.exists() else json.dumps(config,indent=2)+'\\n')
  subprocess.run(['sh',str(temp/'install.sh')],check=True,stdout=subprocess.DEVNULL)
  key_path=root/'credentials.json'
  key_path.write_text(json.dumps({'accessKeyId':credentials['accessKeyId'],'secretAccessKey':credentials['secretAccessKey']})+'\\n')
  key_path.chmod(0o600)
  if not password_path.exists(): password_path.write_text(credentials['password']+'\\n')
  password_path.chmod(0o600)
print(json.dumps({'installed':True,'scheduleChanged':False,'credentials':'root-only host files; recovery copy in OS keychain'}))
`;

export async function installBackupHost(dryRun = false) {
  const provider = backupProvider();
  if (dryRun)
    return {
      host: provider.host,
      repositoryBase: provider.repositoryBase,
      applied: false,
      scheduleChanged: false,
    };
  const directory = fileURLToPath(new URL("../templates/backups/", import.meta.url));
  const files = Object.fromEntries(
    [
      "alerts.py",
      "hatchkit-backup-alerts.service",
      "hatchkit-backup-alerts.timer",
      "runner.py",
      "register.py",
      "restore-check.py",
      "recovery.py",
      "install.sh",
      "hatchkit-backups.service",
      "hatchkit-backups.timer",
    ].map((name) => [name, readFileSync(`${directory}/${name}`, "utf8")]),
  );
  const payload = {
    repositoryBase: provider.repositoryBase,
    credentials: await backupCredentials(),
    files,
  };
  const script = Buffer.from(INSTALL).toString("base64");
  return JSON.parse(
    await backupHostExec(
      `python3 -c 'import base64;exec(base64.b64decode("${script}"))'`,
      JSON.stringify(payload),
    ),
  );
}
