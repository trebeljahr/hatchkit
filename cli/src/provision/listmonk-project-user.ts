/*
 * One Listmonk API user per project.
 *
 * Every project used to receive hatchkit's own API user and token, so a
 * leak from any one app handed out the rights of hatchkit's role on the
 * whole shared instance. Each project now gets three objects, all named
 * after the project and found by name on a re-run:
 *
 *   · user role `<project>`: PROJECT_USER_PERMISSIONS below;
 *   · list role `<project>`: `list:get` + `list:manage` on the project's
 *     live and test lists, and on no other list;
 *   · API user `<project>` holding both roles.
 *
 * Why `subscribers:get_all` and not `subscribers:get`: the starter's
 * newsletter creates a subscriber on NO list until the confirm click.
 * With only `subscribers:get`, Listmonk (v6.0.0 `filterListQueryByPerm`,
 * cmd/subscribers.go) limits subscriber queries to the user's lists, so
 * the confirm step cannot find the address, creates it again and gets a
 * 409. The cost: the token can read every subscriber on the instance.
 *
 * Listmonk returns an API user's token once, in the `POST /api/users`
 * response, and has no endpoint that regenerates it. `PUT /api/users/:id`
 * on an API user sets the token to NULL (v4.0–v6.1), so an existing user
 * is never updated. Without its token the only way to a working pair is
 * to delete the user and create it again, which breaks every deployed
 * copy of the old token: that happens only after `confirmRegenerate`
 * says yes.
 *
 * Creating roles and users needs `users:*` + `roles:*`. hatchkit's own
 * API user has neither, so this runs as `hatchkit-admin` (role Super
 * Admin), whose token the operator stores in the keychain. That token
 * never leaves hatchkit.
 */

import {
  type ListmonkAuth,
  type ListmonkListRole,
  type ListmonkProfile,
  type ListmonkUser,
  type ListmonkUserRole,
  createListmonkApiUser,
  createListmonkListRole,
  createListmonkUserRole,
  deleteListmonkRole,
  deleteListmonkUser,
  getListmonkProfile,
  listListmonkListRoles,
  listListmonkUserRoles,
  listListmonkUsers,
  updateListmonkListRole,
  updateListmonkUserRole,
} from "./listmonk.js";

/** What a project's own API user may do. See the file header. */
export const PROJECT_USER_PERMISSIONS = [
  "tx:send",
  "subscribers:get_all",
  "subscribers:manage",
  "campaigns:manage",
] as const;

/** Per-list rights on the project's live and test lists. */
export const PROJECT_LIST_PERMISSIONS = ["list:get", "list:manage"] as const;

/** Listmonk's built-in Super Admin role passes every permission check. */
const SUPER_ADMIN_ROLE_ID = 1;

/** Rights the admin credential needs. */
const ADMIN_PERMISSIONS = ["users:get", "users:manage", "roles:get", "roles:manage"] as const;

const ADMIN_ACCOUNT = "listmonk:admin-api-token";

/** How to create and store the admin credential. */
export function listmonkAdminSetupSteps(): string[] {
  return [
    "1. Listmonk → Admin → Users → New: type API, username hatchkit-admin, role Super Admin. Copy the token it shows once.",
    `2. Store it in the keychain only (the command prompts, so the token stays out of shell history): \`security add-generic-password -U -s hatchkit -a ${ADMIN_ACCOUNT} -w\` (macOS) or \`secret-tool store --label="hatchkit ${ADMIN_ACCOUNT}" service hatchkit account ${ADMIN_ACCOUNT}\` (Linux).`,
  ];
}

/** Warning for a provision run without the admin credential: the
 *  project receives hatchkit's own user, as before. */
export function sharedListmonkUserWarning(project: string, sharedUser: string): string[] {
  return [
    `Listmonk: no admin credential in the keychain (service hatchkit, account ${ADMIN_ACCOUNT}), so ${project} gets hatchkit's own API user ${sharedUser} and its token.`,
    `  Any leak from ${project} then carries the rights of ${sharedUser}'s role on the whole Listmonk instance. To give ${project} its own user:`,
    ...listmonkAdminSetupSteps().map((s) => `  ${s}`),
    `  3. \`hatchkit listmonk user ${project}\` creates the user and rewrites the env files.`,
  ];
}

/** Whether a profile can create and delete roles and users. */
export function canManageListmonkUsers(p: ListmonkProfile): boolean {
  return (
    p.userRoleId === SUPER_ADMIN_ROLE_ID ||
    ADMIN_PERMISSIONS.every((perm) => p.permissions.includes(perm))
  );
}

/** Check the admin credential before any write. Throws a message that
 *  names the fix. */
export async function checkListmonkAdmin(admin: ListmonkAuth): Promise<ListmonkProfile> {
  let profile: ListmonkProfile;
  try {
    profile = await getListmonkProfile(admin);
  } catch (err) {
    const msg = (err as Error).message;
    if (/HTTP 40[13]\b/.test(msg)) {
      throw new Error(
        [
          `Listmonk rejected the admin credential ${admin.apiUser} (keychain ${ADMIN_ACCOUNT}): ${msg.split("\n")[0]}`,
          "Store the token Listmonk showed when it created that user:",
          ...listmonkAdminSetupSteps().map((s) => `  ${s}`),
        ].join("\n"),
      );
    }
    throw err;
  }
  if (profile.username !== admin.apiUser) {
    throw new Error(
      `The token in keychain ${ADMIN_ACCOUNT} belongs to Listmonk user ${profile.username}, not ${admin.apiUser}.`,
    );
  }
  if (!canManageListmonkUsers(profile)) {
    throw new Error(
      `Listmonk user ${profile.username} (role ${profile.userRoleName || profile.userRoleId}) lacks ${ADMIN_PERMISSIONS.join(", ")}. Give it the Super Admin role in Listmonk → Admin → Users.`,
    );
  }
  return profile;
}

/** Whether `name` can be a Listmonk username (cmd/users.go: 3+
 *  characters from `[a-zA-Z0-9_\-.@]`). */
export function validListmonkUsername(name: string): boolean {
  return name.length >= 3 && /^[a-zA-Z0-9_\-.@]+$/.test(name);
}

export interface ListmonkProjectUserEvents {
  /** A role was created (or found) by name. */
  onRole?: (e: {
    roleType: "user" | "list";
    roleId: number;
    name: string;
    createdThisRun: boolean;
  }) => void;
  /** The API user was created (or found). `createdThisRun` is also true
   *  for a user deleted and created again after `confirmRegenerate`. */
  onUser?: (e: { userId: number; username: string; createdThisRun: boolean }) => void;
  /** Called with the token right after Listmonk returns it, before any
   *  other call that can fail: the token exists nowhere else. */
  onToken?: (e: { username: string; token: string }) => Promise<void> | void;
}

export interface EnsureListmonkProjectUserOptions {
  /** The `hatchkit-admin` credential. */
  admin: ListmonkAuth;
  /** Role and user name — the project name. */
  name: string;
  /** Lists the list role grants get + manage on (live, test). */
  listIds: number[];
  /** Grant only tx:send, without a list role. */
  transactionalOnly?: boolean;
  /** Tokens from an earlier run (the project env, the keychain), best
   *  first. The first one Listmonk accepts for the user is reused. */
  cachedTokens?: string[];
  /** Asked only when the user exists and no working token is known.
   *  Yes deletes the user and creates it again: the deployed copy of
   *  the old token stops working. Omitted means no. */
  confirmRegenerate?: (info: {
    username: string;
    userId: number;
    reason: string;
  }) => Promise<boolean>;
  /** Names that belong to someone else (hatchkit's own API user, the
   *  admin). Refused outright, since a re-run could delete them. */
  reservedNames?: string[];
  /** Report what would change; write nothing. The token is then empty. */
  dryRun?: boolean;
}

export interface ListmonkProjectUserResult {
  username: string;
  /** Empty only under `dryRun`. */
  token: string;
  userId: number;
  userRoleId: number;
  listRoleId: number | null;
  /** One line per change made (or, under `dryRun`, planned). Empty on
   *  a re-run that found everything in place. */
  changes: string[];
  created: { userRole: boolean; listRole: boolean; user: boolean };
  /** The user existed without a known token and was created again. */
  regenerated: boolean;
}

/** Create the project's user role, list role and API user, or find them
 *  by name. Idempotent: a re-run with the cached token writes nothing.
 *  A role that lacks a permission or list gets it added; what else it
 *  holds is kept (the operator may have widened it on purpose). */
export async function ensureListmonkProjectUser(
  opts: EnsureListmonkProjectUserOptions,
  events: ListmonkProjectUserEvents = {},
): Promise<ListmonkProjectUserResult> {
  const { admin, name } = opts;
  const dry = opts.dryRun === true;
  if (!validListmonkUsername(name)) {
    throw new Error(
      `"${name}" cannot be a Listmonk username (3+ characters from letters, digits, _ - . @).`,
    );
  }
  assertNotReserved(name, opts.reservedNames);
  const listIds = [...new Set(opts.listIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (listIds.length === 0 && !opts.transactionalOnly) {
    throw new Error(`No Listmonk list ids for ${name}: the list role would grant nothing.`);
  }
  const changes: string[] = [];
  const created = { userRole: false, listRole: false, user: false };

  // ── user role ──
  const wanted = opts.transactionalOnly ? ["tx:send"] : [...PROJECT_USER_PERMISSIONS];
  const userRoles = await listListmonkUserRoles(admin);
  let userRole: ListmonkUserRole | undefined = userRoles.find((r) => r.name === name);
  if (opts.transactionalOnly && userRole?.permissions.some((p) => p !== "tx:send")) {
    throw new Error(
      `User role ${name} has broader permissions. Choose a different --name for transactional-only access; existing permissions are preserved.`,
    );
  }
  if (!userRole) {
    changes.push(`create user role ${name}: ${wanted.join(", ")}`);
    if (dry) {
      userRole = { id: 0, name, permissions: wanted };
    } else {
      userRole = await createListmonkUserRole(admin, { name, permissions: wanted });
    }
    created.userRole = true;
  } else {
    const missing = wanted.filter((p) => !userRole?.permissions.includes(p));
    if (missing.length > 0) {
      changes.push(`add ${missing.join(", ")} to user role ${name} (id ${userRole.id})`);
      const permissions = [...userRole.permissions, ...missing];
      if (!dry) await updateListmonkUserRole(admin, userRole.id, { name, permissions });
      userRole = { ...userRole, permissions };
    }
  }
  events.onRole?.({
    roleType: "user",
    roleId: userRole.id,
    name,
    createdThisRun: created.userRole,
  });

  // ── list role ──
  let listRole: ListmonkListRole | undefined;
  if (!opts.transactionalOnly) {
    const listPerms = [...PROJECT_LIST_PERMISSIONS];
    const listRoles = await listListmonkListRoles(admin);
    listRole = listRoles.find((r) => r.name === name);
    if (!listRole) {
      const lists = listIds.map((id) => ({ id, permissions: listPerms }));
      changes.push(`create list role ${name}: lists ${listIds.join(", ")} (get, manage)`);
      if (dry) {
        listRole = { id: 0, name, lists };
      } else {
        const r = await createListmonkListRole(admin, { name, lists });
        listRole = { id: r.id, name, lists };
      }
      created.listRole = true;
    } else {
      // PUT replaces the whole set, so send every list the role has, with
      // the missing rights added to ours.
      const byId = new Map(listRole.lists.map((l) => [l.id, [...l.permissions]]));
      const added: string[] = [];
      for (const id of listIds) {
        const have = byId.get(id) ?? [];
        const missing = listPerms.filter((p) => !have.includes(p));
        if (missing.length === 0) continue;
        byId.set(id, [...have, ...missing]);
        added.push(`${missing.join(" + ")} on list ${id}`);
      }
      if (added.length > 0) {
        const lists = [...byId].map(([id, permissions]) => ({ id, permissions }));
        changes.push(`add ${added.join(", ")} to list role ${name} (id ${listRole.id})`);
        if (!dry) await updateListmonkListRole(admin, listRole.id, { name, lists });
        listRole = { ...listRole, lists };
      }
    }
    events.onRole?.({
      roleType: "list",
      roleId: listRole.id,
      name,
      createdThisRun: created.listRole,
    });
  }
  const listRoleId = listRole?.id ?? null;

  // ── API user ──
  const users = await listListmonkUsers(admin);
  const existing: ListmonkUser | undefined = users.find((u) => u.username === name);
  let regenerated = false;
  let token = "";
  let userId = existing?.id ?? 0;

  if (existing) {
    if (existing.type !== "api") {
      throw new Error(
        `Listmonk user ${name} (id ${existing.id}) is a login user, not an API user. hatchkit will not replace it. Rename it in Listmonk, or pick another project name.`,
      );
    }
    const check = await checkReuse(existing, opts.cachedTokens, userRole.id, listRoleId, admin);
    if (check.token) {
      token = check.token;
    } else {
      const reason = check.reason ?? "no working token for it is stored";
      const ok =
        !dry &&
        (await opts.confirmRegenerate?.({ username: name, userId: existing.id, reason })) === true;
      if (dry) {
        changes.push(
          `API user ${name} (id ${existing.id}): ${reason}. A real run asks before it deletes and creates it again (that breaks every deployed copy of its token).`,
        );
      } else if (!ok) {
        throw new Error(regenerateRefusal(name, existing.id, reason));
      } else {
        if (existing.id === (await getListmonkProfile(admin)).id) {
          throw new Error(`Refusing to delete ${name}: it is the admin credential itself.`);
        }
        await deleteListmonkUser(admin, existing.id);
        changes.push(`delete API user ${name} (id ${existing.id}): ${reason}`);
        regenerated = true;
      }
    }
  }

  if (!existing || regenerated) {
    if (dry) {
      changes.push(
        `create API user ${name} with user role ${name}${opts.transactionalOnly ? " (tx:send only)" : ` and list role ${name}`}`,
      );
    } else {
      const fresh = await createListmonkApiUser(admin, {
        username: name,
        name,
        userRoleId: userRole.id,
        listRoleId,
      });
      await events.onToken?.({ username: fresh.username, token: fresh.token });
      token = fresh.token;
      userId = fresh.id;
      changes.push(`create API user ${name} (id ${fresh.id})`);
    }
    created.user = true;
  }
  events.onUser?.({ userId, username: name, createdThisRun: created.user });

  return {
    username: name,
    token,
    userId,
    userRoleId: userRole.id,
    listRoleId,
    changes,
    created,
    regenerated,
  };
}

/** Throw when `name` is one of hatchkit's own Listmonk users: a re-run
 *  could otherwise offer to delete it. */
export function assertNotReserved(name: string, reservedNames: string[] | undefined): void {
  if ((reservedNames ?? []).includes(name)) {
    throw new Error(
      `Listmonk user ${name} is hatchkit's own credential, not a project's. Pick another project name.`,
    );
  }
}

/** Why hatchkit stopped instead of recreating an existing user. */
export function regenerateRefusal(name: string, userId: number, reason: string): string {
  return [
    `Listmonk API user ${name} (id ${userId}) exists, but ${reason}.`,
    "Listmonk cannot show or regenerate an existing token. Creating the user again breaks every deployed copy of the old token until it redeploys with the new one.",
    `To do that: run \`hatchkit listmonk user ${name} --regenerate-token\`, then \`hatchkit sync\` and redeploy right away.`,
    `Or store the working token in the keychain: \`security add-generic-password -U -s hatchkit -a listmonk:project:${name}:api-token -w\`, and run the command again.`,
  ].join("\n");
}

/** Read-only look at the project's API user, for callers that must ask
 *  before a spinner starts. Null when no user has the name; otherwise
 *  its id and why it cannot be reused (null: it can). Roles missing by
 *  name count as a mismatch, the same way `ensureListmonkProjectUser`
 *  sees them. Throws for a login user with the project's name. */
export async function inspectListmonkProjectUser(
  admin: ListmonkAuth,
  name: string,
  cachedTokens: string[] | undefined,
  transactionalOnly = false,
): Promise<{ userId: number; reason: string | null } | null> {
  const user = (await listListmonkUsers(admin)).find((u) => u.username === name);
  if (!user) return null;
  if (user.type !== "api") {
    throw new Error(
      `Listmonk user ${name} (id ${user.id}) is a login user, not an API user. hatchkit will not replace it. Rename it in Listmonk, or pick another project name.`,
    );
  }
  const userRole = (await listListmonkUserRoles(admin)).find((r) => r.name === name);
  const listRole = transactionalOnly
    ? undefined
    : (await listListmonkListRoles(admin)).find((r) => r.name === name);
  const check = await checkReuse(
    user,
    cachedTokens,
    userRole?.id ?? -1,
    transactionalOnly ? null : (listRole?.id ?? -1),
    admin,
  );
  return { userId: user.id, reason: check.token ? null : (check.reason ?? "no working token") };
}

/** Whether an existing API user can be reused as-is: enabled, holds
 *  our two roles, and one of the cached tokens signs in as it. Returns
 *  that token, or why not. Roles are never fixed in place —
 *  `PUT /api/users/:id` would wipe the token. */
async function checkReuse(
  user: ListmonkUser,
  cachedTokens: string[] | undefined,
  userRoleId: number,
  listRoleId: number | null,
  admin: ListmonkAuth,
): Promise<{ token: string; reason?: undefined } | { token?: undefined; reason: string }> {
  if (user.userRoleId !== userRoleId || user.listRoleId !== listRoleId) {
    return {
      reason:
        listRoleId === null
          ? `it does not hold user role ${user.username} without a list role`
          : `it does not hold user role ${user.username} and list role ${user.username}`,
    };
  }
  if (user.status !== "enabled") return { reason: `it is ${user.status}` };
  const tokens = [...new Set((cachedTokens ?? []).map((t) => t.trim()).filter(Boolean))];
  if (tokens.length === 0) return { reason: "no token for it is stored" };
  let reason = "Listmonk rejects the stored token";
  for (const token of tokens) {
    try {
      const p = await getListmonkProfile({
        url: admin.url,
        apiUser: user.username,
        apiToken: token,
      });
      if (p.id === user.id) return { token };
      reason = `the stored token signs in as user id ${p.id}, not ${user.id}`;
    } catch (err) {
      if (!/HTTP 40[13]\b/.test((err as Error).message)) throw err;
    }
  }
  return { reason };
}

export interface RemoveListmonkProjectUserResult {
  user: "deleted" | "not-found" | "skipped";
  userRole: "deleted" | "not-found" | "skipped";
  listRole: "deleted" | "not-found" | "skipped";
  /** Why a step was skipped. */
  notes: string[];
}

/** Delete the project's API user, then its user role, then its list
 *  role — that order, because Listmonk refuses to delete a user role a
 *  user still holds, and deleting a list role deletes every user that
 *  holds it. A role another user still holds is kept and reported. A
 *  login user with the project's name is never touched. */
export async function removeListmonkProjectUser(
  admin: ListmonkAuth,
  name: string,
  opts: { dryRun?: boolean; reservedNames?: string[] } = {},
): Promise<RemoveListmonkProjectUserResult> {
  const out: RemoveListmonkProjectUserResult = {
    user: "not-found",
    userRole: "not-found",
    listRole: "not-found",
    notes: [],
  };
  if ((opts.reservedNames ?? []).includes(name)) {
    out.user = out.userRole = out.listRole = "skipped";
    out.notes.push(`${name} is hatchkit's own credential; left alone.`);
    return out;
  }
  let users = await listListmonkUsers(admin);
  const user = users.find((u) => u.username === name);
  if (user && user.type !== "api") {
    out.user = "skipped";
    out.notes.push(`Listmonk user ${name} (id ${user.id}) is a login user; left alone.`);
  } else if (user) {
    if (!opts.dryRun) await deleteListmonkUser(admin, user.id);
    out.user = "deleted";
    users = users.filter((u) => u.id !== user.id);
  }

  const userRole = (await listListmonkUserRoles(admin)).find((r) => r.name === name);
  if (userRole) {
    const holders = users.filter((u) => u.userRoleId === userRole.id);
    if (holders.length > 0) {
      out.userRole = "skipped";
      out.notes.push(
        `User role ${name} (id ${userRole.id}) is still held by ${holders.map((u) => u.username).join(", ")}; kept.`,
      );
    } else {
      if (!opts.dryRun) await deleteListmonkRole(admin, userRole.id);
      out.userRole = "deleted";
    }
  }

  const listRole = (await listListmonkListRoles(admin)).find((r) => r.name === name);
  if (listRole) {
    const holders = users.filter((u) => u.listRoleId === listRole.id);
    if (holders.length > 0) {
      // Deleting it would delete these users too (ON DELETE CASCADE).
      out.listRole = "skipped";
      out.notes.push(
        `List role ${name} (id ${listRole.id}) is still held by ${holders.map((u) => u.username).join(", ")}; kept, since deleting it would delete them too.`,
      );
    } else {
      if (!opts.dryRun) await deleteListmonkRole(admin, listRole.id);
      out.listRole = "deleted";
    }
  }
  return out;
}

/** Ledger undo for one role: delete it by id unless a user still holds
 *  it. A list role held by a user is never deleted — that would delete
 *  the user as well. An id that now carries another name is left alone. */
export async function deleteListmonkRoleIfUnheld(
  admin: ListmonkAuth,
  roleType: "user" | "list",
  roleId: number,
  name?: string,
): Promise<"deleted" | "not-found"> {
  const roles =
    roleType === "user" ? await listListmonkUserRoles(admin) : await listListmonkListRoles(admin);
  const role = roles.find((r) => r.id === roleId);
  if (!role) return "not-found";
  if (name !== undefined && role.name !== name) {
    throw new Error(
      `Listmonk ${roleType} role id ${roleId} is now ${role.name}, not ${name}; left alone.`,
    );
  }
  const holders = (await listListmonkUsers(admin)).filter((u) =>
    roleType === "user" ? u.userRoleId === roleId : u.listRoleId === roleId,
  );
  if (holders.length > 0) {
    throw new Error(
      `Listmonk ${roleType} role id ${roleId} is still held by ${holders.map((u) => u.username).join(", ")}; delete or move those users first.`,
    );
  }
  return deleteListmonkRole(admin, roleId);
}

/** Ledger undo for the API user: delete it by id, but only while that id
 *  still belongs to an API user of that name. */
export async function deleteListmonkApiUserIfNamed(
  admin: ListmonkAuth,
  userId: number,
  username: string,
): Promise<"deleted" | "not-found"> {
  const user = (await listListmonkUsers(admin)).find((u) => u.id === userId);
  if (!user) return "not-found";
  if (user.username !== username || user.type !== "api") {
    throw new Error(
      `Listmonk user id ${userId} is now ${user.username} (${user.type}), not API user ${username}; left alone.`,
    );
  }
  return deleteListmonkUser(admin, userId);
}
