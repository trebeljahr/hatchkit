/*
 * Coolify GitHub App walkthrough.
 *
 * The GitHub App is what lets Coolify clone *private* repos. Creating
 * one is a two-step dance Coolify drives via GitHub's App-manifest
 * flow:
 *
 *   1. In the Coolify dashboard → Sources → New → "Public GitHub" or
 *      "GitHub App". Coolify opens github.com with the manifest. The
 *      user clicks "Create GitHub App" and gets redirected back to
 *      Coolify, which stores the App credentials.
 *   2. The user opens the freshly-created App and installs it on
 *      whichever account/org owns the target repos. Without this
 *      install step the App exists but can't see anything.
 *
 * Neither step can be fully automated — both require a browser. This
 * module guides the user through them, polling Coolify until the
 * source appears and `gh api /user/installations` until the install
 * lands. The user can bail at any prompt.
 *
 * Hooked into `hatchkit setup` as a Core step, into
 * `hatchkit config add coolify-github-app` as a one-shot, and called
 * just-in-time from runCoolifySetup when the user picks `--private`
 * but no Coolify GitHub source exists yet.
 */

import { confirm, select } from "@inquirer/prompts";
import chalk from "chalk";
import ora from "ora";
import { getCoolifyConfig } from "../config.js";
import { CoolifyApi } from "../utils/coolify-api.js";
import { exec } from "../utils/exec.js";
import { appSlugFromHtmlUrl, listUserInstallations } from "./github-app-access.js";

export interface CoolifyGithubAppResult {
  ok: boolean;
  uuid?: string;
  name?: string;
  htmlUrl?: string;
  /** True when a matching install was found on the authenticated user's
   *  github.com account or one of their orgs. False is non-fatal — the
   *  App still exists in Coolify; the user just needs to install it on
   *  github.com before any repo can be cloned. */
  installed?: boolean;
}

/** Pre-flight: Coolify must be configured before we can walk the user
 *  through adding a GitHub source. Returns a typed result instead of
 *  throwing so the Setup stepper renders the right error. */
async function requireCoolify(): Promise<
  { ok: true; api: CoolifyApi; url: string } | { ok: false }
> {
  const cfg = await getCoolifyConfig();
  if (!cfg) {
    console.log(
      chalk.yellow(
        "  Coolify isn't configured yet. Run the Coolify step first, then come back to this one.",
      ),
    );
    return { ok: false };
  }
  return { ok: true, api: new CoolifyApi({ url: cfg.url, token: cfg.token }), url: cfg.url };
}

/** Print the manual-create instructions + poll Coolify until the
 *  source appears. Stops when the user bails, when a source shows up,
 *  or after 5 minutes (whichever first). */
async function waitForCoolifyGithubSource(
  api: CoolifyApi,
  coolifyUrl: string,
): Promise<{ uuid: string; name: string; html_url?: string } | undefined> {
  const sourcesUrl = `${coolifyUrl.replace(/\/$/, "")}/sources`;
  console.log(chalk.bold("\n  ── Step 1: create a GitHub App source in Coolify ───────────\n"));
  console.log(chalk.dim(`  1. Open ${sourcesUrl}`));
  console.log(chalk.dim("  2. Click 'New' → 'GitHub App'."));
  console.log(chalk.dim("  3. Give it a name (e.g. `<your-handle>-coolify`)."));
  console.log(chalk.dim("  4. Click 'Register New GitHub App' → GitHub opens."));
  console.log(chalk.dim("  5. On github.com, click 'Create GitHub App for …'."));
  console.log(chalk.dim("  6. You'll be redirected back to Coolify with the App registered.\n"));

  const proceed = await confirm({
    message: "Press Enter once the source appears in Coolify (or 'n' to abort).",
    default: true,
  });
  if (!proceed) return undefined;

  const spinner = ora("Polling Coolify for the new GitHub source...").start();
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const sources = await api.listGithubSources().catch(() => []);
    if (sources.length > 0) {
      // No deterministic "latest first" guarantee from the API, so
      // when ≥2 sources exist we ask the user which one is the new
      // one. Single-source case is the common path.
      spinner.succeed(`Found ${sources.length} GitHub source(s) in Coolify.`);
      if (sources.length === 1) return sources[0];
      const picked = await select<{ uuid: string; name: string; html_url?: string }>({
        message: "Which source did you just create?",
        choices: sources.map((s) => ({
          name: `${s.name}${s.html_url ? `  ${chalk.dim(s.html_url)}` : ""}`,
          value: s,
        })),
      });
      return picked;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  spinner.fail("Timed out waiting for the GitHub source to appear in Coolify.");
  return undefined;
}

/** Step 2 — verify the App is installed on at least one account the
 *  user controls. The App is useless to Coolify until installed; this
 *  catches "created but forgot to install" cleanly. */
async function waitForGithubAppInstallation(appSlug: string): Promise<boolean> {
  const installUrl = `https://github.com/apps/${appSlug}/installations/select_target`;
  console.log(chalk.bold("\n  ── Step 2: install the App on your GitHub account ──────────\n"));
  console.log(chalk.dim(`  1. Open ${installUrl}`));
  console.log(chalk.dim("  2. Pick your account or org."));
  console.log(chalk.dim("  3. Choose 'All repositories' OR 'Only select repositories' — Hatchkit"));
  console.log(chalk.dim("     will add new repos to the selected list automatically when you"));
  console.log(chalk.dim("     run `hatchkit create --private`.\n"));

  const proceed = await confirm({
    message: "Press Enter once you've installed the App (or 'n' to skip).",
    default: true,
  });
  if (!proceed) return false;

  const spinner = ora("Checking gh api for the new App installation...").start();
  const deadline = Date.now() + 2 * 60 * 1000;
  while (Date.now() < deadline) {
    const installs = await listUserInstallations();
    if (installs.some((i) => i.app_slug === appSlug)) {
      spinner.succeed(`Coolify GitHub App "${appSlug}" is installed.`);
      return true;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  spinner.warn(
    `Couldn't see App "${appSlug}" via gh api. If you installed it on an org you're not`,
  );
  console.log(
    chalk.dim(
      "  an admin of, that's fine — Coolify can still clone repos in that org as long as the App",
    ),
  );
  console.log(chalk.dim("  has access to them."));
  return false;
}

/** Pre-check: is `gh` available + authenticated? Without it the
 *  proactive grant + doctor checks degrade to "please do it manually"
 *  but the App itself still works. */
async function ghAuthHint(): Promise<void> {
  const r = await exec("gh", ["auth", "status"], { silent: true });
  if (r.exitCode !== 0) {
    console.log(
      chalk.yellow(
        "  Heads-up: `gh` CLI isn't authenticated. Run `gh auth login` so Hatchkit can grant the",
      ),
    );
    console.log(chalk.yellow("  Coolify App access to new private repos automatically."));
  }
}

/** Top-level walkthrough. Idempotent — if a GitHub source already
 *  exists in Coolify, we offer to reuse it or add another. */
export async function ensureCoolifyGithubApp(): Promise<CoolifyGithubAppResult> {
  const pre = await requireCoolify();
  if (!pre.ok) return { ok: false };
  const { api, url } = pre;

  await ghAuthHint();

  const existing = await api.listGithubSources().catch(() => []);
  if (existing.length > 0) {
    console.log(
      chalk.green(`  ✓ Coolify already has ${existing.length} GitHub source(s) configured.`),
    );
    for (const s of existing) {
      console.log(chalk.dim(`    · ${s.name}${s.html_url ? `  ${s.html_url}` : ""}`));
    }
    const action = await select<"reuse" | "add" | "verify" | "done">({
      message: "What now?",
      choices: [
        { name: "Verify one is installed on GitHub (recommended)", value: "verify" },
        { name: "Add another GitHub App source", value: "add" },
        { name: "Done", value: "done" },
      ],
      default: "verify",
    });
    if (action === "done") {
      return {
        ok: true,
        uuid: existing[0].uuid,
        name: existing[0].name,
        htmlUrl: existing[0].html_url,
      };
    }
    if (action === "verify") {
      const picked =
        existing.length === 1
          ? existing[0]
          : await select<{ uuid: string; name: string; html_url?: string }>({
              message: "Which source?",
              choices: existing.map((s) => ({
                name: `${s.name}${s.html_url ? `  ${chalk.dim(s.html_url)}` : ""}`,
                value: s,
              })),
            });
      const slug = appSlugFromHtmlUrl(picked.html_url);
      if (!slug) {
        console.log(
          chalk.yellow(
            `  Couldn't derive App slug from ${picked.html_url ?? "(empty html_url)"} — skipping install check.`,
          ),
        );
        return { ok: true, uuid: picked.uuid, name: picked.name, htmlUrl: picked.html_url };
      }
      const installed = await waitForGithubAppInstallation(slug);
      return {
        ok: true,
        uuid: picked.uuid,
        name: picked.name,
        htmlUrl: picked.html_url,
        installed,
      };
    }
    // fallthrough: action === "add" runs the create flow below
  }

  const source = await waitForCoolifyGithubSource(api, url);
  if (!source) {
    return { ok: false };
  }
  const slug = appSlugFromHtmlUrl(source.html_url);
  if (!slug) {
    console.log(
      chalk.yellow(
        `  Source registered but the html_url (${source.html_url ?? "(empty)"}) doesn't look like a GitHub App URL — skipping install check.`,
      ),
    );
    return { ok: true, uuid: source.uuid, name: source.name, htmlUrl: source.html_url };
  }
  const installed = await waitForGithubAppInstallation(slug);
  return { ok: true, uuid: source.uuid, name: source.name, htmlUrl: source.html_url, installed };
}
