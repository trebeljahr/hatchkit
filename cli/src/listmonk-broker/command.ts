/* `hatchkit listmonk broker [--dry-run]`: real dependencies for deploy.ts. */
import chalk from "chalk";
import { getCloudflareProvisioner, getListmonkAdminAuth, getStore } from "../config.js";
import { checkListmonkAdmin } from "../provision/listmonk-project-user.js";
import {
  createListmonkApiUser,
  createListmonkUserRole,
  listListmonkUserRoles,
  listListmonkUsers,
  updateListmonkUserRole,
} from "../provision/listmonk.js";
import { getSecret, setSecret } from "../utils/secrets.js";
import { BROKER_NAME, deployListmonkBroker } from "./deploy.js";

export const LISTMONK_BROKER_USAGE = "Usage: hatchkit listmonk broker [--dry-run]";

/** The deployed broker's URL, for a project's LISTMONK_CONFIRM_BROKER_URL. */
export function getListmonkBrokerUrl(): string | undefined {
  return (getStore().get("listmonkBroker") as { url?: string } | undefined)?.url;
}

export async function runListmonkBrokerCli(argv: string[]): Promise<void> {
  const unknown = argv.filter((a) => a !== "--dry-run");
  if (unknown.length) throw new Error(`Unknown argument ${unknown[0]}.\n${LISTMONK_BROKER_USAGE}`);
  const dryRun = argv.includes("--dry-run");

  const admin = await getListmonkAdminAuth();
  if (!admin) {
    throw new Error(
      "This needs the hatchkit-admin Listmonk credential (keychain listmonk:admin-api-token) and `hatchkit config add listmonk`.",
    );
  }
  await checkListmonkAdmin(admin);
  const op = await getCloudflareProvisioner();
  if (!op?.token || !op.accountId) {
    throw new Error(
      "No Cloudflare operator token: run hatchkit config add cloudflare in your own terminal.",
    );
  }

  console.log(
    chalk.bold(`\n  Listmonk confirm broker${dryRun ? chalk.yellow(" [dry-run]") : ""}\n`),
  );
  const result = await deployListmonkBroker({
    listmonkUrl: admin.url,
    cloudflare: { token: op.token, accountId: op.accountId },
    dryRun,
    getSecret,
    setSecret,
    saveBrokerUrl: (url) => getStore().set("listmonkBroker", { url, user: BROKER_NAME }),
    log: (line) => console.log(dryRun ? chalk.cyan(`  would ${line}`) : chalk.green(`  ✓ ${line}`)),
    listmonk: {
      listUserRoles: () => listListmonkUserRoles(admin),
      createUserRole: (name, permissions) => createListmonkUserRole(admin, { name, permissions }),
      updateUserRole: async (id, name, permissions) => {
        await updateListmonkUserRole(admin, id, { name, permissions });
      },
      listUsers: () => listListmonkUsers(admin),
      createApiUser: (username, userRoleId) =>
        createListmonkApiUser(admin, { username, name: username, userRoleId, listRoleId: null }),
    },
  });
  if (result.url) {
    console.log(
      chalk.dim(
        `\n  Set LISTMONK_CONFIRM_BROKER_URL=${result.url} on each project's newsletter\n` +
          "  (starter server env, or the newsletter Worker's vars). A project calls it only\n" +
          "  when Listmonk refuses its own confirm with 403.\n",
      ),
    );
  }
}
