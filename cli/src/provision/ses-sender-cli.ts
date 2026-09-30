import { existsSync, mkdirSync, readFileSync, rmdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
/** Explicit, local-only backfill. Never syncs, deploys, sends mail or changes
 * Listmonk. Preparing credentials does not select the app's mail transport.
 */
import { GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { getConfigPath, getSesConfig } from "../config.js";
import { findManifestDirUpward, readManifest } from "../scaffold/manifest.js";
import { assertEnvKeysNotTracked, resolveProdEnvPath } from "../secrets/env-writer.js";
import { assertKeysNotLeaked } from "../secrets/key-history.js";
import { deleteSecret, getSecret, setSecret } from "../utils/secrets.js";
import { readProjectEnvSnapshot } from "./listmonk-user-cli.js";
import { operatorScope, senderOperatorPolicy } from "./ses-operator-policy.js";
import { senderPolicy, senderSpec } from "./ses-project-policy.js";
import {
  type SenderRecord,
  type SenderStore,
  ensureSender,
  retirePreviousSenderKey,
  senderClients,
  senderRollbackRecipe,
  senderSetupInstructions,
} from "./ses-project-sender.js";
import { devLocalEnvPath, writeDevEnv, writeProdEnv } from "./write-env.js";

export const senderSecretAccount = (project: string) => `ses:project:${project}:sender-v1`;
export function keychainSenderStore(project: string): SenderStore {
  const account = senderSecretAccount(project);
  return {
    async read() {
      const text = await getSecret(account);
      return text ? (JSON.parse(text) as SenderRecord) : null;
    },
    async write(record) {
      if (record) await setSecret(account, JSON.stringify(record));
      else await deleteSecret(account);
    },
  };
}
export function senderEnv(record: SenderRecord): Record<string, string> {
  if (!record.current || record.phase !== "ready") throw new Error("Sender is not ready.");
  return {
    SES_PROJECT_ACCESS_KEY_ID: record.current.id,
    SES_PROJECT_SECRET_ACCESS_KEY: record.current.secret,
    SES_PROJECT_REGION: record.spec.region,
    SES_PROJECT_IDENTITY_ARN: record.spec.identityArn,
    SES_PROJECT_TENANT: record.spec.tenant,
    SES_PROJECT_CONFIGURATION_SET: record.spec.configurationSet,
    SES_PROJECT_FROM_EMAIL: record.spec.from[0],
  };
}
export const LISTMONK_ISOLATION_GAP =
  "Shared Listmonk is an alternate cross-project authority: tx:send/campaigns:manage can use its shared relay, and subscribers:get_all/manage can reach subscriber data. A separate API username/list role does not enforce a sender boundary. Keep newsletter access until a dedicated Listmonk instance/database/relay or an audited project-bound gateway is migrated. SES sender isolation alone does not isolate this app.";

export function parseSenderFlags(argv: string[]) {
  const flags = {
    dryRun: false,
    rotate: false,
    activate: false,
    retirePrevious: false,
    recipe: false,
    acknowledgeListmonkGap: false,
    projectDir: "",
    from: undefined as string[] | undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--rotate") flags.rotate = true;
    else if (a === "--activate") flags.activate = true;
    else if (a === "--retire-previous") flags.retirePrevious = true;
    else if (a === "--recipe") flags.recipe = true;
    else if (a === "--acknowledge-listmonk-gap") flags.acknowledgeListmonkGap = true;
    else if (a === "--from") {
      const value = argv[++i];
      if (!value || value.startsWith("-"))
        throw new Error("--from needs comma-separated exact mailboxes.");
      flags.from = value.split(",");
    } else if (a.startsWith("-") || flags.projectDir)
      throw new Error(`Unknown/extra argument ${a}`);
    else flags.projectDir = resolve(a);
  }
  if (
    [flags.rotate, flags.retirePrevious, flags.recipe].filter(Boolean).length > 1 ||
    ((flags.retirePrevious || flags.recipe) && flags.activate)
  )
    throw new Error("Rotation, retirement and rollback recipe are separate operations.");
  return flags;
}

export async function runSesSenderCli(argv: string[]): Promise<void> {
  const f = parseSenderFlags(argv);
  const dir = f.projectDir || findManifestDirUpward(process.cwd());
  if (!dir) throw new Error("Pass a project directory or run inside a Hatchkit project.");
  const manifest = readManifest(dir);
  if (!manifest?.name || !manifest.domain)
    throw new Error("Project manifest needs name and domain.");
  const store = keychainSenderStore(manifest.name);
  if (f.recipe) {
    const r = await store.read();
    if (!r) throw new Error("No sender ownership journal; no resources can be safely claimed.");
    console.log(senderRollbackRecipe(r).join("\n"));
    return;
  }
  const cfg = await getSesConfig();
  if (!cfg) throw new Error(senderSetupInstructions());
  const clients = senderClients(cfg);
  const deps = { ...clients, store };
  let lock: string | undefined;
  try {
    const snap = await readProjectEnvSnapshot(dir);
    if (snap.undecrypted.length)
      throw new Error(
        "Cannot decrypt project env; restore its dotenvx key before migration. No credentials were created.",
      );
    const hasListmonk = !!(snap.prod.LISTMONK_API_TOKEN || snap.dev.LISTMONK_API_TOKEN);
    if (hasListmonk) console.log(LISTMONK_ISOLATION_GAP);
    if (f.activate && hasListmonk && !f.acknowledgeListmonkGap)
      throw new Error(
        "Activation requires --acknowledge-listmonk-gap while this app retains Listmonk credentials. Full project isolation remains incomplete.",
      );
    if (f.activate) {
      // Never replace custom application code automatically. Both layouts are
      // supported; the operator ports/reviews the transport before activation.
      const source = [
        join(dir, "packages/server/src/services/email.ts"),
        join(dir, "src/services/email.ts"),
      ].find(existsSync);
      if (!source || !readFileSync(source, "utf8").includes("hatchkit-ses-project-v1"))
        throw new Error(
          "Port/review the starter SES transport (hatchkit-ses-project-v1), env schema and container variables first. This command does not overwrite application code.",
        );
    }
    await assertEnvKeysNotTracked(dir);
    await assertKeysNotLeaked(dir, { projectName: manifest.name });
    if (!f.dryRun) {
      // Serialize the complete AWS -> keychain -> env transaction locally.
      const base = join(dirname(getConfigPath()), "ses-sender-locks");
      mkdirSync(base, { recursive: true });
      const candidate = join(base, manifest.name);
      mkdirSync(candidate); // Existing lock is never removed by this run.
      lock = candidate;
    }
    if (f.retirePrevious) {
      console.log(await retirePreviousSenderKey(deps, f.dryRun));
      return;
    }
    // Print the exact administrative setup fragment even if the following
    // IAM/SES read preflight is denied. No key values enter this plan.
    const journal = await store.read();
    const account = (await clients.sts.send(new GetCallerIdentityCommand({}))).Account ?? "";
    const planned = senderSpec(
      manifest.name,
      manifest.domain,
      account,
      cfg.region,
      f.from ?? journal?.spec.from,
    );
    console.log(
      JSON.stringify(
        {
          scope: planned,
          senderPolicy: senderPolicy(planned),
          provisionerPolicy: senderOperatorPolicy(planned.account, planned.region),
          senderBoundaryArn: operatorScope(planned.account, planned.region).boundaryArn,
        },
        null,
        2,
      ),
    );
    const result = await ensureSender(deps, {
      project: manifest.name,
      domain: manifest.domain,
      region: cfg.region,
      from: f.from,
      dryRun: f.dryRun,
      rotate: f.rotate,
    });
    console.log(
      JSON.stringify(
        {
          changes: result.changes,
          transport: f.activate ? "explicit SES activation in local env" : "unchanged",
          fullProjectIsolation: hasListmonk
            ? "blocked by shared Listmonk"
            : "requires doctor audit and deployed credential verification",
        },
        null,
        2,
      ),
    );
    const prodPath = snap.prodPath ?? resolveProdEnvPath(dir);
    const devPath = devLocalEnvPath(snap.devDir);
    if (f.dryRun) {
      console.log(
        `Would write project credentials to ${prodPath} (encrypted) and ${devPath} (gitignored). No writes performed. No deployment or test email.`,
      );
      return;
    }
    if (!result.record)
      throw new Error("No restricted sender credentials; refusing any shared-key fallback.");
    const values = senderEnv(result.record);
    if (f.activate) values.EMAIL_TRANSPORT = "ses";
    const changed = (current: Record<string, string>) =>
      Object.entries(values)
        .filter(([key, value]) => current[key] !== value)
        .map(([key, value]) => ({ key, value }));
    // Keys remain journaled if either write fails. Rerun without --rotate to
    // resume. Previous credentials remain active until explicit retirement.
    const prod = changed(snap.prod);
    const dev = changed(snap.dev);
    if (prod.length) writeProdEnv(prodPath, prod);
    if (dev.length) writeDevEnv(devPath, dev);
    console.log(
      "Project sender prepared locally. No mail sent and no live app changed. Review code/env, then approve sync/deploy separately. Rerun without --rotate to resume a partial env write. Retire the previous key only after a verified rollout. `hatchkit ses isolate <directory> --recipe` prints owned-resource rollback.",
    );
  } catch (err) {
    if (err instanceof Error && /AccessDenied|Unauthorized|CredentialsProvider/.test(err.name))
      throw new Error(`SES sender operation refused (${err.name}). ${senderSetupInstructions()}`);
    throw err;
  } finally {
    clients.iam.destroy();
    clients.ses.destroy();
    clients.sts.destroy();
    if (lock) rmdirSync(lock);
  }
}
