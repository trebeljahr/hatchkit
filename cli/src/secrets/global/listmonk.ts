/*
 * cli/src/secrets/global/listmonk.ts — rotate hatchkit's global ListMonk
 * API user token.
 *
 * ListMonk (checked against v6.0.0) shows an API user's token once, in
 * the `POST /api/users` response, and has no endpoint that regenerates
 * it. So:
 *
 *   1. create a replacement API user `<name>-rotate-<stamp>` with the old
 *      user's role → its token is the new credential;
 *   2. verify with `GET /api/profile` as that user;
 *   3. store it in the keychain (config meta names the replacement, a
 *      valid pair at every step);
 *   4. fan out LISTMONK_API_TOKEN;
 *   5. revoke: delete the old user, rename the replacement to the old
 *      name (the rename keeps the token), verify again.
 *
 * Step 5's rename keeps LISTMONK_API_USER unchanged everywhere, so a
 * consumer that only carries LISTMONK_API_TOKEN (Coolify app
 * `tracktime-server` on 2026-09-29) keeps working. Both users are never
 * left alive after a successful run.
 *
 * Rights: creating and deleting users needs `users:get` + `users:manage`.
 * hatchkit's `Admin` role has neither — and should not get them, since a
 * leaked token could then mint admins. The operator pastes a one-off
 * admin API user instead (memory only), and may delete it at the end.
 */

import { getListmonkConfig, getStore } from "../../config.js";
import {
  type ListmonkAuth,
  type ListmonkProfile,
  createListmonkApiUser,
  deleteListmonkUser,
  getListmonkProfile,
  renameListmonkApiUser,
} from "../../provision/listmonk.js";
import { SECRET_KEYS, setSecret } from "../../utils/secrets.js";
import { redactErrorMessage } from "../audit.js";
import type { NewCred, OldCred, VerifyOutcome } from "../types.js";
import { promptOneOffInput, promptOneOffSecret, promptYesNo } from "./prompt.js";
import type { GlobalPreflight, GlobalRotationContext, GlobalRotator } from "./types.js";

/** Listmonk's built-in Super Admin role bypasses permission checks. */
const SUPER_ADMIN_ROLE_ID = 1;

interface LmScratch {
  url?: string;
  /** Profile of the user being rotated. */
  old?: ListmonkProfile;
  oldToken?: string;
  /** One-off admin pair (memory only), when the rotated user cannot
   *  manage users itself. */
  admin?: ListmonkAuth;
  adminProfile?: ListmonkProfile;
  fresh?: { id: number; username: string; token: string };
}

function scratch(ctx: GlobalRotationContext): LmScratch {
  ctx.scratch.listmonk ??= {};
  return ctx.scratch.listmonk as LmScratch;
}

function canManageUsers(p: ListmonkProfile): boolean {
  return (
    p.userRoleId === SUPER_ADMIN_ROLE_ID ||
    (p.permissions.includes("users:get") && p.permissions.includes("users:manage"))
  );
}

/** Who creates, deletes and renames users. Without a one-off admin the
 *  rotated user's role can do it, and after the replacement exists it
 *  signs (the old user is about to be deleted). */
function manager(s: LmScratch): ListmonkAuth {
  if (s.admin) return s.admin;
  if (s.fresh && s.url) return { url: s.url, apiUser: s.fresh.username, apiToken: s.fresh.token };
  if (s.old && s.url && s.oldToken) {
    return { url: s.url, apiUser: s.old.username, apiToken: s.oldToken };
  }
  throw new Error("ListMonk rotation has no credentials that can manage users");
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function remedy(profile: ListmonkProfile | undefined): string[] {
  const who = profile ? `API user ${profile.username} (role ${profile.userRoleName || "?"})` : "The API user";
  return [
    `${who} lacks users:get and users:manage, so it cannot create its replacement. Do not add those to its role: a leaked token could then create admins. Instead:`,
    "  1. ListMonk → Admin → Users → New: type API, role Super Admin (or one with users:get + users:manage).",
    "  2. Run this command in a terminal and paste that user's name and token when asked. They are used for this run only and never stored.",
    "  3. Let hatchkit delete that one-off user at the end (it asks), or delete it yourself.",
  ];
}

export const listmonkRotator: GlobalRotator = {
  name: "listmonk",
  label: "ListMonk API user token (LISTMONK_API_TOKEN)",
  consumerKeys: ["LISTMONK_API_TOKEN"],
  matchKey: "LISTMONK_API_TOKEN",

  planNotes() {
    return [
      "ListMonk cannot regenerate an API user's token. hatchkit creates a replacement API user with the same role, verifies it, deletes the old user, then renames the replacement to the old name. LISTMONK_API_USER stays the same; only LISTMONK_API_TOKEN changes.",
      "Running apps keep the old token until they redeploy. After the old user is deleted their ListMonk calls fail, so push and redeploy right after the run.",
    ];
  },

  async preflight(ctx): Promise<GlobalPreflight> {
    const s = scratch(ctx);
    if (ctx.revokePolicy === "never") {
      return {
        ready: false,
        notes: [],
        remedy: [
          "--revoke-old=never cannot apply to ListMonk: the replacement takes the old user's name, which needs the old user gone. Use after-verify (default) or immediate.",
        ],
      };
    }
    const cfg = await getListmonkConfig();
    if (!cfg) {
      return { ready: false, notes: [], remedy: ["ListMonk is not configured. Run `hatchkit config add listmonk`."] };
    }
    s.url = cfg.url;
    s.oldToken = cfg.apiToken;
    let profile: ListmonkProfile;
    try {
      profile = await getListmonkProfile(cfg);
    } catch (err) {
      return {
        ready: false,
        notes: [],
        remedy: [`GET /api/profile with the stored token failed: ${redactErrorMessage((err as Error).message)}`],
      };
    }
    s.old = profile;
    const notes = [`ListMonk ${cfg.url}: API user ${profile.username}, role ${profile.userRoleName || profile.userRoleId}.`];
    if (canManageUsers(profile)) {
      notes.push("The API user's role can manage users; no admin credential needed.");
      return { ready: true, notes };
    }
    if (ctx.dryRun || !ctx.interactive) {
      return { ready: false, notes, remedy: remedy(profile) };
    }

    console.log("");
    for (const line of remedy(profile)) console.log(`  ${line}`);
    console.log("");
    const apiUser = await promptOneOffInput("One-off ListMonk admin API user name");
    const apiToken = await promptOneOffSecret("One-off ListMonk admin API token");
    const admin: ListmonkAuth = { url: cfg.url, apiUser, apiToken };
    let adminProfile: ListmonkProfile;
    try {
      adminProfile = await getListmonkProfile(admin);
    } catch (err) {
      return {
        ready: false,
        notes,
        remedy: [`The one-off admin pair does not authenticate: ${redactErrorMessage((err as Error).message)}`],
      };
    }
    if (!canManageUsers(adminProfile)) {
      return {
        ready: false,
        notes,
        remedy: [`${adminProfile.username}'s role lacks users:get + users:manage.`, ...remedy(profile).slice(1)],
      };
    }
    s.admin = admin;
    s.adminProfile = adminProfile;
    notes.push(`Managing users as one-off admin ${adminProfile.username} (this run only).`);
    return { ready: true, notes };
  },

  async captureOld(ctx): Promise<OldCred> {
    const s = scratch(ctx);
    const cfg = await getListmonkConfig();
    if (!cfg) throw new Error("ListMonk is not configured. Run `hatchkit config add listmonk`.");
    s.url = cfg.url;
    s.oldToken = cfg.apiToken;
    s.old ??= await getListmonkProfile(cfg);
    return {
      values: { LISTMONK_API_TOKEN: cfg.apiToken },
      handle: {
        url: cfg.url,
        userId: String(s.old.id),
        username: s.old.username,
        name: s.old.name,
        userRoleId: String(s.old.userRoleId),
        listRoleId: s.old.listRoleId ? String(s.old.listRoleId) : "",
      },
    };
  },

  async createNew(ctx): Promise<NewCred> {
    const s = scratch(ctx);
    if (!s.old) throw new Error("ListMonk rotation: captureOld did not run");
    const created = await createListmonkApiUser(manager(s), {
      username: `${s.old.username}-rotate-${stamp()}`,
      name: s.old.name,
      userRoleId: s.old.userRoleId,
      listRoleId: s.old.listRoleId,
    });
    s.fresh = { id: created.id, username: created.username, token: created.token };
    return {
      values: { LISTMONK_API_TOKEN: created.token },
      handle: { userId: String(created.id), username: created.username, finalUsername: s.old.username },
    };
  },

  async verify(ctx): Promise<VerifyOutcome> {
    const s = scratch(ctx);
    if (!s.fresh || !s.url) return "failed";
    for (let i = 0; i < 3; i++) {
      try {
        const p = await getListmonkProfile({ url: s.url, apiUser: s.fresh.username, apiToken: s.fresh.token });
        if (p.id === s.fresh.id && p.userRoleId === s.old?.userRoleId) return "ok";
        return "failed";
      } catch {
        await sleep(1000);
      }
    }
    return "failed";
  },

  async discard(ctx, fresh) {
    const s = scratch(ctx);
    const id = Number(fresh.handle.userId);
    // The replacement cannot be trusted to delete itself; use the admin,
    // or the old user, which is still alive at this point.
    const auth = s.admin ?? (s.old && s.url && s.oldToken
      ? { url: s.url, apiUser: s.old.username, apiToken: s.oldToken }
      : undefined);
    if (!auth || !Number.isFinite(id)) return;
    await deleteListmonkUser(auth, id);
  },

  async commit(ctx) {
    const s = scratch(ctx);
    if (!s.fresh) throw new Error("ListMonk rotation: nothing to commit");
    await setSecret(SECRET_KEYS.listmonkApiToken, s.fresh.token);
    getStore().set("providers.listmonk.apiUser", s.fresh.username);
    getStore().set("providers.listmonk.lastVerified", new Date().toISOString());
  },

  async loadCommitted(ctx, newHandle): Promise<NewCred> {
    const s = scratch(ctx);
    const cfg = await getListmonkConfig();
    if (!cfg) throw new Error("ListMonk is not configured. Run `hatchkit config add listmonk`.");
    if (cfg.apiUser !== newHandle.username && cfg.apiUser !== newHandle.finalUsername) {
      throw new Error(
        `The keychain's ListMonk user (${cfg.apiUser}) is not the one the interrupted rotation created. Resolve by hand in ListMonk → Admin → Users before resuming.`,
      );
    }
    s.url = cfg.url;
    s.fresh = { id: Number(newHandle.userId), username: cfg.apiUser, token: cfg.apiToken };
    return {
      values: { LISTMONK_API_TOKEN: cfg.apiToken },
      handle: { ...newHandle },
    };
  },

  async revoke(ctx, old) {
    const s = scratch(ctx);
    if (!s.fresh || !s.url) throw new Error("ListMonk rotation: no replacement user to promote");
    const oldId = Number(old.handle.userId);
    const finalName = old.handle.username;
    const role = {
      name: old.handle.name || finalName,
      userRoleId: Number(old.handle.userRoleId),
      listRoleId: old.handle.listRoleId ? Number(old.handle.listRoleId) : null,
    };
    if (Number.isFinite(oldId) && oldId !== s.fresh.id) {
      await deleteListmonkUser(manager(s), oldId);
    }
    if (s.fresh.username !== finalName) {
      try {
        await renameListmonkApiUser(manager(s), s.fresh.id, { username: finalName, ...role });
      } catch (err) {
        throw new Error(
          `Deleted the old API user, but renaming ${s.fresh.username} to ${finalName} failed: ${redactErrorMessage((err as Error).message)}. hatchkit's config uses ${s.fresh.username}, which works. Rename it to ${finalName} in ListMonk → Admin → Users, or consumers holding LISTMONK_API_USER=${finalName} fail.`,
        );
      }
      s.fresh.username = finalName;
      getStore().set("providers.listmonk.apiUser", finalName);
    }
    const p = await getListmonkProfile({ url: s.url, apiUser: finalName, apiToken: s.fresh.token });
    if (p.id !== s.fresh.id) {
      throw new Error(`After the rename, ${finalName} does not authenticate as the replacement user.`);
    }
  },

  async finish(ctx) {
    const s = scratch(ctx);
    if (!s.admin || !s.adminProfile) return [];
    const name = s.adminProfile.username;
    if (ctx.interactive && (await promptYesNo(`Delete the one-off ListMonk admin user ${name} now?`, true))) {
      try {
        await deleteListmonkUser(s.admin, s.adminProfile.id);
        return [`Deleted the one-off ListMonk admin user ${name}.`];
      } catch (err) {
        return [
          `Could not delete the one-off ListMonk admin user ${name} (${redactErrorMessage((err as Error).message)}). Delete it in ListMonk → Admin → Users.`,
        ];
      }
    }
    return [`Delete the one-off ListMonk admin user ${name} in ListMonk → Admin → Users.`];
  },
};
