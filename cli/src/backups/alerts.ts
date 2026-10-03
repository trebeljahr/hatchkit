import { ensureSes, getConfig } from "../config.js";
import { sesSmtpCredentials } from "../provision/ses.js";
import { backupHostExec, backupProvider } from "./provider.js";

const CONFIGURE = `import fcntl,json,os,pathlib,subprocess,sys
os.umask(0o077)
payload=json.load(sys.stdin)
root=pathlib.Path('/etc/hatchkit-backups')
if not pathlib.Path('/opt/hatchkit-backups/alerts.py').exists() or not pathlib.Path('/etc/systemd/system/hatchkit-backup-alerts.timer').exists():
 raise SystemExit('Install the current backup bundle first')
with (root/'.register.lock').open('w') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX)
 path=root/'config.json'
 config=json.loads(path.read_text())
 smtp_path=root/'alert-smtp.json'
 temp=root/'alert-smtp.json.tmp'
 temp.write_text(json.dumps(payload['smtp'])+'\\n')
 temp.chmod(0o600)
 temp.replace(smtp_path)
 config['alerts']={'enabled':True,'to':payload['to'],'from':'Hatchkit Backups <'+payload['from']+'>','smtpFile':str(smtp_path)}
 temp=root/'config.json.tmp'
 temp.write_text(json.dumps(config,indent=2)+'\\n')
 temp.chmod(0o600)
 temp.replace(path)
subprocess.run(['systemctl','enable','--now','hatchkit-backup-alerts.timer'],check=True,stdout=subprocess.DEVNULL)
print(json.dumps({'configured':True,'to':payload['to'],'from':payload['from'],'timerEnabled':True,'testSent':False}))
`;

export async function configureBackupAlerts(to: string, from: string, dryRun = false) {
  for (const address of [to, from]) {
    if (!/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(address))
      throw new Error("Use a single plain email address for --to and --from.");
  }
  const provider = backupProvider();
  if (dryRun)
    return {
      applied: false,
      to,
      from,
      host: provider.host,
      transport: "SES SMTP",
    };
  if (getConfig().providers.ses?.status !== "configured")
    throw new Error("Configure the SES provider before enabling backup email alerts.");
  // SES stays in the existing OS keychain. Only the derived SMTP credential is
  // sent over Tailscale stdin into a root-only host file, never into app envs.
  const smtp = { ...sesSmtpCredentials(await ensureSes()), tls: "starttls" };
  const script = Buffer.from(CONFIGURE).toString("base64");
  return JSON.parse(
    await backupHostExec(
      `python3 -c 'import base64;exec(base64.b64decode("${script}"))'`,
      JSON.stringify({ to, from, smtp }),
    ),
  );
}
