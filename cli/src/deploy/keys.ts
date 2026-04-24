/*
 * `hatchkit keys` subcommands — retrieve + push the per-project
 * dotenvx private key that lives in the OS keychain.
 *
 *   keys show <project>   Print the DOTENV_PRIVATE_KEY_PRODUCTION for
 *                         the named project so the user can paste it
 *                         into Coolify / a CI secret / etc.
 *
 *   keys push <project>   Upsert DOTENV_PRIVATE_KEY_PRODUCTION as an
 *                         env var on the project's Coolify
 *                         application. Requires Coolify to already be
 *                         configured and the application to exist.
 */

import chalk from "chalk";
import ora from "ora";
import { getCoolifyConfig } from "../config.js";
import { CoolifyApi } from "../utils/coolify-api.js";
import { SECRET_KEYS, getSecret } from "../utils/secrets.js";

/** Print the private key for a project to stdout. `--json` emits a
 *  structured `{ project, key, found }` object so agents can parse
 *  without scraping. */
export async function showProjectKey(
  projectName: string,
  opts: { json?: boolean } = {},
): Promise<void> {
  const key = await getSecret(SECRET_KEYS.dotenvxPrivateKey(projectName));
  if (!key) {
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({
          project: projectName,
          found: false,
          error:
            "No dotenvx key in keychain. Project may have been scaffolded before dotenvx integration, or `config reset` cleared the keychain.",
        })}\n`,
      );
      process.exit(1);
    }
    console.error(
      chalk.red(`  No dotenvx key found for project "${projectName}" in the keychain.`),
    );
    console.error(
      chalk.dim(
        "  This usually means the project was scaffolded before dotenvx integration, or `config reset` cleared the keychain.",
      ),
    );
    process.exit(1);
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ project: projectName, found: true, key })}\n`);
    return;
  }
  // Print plainly so it's easy to pipe into pbcopy etc. No chalk
  // around the value — chalk adds ANSI codes that corrupt the key
  // when redirected.
  process.stdout.write(`${key}\n`);
}

/** Push DOTENV_PRIVATE_KEY_PRODUCTION onto a Coolify application.
 *  Resolves the application by name, defaulting to `<project>-web`
 *  which matches scaffoldInfra's naming convention. */
export async function pushProjectKeyToCoolify(
  projectName: string,
  options: { appName?: string } = {},
): Promise<void> {
  const key = await getSecret(SECRET_KEYS.dotenvxPrivateKey(projectName));
  if (!key) {
    throw new Error(
      `No dotenvx key in keychain for project "${projectName}". Was it scaffolded with dotenvx integration?`,
    );
  }

  const coolify = await getCoolifyConfig();
  if (!coolify) {
    throw new Error("Coolify is not configured. Run `hatchkit config add coolify` first.");
  }

  const api = new CoolifyApi({ url: coolify.url, token: coolify.token });
  const appName = options.appName ?? `${projectName}-web`;

  const spinner = ora(`Resolving Coolify app "${appName}"`).start();
  let uuid: string;
  try {
    const apps = await api.listApplications();
    const match = apps.find((a) => a.name === appName);
    if (!match) {
      spinner.fail(
        `No Coolify application named "${appName}". Run \`hatchkit create\` with runDeployment first.`,
      );
      throw new Error(`Coolify app not found: ${appName}`);
    }
    uuid = match.uuid;
    spinner.succeed(`Found app ${appName} (${uuid})`);
  } catch (err) {
    if (spinner.isSpinning) spinner.fail();
    throw err;
  }

  const pushSpinner = ora("Upserting DOTENV_PRIVATE_KEY_PRODUCTION on Coolify").start();
  try {
    await api.setAppEnv(uuid, { DOTENV_PRIVATE_KEY_PRODUCTION: key });
    pushSpinner.succeed("Key pushed to Coolify");
  } catch (err) {
    pushSpinner.fail("Coolify env update failed");
    throw err;
  }
}
