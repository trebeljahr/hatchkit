/*
 * `hatchkit stripe …` — the command side of stripe-sync.ts.
 *
 *   sync [dir] --mode test|live   products, prices, webhook from unlocks.json
 *   org-key --mode test|live      store the Stripe organization API key
 *   webhook-secret [dir] --mode … print the stored paid-unlock webhook secret
 *
 * Which key writes: the organization key with `Stripe-Context: <acct>`
 * when both exist (the account comes from `--account` or the manifest's
 * `stripe.accounts`), else the project's own key from `hatchkit add
 * <project> stripe`. Live writes show the plan and ask first.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import chalk from "chalk";
import { type StripeClient, parseUnlockConfig } from "../paid-unlock/core.js";
import { MANIFEST_FILENAME, readManifest, writeManifest } from "../scaffold/manifest.js";
import { SECRET_KEYS, getSecret, setSecret } from "../utils/secrets.js";
import { type StripeMode, type StripeSyncResult, syncStripe } from "./stripe-sync.js";
import { STRIPE_USAGE } from "./stripe-usage.js";

interface Args {
  positional: string[];
  flags: Map<string, string | true>;
}

function parse(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const withValue = new Set(["--mode", "--account", "--webhook-url"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const [name, inline] = arg.split("=", 2);
      if (inline !== undefined) flags.set(name, inline);
      else if (withValue.has(name)) {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
        flags.set(name, value);
        i++;
      } else flags.set(name, true);
    } else positional.push(arg);
  }
  return { positional, flags };
}

function modeOf(args: Args): StripeMode {
  const mode = args.flags.get("--mode");
  if (mode !== "test" && mode !== "live") throw new Error("--mode test|live is required");
  return mode;
}

function str(args: Args, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

/** Locate unlocks.json the way `hatchkit add … paid-unlock` writes it.
 *  Also tells `migrate-domain` that a project sells through paid unlock. */
export function findUnlocks(
  projectDir: string,
): { path: string; runtime: "worker" | "server"; envDir: string } | null {
  const worker = join(projectDir, "workers", "unlock", "src", "unlocks.json");
  if (existsSync(worker))
    return { path: worker, runtime: "worker", envDir: join(projectDir, "workers", "unlock") };
  for (const serverDir of [join(projectDir, "packages", "server"), projectDir]) {
    const path = join(serverDir, "src", "services", "unlock", "unlocks.json");
    if (existsSync(path)) return { path, runtime: "server", envDir: serverDir };
  }
  return null;
}

let fetchOverride: typeof fetch | undefined;
/** Route Stripe calls to a fake (tests). */
export function _setStripeFetchForTests(fake: typeof fetch | undefined): void {
  fetchOverride = fake;
}

let confirmOverride: ((message: string) => Promise<boolean>) | undefined;
export function _setConfirmForTests(
  fake: ((message: string) => Promise<boolean>) | undefined,
): void {
  confirmOverride = fake;
}

async function confirmLive(message: string): Promise<boolean> {
  if (confirmOverride) return confirmOverride(message);
  if (!process.stdin.isTTY) return false;
  const { confirm } = await import("@inquirer/prompts");
  return confirm({ message, default: false });
}

/** Refuse a key whose prefix says the other mode. */
function checkKeyMode(key: string, mode: StripeMode, label: string): void {
  const other = mode === "test" ? "live" : "test";
  if (key.includes(`_${other}_`)) throw new Error(`The ${label} is a ${other} key, not ${mode}.`);
}

/** HATCHKIT_STRIPE_API_VERSION overrides the Stripe-Version sync sends
 *  (organization keys require one on every request). */
function apiVersion(): string | undefined {
  return process.env.HATCHKIT_STRIPE_API_VERSION || undefined;
}

export async function resolveSyncClient(
  project: string,
  mode: StripeMode,
  account: string | undefined,
): Promise<{ client: StripeClient; label: string; usesAccount: boolean }> {
  const orgKey = await getSecret(SECRET_KEYS.stripeOrgSecretKey(mode));
  if (orgKey && account) {
    checkKeyMode(orgKey, mode, "organization key");
    return {
      client: {
        secretKey: orgKey,
        context: account,
        fetch: fetchOverride,
        apiVersion: apiVersion(),
      },
      label: `organization key → ${account}`,
      usesAccount: true,
    };
  }
  const projectKey = await getSecret(SECRET_KEYS.stripeProjectSecretKey(project, mode));
  if (projectKey) {
    checkKeyMode(projectKey, mode, "project key");
    return {
      client: { secretKey: projectKey, fetch: fetchOverride },
      label: `${project}'s own ${mode} key`,
      usesAccount: false,
    };
  }
  if (orgKey)
    throw new Error(
      `The organization key needs the project's Stripe account: pass --account acct_… (Stripe dashboard → the ${mode === "test" ? "sandbox" : "account"} → Settings → Account details).`,
    );
  throw new Error(
    [
      `No Stripe key for ${project} (${mode}). Either:`,
      `  hatchkit stripe org-key --mode ${mode}     then sync with --account acct_…`,
      `  hatchkit add ${project} stripe             stores the project's own key`,
    ].join("\n"),
  );
}

/** Every key that may hold a webhook endpoint hatchkit made for this
 *  project, in the order to try them when looking one up by id: the
 *  project's own account (`resolveSyncClient`), then the master key from
 *  `hatchkit config add stripe`. Before 2026-11-07 the starter webhook
 *  was created with that master key, in the master's account, so
 *  rename-domain and destroy still find those older endpoints. Never
 *  prompts; an empty list means no key is stored. */
export async function resolveWebhookClients(
  project: string,
  mode: StripeMode,
  account: string | undefined,
): Promise<Array<{ client: StripeClient; label: string }>> {
  const out: Array<{ client: StripeClient; label: string }> = [];
  try {
    const { client, label } = await resolveSyncClient(project, mode, account);
    out.push({ client, label });
  } catch {
    // No project key and no usable organization key: try the master.
  }
  const master = await getSecret(
    mode === "test" ? SECRET_KEYS.stripeMasterTestSecretKey : SECRET_KEYS.stripeMasterLiveSecretKey,
  );
  if (master && !out.some(({ client }) => client.secretKey === master && !client.context)) {
    out.push({
      client: { secretKey: master, fetch: fetchOverride },
      label: `the ${mode} master key`,
    });
  }
  return out;
}

function printSteps(result: StripeSyncResult, dryRun: boolean): void {
  const colors = {
    create: chalk.green,
    update: chalk.yellow,
    archive: chalk.yellow,
    keep: chalk.dim,
    report: chalk.magenta,
  } as const;
  for (const step of result.steps) {
    const label = `${dryRun && step.action !== "keep" && step.action !== "report" ? "would " : ""}${step.action}`;
    const what = `${step.target}${step.key ? ` ${step.key}` : ""}${step.id ? chalk.dim(` ${step.id}`) : ""}`;
    console.log(`    ${colors[step.action](label.padEnd(15))} ${what}  ${chalk.dim(step.detail)}`);
  }
}

async function writeWebhookSecret(
  projectDir: string,
  found: { runtime: "worker" | "server"; envDir: string },
  mode: StripeMode,
  secret: string,
): Promise<string> {
  const pairs = [{ key: "UNLOCK_WEBHOOK_SECRET", value: secret }];
  const env = await import("./write-env.js");
  if (found.runtime === "worker") {
    if (mode === "live") return "";
    const path = join(found.envDir, ".dev.vars");
    env.writeLocalEnv(path, pairs);
    return relative(projectDir, path);
  }
  if (mode === "test") {
    const path = env.devLocalEnvPath(found.envDir);
    env.writeDevEnv(path, pairs);
    return relative(projectDir, path);
  }
  const path = join(found.envDir, ".env.production");
  env.writeProdEnv(path, pairs);
  return relative(projectDir, path);
}

async function runSync(args: Args): Promise<void> {
  const mode = modeOf(args);
  const dryRun = args.flags.has("--dry-run");
  const asJson = args.flags.has("--json");
  const projectDir = resolve(args.positional[0] ?? ".");
  const manifest = readManifest(projectDir);
  if (!manifest) throw new Error(`No ${MANIFEST_FILENAME} in ${projectDir}.`);
  const found = findUnlocks(projectDir);
  if (!found)
    throw new Error(
      `No unlocks.json in ${projectDir}. Run \`hatchkit add ${manifest.name} paid-unlock\` first.`,
    );
  const config = parseUnlockConfig(JSON.parse(readFileSync(found.path, "utf-8")));
  if (config.project !== manifest.name)
    throw new Error(
      `${relative(projectDir, found.path)} names project "${config.project}", the manifest "${manifest.name}".`,
    );

  const account = str(args, "--account") ?? manifest.stripe?.accounts?.[mode];
  if (account && !/^acct_[A-Za-z0-9]+$/.test(account))
    throw new Error("--account must look like acct_…");
  if (asJson && mode === "live" && !dryRun && !args.flags.has("--yes"))
    throw new Error("--json with --mode live needs --yes. Read the plan with --dry-run first.");
  const { client, label, usesAccount } = await resolveSyncClient(manifest.name, mode, account);
  const webhookUrl =
    str(args, "--webhook-url") ??
    (mode === "live" ? `https://${manifest.domain}/api/unlock/webhook` : null);
  if (webhookUrl && !/^https:\/\//.test(webhookUrl))
    throw new Error("--webhook-url must be an https URL");

  const secrets = {
    async get() {
      const id = await getSecret(SECRET_KEYS.stripeProjectUnlockWebhookId(manifest.name, mode));
      const secret = await getSecret(
        SECRET_KEYS.stripeProjectUnlockWebhookSecret(manifest.name, mode),
      );
      return id && secret ? { id, secret } : null;
    },
    async set(value: { id: string; secret: string }) {
      await setSecret(
        SECRET_KEYS.stripeProjectUnlockWebhookSecret(manifest.name, mode),
        value.secret,
      );
      await setSecret(SECRET_KEYS.stripeProjectUnlockWebhookId(manifest.name, mode), value.id);
    },
  };
  const input = {
    client,
    config,
    mode,
    webhookUrl,
    secrets,
    archiveRemoved: args.flags.has("--archive-removed"),
    recreateWebhook: args.flags.has("--recreate-webhook"),
  };

  if (!asJson) {
    console.log(
      chalk.bold(
        `\n  Stripe sync — ${manifest.name} (${mode})${dryRun ? chalk.yellow(" [dry-run]") : ""}`,
      ),
    );
    console.log(chalk.dim(`  Key: ${label}\n`));
  }

  // Live: read-only plan first, then ask.
  if (mode === "live" && !dryRun) {
    const plan = await syncStripe({ ...input, dryRun: true });
    if (plan.writes > 0 && !args.flags.has("--yes")) {
      printSteps(plan, true);
      const ok = await confirmLive(`Write ${plan.writes} change(s) to Stripe LIVE (${label})?`);
      if (!ok) {
        console.log(chalk.yellow("\n  Nothing written."));
        process.exitCode = 1;
        return;
      }
      console.log("");
    }
  }

  const result = await syncStripe({ ...input, dryRun });

  // Saved only when it was used: an account recorded beside a project key
  // would steer a later organization-key run somewhere nobody checked.
  if (
    usesAccount &&
    str(args, "--account") &&
    !dryRun &&
    manifest.stripe?.accounts?.[mode] !== account
  ) {
    manifest.stripe = {
      ...manifest.stripe,
      accounts: { ...manifest.stripe?.accounts, [mode]: account },
    };
    writeManifest(projectDir, manifest);
  }

  // Destroy deletes the endpoint. Recorded when hatchkit made it: created
  // now, or kept with the id hatchkit stored when it created it (so a
  // re-run also records an endpoint from before sync wrote the ledger).
  if (!dryRun && result.webhook.id && result.webhook.url && result.webhook.secretKnown) {
    const { appendLedgerStep } = await import("../utils/run-ledger.js");
    try {
      appendLedgerStep(manifest.name, {
        kind: "stripeWebhook",
        mode,
        endpoint: "unlock",
        endpointId: result.webhook.id,
        url: result.webhook.url,
        ...(usesAccount && account ? { account } : {}),
      });
    } catch (err) {
      console.warn(
        chalk.yellow(
          `  ! ${(err as Error).message}. \`hatchkit destroy ${manifest.name}\` will not delete webhook ${result.webhook.id}.`,
        ),
      );
    }
  }

  let secretFile = "";
  if (result.webhook.createdSecret && !dryRun)
    secretFile = await writeWebhookSecret(projectDir, found, mode, result.webhook.createdSecret);

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          project: manifest.name,
          mode,
          dryRun,
          key: label,
          steps: result.steps,
          writes: result.writes,
          webhook: {
            id: result.webhook.id,
            url: result.webhook.url,
            secretKnown: result.webhook.secretKnown,
          },
          secretWrittenTo: secretFile || undefined,
        },
        null,
        2,
      ),
    );
    return;
  }

  printSteps(result, dryRun);
  console.log(
    chalk.bold(
      `\n  ${dryRun ? `${result.writes} change(s) planned` : result.writes ? `${result.writes} change(s) written` : "Already in sync"}.`,
    ),
  );
  const rel = relative(projectDir, dirname(found.path));
  if (secretFile) console.log(chalk.green(`  ✓ Webhook secret → ${secretFile}`));
  if (result.webhook.createdSecret && found.runtime === "worker" && mode === "live") {
    console.log(chalk.bold("\n  Deploy the webhook secret:"));
    console.log(
      `    hatchkit stripe webhook-secret ${relative(process.cwd(), projectDir) || "."} --mode live | pnpm --dir ${relative(process.cwd(), dirname(dirname(found.path))) || "."} exec wrangler secret put UNLOCK_WEBHOOK_SECRET`,
    );
  }
  if (secretFile && found.runtime === "server" && mode === "live")
    console.log(chalk.dim("  Then `hatchkit sync` (or your deploy) so the server sees it."));
  if (!webhookUrl && mode === "test") {
    const local =
      found.runtime === "worker"
        ? "localhost:8787/api/unlock/webhook"
        : "localhost:<server port>/api/unlock/webhook";
    console.log(
      chalk.dim(
        `\n  Test webhooks: \`stripe listen --forward-to ${local}\` prints a whsec_…; put it in UNLOCK_WEBHOOK_SECRET (${found.runtime === "worker" ? ".dev.vars" : ".env.development.local"}) while it runs.`,
      ),
    );
  }
  if (!config.refundPolicy)
    console.log(
      chalk.yellow(
        `\n  ! ${rel}/unlocks.json has no "refundPolicy" — add the line buyers see at checkout.`,
      ),
    );
  console.log("");
}

async function runOrgKey(args: Args): Promise<void> {
  const mode = modeOf(args);
  const { confirmPastedSecret } = await import("../config.js");
  console.log(
    chalk.dim(
      [
        "",
        "  Stripe dashboard → your organization → API keys → Create restricted key.",
        "  Permissions: Products write, Prices write, Webhook Endpoints write.",
        `  ${mode === "test" ? "Use the sandbox/test variant." : "Live key: it can write to every account in the organization."}`,
        "",
      ].join("\n"),
    ),
  );
  const key = await confirmPastedSecret(`Stripe organization ${mode} key`);
  checkKeyMode(key, mode, "pasted key");
  await setSecret(SECRET_KEYS.stripeOrgSecretKey(mode), key);
  console.log(chalk.green(`  ✓ Stored in the keychain (stripe:org:${mode}:secret-key).`));
}

async function runWebhookSecret(args: Args): Promise<void> {
  const mode = modeOf(args);
  const projectDir = resolve(args.positional[0] ?? ".");
  const manifest = readManifest(projectDir);
  if (!manifest) throw new Error(`No ${MANIFEST_FILENAME} in ${projectDir}.`);
  const secret = await getSecret(SECRET_KEYS.stripeProjectUnlockWebhookSecret(manifest.name, mode));
  if (!secret)
    throw new Error(
      `No ${mode} paid-unlock webhook secret stored for ${manifest.name}. Run \`hatchkit stripe sync\` first.`,
    );
  process.stdout.write(secret);
}

export async function runStripeCli(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  const args = parse(rest);
  if (sub === "sync") return runSync(args);
  if (sub === "org-key") return runOrgKey(args);
  if (sub === "webhook-secret") return runWebhookSecret(args);
  console.log(STRIPE_USAGE);
  if (sub !== undefined) process.exitCode = 1;
}
