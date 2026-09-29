import { getSesConfig } from "../config.js";
import type { IsolationFinding } from "../secrets/isolation.js";
import { auditSender, senderClients } from "./ses-project-sender.js";
import { keychainSenderStore, senderEnv } from "./ses-sender-cli.js";

/** Doctor reads AWS and compares deployed/local values in memory. It never
 * treats an env variable name or a journal entry as evidence of AWS isolation.
 */
export async function auditProjectSenderEnvs(
  project: string,
  envs: Array<{ where: string; env: Record<string, string> }>,
): Promise<IsolationFinding[]> {
  const fail = (where: string, what: string): IsolationFinding => ({
    provider: "ses",
    severity: "fail",
    where,
    what,
  });
  try {
    const record = await keychainSenderStore(project).read();
    if (!record || record.spec.project !== project)
      return [fail(project, "No matching SES sender ownership journal; isolation is unverified.")];
    const cfg = await getSesConfig();
    if (!cfg || cfg.region !== record.spec.region)
      return [fail(project, "SES provisioner missing or region changed; isolation is unverified.")];
    const clients = senderClients(cfg);
    try {
      await auditSender({ ...clients, store: keychainSenderStore(project) }, record);
      const expected = senderEnv(record);
      return envs.flatMap(({ where, env }) => {
        if (!env.SES_PROJECT_ACCESS_KEY_ID && env.EMAIL_TRANSPORT !== "ses") return [];
        const drift = Object.keys(expected).filter((key) => env[key] !== expected[key]);
        return drift.length
          ? [
              fail(
                where,
                `SES sender differs from audited keychain scope: ${drift.join(", ")}. A previous rotation key may still be deployed; do not retire it yet.`,
              ),
            ]
          : [];
      });
    } catch {
      return [
        fail(
          project,
          "SES sender AWS audit failed (ownership, policy, key, identity or tenant drift, or insufficient read permission). Run `hatchkit ses isolate <directory> --dry-run` for the scoped refusal; no repair was attempted.",
        ),
      ];
    } finally {
      clients.iam.destroy();
      clients.ses.destroy();
      clients.sts.destroy();
    }
  } catch {
    return [
      fail(
        project,
        "SES sender audit could not read its credentials or journal; isolation is unverified.",
      ),
    ];
  }
}
