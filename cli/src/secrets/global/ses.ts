/*
 * cli/src/secrets/global/ses.ts — rotate hatchkit's global SES IAM key.
 *
 * One IAM user (`hatchkit-ses`) sends every project's mail. Its access
 * key id IS each project's SES_SMTP_USERNAME, and SES_SMTP_PASSWORD is
 * `deriveSesSmtpPassword(secret, region)`, so one key rotation changes
 * both values everywhere, plus ListMonk's own SMTP login.
 *
 * Flow: create a second access key (IAM allows two) → verify it with
 * `probeSes` and an SMTP AUTH that sends nothing → store it in the
 * keychain → fan out → deactivate the old key → delete it.
 *
 * IAM rights. As of 2026-09-29 `hatchkit-ses` has none
 * (`iam:ListAccessKeys` is denied). Two ways in:
 *   · attach SELF_ROTATE_POLICY (below) to the user — it can then
 *     rotate only its own keys, nothing else; or
 *   · paste a one-off admin access key when prompted. It stays in
 *     memory for this run and is never stored.
 */

import {
  CreateAccessKeyCommand,
  DeleteAccessKeyCommand,
  GetAccessKeyLastUsedCommand,
  IAMClient,
  ListAccessKeysCommand,
  UpdateAccessKeyCommand,
} from "@aws-sdk/client-iam";
import { getListmonkConfig, getSesConfig, getStore } from "../../config.js";
import { planListmonkSmtpSwap, swapListmonkSmtpCredentials } from "../../provision/listmonk.js";
import { type SesAuth, deriveSesSmtpPassword, probeSes } from "../../provision/ses.js";
import { SECRET_KEYS, setSecret } from "../../utils/secrets.js";
import { redactErrorMessage } from "../audit.js";
import type { NewCred, OldCred, VerifyOutcome } from "../types.js";
import { mask, promptOneOffInput, promptOneOffSecret } from "./prompt.js";
import { type SmtpAuthOptions, type SmtpAuthResult, checkSmtpAuth } from "./smtp-auth.js";
import type {
  ConsumerAuditEntry,
  GlobalPreflight,
  GlobalRotationContext,
  GlobalRotator,
} from "./types.js";

/** The inline policy that lets an IAM user rotate its own keys and do
 *  nothing else. `${aws:username}` resolves to the calling user. */
export const SELF_ROTATE_POLICY = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "RotateOwnAccessKeys",
      Effect: "Allow",
      Action: [
        "iam:CreateAccessKey",
        "iam:DeleteAccessKey",
        "iam:ListAccessKeys",
        "iam:UpdateAccessKey",
      ],
      Resource: "arn:aws:iam::*:user/${aws:username}",
    },
  ],
};

const DEFAULT_IAM_USER = "hatchkit-ses";

// ─── IAM operations (seam) ───────────────────────────────────────────

export interface IamAccessKey {
  id: string;
  status: string;
  userName?: string;
}

export interface IamOps {
  /** Omit `userName` to act on the calling user's own keys. */
  listKeys(userName?: string): Promise<IamAccessKey[]>;
  createKey(userName?: string): Promise<{ id: string; secret: string }>;
  setStatus(id: string, status: "Active" | "Inactive", userName?: string): Promise<void>;
  deleteKey(id: string, userName?: string): Promise<"deleted" | "not-found">;
  /** The IAM user that owns `id` (GetAccessKeyLastUsed). */
  ownerOf(id: string): Promise<string | undefined>;
}

interface AwsCreds {
  accessKeyId: string;
  secretAccessKey: string;
}

/** IamOps over the AWS SDK. `endpoint` exists for tests against a local
 *  mock of the IAM query API. */
export function createAwsIamOps(creds: AwsCreds, opts: { endpoint?: string } = {}): IamOps {
  const client = new IAMClient({
    region: "us-east-1",
    credentials: creds,
    ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
  });
  return {
    async listKeys(userName) {
      const res = await client.send(new ListAccessKeysCommand(userName ? { UserName: userName } : {}));
      return (res.AccessKeyMetadata ?? []).map((k) => ({
        id: k.AccessKeyId ?? "",
        status: k.Status ?? "",
        userName: k.UserName,
      }));
    },
    async createKey(userName) {
      const res = await client.send(new CreateAccessKeyCommand(userName ? { UserName: userName } : {}));
      const key = res.AccessKey;
      if (!key?.AccessKeyId || !key.SecretAccessKey) {
        throw new Error("IAM CreateAccessKey returned no key");
      }
      return { id: key.AccessKeyId, secret: key.SecretAccessKey };
    },
    async setStatus(id, status, userName) {
      await client.send(
        new UpdateAccessKeyCommand({
          AccessKeyId: id,
          Status: status,
          ...(userName ? { UserName: userName } : {}),
        }),
      );
    },
    async deleteKey(id, userName) {
      try {
        await client.send(
          new DeleteAccessKeyCommand({ AccessKeyId: id, ...(userName ? { UserName: userName } : {}) }),
        );
        return "deleted";
      } catch (err) {
        if ((err as { name?: string }).name === "NoSuchEntityException") return "not-found";
        throw err;
      }
    },
    async ownerOf(id) {
      const res = await client.send(new GetAccessKeyLastUsedCommand({ AccessKeyId: id }));
      return res.UserName;
    },
  };
}

interface SesDeps {
  iam(creds: AwsCreds): IamOps;
  probe(auth: SesAuth): Promise<unknown>;
  smtpAuth(opts: SmtpAuthOptions): Promise<SmtpAuthResult>;
  /** Attempts + delay for the post-create checks: a new IAM key takes a
   *  few seconds to work everywhere. */
  timing: { attempts: number; delayMs: number };
  /** Resolve the ListMonk the SMTP settings live on (null = none). */
  listmonk(): ReturnType<typeof getListmonkConfig>;
}

const defaultDeps: SesDeps = {
  iam: (creds) => createAwsIamOps(creds),
  probe: probeSes,
  smtpAuth: checkSmtpAuth,
  timing: { attempts: 8, delayMs: 5000 },
  listmonk: getListmonkConfig,
};
let deps: SesDeps = defaultDeps;

/** Test-only: replace IAM, probes, timing or the ListMonk lookup. */
export function __setSesRotationDepsForTesting(partial: Partial<SesDeps> | undefined): void {
  deps = partial ? { ...defaultDeps, ...partial } : defaultDeps;
}

// ─── Rotator ─────────────────────────────────────────────────────────

interface SesScratch {
  mode?: "self" | "admin";
  /** One-off admin key. Memory only. */
  admin?: AwsCreds;
  userName?: string;
  region?: string;
  oldKey?: AwsCreds;
  newKey?: AwsCreds;
}

function scratch(ctx: GlobalRotationContext): SesScratch {
  ctx.scratch.ses ??= {};
  return ctx.scratch.ses as SesScratch;
}

function isAccessDenied(err: unknown): boolean {
  const e = err as { name?: string; message?: string };
  return (
    e.name === "AccessDenied" ||
    e.name === "AccessDeniedException" ||
    /not authorized|AccessDenied/i.test(e.message ?? "")
  );
}

/** The ops that act on the SES user's keys: its own key in self mode,
 *  the one-off admin key otherwise. */
function managerOps(s: SesScratch, signWith?: AwsCreds): IamOps {
  if (s.mode === "admin" && s.admin) return deps.iam(s.admin);
  const creds = signWith ?? s.oldKey;
  if (!creds) throw new Error("SES rotation has no IAM credentials to sign with");
  return deps.iam(creds);
}

/** UserName argument: omitted in self mode (IAM uses the caller). */
function userArg(s: SesScratch): string | undefined {
  return s.mode === "admin" ? s.userName : undefined;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function remedy(userName: string): string[] {
  return [
    `IAM user ${userName} cannot manage its own access keys. Either:`,
    `  a) Attach this inline policy to ${userName} (IAM → Users → ${userName} → Add permissions → Create inline policy → JSON). It lets the user rotate only its own keys:`,
    ...JSON.stringify(SELF_ROTATE_POLICY, null, 2)
      .split("\n")
      .map((l) => `       ${l}`),
    "  b) Run this command in a terminal and paste a one-off admin access key when asked (needs iam:ListAccessKeys, iam:CreateAccessKey, iam:UpdateAccessKey, iam:DeleteAccessKey, iam:GetAccessKeyLastUsed on that user). It is used for this run only and never stored. Deactivate it afterwards if you created it just for this.",
  ];
}

function smtpHost(region: string): string {
  return `email-smtp.${region}.amazonaws.com`;
}

export const sesRotator: GlobalRotator = {
  name: "ses",
  label: "AWS SES IAM key (SES_SMTP_USERNAME / SES_SMTP_PASSWORD)",
  consumerKeys: ["SES_SMTP_USERNAME", "SES_SMTP_PASSWORD"],
  matchKey: "SES_SMTP_USERNAME",

  planNotes() {
    return [
      "IAM allows two access keys per user: the new key is created next to the current one. The old key is deactivated, then deleted, once every consumer holds the new pair.",
      "SES_SMTP_USERNAME is the access key id and SES_SMTP_PASSWORD derives from its secret, so both change in every consumer, and in ListMonk's SMTP settings.",
      "Running apps keep sending with the old pair until they redeploy. After the old key is deleted those sends fail, so push and redeploy right after the run.",
    ];
  },

  async preflight(ctx): Promise<GlobalPreflight> {
    const s = scratch(ctx);
    const cfg = await getSesConfig();
    if (!cfg) {
      return { ready: false, notes: [], remedy: ["SES is not configured. Run `hatchkit config add ses`."] };
    }
    s.region = cfg.region;
    s.oldKey = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };

    let keys: IamAccessKey[] | undefined;
    try {
      keys = await deps.iam(s.oldKey).listKeys();
      s.mode = "self";
      s.userName = keys.find((k) => k.id === cfg.accessKeyId)?.userName ?? keys[0]?.userName;
    } catch (err) {
      if (!isAccessDenied(err)) {
        return {
          ready: false,
          notes: [],
          remedy: [`IAM ListAccessKeys failed: ${redactErrorMessage((err as Error).message)}`],
        };
      }
    }

    if (!keys) {
      const who = s.userName ?? DEFAULT_IAM_USER;
      if (ctx.dryRun || !ctx.interactive) {
        return {
          ready: false,
          notes: [`The SES key ${mask(cfg.accessKeyId)} has no IAM rights over its own user.`],
          remedy: remedy(who),
        };
      }
      console.log("");
      for (const line of remedy(who)) console.log(`  ${line}`);
      console.log("");
      const accessKeyId = await promptOneOffInput("One-off admin AWS access key id");
      const secretAccessKey = await promptOneOffSecret("One-off admin AWS secret access key");
      s.admin = { accessKeyId, secretAccessKey };
      s.mode = "admin";
      const admin = deps.iam(s.admin);
      try {
        s.userName = (await admin.ownerOf(cfg.accessKeyId)) ?? DEFAULT_IAM_USER;
        keys = await admin.listKeys(s.userName);
      } catch (err) {
        return {
          ready: false,
          notes: [],
          remedy: [
            `The one-off admin key cannot manage ${s.userName ?? DEFAULT_IAM_USER}'s keys: ${redactErrorMessage((err as Error).message)}`,
          ],
        };
      }
    }

    const userName = s.userName ?? DEFAULT_IAM_USER;
    const notes = [
      `IAM user ${userName}, region ${cfg.region}. Rights: ${s.mode === "admin" ? "one-off admin key (this run only)" : "the user's own key (self-rotation policy)"}.`,
    ];
    // On --resume the keychain holds the new key and the old one is
    // still there: both are expected.
    const expected = new Set([cfg.accessKeyId, ctx.resumeOld?.handle.accessKeyId]);
    const others = keys.filter((k) => !expected.has(k.id));
    if (others.length > 0 && keys.length >= 2 && !ctx.resumeOld) {
      return {
        ready: false,
        notes,
        remedy: [
          `IAM user ${userName} already has two access keys, and IAM allows no third. The one hatchkit does not use is ${others.map((k) => `${mask(k.id)} (${k.status})`).join(", ")}. Delete it in IAM → Users → ${userName} → Security credentials if nothing else uses it, then retry.`,
        ],
      };
    }
    return { ready: true, notes };
  },

  async captureOld(ctx): Promise<OldCred> {
    const s = scratch(ctx);
    const cfg = await getSesConfig();
    if (!cfg) throw new Error("SES is not configured. Run `hatchkit config add ses`.");
    s.region = cfg.region;
    s.oldKey = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };
    return {
      values: {
        SES_SMTP_USERNAME: cfg.accessKeyId,
        SES_SMTP_PASSWORD: deriveSesSmtpPassword(cfg.secretAccessKey, cfg.region),
        // For a manual rollback before revoke: the keychain copy is
        // overwritten by commit. Never fanned out (not a consumer key).
        SES_IAM_SECRET_ACCESS_KEY: cfg.secretAccessKey,
      },
      handle: {
        accessKeyId: cfg.accessKeyId,
        region: cfg.region,
        ...(s.userName ? { userName: s.userName } : {}),
      },
    };
  },

  async createNew(ctx): Promise<NewCred> {
    const s = scratch(ctx);
    if (!s.region) throw new Error("SES rotation: captureOld did not run");
    const key = await managerOps(s).createKey(userArg(s));
    s.newKey = { accessKeyId: key.id, secretAccessKey: key.secret };
    return {
      values: {
        SES_SMTP_USERNAME: key.id,
        SES_SMTP_PASSWORD: deriveSesSmtpPassword(key.secret, s.region),
      },
      handle: { accessKeyId: key.id },
    };
  },

  async verify(ctx, fresh): Promise<VerifyOutcome> {
    const s = scratch(ctx);
    if (!s.newKey || !s.region) return "failed";
    const auth: SesAuth = { region: s.region, ...s.newKey };
    const { attempts, delayMs } = deps.timing;

    let apiOk = false;
    for (let i = 1; i <= attempts && !apiOk; i++) {
      try {
        await deps.probe(auth);
        apiOk = true;
      } catch {
        if (i < attempts) await sleep(delayMs);
      }
    }
    if (!apiOk) {
      console.error("  · ses verify: the new key could not call SES ListEmailIdentities");
      return "failed";
    }

    let last: SmtpAuthResult | undefined;
    for (let i = 1; i <= attempts; i++) {
      last = await deps.smtpAuth({
        host: smtpHost(s.region),
        port: 587,
        username: fresh.values.SES_SMTP_USERNAME,
        password: fresh.values.SES_SMTP_PASSWORD,
      });
      if (last.ok) return "ok";
      if (i < attempts) await sleep(delayMs);
    }
    if (last && !last.ok) {
      console.error(
        `  · ses verify: SMTP AUTH with the new pair failed at ${last.phase}${last.code ? ` (${last.code})` : ""}`,
      );
    }
    return "failed";
  },

  async discard(ctx, fresh) {
    const s = scratch(ctx);
    await managerOps(s).deleteKey(fresh.handle.accessKeyId, userArg(s));
  },

  async commit(ctx) {
    const s = scratch(ctx);
    if (!s.newKey) throw new Error("SES rotation: nothing to commit");
    await setSecret(SECRET_KEYS.sesAccessKeyId, s.newKey.accessKeyId);
    await setSecret(SECRET_KEYS.sesSecretAccessKey, s.newKey.secretAccessKey);
    getStore().set("providers.ses.lastVerified", new Date().toISOString());
  },

  async loadCommitted(ctx, newHandle): Promise<NewCred> {
    const s = scratch(ctx);
    const cfg = await getSesConfig();
    if (!cfg) throw new Error("SES is not configured. Run `hatchkit config add ses`.");
    if (newHandle.accessKeyId && newHandle.accessKeyId !== cfg.accessKeyId) {
      throw new Error(
        "The keychain's SES key is not the one the interrupted rotation created. Resolve by hand in IAM before resuming.",
      );
    }
    s.region = cfg.region;
    s.newKey = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };
    return {
      values: {
        SES_SMTP_USERNAME: cfg.accessKeyId,
        SES_SMTP_PASSWORD: deriveSesSmtpPassword(cfg.secretAccessKey, cfg.region),
      },
      handle: { accessKeyId: cfg.accessKeyId },
    };
  },

  async planServices(ctx): Promise<ConsumerAuditEntry[]> {
    const s = scratch(ctx);
    const base: ConsumerAuditEntry = {
      kind: "service",
      name: "ListMonk SMTP settings",
      keys: ["smtp[].username", "smtp[].password"],
      status: "planned",
    };
    const auth = await deps.listmonk();
    if (!auth) return [{ ...base, status: "skipped", reason: "ListMonk is not configured" }];
    // On --resume the keychain already holds the new key; the relay to
    // swap is the one still on the old key from the rollback blob.
    const oldId = ctx.resumeOld?.handle.accessKeyId ?? s.oldKey?.accessKeyId;
    if (!oldId) return [base];
    try {
      const plan = await planListmonkSmtpSwap(oldId, auth);
      if (plan.matched === 0) {
        return [{ ...base, status: "unchanged", reason: "no SMTP server logs in with the old key" }];
      }
      return [
        {
          ...base,
          reason: plan.blocked
            ? `needs a manual paste, so the old key will be held: ${plan.blocked}`
            : `${plan.matched} SMTP server(s) log in with the old key`,
        },
      ];
    } catch (err) {
      return [{ ...base, status: "skipped", reason: redactErrorMessage((err as Error).message) }];
    }
  },

  async updateServices(_ctx, old, fresh): Promise<ConsumerAuditEntry[]> {
    const base: ConsumerAuditEntry = {
      kind: "service",
      name: "ListMonk SMTP settings",
      keys: ["smtp[].username", "smtp[].password"],
      status: "updated",
    };
    const auth = await deps.listmonk();
    if (!auth) return [{ ...base, status: "skipped", reason: "ListMonk is not configured" }];
    try {
      const res = await swapListmonkSmtpCredentials(
        {
          oldUsername: old.values.SES_SMTP_USERNAME,
          username: fresh.values.SES_SMTP_USERNAME,
          password: fresh.values.SES_SMTP_PASSWORD,
        },
        auth,
        { reloadDelayMs: deps.timing.delayMs },
      );
      if (res.matched === 0) {
        return [{ ...base, status: "unchanged", reason: "no SMTP server logs in with the old key" }];
      }
      // Blocked: ListMonk still sends with the old key, so this must hold
      // the revoke until the operator pastes the new login by hand.
      if (!res.written) return [{ ...base, status: "failed", reason: res.reason }];
      return [
        {
          ...base,
          reason: `${res.matched} SMTP server(s) updated${res.needsRestart ? "; a campaign is running, so ListMonk applies it on its next restart" : ""}`,
        },
      ];
    } catch (err) {
      const msg = redactErrorMessage((err as Error).message);
      return [
        {
          ...base,
          status: "failed",
          reason: /permission denied|403/.test(msg)
            ? "the ListMonk API user lacks settings:manage; paste the new SMTP login in ListMonk → Settings → SMTP"
            : msg,
        },
      ];
    }
  },

  async revoke(ctx, old) {
    const s = scratch(ctx);
    const oldId = old.handle.accessKeyId;
    if (!oldId || oldId === s.newKey?.accessKeyId) return;
    // In self mode the NEW key signs: the old one is about to stop working.
    const ops = managerOps(s, s.newKey);
    try {
      await ops.setStatus(oldId, "Inactive", userArg(s));
    } catch (err) {
      if ((err as { name?: string }).name !== "NoSuchEntityException") throw err;
    }
    if (s.newKey && s.region) {
      await deps.probe({ region: s.region, ...s.newKey });
    }
    await ops.deleteKey(oldId, userArg(s));
  },

  async finish(ctx) {
    const s = scratch(ctx);
    return s.mode === "admin"
      ? ["The one-off admin AWS key was used for this run only. If you created it for this rotation, deactivate and delete it in IAM now."]
      : [];
  },
};
