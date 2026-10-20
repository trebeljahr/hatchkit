/*
 * `hatchkit listmonk list <project> <key>` — one more mailing list for a
 * project that already has its own Listmonk API user.
 *
 * `hatchkit add <project> listmonk-ses` makes the project's first pair of
 * lists, `<project>` and `<project>-test`. A project that later wants a
 * second list (an announce-only list, a supporters list) gets another
 * pair here: the live list (named `--name`, or `<project>-<key>`) and
 * `<project>-<key>-test`. Both are private and double opt-in, like the
 * first pair, and the project's list role `<project>` gets get + manage
 * on both. Nothing else on the role changes.
 *
 * A list that already exists by name is reused as it is. A public or
 * single-opt-in one is reported and left alone: changing it would change
 * who receives the next campaign.
 *
 * It writes no env file: the variable that holds the new list id is the
 * project's own choice. The run prints the ids to set.
 */

import chalk from "chalk";
import { grantListsOnListRole } from "./listmonk-project-user.js";
import {
  type ListmonkAuth,
  type ListmonkList,
  createListmonkList,
  listListmonkListRoles,
  listListmonkLists,
} from "./listmonk.js";

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function validListKey(key: string): boolean {
  return KEY_RE.test(key);
}

/** The live and test list names for `key`. */
export function projectListNames(
  project: string,
  key: string,
  liveName?: string,
): { live: string; test: string } {
  const live = liveName?.trim() || `${project}-${key}`;
  return { live, test: `${project}-${key}-test` };
}

export interface EnsureProjectListsOptions {
  admin: ListmonkAuth;
  /** The project, which is also its list role's name. */
  project: string;
  key: string;
  liveName?: string;
  dryRun?: boolean;
}

export interface ProjectListOutcome {
  /** 0 on a dry run that would create the list. */
  id: number;
  name: string;
  createdThisRun: boolean;
}

export interface EnsureProjectListsResult {
  live: ProjectListOutcome;
  test: ProjectListOutcome;
  changes: string[];
  warnings: string[];
}

function listWarning(list: ListmonkList): string | null {
  const problems: string[] = [];
  if (list.type !== "private") {
    problems.push("public (anyone can join through Listmonk's own form, without double opt-in)");
  }
  if (list.optin !== "double") {
    problems.push("single opt-in (a campaign reaches unconfirmed members too)");
  }
  return problems.length > 0
    ? `List ${list.name} (id ${list.id}) is ${problems.join(" and ")}. Left unchanged; fix it in Listmonk.`
    : null;
}

export async function ensureListmonkProjectLists(
  opts: EnsureProjectListsOptions,
  events: { onListCreated?: (list: { id: number; name: string }) => void } = {},
): Promise<EnsureProjectListsResult> {
  const { admin, project, key } = opts;
  const dry = opts.dryRun === true;
  if (!validListKey(key)) {
    throw new Error(
      `"${key}" cannot be a list key: use lowercase letters, digits and dashes (up to 40).`,
    );
  }
  const names = projectListNames(project, key, opts.liveName);
  if (names.live === project || names.live === `${project}-test`) {
    throw new Error(`${names.live} is the project's first list; pick another name.`);
  }

  // Check the role first, so a project without one creates no list.
  const role = (await listListmonkListRoles(admin)).find((r) => r.name === project);
  if (!role) {
    throw new Error(
      `Listmonk has no list role ${project}. Give the project its own API user first: \`hatchkit listmonk user ${project}\`.`,
    );
  }

  const lists = await listListmonkLists(admin);
  const changes: string[] = [];
  const warnings: string[] = [];

  async function ensure(name: string): Promise<ProjectListOutcome> {
    const found = lists.filter((l) => l.name === name);
    if (found.length > 1) {
      throw new Error(
        `Listmonk has ${found.length} lists named ${name} (ids ${found.map((l) => l.id).join(", ")}). Rename or delete the extra ones first.`,
      );
    }
    if (found[0]) {
      const warning = listWarning(found[0]);
      if (warning) warnings.push(warning);
      return { id: found[0].id, name, createdThisRun: false };
    }
    changes.push(`create list ${name} (private, double opt-in)`);
    if (dry) return { id: 0, name, createdThisRun: true };
    const created = await createListmonkList(name, {
      type: "private",
      optin: "double",
      tags: [project],
      auth: admin,
    });
    events.onListCreated?.({ id: created.id, name });
    return { id: created.id, name, createdThisRun: true };
  }

  const live = await ensure(names.live);
  const test = await ensure(names.test);

  const ids = [live.id, test.id].filter((id) => id > 0);
  const grant = await grantListsOnListRole(admin, role, ids, dry);
  if (grant.change) changes.push(grant.change);
  // On a dry run a list to create has no id yet; the grant would follow.
  for (const list of [live, test]) {
    if (list.id === 0) {
      changes.push(`add list:get + list:manage on ${list.name} to list role ${project}`);
    }
  }

  return { live, test, changes, warnings };
}

function parseArgs(argv: string[]): {
  positional: string[];
  name?: string;
  dryRun: boolean;
} {
  const out: { positional: string[]; name?: string; dryRun: boolean } = {
    positional: [],
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--name") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Error("--name needs a value");
      out.name = v;
    } else if (a.startsWith("--")) throw new Error(`Unknown option ${a}`);
    else out.positional.push(a);
  }
  return out;
}

export const LISTMONK_LIST_USAGE =
  'Usage: hatchkit listmonk list <project> <key> [--name "<live list name>"] [--dry-run]';

/** `hatchkit listmonk list …`. Throws on anything that stops the run. */
export async function runListmonkListCli(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const [project, key] = args.positional;
  if (!project || !key || args.positional.length > 2) throw new Error(LISTMONK_LIST_USAGE);
  const dry = args.dryRun;

  const { getListmonkAdminAuth } = await import("../config.js");
  const { checkListmonkAdmin, listmonkAdminSetupSteps } = await import(
    "./listmonk-project-user.js"
  );
  const admin = await getListmonkAdminAuth();
  if (!admin) {
    throw new Error(
      [
        "This needs the hatchkit-admin Listmonk credential, and the keychain has none:",
        ...listmonkAdminSetupSteps().map((s) => `  ${s}`),
      ].join("\n"),
    );
  }
  const profile = await checkListmonkAdmin(admin);

  console.log(
    chalk.bold(`\n  Listmonk list ${key} for ${project}${dry ? chalk.yellow(" [dry-run]") : ""}\n`),
  );
  console.log(chalk.dim(`  Listmonk:   ${admin.url} (as ${profile.username})`));

  const { RunLedger } = await import("../utils/run-ledger.js");
  const ledger = dry ? null : RunLedger.resumeOrStart(project);
  const result = await ensureListmonkProjectLists(
    { admin, project, key, liveName: args.name, dryRun: dry },
    {
      onListCreated: (list) =>
        ledger?.record({
          kind: "listmonkList",
          listmonkUrl: admin.url,
          listName: list.name,
          listId: list.id,
        }),
    },
  );

  if (result.changes.length === 0) {
    console.log(chalk.green(`  ✓ Lists and list role already in place.`));
  } else {
    for (const line of result.changes) {
      console.log(dry ? chalk.cyan(`  would ${line}`) : chalk.green(`  ✓ ${line}`));
    }
  }
  for (const w of result.warnings) console.log(chalk.yellow(`  ! ${w}`));

  const idText = (l: ProjectListOutcome) => (l.id > 0 ? String(l.id) : "(new)");
  console.log(
    chalk.dim(
      `\n  Live list: ${result.live.name} = ${idText(result.live)}   Test list: ${result.test.name} = ${idText(result.test)}`,
    ),
  );
  console.log(
    chalk.dim(
      "  Set the live id in the project's production env and the test id everywhere else.\n",
    ),
  );
}
