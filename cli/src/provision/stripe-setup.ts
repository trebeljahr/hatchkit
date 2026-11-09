/*
 * Stripe setup inside a project's flow: which key writes to the
 * project's own Stripe account, set up on the spot when none does.
 *
 * Every Stripe write hatchkit makes lands in the project's own account,
 * through one of two keys per mode (see config.ts, "Provider: Stripe"):
 *
 *   · the organization key (`hatchkit config add stripe` or `hatchkit
 *     stripe org-key`, keychain `stripe:org:<mode>:secret-key`) plus
 *     the project's `acct_…` (`stripe.accounts[mode]` in .hatchkit.json),
 *     sent as `Stripe-Context`. One key serves every project.
 *   · the project's own secret key, pasted during create / adopt /
 *     `hatchkit add <project> stripe`. It then needs Webhook Endpoints
 *     write.
 *
 * `ensureStripeForProject` runs before a project's keys are collected
 * (create, adopt, `add <project> stripe`) and before `stripe sync`
 * writes. When a mode has neither key, it shows the dashboard steps and
 * waits for the organization key and the account id (checked with one
 * read), takes the project's own key, or lets the user skip that mode.
 * Prompts go through a port so tests drive it.
 *
 * `stripeWebhookRows` gives doctor the recorded webhook endpoints that
 * no stored key can reach any more.
 */

import chalk from "chalk";
import { patchManifest, readManifest } from "../scaffold/manifest.js";
import { SECRET_KEYS, getSecret, setSecret } from "../utils/secrets.js";

export type StripeMode = "test" | "live";
export const STRIPE_MODES: readonly StripeMode[] = ["test", "live"];
export type StripeAccounts = { test?: string; live?: string };

const MODE_LABEL: Record<StripeMode, string> = { test: "TEST / sandbox", live: "LIVE" };

export interface StripeModeKeys {
  /** Organization key stored (`hatchkit stripe org-key`). */
  org: boolean;
  /** Master key of an older setup stored (`stripe:master:<mode>:…`). */
  master: boolean;
}
export type StripeKeyState = Record<StripeMode, StripeModeKeys>;

function masterKeychain(mode: StripeMode): string {
  return mode === "test"
    ? SECRET_KEYS.stripeMasterTestSecretKey
    : SECRET_KEYS.stripeMasterLiveSecretKey;
}

export async function readStripeKeyState(): Promise<StripeKeyState> {
  const state = {} as StripeKeyState;
  for (const mode of STRIPE_MODES) {
    state[mode] = {
      org: !!(await getSecret(SECRET_KEYS.stripeOrgSecretKey(mode))),
      master: !!(await getSecret(masterKeychain(mode))),
    };
  }
  return state;
}

/** The organization-key dashboard steps, one line each. */
async function orgKeyLines(mode: StripeMode): Promise<string[]> {
  const { stripeOrgKeyHint } = await import("../config.js");
  return stripeOrgKeyHint(mode)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Where a project's `acct_…` comes from. */
export function accountGuide(project: string, mode: StripeMode): string[] {
  return [
    mode === "test"
      ? `Open https://dashboard.stripe.com/sandboxes and create (or open) a sandbox for ${project}.`
      : `Open (or create) ${project}'s live account in your Stripe organization.`,
    "Its id is under Settings → Account details (acct_…).",
  ];
}

// ── Prompt port ───────────────────────────────────────────────────────

export interface StripeSetupPrompts {
  select<T extends string>(
    message: string,
    choices: Array<{ name: string; value: T }>,
    defaultValue: T,
  ): Promise<T>;
  /** A pasted secret; never echoed. */
  secret(message: string): Promise<string>;
  /** A line of text, trimmed. */
  text(message: string, validate: (value: string) => true | string): Promise<string>;
  log(line: string): void;
}

const terminalPrompts: StripeSetupPrompts = {
  async select(message, choices, defaultValue) {
    const { select } = await import("@inquirer/prompts");
    return select({ message, choices, default: defaultValue });
  },
  async secret(message) {
    const { confirmPastedSecret } = await import("../config.js");
    return confirmPastedSecret(message);
  },
  async text(message, validate) {
    const { input } = await import("@inquirer/prompts");
    return (await input({ message, validate: (v) => validate(v.trim()) })).trim();
  },
  log: (line) => console.log(line),
};

let promptsOverride: StripeSetupPrompts | null | undefined;
const decided = new Map<string, StripeProjectPlan>();

/** Drive the flows from a test: scripted prompts, `null` for a run
 *  without a terminal, `undefined` for the real one. Also clears the
 *  per-run decisions. */
export function _setStripeSetupPromptsForTests(
  prompts: StripeSetupPrompts | null | undefined,
): void {
  promptsOverride = prompts;
  decided.clear();
}

function ui(): { prompts: StripeSetupPrompts; interactive: boolean } {
  if (promptsOverride === null) return { prompts: terminalPrompts, interactive: false };
  if (promptsOverride) return { prompts: promptsOverride, interactive: true };
  return { prompts: terminalPrompts, interactive: !!process.stdin.isTTY };
}

// ── Keys ──────────────────────────────────────────────────────────────

/** Show the dashboard steps, then wait for the key or a "not now".
 *  True when a key is stored. */
export async function promptStripeOrgKey(
  mode: StripeMode,
  prompts: StripeSetupPrompts = ui().prompts,
): Promise<boolean> {
  const { storeStripeOrgKey } = await import("../config.js");
  prompts.log("");
  for (const line of await orgKeyLines(mode)) prompts.log(chalk.dim(`  ${line}`));
  for (;;) {
    const go = await prompts.select(
      `${MODE_LABEL[mode]} organization key:`,
      [
        { name: "Paste it now (take your time in the dashboard; this waits)", value: "paste" },
        { name: "Not now", value: "skip" },
      ],
      "paste",
    );
    if (go === "skip") return false;
    const key = await prompts.secret(`Stripe organization ${mode} key`);
    try {
      await storeStripeOrgKey(mode, key);
      prompts.log(chalk.green(`  ✓ Stored in the keychain (stripe:org:${mode}:secret-key).`));
      return true;
    } catch (err) {
      prompts.log(chalk.yellow(`  ! ${(err as Error).message}`));
    }
  }
}

// ── Per-project subflow ───────────────────────────────────────────────

/** How each mode's webhooks get written for one project. */
export interface StripeProjectPlan {
  /** `org`: organization key + `accounts[mode]`. `project`: the
   *  project's own key (collected next). `skip`: placeholders now,
   *  `hatchkit add <project> stripe` later. */
  modes: Record<StripeMode, "org" | "project" | "skip">;
  /** `stripe.accounts`, with any account entered here. */
  accounts: StripeAccounts;
}

const ACCOUNT_ID = /^acct_[A-Za-z0-9]+$/;

/** Can the organization key write to `account`? A read of the
 *  account's webhook endpoints proves the pair works. Null when it
 *  does; the error otherwise. */
async function checkOrgAccount(
  project: string,
  mode: StripeMode,
  account: string,
): Promise<string | null> {
  const { resolveSyncClient } = await import("./stripe-sync-cli.js");
  const { stripeRequest } = await import("../paid-unlock/core.js");
  try {
    const { client } = await resolveSyncClient(project, mode, account);
    await stripeRequest(client, "GET", "/v1/webhook_endpoints", { limit: 1 });
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/** Ask for the project's acct_… and check it with the organization key.
 *  Null when the user backs out (empty answer). */
async function promptAccount(
  project: string,
  mode: StripeMode,
  prompts: StripeSetupPrompts,
): Promise<string | null> {
  for (const line of accountGuide(project, mode)) prompts.log(chalk.dim(`  ${line}`));
  for (;;) {
    const account = await prompts.text(
      `${project}'s ${mode} account (acct_…; empty to go back):`,
      (v) => v === "" || ACCOUNT_ID.test(v) || "Must look like acct_…",
    );
    if (account === "") return null;
    const problem = await checkOrgAccount(project, mode, account);
    if (!problem) {
      prompts.log(chalk.green(`  ✓ The organization key reaches ${account}.`));
      return account;
    }
    prompts.log(chalk.yellow(`  ! The organization key cannot read ${account}: ${problem}`));
  }
}

/** What "use this project's own key" means for the caller: `next` when
 *  the caller collects the app keys right after (create, adopt, `add
 *  <project> stripe`); `paste` when nothing else will (`stripe sync`),
 *  so the subflow takes and checks the secret key itself. */
export type OwnKeyStep = "next" | "paste";

/**
 * Before a project's Stripe keys are collected: make sure each mode has
 * a key that can create its webhooks in the project's own account, or
 * let the user skip that mode for now.
 *
 * A mode is ready without a question when the organization key and the
 * project's account are both known, or the project's own key is stored.
 * Otherwise, in a terminal, the user picks: set up the organization key
 * (the flow shows the dashboard steps and waits for the key and the
 * account id), use the project's own key, or skip. Without a terminal a
 * mode that is not ready is skipped. `only` limits it to one mode (the
 * other is reported as skipped).
 *
 * Answers are kept for the rest of the run, so `create` asks during its
 * pre-flight and the later wiring step does not ask again.
 */
export async function ensureStripeForProject(args: {
  project: string;
  accounts?: StripeAccounts;
  only?: StripeMode;
  ownKey?: OwnKeyStep;
}): Promise<StripeProjectPlan> {
  const cacheKey = `${args.project}\0${args.only ?? "both"}`;
  const earlier = decided.get(cacheKey);
  if (earlier) return earlier;
  const { prompts, interactive } = ui();
  const accounts: StripeAccounts = { ...args.accounts };
  const modes = {} as StripeProjectPlan["modes"];
  let asked = false;

  for (const mode of STRIPE_MODES) {
    if (args.only && mode !== args.only) {
      modes[mode] = "skip";
      continue;
    }
    const org = !!(await getSecret(SECRET_KEYS.stripeOrgSecretKey(mode)));
    const own = !!(await getSecret(SECRET_KEYS.stripeProjectSecretKey(args.project, mode)));
    if (org && accounts[mode]) {
      modes[mode] = "org";
      continue;
    }
    if (own) {
      modes[mode] = "project";
      continue;
    }
    if (!interactive) {
      modes[mode] = "skip";
      continue;
    }

    if (!asked) {
      prompts.log(
        chalk.yellow(`\n  Stripe for ${args.project}: a key has to write to its Stripe account.`) +
          chalk.dim(
            "\n  Webhooks (and paid-unlock products) go in the project's own account: through\n" +
              "  the organization key and the project's acct_…, or through the project's own key.",
          ),
      );
      asked = true;
    }
    modes[mode] = await chooseModePath({
      project: args.project,
      mode,
      orgStored: org,
      accounts,
      prompts,
      ownKey: args.ownKey ?? "next",
    });
  }

  const plan: StripeProjectPlan = { modes, accounts };
  if (asked) decided.set(cacheKey, plan);
  return plan;
}

async function chooseModePath(args: {
  project: string;
  mode: StripeMode;
  orgStored: boolean;
  accounts: StripeAccounts;
  prompts: StripeSetupPrompts;
  ownKey: OwnKeyStep;
}): Promise<"org" | "project" | "skip"> {
  const { project, mode, accounts, prompts } = args;
  let org = args.orgStored;
  for (;;) {
    const choice = await prompts.select<"org" | "project" | "skip">(
      `${MODE_LABEL[mode]}:`,
      [
        org
          ? { name: `Enter ${project}'s ${mode} account id (organization key)`, value: "org" }
          : {
              name: "Set up the organization key (recommended: one key for every project)",
              value: "org",
            },
        args.ownKey === "next"
          ? {
              name: "Use this project's own key (pasted next; needs Webhook Endpoints write)",
              value: "project",
            }
          : {
              name: "Paste this project's own secret key (Products, Prices, Webhook Endpoints write)",
              value: "project",
            },
        { name: `Skip ${mode} for now`, value: "skip" },
      ],
      "org",
    );
    if (choice === "skip") {
      const later =
        args.ownKey === "next"
          ? `hatchkit add ${project} stripe`
          : `hatchkit stripe sync --mode ${mode}`;
      prompts.log(chalk.dim(`  · ${MODE_LABEL[mode]} skipped. Later: ${later}`));
      return "skip";
    }
    if (choice === "project") {
      if (args.ownKey === "next" || (await promptProjectKey(project, mode, prompts))) {
        return "project";
      }
      continue;
    }
    if (!org) org = await promptStripeOrgKey(mode, prompts);
    if (!org) continue;
    const account = await promptAccount(project, mode, prompts);
    if (account) {
      accounts[mode] = account;
      return "org";
    }
  }
}

/** Take the project's own secret key, check it with one read of its
 *  webhook endpoints, and store it. False when the user backs out. */
async function promptProjectKey(
  project: string,
  mode: StripeMode,
  prompts: StripeSetupPrompts,
): Promise<boolean> {
  const pattern = mode === "test" ? /^(sk|rk)_test_/ : /^(sk|rk)_live_/;
  for (;;) {
    const key = await prompts.secret(
      `${project}'s ${mode} secret key (sk_${mode}_… or rk_${mode}_…)`,
    );
    if (!pattern.test(key)) {
      prompts.log(chalk.yellow(`  ! Expected a key starting with sk_${mode}_ or rk_${mode}_.`));
    } else {
      const { _stripeFetch } = await import("./stripe-sync-cli.js");
      const { stripeRequest } = await import("../paid-unlock/core.js");
      try {
        await stripeRequest(
          { secretKey: key, fetch: _stripeFetch() },
          "GET",
          "/v1/webhook_endpoints",
          {
            limit: 1,
          },
        );
        await setSecret(SECRET_KEYS.stripeProjectSecretKey(project, mode), key);
        prompts.log(chalk.green(`  ✓ Stored ${project}'s ${mode} key in the keychain.`));
        return true;
      } catch (err) {
        prompts.log(chalk.yellow(`  ! Stripe refused the key: ${(err as Error).message}`));
      }
    }
    const again = await prompts.select(
      "Try another key?",
      [
        { name: "Paste again", value: "again" },
        { name: "Back", value: "back" },
      ],
      "again",
    );
    if (again === "back") return false;
  }
}

/** Write accounts entered during a run into `.hatchkit.json`
 *  (`stripe.accounts`). No write when nothing changed. */
export function saveStripeAccounts(projectDir: string, accounts: StripeAccounts | undefined): void {
  if (!accounts || (!accounts.test && !accounts.live)) return;
  const manifest = readManifest(projectDir);
  if (!manifest) return;
  const merged = { ...manifest.stripe?.accounts, ...accounts };
  const current = manifest.stripe?.accounts ?? {};
  if (merged.test === current.test && merged.live === current.live) return;
  patchManifest(projectDir, { stripe: { ...manifest.stripe, accounts: merged } });
}

// ── Doctor ────────────────────────────────────────────────────────────

/** Webhook endpoints hatchkit recorded for one project and mode, and
 *  whether a key stored here can still reach them. */
export interface StripeWebhookReach {
  project: string;
  mode: StripeMode;
  endpoints: number;
  /** The `acct_…` an organization key created them in, if any. */
  account?: string;
  /** Which key they need: the organization key (`account` set), the
   *  project's own key or the master (created since / before
   *  2026-11-07), or the master alone (an older ledger's keychain
   *  entry). */
  needs: "org" | "project-or-master" | "master";
  reachable: boolean;
}

/** Every Stripe webhook endpoint on the run ledgers (create, adopt,
 *  `add <p> stripe`, `stripe sync`), grouped by project and mode, with
 *  whether a stored key reaches it. Keychain only, no Stripe call: an
 *  endpoint no key reaches cannot be moved by migrate-domain or deleted
 *  by destroy. */
export async function stripeWebhookReach(): Promise<StripeWebhookReach[]> {
  const { loadAllLedgers } = await import("../utils/run-ledger.js");
  const { parseStripeWebhookIdAccount } = await import("../utils/secrets.js");
  const groups = new Map<string, StripeWebhookReach>();
  for (const ledger of loadAllLedgers()) {
    for (const step of ledger.steps) {
      let mode: StripeMode;
      let needs: StripeWebhookReach["needs"];
      let account: string | undefined;
      if (step.kind === "stripeWebhook") {
        mode = step.mode;
        account = step.account;
        needs = account ? "org" : "project-or-master";
      } else if (step.kind === "keychain") {
        const parsed = parseStripeWebhookIdAccount(step.account);
        if (!parsed) continue;
        mode = parsed.mode;
        needs = "master";
      } else continue;
      const key = `${ledger.name}\0${mode}\0${needs}\0${account ?? ""}`;
      const group = groups.get(key) ?? {
        project: ledger.name,
        mode,
        endpoints: 0,
        account,
        needs,
        reachable: false,
      };
      group.endpoints += 1;
      groups.set(key, group);
    }
  }
  const state = await readStripeKeyState();
  for (const group of groups.values()) {
    const own = !!(await getSecret(SECRET_KEYS.stripeProjectSecretKey(group.project, group.mode)));
    const { org, master } = state[group.mode];
    group.reachable =
      group.needs === "org" ? org : group.needs === "master" ? master : own || master;
  }
  return [...groups.values()];
}

export interface StripeDoctorRow {
  name: string;
  status: "ok" | "warn";
  detail?: string;
  hint?: string[];
}

/** Doctor rows for the recorded webhook endpoints (`config.ts` keys get
 *  their own rows): one ok row for those a stored key reaches, and a
 *  warning with the fix for each project and mode no key reaches —
 *  migrate-domain and destroy cannot move or delete those. Empty when
 *  nothing is recorded. */
export async function stripeWebhookRows(): Promise<StripeDoctorRow[]> {
  const reach = await stripeWebhookReach();
  const rows: StripeDoctorRow[] = [];
  const reachable = reach.filter((r) => r.reachable);
  if (reachable.length > 0) {
    const endpoints = reachable.reduce((n, r) => n + r.endpoints, 0);
    const projects = new Set(reachable.map((r) => r.project)).size;
    rows.push({
      name: "Stripe webhooks",
      status: "ok",
      detail: `${endpoints} recorded endpoint(s) in ${projects} project(s) reachable`,
    });
  }
  for (const r of reach.filter((g) => !g.reachable)) {
    rows.push({
      name: `Stripe webhooks of ${r.project} (${r.mode})`,
      status: "warn",
      detail: `no stored key reaches ${r.endpoints} endpoint(s); migrate-domain and destroy cannot move or delete them`,
      hint:
        r.needs === "org"
          ? [
              `They are in ${r.account}, created with the organization key.`,
              ...(await orgKeyLines(r.mode)),
              `Store it: hatchkit stripe org-key --mode ${r.mode}`,
            ]
          : r.needs === "master"
            ? [
                "An older hatchkit created them with a master key that is no longer stored.",
                "Delete them in the Stripe dashboard (Developers → Webhooks) once the project no longer needs them.",
              ]
            : [
                `Store ${r.project}'s own ${r.mode} key: hatchkit add ${r.project} stripe`,
                "(it reuses cached keys and asks only for what is missing).",
              ],
    });
  }
  return rows;
}
