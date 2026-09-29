/*
 * cli/src/secrets/global/listmonk.ts — rotate hatchkit's global ListMonk
 * API user token.
 *
 * ListMonk shows an API user's token once, in the `POST /api/users`
 * response, and has no endpoint that regenerates it. Nor can a
 * replacement take over the old user's name: the token lives in the
 * `password` column, and `update-user` (queries.sql, v4.0 through
 * v6.1) sets that column to NULL whenever `password_login` is false —
 * which it always is for an API user. A rename wipes the token. v6.2
 * keeps it, but a rotation has to work on every version from v4 on.
 * On 2026-09-29 a rename left every consumer holding a dead token.
 *
 * So the replacement keeps its own name, and LISTMONK_API_USER rotates
 * together with LISTMONK_API_TOKEN:
 *
 *   1. create API user `<base>-rotate-<stamp>` with the old user's role;
 *   2. verify it (GET /api/profile, retries);
 *   3. store the pair (keychain token + config `apiUser`);
 *   4. fan out LISTMONK_API_USER + LISTMONK_API_TOKEN to every consumer,
 *      also one that held only the token;
 *   5. revoke: delete the old user, then prove (retries) that the
 *      replacement still authenticates and the old pair no longer does.
 *      On any other result, report what exists and how to recover.
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
  normalizeListmonkUrl,
} from "../../provision/listmonk.js";
import { SECRET_KEYS, setSecret } from "../../utils/secrets.js";
import { redactErrorMessage } from "../audit.js";
import type { NewCred, OldCred, VerifyOutcome } from "../types.js";
import {
  LISTMONK_TOKEN_SHAPE,
  LISTMONK_USER_SHAPE,
  authenticatedLine,
  promptPasted,
  promptYesNo,
  rejectedLine,
} from "./prompt.js";
import {
  type GlobalPreflight,
  type GlobalRotationContext,
  type GlobalRotator,
  RevokeError,
  SHARED_CREDENTIAL_KEYS,
} from "./types.js";

/** Listmonk's built-in Super Admin role bypasses permission checks. */
const SUPER_ADMIN_ROLE_ID = 1;

const RESUME = "hatchkit secrets rotate --global listmonk --resume";
/** Keychain account of this rotation's rollback blob (rollback-store). */
const ROLLBACK_ACCOUNT = "secrets-rollback:@global:listmonk";

interface LmDeps {
  /** Tries + pause for every auth check after a change. */
  timing: { attempts: number; delayMs: number };
}
const defaultDeps: LmDeps = { timing: { attempts: 3, delayMs: 1000 } };
let deps: LmDeps = defaultDeps;

/** Test-only: shorten the retry pauses. */
export function __setListmonkRotationDepsForTesting(partial: Partial<LmDeps> | undefined): void {
  deps = partial ? { ...defaultDeps, ...partial } : defaultDeps;
}

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
  /** Resume found a working keychain pair that is not the replacement
   *  the interrupted run created (fixed by hand since). */
  adopted?: { id: string; username: string };
  /** Id of the user `revoke` deleted or found gone. */
  revokedId?: number;
  /** The old user's token is dead but deleting the user failed. */
  orphan?: { name: string; id: string; error: string };
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

/** Who creates and deletes users. Without a one-off admin the rotated
 *  user's role can do it, and after the replacement exists it signs
 *  (the old user is about to be deleted). */
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

/** `hatchkit-rotate-202609291130` → `hatchkit`, so names do not grow a
 *  suffix per rotation. */
export function listmonkBaseName(username: string): string {
  return username.replace(/-rotate-\d{12}$/, "");
}

function profileDetails(p: ListmonkProfile): string[] {
  return [`id ${p.id}`, `type ${p.type}`, `role ${p.userRoleName || p.userRoleId}`];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Probe =
  | { kind: "accepted"; profile: ListmonkProfile }
  | { kind: "rejected"; detail: string }
  | { kind: "unreachable"; detail: string };

async function probeOnce(auth: ListmonkAuth): Promise<Probe> {
  try {
    return { kind: "accepted", profile: await getListmonkProfile(auth) };
  } catch (err) {
    const detail = redactErrorMessage((err as Error).message);
    return /HTTP 40[13]\b/.test(detail) ? { kind: "rejected", detail } : { kind: "unreachable", detail };
  }
}

/** GET /api/profile until the answer is `want` or the tries run out.
 *  Returns the last answer. */
async function probeUntil(auth: ListmonkAuth, want: "accepted" | "rejected"): Promise<Probe> {
  let last: Probe = { kind: "unreachable", detail: "not tried" };
  for (let i = 0; i < deps.timing.attempts; i++) {
    if (i > 0) await sleep(deps.timing.delayMs);
    last = await probeOnce(auth);
    if (last.kind === want) break;
  }
  return last;
}

function remedy(profile: ListmonkProfile | undefined): string[] {
  const who = profile ? `API user ${profile.username} (role ${profile.userRoleName || "?"})` : "The API user";
  return [
    `${who} lacks users:get and users:manage, so it cannot create its replacement. Do not add those to its role: a leaked token could then create admins. Instead:`,
    "  1. ListMonk → Admin → Users → New: type API, role Super Admin (or one with users:get + users:manage).",
    "  2. Run this command in a terminal and paste that user's name and token when asked. They are used for this run only and never stored.",
    "  3. Let hatchkit delete that one-off user at the end (it asks), or delete it yourself.",
  ];
}

/** Steps to a working pair when the one in the keychain is dead. */
function recreateSteps(base: string, role: string, then: string): string[] {
  return [
    `  1. ListMonk → Admin → Users → New: type API, role ${role}, a new name such as ${base}-rotate-fix. Copy the token it shows once.`,
    "  2. `hatchkit config add listmonk`: paste that name and token. hatchkit checks them before it stores them.",
    `  3. \`${RESUME}\`: ${then}`,
    "  4. Commit, push and redeploy the consumers it lists.",
  ];
}

/** The keychain's pair did not authenticate. Rejected: on `--resume` the
 *  fix is a working pair in the keychain, which the resume fans out.
 *  Unreachable says so and nothing more — a ListMonk that is down is no
 *  reason to recreate users. */
function storedPairRemedy(
  ctx: GlobalRotationContext,
  url: string,
  apiUser: string,
  probe: Exclude<Probe, { kind: "accepted" }>,
): string[] {
  if (probe.kind === "unreachable") {
    return [`ListMonk ${url} did not answer GET /api/profile: ${probe.detail}. Nothing was changed; run the command again once it answers.`];
  }
  const head = `The stored ListMonk pair (user ${apiUser}) does not authenticate: ${probe.detail}.`;
  const old = ctx.resumeOld?.handle;
  if (!old) {
    return [`${head} Store a working API user with \`hatchkit config add listmonk\`, then run the rotation.`];
  }
  const who = old.username || "the old user";
  return [
    `${head} Resuming would write a dead token into every consumer, so nothing was changed. To recover:`,
    ...recreateSteps(
      listmonkBaseName(old.username || apiUser),
      old.userRoleName || `id ${old.userRoleId || "?"}`,
      `writes that pair into every consumer that still holds ${who}'s token and deletes ${who}.`,
    ),
  ];
}

export const listmonkRotator: GlobalRotator = {
  name: "listmonk",
  label: "ListMonk API user (LISTMONK_API_USER / LISTMONK_API_TOKEN)",
  consumerKeys: SHARED_CREDENTIAL_KEYS.listmonk,
  matchKey: "LISTMONK_API_TOKEN",

  planNotes() {
    return [
      "ListMonk cannot regenerate an API user's token, and renaming an API user wipes its token (ListMonk v4.0–v6.1). hatchkit creates a replacement API user <name>-rotate-<stamp> with the same role and verifies it. LISTMONK_API_USER and LISTMONK_API_TOKEN change together in every consumer; one that held only the token gets both.",
      "After the fan-out hatchkit deletes the old user, then checks that the replacement still authenticates and the old pair no longer does. Running apps keep the old pair until they redeploy and fail after the delete, so push and redeploy right after the run.",
    ];
  },

  async preflight(ctx): Promise<GlobalPreflight> {
    const s = scratch(ctx);
    const cfg = await getListmonkConfig();
    if (!cfg) {
      return { ready: false, notes: [], remedy: ["ListMonk is not configured. Run `hatchkit config add listmonk`."] };
    }
    s.url = cfg.url;
    s.oldToken = cfg.apiToken;
    const stored = await probeOnce(cfg);
    if (stored.kind !== "accepted") {
      return { ready: false, notes: [], remedy: storedPairRemedy(ctx, cfg.url, cfg.apiUser, stored) };
    }
    const profile = stored.profile;
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
    const refuse = (why: string): GlobalPreflight => ({
      ready: false,
      notes,
      remedy: [why, ...remedy(profile).slice(1)],
    });
    const apiUser = await promptPasted("One-off ListMonk admin API user name", LISTMONK_USER_SHAPE);
    if (apiUser === undefined) return refuse("The pasted user name did not have the expected shape (see above).");
    const apiToken = await promptPasted("One-off ListMonk admin API token", LISTMONK_TOKEN_SHAPE);
    if (apiToken === undefined) return refuse("The pasted token did not have the expected shape (see above).");

    const admin: ListmonkAuth = { url: cfg.url, apiUser, apiToken };
    const probe = await probeOnce(admin);
    if (probe.kind !== "accepted") {
      console.log(`  ${rejectedLine(`ListMonk did not accept ${apiUser} with that token: ${probe.detail}`)}`);
      return refuse(
        probe.kind === "rejected"
          ? `ListMonk rejected ${apiUser} with the pasted token. Paste the token that ListMonk showed when it created ${apiUser}.`
          : `ListMonk did not answer: ${probe.detail}`,
      );
    }
    const adminProfile = probe.profile;
    console.log(`  ${authenticatedLine(adminProfile.username, profileDetails(adminProfile))}`);
    if (adminProfile.username !== apiUser) {
      return refuse(`The token belongs to ${adminProfile.username}, not ${apiUser}.`);
    }
    if (adminProfile.id === profile.id) {
      return refuse(`${apiUser} is the user being rotated, not a one-off admin.`);
    }
    if (!canManageUsers(adminProfile)) {
      return refuse(`${adminProfile.username}'s role lacks users:get + users:manage.`);
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
      values: { LISTMONK_API_USER: s.old.username, LISTMONK_API_TOKEN: cfg.apiToken },
      handle: {
        url: cfg.url,
        userId: String(s.old.id),
        username: s.old.username,
        name: s.old.name,
        userRoleId: String(s.old.userRoleId),
        userRoleName: s.old.userRoleName,
        listRoleId: s.old.listRoleId ? String(s.old.listRoleId) : "",
      },
    };
  },

  async createNew(ctx): Promise<NewCred> {
    const s = scratch(ctx);
    if (!s.old) throw new Error("ListMonk rotation: captureOld did not run");
    const created = await createListmonkApiUser(manager(s), {
      username: `${listmonkBaseName(s.old.username)}-rotate-${stamp()}`,
      name: s.old.name,
      userRoleId: s.old.userRoleId,
      listRoleId: s.old.listRoleId,
    });
    s.fresh = { id: created.id, username: created.username, token: created.token };
    return {
      values: { LISTMONK_API_USER: created.username, LISTMONK_API_TOKEN: created.token },
      handle: { userId: String(created.id), username: created.username },
    };
  },

  async verify(ctx): Promise<VerifyOutcome> {
    const s = scratch(ctx);
    if (!s.fresh || !s.url) return "failed";
    const probe = await probeUntil({ url: s.url, apiUser: s.fresh.username, apiToken: s.fresh.token }, "accepted");
    if (probe.kind !== "accepted") {
      console.error(`  · listmonk verify: ${s.fresh.username} does not authenticate: ${probe.detail}`);
      return "failed";
    }
    return probe.profile.id === s.fresh.id && probe.profile.userRoleId === s.old?.userRoleId ? "ok" : "failed";
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

  /** Resume fans out whatever working pair the keychain holds: normally
   *  the replacement, or a pair set with `hatchkit config add listmonk`
   *  after a failed run. A dead pair is refused — fanning it out would
   *  break every consumer. */
  async loadCommitted(ctx, newHandle): Promise<NewCred> {
    const s = scratch(ctx);
    const cfg = await getListmonkConfig();
    if (!cfg) throw new Error("ListMonk is not configured. Run `hatchkit config add listmonk`.");
    const old = ctx.resumeOld?.handle ?? {};
    if (old.url && normalizeListmonkUrl(old.url) !== normalizeListmonkUrl(cfg.url)) {
      throw new Error(
        `The keychain's ListMonk is ${cfg.url}, but the interrupted rotation ran against ${old.url}. Run \`hatchkit config add listmonk\` for ${old.url}, then resume.`,
      );
    }
    const probe = await probeUntil(cfg, "accepted");
    if (probe.kind !== "accepted") {
      throw new Error(storedPairRemedy(ctx, cfg.url, cfg.apiUser, probe).join("\n"));
    }
    const p = probe.profile;
    if (old.userId && String(p.id) === old.userId) {
      throw new Error(
        [
          `The keychain holds ${p.username} (id ${p.id}) again, the user this rotation set out to replace: it was rolled back by hand, and there is nothing to resume.`,
          `  1. If ${newHandle.username || `user id ${newHandle.userId}`} is still listed in ListMonk → Admin → Users and nothing uses it, delete it.`,
          `  2. Drop the interrupted rotation's record: \`security delete-generic-password -s hatchkit -a ${ROLLBACK_ACCOUNT}\` (macOS) or \`secret-tool clear service hatchkit account ${ROLLBACK_ACCOUNT}\` (Linux).`,
          "  3. Start a new rotation.",
        ].join("\n"),
      );
    }
    s.url = cfg.url;
    s.fresh = { id: p.id, username: p.username, token: cfg.apiToken };
    if (newHandle.userId && String(p.id) !== newHandle.userId) {
      s.adopted = { id: newHandle.userId, username: newHandle.username || `id ${newHandle.userId}` };
    }
    return {
      values: { LISTMONK_API_USER: p.username, LISTMONK_API_TOKEN: cfg.apiToken },
      handle: { userId: String(p.id), username: p.username },
    };
  },

  async revoke(ctx, old) {
    const s = scratch(ctx);
    if (!s.fresh || !s.url) throw new Error("ListMonk rotation: no replacement user");
    const fresh = s.fresh;
    const oldId = Number(old.handle.userId);
    const oldName = old.handle.username || `id ${old.handle.userId}`;
    const oldLabel = `old API user ${oldName} (id ${old.handle.userId})`;
    const freshLabel = `replacement ${fresh.username} (id ${fresh.id})`;

    let deleteError: string | undefined;
    let deleted = false;
    if (Number.isFinite(oldId) && oldId !== fresh.id) {
      try {
        await deleteListmonkUser(manager(s), oldId);
        deleted = true;
        s.revokedId = oldId;
      } catch (err) {
        deleteError = redactErrorMessage((err as Error).message);
      }
    }

    // A delete changes ListMonk's API-user cache: prove both sides.
    const freshProbe = await probeUntil({ url: s.url, apiUser: fresh.username, apiToken: fresh.token }, "accepted");
    const oldToken = old.values.LISTMONK_API_TOKEN;
    const oldProbe = oldToken && old.handle.username
      ? await probeUntil({ url: s.url, apiUser: old.handle.username, apiToken: oldToken }, "rejected")
      : undefined;
    const newWorks = freshProbe.kind === "accepted" && freshProbe.profile.id === fresh.id;
    const oldRevoked = oldProbe ? oldProbe.kind === "rejected" || (deleted && oldProbe.kind === "unreachable") : deleted;
    if (newWorks && oldRevoked) {
      if (deleteError) s.orphan = { name: oldName, id: old.handle.userId, error: deleteError };
      return;
    }

    const why = deleteError ? ` (delete failed: ${deleteError})` : "";
    const oldStatus =
      oldProbe?.kind === "accepted"
        ? `${oldLabel} still authenticates${why}`
        : !oldRevoked
          ? `could not confirm the ${oldLabel} is gone${why}`
          : deleted
            ? `${oldLabel} deleted`
            : `${oldLabel} no longer authenticates${why}`;
    const newStatus = newWorks
      ? `${freshLabel} authenticates`
      : freshProbe.kind === "rejected"
        ? `${freshLabel}: ListMonk rejects its token`
        : freshProbe.kind === "accepted"
          ? `${fresh.username}'s token authenticates as user id ${freshProbe.profile.id}, not ${fresh.id}`
          : `${freshLabel}: ListMonk did not answer (${freshProbe.detail})`;
    const holders = `The keychain and every consumer this run updated hold LISTMONK_API_USER=${fresh.username} and its token.`;

    if (freshProbe.kind === "unreachable") {
      // Unknown is not broken: do not send anyone recreating users.
      throw new RevokeError(`${oldStatus}; ${newStatus}. ${holders}`, {
        oldRevoked,
        newWorks: true,
        oldStatus,
        newStatus,
        recovery: [`ListMonk did not answer the check. Run \`${RESUME}\` to check again${oldRevoked ? "" : " and delete the old user"}.`],
      });
    }
    if (newWorks) {
      throw new RevokeError(`${oldStatus}; ${newStatus}. ${holders}`, {
        oldRevoked,
        newWorks,
        oldStatus,
        newStatus,
        recovery: [
          `The old user still works, so nothing is down. Delete ${oldName} in ListMonk → Admin → Users once nothing uses it, or run \`${RESUME}\` to try again.`,
        ],
      });
    }
    const role = old.handle.userRoleName || `id ${old.handle.userRoleId}`;
    throw new RevokeError(`${oldStatus}; ${newStatus}. ${holders}`, {
      oldRevoked,
      newWorks,
      oldStatus,
      newStatus,
      recovery: [
        `Every ListMonk call from the consumers below fails until you:`,
        ...recreateSteps(
          listmonkBaseName(fresh.username),
          role,
          `writes that pair into every consumer that holds ${fresh.username} and deletes ${fresh.username} (id ${fresh.id}).`,
        ),
        ...(oldRevoked ? [] : [`  5. Then delete ${oldName} (id ${old.handle.userId}) in ListMonk → Admin → Users: it still exists.`]),
      ],
      // --resume swaps the dead pair for the keychain's working one.
      consumersHold: {
        values: { LISTMONK_API_USER: fresh.username, LISTMONK_API_TOKEN: fresh.token },
        handle: {
          url: s.url,
          userId: String(fresh.id),
          username: fresh.username,
          name: old.handle.name ?? fresh.username,
          userRoleId: old.handle.userRoleId ?? "",
          userRoleName: old.handle.userRoleName ?? "",
          listRoleId: old.handle.listRoleId ?? "",
        },
      },
    });
  },

  async finish(ctx) {
    const s = scratch(ctx);
    const lines: string[] = [];
    if (s.orphan) {
      lines.push(
        `Could not delete the old API user ${s.orphan.name} (id ${s.orphan.id}): ${s.orphan.error}. Its token no longer works; delete the user in ListMonk → Admin → Users.`,
      );
    }
    if (s.adopted && Number(s.adopted.id) !== s.revokedId && s.fresh) {
      lines.push(
        `Resumed with the keychain's pair ${s.fresh.username} (id ${s.fresh.id}), not ${s.adopted.username} (id ${s.adopted.id}) that the interrupted run created. If ${s.adopted.username} is still listed in ListMonk → Admin → Users and nothing uses it, delete it.`,
      );
    }
    if (!s.admin || !s.adminProfile) return lines;
    const name = s.adminProfile.username;
    if (!ctx.interactive || !(await promptYesNo(`Delete the one-off ListMonk admin user ${name} now?`, true))) {
      return [...lines, `Delete the one-off ListMonk admin user ${name} in ListMonk → Admin → Users.`];
    }
    try {
      await deleteListmonkUser(s.admin, s.adminProfile.id);
      lines.push(`Deleted the one-off ListMonk admin user ${name}.`);
    } catch (err) {
      return [
        ...lines,
        `Could not delete the one-off ListMonk admin user ${name} (${redactErrorMessage((err as Error).message)}). Delete it in ListMonk → Admin → Users.`,
      ];
    }
    // Deleting a user rebuilds ListMonk's API-user cache: check again.
    if (s.fresh && s.url) {
      const probe = await probeUntil({ url: s.url, apiUser: s.fresh.username, apiToken: s.fresh.token }, "accepted");
      if (probe.kind !== "accepted" || probe.profile.id !== s.fresh.id) {
        lines.push(
          `After deleting ${name}, ${s.fresh.username} (id ${s.fresh.id}) no longer authenticates (${probe.kind === "accepted" ? `answers as id ${probe.profile.id}` : probe.detail}). Check ListMonk → Admin → Users before redeploying.`,
        );
      }
    }
    return lines;
  },
};
