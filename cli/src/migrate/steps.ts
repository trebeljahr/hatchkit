/*
 * migrate-domain — the executors.
 *
 * One function per planned action id. Every one of them is idempotent
 * and re-derives its own current state before writing, because the
 * whole command is designed to be run repeatedly: prepare today,
 * prepare again tomorrow when SES has finally verified, cutover next
 * week, cleanup the week after. A step that assumed it was running
 * once would break the second time.
 *
 * The cutover steps carry GATES. A gate is a live read (SES verified?
 * certificate issued?) that must pass before the pointer moves. It is
 * the difference between a migration that takes two commands and one
 * that takes email down for a day, so gates fail the step — recorded as
 * a resumable deferral — rather than warning and proceeding.
 *
 * Nothing here prompts. The orchestrator owns confirmation; these are
 * plain effectful functions so a `--yes` run and an interactive run
 * execute exactly the same code.
 */

import {
  getDefaultForwardingEmail,
  getDnsConfig,
  getListmonkConfig,
  getPersonalEmailLocalPart,
  getSesConfig,
} from "../config.js";
import { resolveCarriedForwarding } from "../email/presets.js";
import { probeEmailRouting, summarizeEmailRoutingProbe } from "../email/routing-access.js";
import { publishDnsRecordsToCloudflare } from "../provision/cloudflare-dns-publish.js";
import { sesSendingSubdomain } from "../provision/listmonk-ses.js";
import {
  type ListmonkAuth,
  getListmonkSettings,
  putListmonkSetting,
  waitForListmonk,
} from "../provision/listmonk.js";
import {
  accountIdFromR2Endpoint,
  defaultBucketHostname,
  detectEnvPrefix,
  envKeysForPrefix,
  existingCustomHostname,
  reconcileAssetsCorsFromManifest,
} from "../provision/s3-buckets.js";
import {
  type ManualNotificationTopic,
  SES_FEEDBACK_TYPES,
  type SesFeedbackAws,
  type SesFeedbackListmonk,
  type SesFeedbackType,
  copyIdentityNotificationTopics,
  createSesFeedbackAws,
  createSesFeedbackListmonk,
  ensureSesFeedback,
  getNotificationAttributesCommand,
  renderCopyTopicsLines,
  renderSesFeedbackLines,
  setNotificationTopicCommand,
} from "../provision/ses-feedback.js";
import {
  SES_MAIL_FROM_SPF,
  type SesAuth,
  createSesDomain,
  deleteSesDomain,
  getSesDomain,
  sesMailFromMxTarget,
  sesMailFromSubdomain,
  setSesMailFromDomain,
} from "../provision/ses.js";
import { type ProjectManifest, readManifest, writeManifest } from "../scaffold/manifest.js";
import { CloudflareApi } from "../utils/cloudflare-api.js";
import { SECRET_KEYS, getSecret } from "../utils/secrets.js";
import { readSesFromEnv, rewriteFromAddress, rewriteSesFromEnv } from "./ses-env.js";

// ---------------------------------------------------------------------------
// Step contract
// ---------------------------------------------------------------------------

export interface StepContext {
  /** Repo root holding `.hatchkit.json`. */
  projectDir: string;
  /** Monorepo root — where `infra/` lives. */
  monorepoRoot: string;
  oldDomain: string;
  newDomain: string;
}

export type StepStatus =
  /** The step changed something. */
  | "done"
  /** Nothing to change — already in the target state. */
  | "skipped"
  /** A precondition isn't met yet. Recoverable: re-run later. */
  | "gated";

export interface StepOutcome {
  status: StepStatus;
  message: string;
  detail?: string[];
  /** Work left for the operator after the step itself went through. */
  followUp?: StepFollowUp;
}

/** Something a step could not do with the credentials it has, such as
 *  an AWS call the IAM user may not make. The orchestrator prints it and
 *  records it under `deferred[]`, with `commands` as the way home. */
export interface StepFollowUp {
  reason: string;
  commands: string[];
}

export type StepFn = (ctx: StepContext) => Promise<StepOutcome>;

/** Read the manifest fresh. Steps mutate it (and `rename-domain`
 *  rewrites it wholesale), so holding one across steps would write back
 *  a stale document and silently drop an earlier step's changes. */
function manifestOf(ctx: StepContext): ProjectManifest {
  const manifest = readManifest(ctx.projectDir);
  if (!manifest) throw new Error(`No .hatchkit.json in ${ctx.projectDir}.`);
  return manifest;
}

/** The old web origin, for as long as the old site is still live.
 *  Every CORS reconcile before cleanup keeps it on the assets bucket:
 *  prepare rewrites `manifest.domain`, and the desired origin set is
 *  derived from that field, so without this the old site would lose
 *  its assets days before cutover. Cleanup removes it. */
export function transitionalCorsOrigins(
  ctx: Pick<StepContext, "oldDomain" | "newDomain">,
): string[] {
  const oldDomain = ctx.oldDomain.trim().toLowerCase();
  if (!oldDomain || oldDomain === ctx.newDomain.trim().toLowerCase()) return [];
  return [`https://${oldDomain}`];
}

async function cloudflareForDns(): Promise<CloudflareApi> {
  const dns = await getDnsConfig();
  if (!dns?.apiToken) {
    throw new Error("Cloudflare DNS not configured. Run `hatchkit config add dns` first.");
  }
  return new CloudflareApi({ token: dns.apiToken, accountId: dns.accountId });
}

async function sesAuth(): Promise<SesAuth> {
  const cfg = await getSesConfig();
  if (!cfg) throw new Error("SES not configured. Run `hatchkit config add ses` first.");
  return {
    region: cfg.region,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
  };
}

// ---------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------

/** Delegate the whole local-file rewrite to `rename-domain`. It already
 *  owns the list of files that hard-code the domain and keeps it in
 *  sync with the scaffold templates; a second copy here would drift the
 *  first time a template grew a new URL. */
export const stepFilesRewrite: StepFn = async (ctx) => {
  const { runRenameDomain } = await import("../deploy/rename-domain.js");
  await runRenameDomain({
    projectDir: ctx.projectDir,
    monorepoRoot: ctx.monorepoRoot,
    newDomain: ctx.newDomain,
    yes: true,
    // prepare is additive: the old site is still live, so its origin
    // stays on the bucket's CORS rule until cleanup.
    keepCorsOrigins: transitionalCorsOrigins(ctx),
  });
  return { status: "done", message: `local files rewritten to ${ctx.newDomain}` };
};

// ---------------------------------------------------------------------------
// dns / coolify — both delegate to their existing reconcilers
// ---------------------------------------------------------------------------

export const stepDnsPublish: StepFn = async (ctx) => {
  const { runDnsPublish } = await import("../dns.js");
  await runDnsPublish({ projectDir: ctx.projectDir, dryRun: false });
  return { status: "done", message: "A/AAAA records published for every manifest hostname" };
};

export const stepCoolifySync: StepFn = async (ctx) => {
  const { runSync } = await import("../deploy/sync.js");
  await runSync({ projectDir: ctx.projectDir });
  return {
    status: "done",
    message: "Coolify routing updated",
    detail: [
      "rebuild the client image before calling this done — NEXT_PUBLIC_* URLs",
      "are baked into the browser bundle at image-build time, so the running",
      `container still points browsers at ${ctx.oldDomain} until it is rebuilt`,
    ],
  };
};

// ---------------------------------------------------------------------------
// SES
// ---------------------------------------------------------------------------

/** The identities the project sent from before this migration, recorded
 *  one first. Cutover rewrites `manifest.ses`, so after it only the old
 *  domain (`--from`) still names the old identity. Never includes the
 *  new identity. */
export function previousIdentities(
  manifest: Pick<ProjectManifest, "ses">,
  ctx: Pick<StepContext, "oldDomain" | "newDomain">,
): string[] {
  const next = sesSendingSubdomain(ctx.newDomain).toLowerCase();
  const out: string[] = [];
  for (const id of [manifest.ses?.identity, sesSendingSubdomain(ctx.oldDomain)]) {
    const name = id?.trim().toLowerCase();
    if (name && name !== next && !out.includes(name)) out.push(name);
  }
  return out;
}

export interface CarrySesFeedbackOptions {
  aws: SesFeedbackAws;
  region: string;
  /** The identity the project sent from until now. Null: nothing to copy. */
  oldIdentity: string | null;
  newIdentity: string;
  /** Null when Listmonk is not configured on this machine. */
  listmonk: { url: string; port: SesFeedbackListmonk } | null;
  confirmTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface CarrySesFeedbackResult {
  /** Whether anything was written. */
  changed: boolean;
  detail: string[];
  followUp?: StepFollowUp;
}

/**
 * Bounce + complaint routing for the new identity, before it sends.
 *
 * First the old identity's Bounce and Complaint topics are copied, so
 * the new identity reports wherever the old one did: the shared
 * `ses-feedback-listmonk` topic on a Hatchkit account, or a topic an
 * operator set by hand. Then, when Listmonk is configured here,
 * `ensureSesFeedback` routes any type still unset to the shared topic
 * and checks the subscription, account suppression and Listmonk bounce
 * settings that every project shares.
 *
 * Never throws. What IAM refused comes back as `followUp` with the
 * exact AWS CLI commands, one per type. When both halves wanted the same
 * type, the old identity's topic wins.
 */
export async function carrySesFeedback(
  opts: CarrySesFeedbackOptions,
): Promise<CarrySesFeedbackResult> {
  const detail: string[] = [];
  const manual: ManualNotificationTopic[] = [];
  const text = (line: { text: string }) => line.text.replace(/^[✓·] /, "");
  let changed = false;
  let copyReadDenied = false;
  // Types that have a topic, or will once the operator runs a command.
  const covered = new Set<SesFeedbackType>();

  if (opts.oldIdentity) {
    const copy = await copyIdentityNotificationTopics(opts.aws, opts.oldIdentity, opts.newIdentity);
    detail.push(...renderCopyTopicsLines(copy).map(text));
    manual.push(...copy.manualTopics);
    copyReadDenied = copy.readDenied;
    changed ||= copy.copied.length > 0;
    for (const t of [
      ...copy.copied.map((c) => c.type),
      ...copy.unchanged,
      ...copy.conflicts.map((c) => c.type),
      ...copy.manualTopics.map((m) => m.type),
    ]) {
      covered.add(t);
    }
  }

  if (opts.listmonk) {
    const feedback = await ensureSesFeedback({
      identity: opts.newIdentity,
      listmonkUrl: opts.listmonk.url,
      aws: opts.aws,
      listmonk: opts.listmonk.port,
      region: opts.region,
      confirmTimeoutMs: opts.confirmTimeoutMs,
      pollIntervalMs: opts.pollIntervalMs,
    });
    // Its commands go out once, below, merged with the copy's.
    detail.push(...renderSesFeedbackLines({ ...feedback, manualTopics: [] }).map(text));
    for (const t of feedback.manualTopics) {
      if (!manual.some((m) => m.identity === t.identity && m.type === t.type)) manual.push(t);
    }
    changed ||=
      feedback.typesSetThisRun.length > 0 ||
      feedback.subscribedThisRun ||
      feedback.suppressionAdded.length > 0 ||
      feedback.listmonkSettingsWritten.length > 0;
  } else {
    const missing = SES_FEEDBACK_TYPES.filter((t) => !covered.has(t));
    if (missing.length > 0 && !copyReadDenied) {
      detail.push(
        `${opts.newIdentity} routes no ${missing.join(" or ")} notifications: Listmonk is not configured here, so the shared topic was not checked (\`hatchkit config add listmonk\`, then re-run)`,
      );
    }
  }

  const commands = manual.map((t) => setNotificationTopicCommand(t, opts.region));
  // The old identity's topics could not be read and nothing above
  // produced a command for every type: start with the read.
  const readFirst =
    copyReadDenied && opts.oldIdentity !== null && manual.length < SES_FEEDBACK_TYPES.length;
  if (readFirst && opts.oldIdentity) {
    commands.unshift(getNotificationAttributesCommand([opts.oldIdentity], opts.region));
  }
  if (commands.length === 0) return { changed, detail };

  const reasons: string[] = [];
  if (manual.length > 0) {
    reasons.push(
      `the SES IAM user may not set ${opts.newIdentity}'s notification topics; run the set commands with a profile that has ses:SetIdentityNotificationTopic`,
    );
  }
  if (readFirst) {
    reasons.push(
      `could not read ${opts.oldIdentity}'s notification topics; give ${opts.newIdentity} the same Bounce and Complaint topic ARNs`,
    );
  }
  return { changed, detail, followUp: { reason: reasons.join("; "), commands } };
}

/** `carrySesFeedback` against the real AWS account and Listmonk. A
 *  Listmonk credential that can't be read counts as not configured: it
 *  must not stop the SES cutover. */
async function carrySesFeedbackLive(
  auth: SesAuth,
  oldIdentity: string | null,
  newIdentity: string,
): Promise<CarrySesFeedbackResult> {
  let listmonk: Awaited<ReturnType<typeof getListmonkConfig>> = null;
  let listmonkError: string | null = null;
  try {
    listmonk = await getListmonkConfig();
  } catch (err) {
    listmonkError = (err as Error).message.split("\n")[0];
  }
  const result = await carrySesFeedback({
    aws: createSesFeedbackAws(auth),
    region: auth.region,
    oldIdentity,
    newIdentity,
    listmonk: listmonk ? { url: listmonk.url, port: createSesFeedbackListmonk(listmonk) } : null,
  });
  if (listmonkError) result.detail.unshift(`Listmonk config unreadable: ${listmonkError}`);
  return result;
}

/**
 * Stand up `mail.<new>` next to `mail.<old>`.
 *
 * Two identities coexist happily — SES scopes DKIM keys and the MAIL
 * FROM attribute per identity, and nothing about creating one affects
 * the other. That is what makes this safe to run long before cutover.
 *
 * Order matters within the step: create the identity FIRST (that call
 * is what mints the DKIM tokens), publish the CNAMEs, then set MAIL
 * FROM and publish its MX + SPF. Setting MAIL FROM before the records
 * exist is legal but parks the attribute in PENDING until SES next
 * polls, which just makes the status output confusing. Last, the new
 * identity gets the old one's Bounce + Complaint notification topics
 * (see `carrySesFeedback`). SES documents that call for a verified
 * identity, so cutover runs it again behind its verification gate.
 */
export const stepSesPrepare: StepFn = async (ctx) => {
  const manifest = manifestOf(ctx);
  const auth = await sesAuth();
  const cf = await cloudflareForDns();

  const identityName = sesSendingSubdomain(ctx.newDomain);
  const label = manifest.ses?.mailFromLabel ?? "bounce";
  const behavior = manifest.ses?.mailFromBehaviorOnMxFailure ?? "UseDefaultValue";
  const mailFrom = sesMailFromSubdomain(identityName, label);

  const identity = await createSesDomain(identityName, auth);
  const detail: string[] = [];

  if (identity.dkimRecords.length > 0) {
    const res = await publishDnsRecordsToCloudflare(
      identity.dkimRecords.map((r) => ({
        type: r.type,
        name: r.name,
        value: r.value,
        label: "DKIM",
      })),
      { cf, domain: identityName, logTag: "SES" },
    );
    detail.push(
      `DKIM: ${res.created} created, ${res.updated} updated, ${res.unchanged} unchanged in ${res.zoneName}`,
    );
  }

  await setSesMailFromDomain(identityName, mailFrom, behavior, auth);
  const mailFromRes = await publishDnsRecordsToCloudflare(
    [
      {
        type: "MX",
        name: mailFrom,
        value: sesMailFromMxTarget(auth.region),
        priority: 10,
        label: "MAIL-FROM",
      },
      { type: "TXT", name: mailFrom, value: SES_MAIL_FROM_SPF, label: "MAIL-FROM-SPF" },
    ],
    { cf, domain: identityName, logTag: "MAIL-FROM" },
  );
  detail.push(
    `MAIL FROM ${mailFrom}: ${mailFromRes.created} created, ${mailFromRes.updated} updated`,
  );

  // Bounce + complaint routing, copied from the identity this one
  // replaces. Failures (usually IAM) come back as detail lines and a
  // follow-up, not a failed step.
  const [oldIdentity = null] = previousIdentities(manifest, ctx);
  const feedback = await carrySesFeedbackLive(auth, oldIdentity, identityName);
  detail.push(...feedback.detail);

  const verified = identity.verifiedForSendingStatus === true;
  detail.push(
    verified
      ? "identity already verified — cutover can run now"
      : "AWS verifies DKIM on its own schedule (minutes to a few hours); " +
          "cutover stays gated until it does, then checks the notification topics again",
  );
  return {
    status: "done",
    message: `SES identity ${identityName} created (${manifest.ses?.identity ?? "none"} still sending)`,
    detail,
    followUp: feedback.followUp,
  };
};

/**
 * The FROM switch. Gated on the new identity being verified, because
 * SES does not soft-fail a send from an unverified identity — it
 * rejects the message. Recording an identity the account cannot send
 * from would turn every transactional email into a hard bounce.
 *
 * Before anything moves, the new identity's notification topics are
 * checked again: this is the moment it starts sending, and prepare may
 * have run before SES would take the topics. On a healthy setup that
 * check only reads.
 */
export const stepSesCutover: StepFn = async (ctx) => {
  const manifest = manifestOf(ctx);
  const auth = await sesAuth();
  const identityName = sesSendingSubdomain(ctx.newDomain);
  const oldIdentity = sesSendingSubdomain(ctx.oldDomain);

  // Gate both branches: a manifest that already records the new
  // identity may have been hand-edited, and pointing the env at an
  // identity SES won't send from is the outage this gate exists for.
  const identity = await getSesDomain(identityName, auth);
  if (identity.verifiedForSendingStatus !== true) {
    return {
      status: "gated",
      message: `SES has not verified ${identityName} yet`,
      detail: [
        "AWS is still waiting on the DKIM CNAMEs. Nothing is broken — the old",
        "identity keeps sending. Re-run this phase once it flips.",
        `check with: hatchkit doctor  (or the SES console, region ${auth.region})`,
      ],
    };
  }

  const [feedbackSource = null] = previousIdentities(manifest, ctx);
  const feedback = await carrySesFeedbackLive(auth, feedbackSource, identityName);

  if (manifest.ses?.identity === identityName) {
    // The manifest moved on an earlier run, but the env files are what
    // the app actually sends from — and older hatchkit versions moved
    // only the manifest. Re-check them. Unreadable (encrypted, no key
    // here) entries are left alone: this is a re-run, and writing a
    // recomputed default every time would churn committed ciphertext.
    const env = await rewriteSesFromEnv({
      projectDir: ctx.projectDir,
      projectName: manifest.name,
      prevIdentity: oldIdentity,
      newIdentity: identityName,
      defaultsWhenUnreadable: false,
    });
    return {
      status: env.rewritten.length > 0 || feedback.changed ? "done" : "skipped",
      message:
        env.rewritten.length > 0
          ? `manifest already records ${identityName}; moved ${env.rewritten.length} env from-address entr${env.rewritten.length === 1 ? "y" : "ies"}`
          : `manifest already records ${identityName}`,
      detail: [...env.detail, ...feedback.detail],
      followUp: feedback.followUp,
    };
  }

  const label = manifest.ses?.mailFromLabel ?? "bounce";
  const behavior = manifest.ses?.mailFromBehaviorOnMxFailure ?? "UseDefaultValue";
  const mailFrom = sesMailFromSubdomain(identityName, label);
  const previous = manifest.ses?.identity ?? "(none)";

  // Env first. It is what the running app sends from, and if the
  // rewrite fails the manifest must not already claim the move — a
  // re-run would then take the "already recorded" branch above and
  // report success over env files that still name the old identity.
  const env = await rewriteSesFromEnv({
    projectDir: ctx.projectDir,
    projectName: manifest.name,
    prevIdentity: manifest.ses?.identity ?? oldIdentity,
    newIdentity: identityName,
    // First cutover: an entry we can't decrypt was written by
    // provisioning as exactly this default, so recomputing it is safe.
    defaultsWhenUnreadable: true,
  });

  writeManifest(ctx.projectDir, {
    ...manifest,
    ses: {
      identity: identityName,
      mailFromDomain: mailFrom,
      mailFromLabel: label,
      mailFromBehaviorOnMxFailure: behavior,
      mailFromManagedDnsRecords: [
        { type: "MX", name: mailFrom, value: sesMailFromMxTarget(auth.region), priority: 10 },
        { type: "TXT", name: mailFrom, value: SES_MAIL_FROM_SPF },
      ],
    },
  });

  const detail =
    env.detail.length > 0
      ? env.detail
      : [
          "no SES_FROM_EMAIL / LISTMONK_FROM in .env.production or .env.development —",
          `set the app's from-address to an @${identityName} address yourself`,
        ];
  if (env.rewritten.length > 0) {
    detail.push("run `hatchkit sync` (or redeploy) so the running app picks up the new env");
  }
  detail.push(...feedback.detail);
  return {
    status: "done",
    message: `sending identity ${previous} → ${identityName}`,
    detail,
    followUp: feedback.followUp,
  };
};

/**
 * Retire `mail.<old>`.
 *
 * DKIM tokens are read back from SES BEFORE the identity is deleted —
 * deleting it first would leave the three `<token>._domainkey.<old>`
 * CNAMEs in the zone with no way left to compute their names. The MAIL
 * FROM rows are recomputed from the old identity name rather than read
 * from the manifest, because cutover has already overwritten the
 * manifest's `ses` block with the new identity's records.
 */
export const stepSesRetire: StepFn = async (ctx) => {
  const manifest = manifestOf(ctx);
  const auth = await sesAuth();
  const oldIdentity = sesSendingSubdomain(ctx.oldDomain);
  const detail: string[] = [];

  // Deleting the identity the app still sends from turns every email
  // into an SES rejection. Refuse while any readable from-address entry
  // names it; the SES cutover step is what moves them.
  const stillOld = (await readSesFromEnv(ctx.projectDir, manifest.name)).filter(
    (e) => e.value !== null && rewriteFromAddress(e.value, oldIdentity, oldIdentity) !== null,
  );
  if (stillOld.length > 0) {
    return {
      status: "gated",
      message: `the app still sends from @${oldIdentity}`,
      detail: [
        ...stillOld.map((e) => `${e.relPath} ${e.key} = ${e.value}`),
        `move them first: hatchkit migrate-domain --to ${ctx.newDomain} --from ${ctx.oldDomain} --phase cutover --only ses`,
      ],
    };
  }

  let dkimNames: string[] = [];
  try {
    const identity = await getSesDomain(oldIdentity, auth);
    dkimNames = identity.dkimRecords.map((r) => r.name);
  } catch (err) {
    if ((err as { name?: string }).name !== "NotFoundException") throw err;
    return { status: "skipped", message: `SES identity ${oldIdentity} is already gone` };
  }

  // DNS first: once the identity is deleted the token names are
  // unrecoverable, and orphan CNAMEs in a zone are the kind of thing
  // nobody ever goes back for.
  try {
    const cf = await cloudflareForDns();
    const mailFrom = sesMailFromSubdomain(oldIdentity, "bounce");
    const names = [...dkimNames, mailFrom];
    let removed = 0;
    for (const name of names) {
      const zone = await cf.resolveZoneForName(name);
      if (!zone) continue;
      const records = await cf.findRecordsByName(zone.id, name);
      for (const record of records) {
        // Only pull rows that are unmistakably SES's. A TXT at the
        // MAIL FROM name could be a merged SPF the user also owns.
        const isSesRow =
          (record.type === "CNAME" && record.content.endsWith(".dkim.amazonses.com")) ||
          (record.type === "MX" && record.content.includes("feedback-smtp.")) ||
          (record.type === "TXT" && record.content.replace(/^"|"$/g, "") === SES_MAIL_FROM_SPF);
        if (!isSesRow) continue;
        await cf.deleteRecord(zone.id, record.id);
        removed += 1;
      }
    }
    detail.push(`removed ${removed} SES DNS record(s) under ${ctx.oldDomain}`);
  } catch (err) {
    detail.push(`DNS cleanup skipped: ${(err as Error).message.split("\n")[0]}`);
  }

  const result = await deleteSesDomain(oldIdentity, auth);
  return {
    status: result === "deleted" ? "done" : "skipped",
    message:
      result === "deleted"
        ? `deleted SES identity ${oldIdentity}`
        : `SES identity ${oldIdentity} was already gone`,
    detail,
  };
};

// ---------------------------------------------------------------------------
// Email Routing (inbound)
// ---------------------------------------------------------------------------

/** Local parts with a literal forwarding rule on `domain` — i.e. what the
 *  operator chose to forward on the old domain. Null when it can't be
 *  read; the caller then falls back to the defaults. */
async function forwardedLocalParts(cf: CloudflareApi, domain: string): Promise<string[] | null> {
  try {
    const zone = await cf.resolveZoneForName(domain);
    if (!zone) return null;
    const suffix = `@${domain.trim().toLowerCase()}`;
    const rules = await cf.listEmailRoutingRules(zone.id);
    return rules.flatMap((r) =>
      (r.matchers ?? [])
        .filter((m) => m.type === "literal" && m.field === "to" && m.value)
        .map((m) => (m.value as string).toLowerCase())
        .filter((to) => to.endsWith(suffix))
        .map((to) => to.slice(0, -suffix.length)),
    );
  } catch {
    return null;
  }
}

/**
 * `hatchkit email setup`, non-interactively, for the new domain.
 *
 * Re-probes before writing: the plan may be minutes old, and the two
 * cases that must stop it — another provider's MX on the new domain, a
 * token without the Email Routing scopes — are both live facts. A scope
 * failure throws {@link EmailRoutingScopeError}, whose `hint` names the
 * exact permissions; the orchestrator prints it and records a deferral.
 */
export const stepEmailRoutingSetup: StepFn = async (ctx) => {
  const manifest = manifestOf(ctx);
  const dns = await getDnsConfig();
  if (!dns?.apiToken) {
    throw new Error("Cloudflare DNS not configured. Run `hatchkit config add dns` first.");
  }
  const cf = new CloudflareApi({ token: dns.apiToken, accountId: dns.accountId });

  const probe = await probeEmailRouting(cf, ctx.newDomain, { accountId: dns.accountId });
  if (probe.access === "no-zone") {
    return {
      status: "gated",
      message: `no Cloudflare zone covers ${ctx.newDomain}`,
      detail: ["add the zone in the Cloudflare dashboard first, then re-run this phase"],
    };
  }
  if (probe.access === "unauthorized") throw probe.error;

  const facts = summarizeEmailRoutingProbe(probe);
  if (facts.state === "foreign-mx") {
    return {
      status: "skipped",
      message: `inbound mail for ${ctx.newDomain} already goes to ${facts.mxHosts.join(", ")}`,
      detail: ["left alone — Cloudflare MX beside another provider's would split delivery"],
    };
  }

  const recorded = manifest.integrations?.email;
  const destination = recorded?.destinationEmail ?? getDefaultForwardingEmail();
  if (!destination) {
    return {
      status: "gated",
      message: "no forwarding destination saved on this machine",
      detail: [
        "save one under Defaults in `hatchkit setup` (Default forwarding email),",
        `or run \`hatchkit email setup --domain ${ctx.newDomain} --to <you@example.com>\``,
      ],
    };
  }

  const forwarding = resolveCarriedForwarding({
    recorded,
    oldDomainLocalParts:
      recorded?.addresses === undefined ? await forwardedLocalParts(cf, ctx.oldDomain) : null,
    personalLocalPart: getPersonalEmailLocalPart(),
  });

  const { detectExtraSpfIncludes } = await import("../email/index.js");
  const { runEmailSetup } = await import("../email/setup.js");
  const result = await runEmailSetup({
    token: dns.apiToken,
    accountId: probe.accountId,
    domain: ctx.newDomain,
    destination,
    addresses: forwarding.addresses,
    catchAll: forwarding.catchAll,
    extraSpfIncludes: await detectExtraSpfIncludes(dns.apiToken, probe.zone.id, ctx.newDomain),
    // Additive: a DMARC policy already on the new zone is someone's choice.
    preserveExistingDmarc: true,
  });

  // Re-read: runEmailSetup is slow, and the manifest is shared state.
  const fresh = manifestOf(ctx);
  writeManifest(ctx.projectDir, {
    ...fresh,
    integrations: {
      ...fresh.integrations,
      email: {
        domain: result.domain,
        configuredAt: new Date().toISOString(),
        destinationEmail: result.destination.record.email,
        addresses: forwarding.addresses,
        catchAll: forwarding.catchAll,
      },
    },
  });

  const changed =
    result.routingEnabledThisRun ||
    result.destination.createdThisRun ||
    result.dnsRecords.some((r) => r.created || r.updated) ||
    result.rules.some((r) => r.created || r.updated) ||
    result.catchAll?.changed === true;
  const sourceNote: Record<typeof forwarding.source, string> = {
    manifest: "as recorded in .hatchkit.json",
    "old-domain-rules": `carried over from @${ctx.oldDomain}`,
    defaults: "default presets",
  };
  const detail = [
    `rules: ${forwarding.addresses.length > 0 ? forwarding.addresses.map((a) => `${a}@`).join(", ") : "(none)"} (${sourceNote[forwarding.source]}); catch-all ${forwarding.catchAll ? "on" : "off"}`,
    `MX/SPF/DMARC: ${result.dnsRecords.filter((r) => r.created).length} created, ${result.dnsRecords.filter((r) => r.updated).length} updated`,
  ];
  if (result.destination.verified !== "active") {
    detail.push(
      `${result.destination.record.email} must click Cloudflare's verification email before forwards deliver`,
    );
  }
  return {
    status: changed ? "done" : "skipped",
    message: changed
      ? `mail to @${ctx.newDomain} now forwards to ${destination}`
      : `Email Routing for ${ctx.newDomain} was already in place`,
    detail,
  };
};

// ---------------------------------------------------------------------------
// Listmonk
// ---------------------------------------------------------------------------

/** Listmonk's instance-wide default sender, `app.from_email`. */
export interface ListmonkSenderPort {
  /** Null when unset. */
  getFromEmail(): Promise<string | null>;
  setFromEmail(value: string): Promise<void>;
}

/**
 * Move Listmonk's default sender off this project's old identity, and
 * only off that.
 *
 * One Listmonk serves every project, so `app.from_email` belongs to no
 * single one of them: it sends Listmonk's own mail (opt-in
 * confirmations, notifications) and any campaign or tx call that names
 * no sender. This project's mail doesn't depend on it, because the
 * starter passes `from_email` (LISTMONK_FROM) on every call and the SES
 * cutover moves that. The one case this project must handle is a
 * default sender on its OLD identity: after cleanup deletes that
 * identity, SES rejects everything Listmonk sends from it. Any other
 * value is another sender's and is left alone.
 *
 * The rewrite swaps only the domain, so the display name and local part
 * the operator chose survive. The SES gate is read only when there is
 * something to move.
 */
export async function moveListmonkDefaultSender(opts: {
  listmonk: ListmonkSenderPort;
  /** From `previousIdentities`. */
  oldIdentities: string[];
  newIdentity: string;
  /** Live SES check that the new identity may send. */
  isVerified: () => Promise<boolean>;
}): Promise<StepOutcome> {
  const current = await opts.listmonk.getFromEmail();
  if (!current) {
    return { status: "skipped", message: "Listmonk has no default sender set, so nothing to move" };
  }

  let next: string | null = null;
  let from: string | undefined;
  for (const old of opts.oldIdentities) {
    next = rewriteFromAddress(current, old, opts.newIdentity);
    if (next !== null) {
      from = old;
      break;
    }
  }

  if (next === null || from === undefined) {
    if (current.toLowerCase().includes(`@${opts.newIdentity.toLowerCase()}`)) {
      return { status: "skipped", message: `Listmonk default sender already ${current}` };
    }
    return {
      status: "skipped",
      message: `Listmonk default sender is ${current}: not this project's old identity, left alone`,
      detail: [
        "one Listmonk serves every project, so only a sender on " +
          (opts.oldIdentities.map((i) => `@${i}`).join(" or ") || "the old identity") +
          " is moved",
        "this app sends with LISTMONK_FROM on every call; the SES cutover moves that",
      ],
    };
  }

  if (!(await opts.isVerified())) {
    return {
      status: "gated",
      message: `SES has not verified ${opts.newIdentity}, so Listmonk's default sender stays ${current}`,
    };
  }

  await opts.listmonk.setFromEmail(next);
  return {
    status: "done",
    message: `Listmonk default sender ${current} → ${next}`,
    detail: [`it sent from @${from}, the identity this project is leaving`],
  };
}

/** `app.from_email` through Listmonk's per-key `PUT /api/settings/<key>`.
 *  Not the whole-document PUT: that sends back the masked SMTP passwords
 *  `GET /api/settings` returns, and every project sends through them. */
function listmonkSenderPort(auth: ListmonkAuth): ListmonkSenderPort {
  return {
    async getFromEmail() {
      await waitForListmonk(auth);
      const value = (await getListmonkSettings(auth))["app.from_email"];
      return typeof value === "string" && value.trim() ? value : null;
    },
    async setFromEmail(value) {
      try {
        await putListmonkSetting("app.from_email", value, auth);
      } catch (err) {
        if (/HTTP (404|405)/.test((err as Error).message)) {
          throw new Error(
            `Listmonk has no per-key settings endpoint (needs v6+). Set Settings → General → Default 'from' email to "${value}" by hand.`,
          );
        }
        throw err;
      }
      await waitForListmonk(auth, { initialDelayMs: 500 });
    },
  };
}

/** Move `app.from_email` when it names this project's old identity. The
 *  write is gated on the same SES verification as the identity switch. */
export const stepListmonkFrom: StepFn = async (ctx) => {
  const manifest = manifestOf(ctx);
  const listmonk = await getListmonkConfig();
  if (!listmonk) {
    return { status: "gated", message: "Listmonk not configured on this machine" };
  }
  const newIdentity = sesSendingSubdomain(ctx.newDomain);
  return moveListmonkDefaultSender({
    listmonk: listmonkSenderPort(listmonk),
    oldIdentities: previousIdentities(manifest, ctx),
    newIdentity,
    isVerified: async () =>
      (await getSesDomain(newIdentity, await sesAuth())).verifiedForSendingStatus === true,
  });
};

// ---------------------------------------------------------------------------
// R2
// ---------------------------------------------------------------------------

interface R2Context {
  cf: CloudflareApi;
  accountId: string;
  bucket: string;
}

async function r2Context(manifest: ProjectManifest): Promise<R2Context> {
  const bucket = manifest.s3Buckets?.assets?.name;
  if (!bucket) throw new Error("Manifest records no assets bucket.");

  const adminToken = await getSecret(SECRET_KEYS.r2AdminToken);
  if (!adminToken) {
    throw new Error("R2 admin token not in the keychain. Run `hatchkit config add s3 r2`.");
  }

  let accountId = manifest.s3Buckets?.accountId;
  if (!accountId) {
    const { getStore } = await import("../config.js");
    const meta = getStore().get("providers.s3.r2") as { endpoint?: string } | undefined;
    if (meta?.endpoint) accountId = accountIdFromR2Endpoint(meta.endpoint);
  }
  if (!accountId) throw new Error("Could not determine the Cloudflare account id for R2.");

  return { cf: new CloudflareApi({ token: adminToken }), accountId, bucket };
}

/** Attach `assets.<new>` while `assets.<old>` keeps serving. R2 accepts
 *  several custom domains per bucket, so this genuinely is additive —
 *  every client bundle already in a browser keeps resolving the URL it
 *  was built with. */
export const stepR2Prepare: StepFn = async (ctx) => {
  const manifest = manifestOf(ctx);
  const { cf, accountId, bucket } = await r2Context(manifest);
  const desiredHost = defaultBucketHostname(ctx.newDomain);

  // The zone lookup wants Zone:Read, which the R2 admin token may not
  // carry; the DNS token is the one hatchkit verifies for zone reads.
  const dns = await getDnsConfig();
  const zoneApi = dns?.apiToken ? new CloudflareApi({ token: dns.apiToken }) : cf;
  const zone = await zoneApi.resolveZoneForName(desiredHost);
  if (!zone) {
    return {
      status: "gated",
      message: `no Cloudflare zone covers ${desiredHost}`,
      detail: [
        "add the zone in the Cloudflare dashboard first — hatchkit has no",
        "create-zone path (see the manual checklist), then re-run this phase",
      ],
    };
  }

  const attached = await cf.addR2CustomDomain(accountId, bucket, {
    domain: desiredHost,
    zoneId: zone.id,
    minTLS: "1.2",
  });
  return {
    status: attached.existed ? "skipped" : "done",
    message: attached.existed
      ? `${desiredHost} was already attached to ${bucket}`
      : `attached ${desiredHost} to ${bucket}`,
    detail: [
      "Cloudflare issues the certificate asynchronously; the cutover step",
      "waits for it rather than moving the URL onto a host that 525s",
    ],
  };
};

/** Move `publicUrl` (manifest + env) and recompute CORS. Gated on
 *  Cloudflare reporting the new hostname's certificate as active —
 *  pointing the app at a custom domain whose cert hasn't issued yet
 *  serves every asset as a TLS error. */
export const stepR2Cutover: StepFn = async (ctx) => {
  const manifest = manifestOf(ctx);
  const { cf, accountId, bucket } = await r2Context(manifest);
  const desiredHost = defaultBucketHostname(ctx.newDomain);
  const currentHost = existingCustomHostname(manifest);

  if (currentHost?.toLowerCase() === desiredHost.toLowerCase()) {
    return { status: "skipped", message: `assets publicUrl already https://${desiredHost}` };
  }

  const domains = await cf.listR2CustomDomains(accountId, bucket);
  const match = domains.find((d) => d.domain.toLowerCase() === desiredHost.toLowerCase());
  if (!match) {
    return {
      status: "gated",
      message: `${desiredHost} is not attached to ${bucket} yet — run the prepare phase first`,
    };
  }
  // Cloudflare reports ssl as "initializing" / "pending" / "active".
  // Anything but active means a browser hitting the host gets a TLS
  // error rather than an asset, so the URL must not move yet.
  if (match.status?.ssl && match.status.ssl !== "active") {
    return {
      status: "gated",
      message: `certificate for ${desiredHost} is "${match.status.ssl}", not "active"`,
      detail: ["Cloudflare usually issues within a few minutes; re-run this phase after"],
    };
  }

  const publicUrl = `https://${desiredHost}`;
  writeManifest(ctx.projectDir, {
    ...manifest,
    s3Buckets: {
      ...manifest.s3Buckets,
      assets: { ...manifest.s3Buckets?.assets, name: bucket, publicUrl },
    },
  });

  const detail: string[] = [];

  // Env: same key-selection rule provision uses, so the value lands
  // under the name this project's runtime actually reads.
  try {
    const { dotenvxSet } = await import("../utils/dotenvx-safe.js");
    const { resolveEnvFileTarget } = await import("../utils/env-files.js");
    const keys = envKeysForPrefix(detectEnvPrefix(ctx.projectDir));
    const envPath = resolveEnvFileTarget(ctx.projectDir, ".env.production");
    const { readEnvKeys } = await import("../provision/write-env.js");
    const present = readEnvKeys(envPath);
    const key = present.has("NEXT_PUBLIC_ASSETS_BASE_URL")
      ? "NEXT_PUBLIC_ASSETS_BASE_URL"
      : present.has(keys.publicUrl)
        ? keys.publicUrl
        : null;
    if (key) {
      dotenvxSet(key, publicUrl, { path: envPath, encrypt: true });
      detail.push(`${key} → ${publicUrl}`);
    } else {
      detail.push("no assets-URL key in .env.production — nothing to rewrite there");
    }
  } catch (err) {
    detail.push(`env rewrite failed: ${(err as Error).message.split("\n")[0]}`);
  }

  // CORS lists who may FETCH, so it follows the web origin, not the
  // bucket hostname. The manifest is already on the new domain by now,
  // so the existing reconciler computes the right set — plus the old
  // origin, which stays until cleanup: the old site may still be up.
  try {
    const keep = transitionalCorsOrigins(ctx);
    const applied = await reconcileAssetsCorsFromManifest(ctx.projectDir, { addOrigins: keep });
    if (applied?.origins?.length) {
      detail.push(
        `CORS: ${applied.origins.length} origin(s), including https://${ctx.newDomain}` +
          (keep.length > 0 ? ` (${keep.join(", ")} kept until cleanup)` : ""),
      );
    }
  } catch (err) {
    detail.push(`CORS reconcile failed: ${(err as Error).message.split("\n")[0]}`);
  }

  detail.push("rebuild + redeploy the client image — the old URL is baked into the bundle");
  return {
    status: "done",
    message: `assets publicUrl ${currentHost ? `https://${currentHost}` : "(managed)"} → ${publicUrl}`,
    detail,
  };
};

/** Drop the old web origin from the bucket's CORS rule. Cleanup only:
 *  until now it was kept on purpose (see `transitionalCorsOrigins`). */
export const stepR2CorsRetire: StepFn = async (ctx) => {
  const manifest = manifestOf(ctx);
  const [oldOrigin] = transitionalCorsOrigins(ctx);
  if (!oldOrigin) return { status: "skipped", message: "old and new domain are the same" };

  const applied = await reconcileAssetsCorsFromManifest(ctx.projectDir, {
    removeOrigins: [oldOrigin],
  });
  if (applied === null) {
    throw new Error(
      `could not reconcile CORS on ${manifest.s3Buckets?.assets?.name ?? "the assets bucket"} — R2 admin token or account id missing. Run \`hatchkit config add s3 r2\`.`,
    );
  }
  return {
    status: "done",
    message: `removed ${oldOrigin} from bucket CORS`,
    detail: [`origins now: ${(applied.origins ?? []).join(", ")}`],
  };
};

/** Detach `assets.<old>`. Genuinely destructive for any client bundle
 *  still carrying the old URL, which is why it lives in cleanup. */
export const stepR2Retire: StepFn = async (ctx) => {
  const manifest = manifestOf(ctx);
  const { cf, accountId, bucket } = await r2Context(manifest);
  const oldHost = defaultBucketHostname(ctx.oldDomain);
  const result = await cf.deleteR2CustomDomain(accountId, bucket, oldHost);
  return {
    status: result === "deleted" ? "done" : "skipped",
    message:
      result === "deleted"
        ? `detached ${oldHost} from ${bucket}`
        : `${oldHost} was not attached to ${bucket}`,
  };
};

// ---------------------------------------------------------------------------
// Plausible
// ---------------------------------------------------------------------------

export const stepPlausibleRename: StepFn = async (ctx) => {
  const manifest = manifestOf(ctx);
  const { renamePlausibleSite, updateCachedPlausibleDomain } = await import(
    "../provision/plausible.js"
  );
  await renamePlausibleSite(ctx.oldDomain, ctx.newDomain);
  const cacheMoved = await updateCachedPlausibleDomain(manifest.name, ctx.oldDomain, ctx.newDomain);
  return {
    status: "done",
    message: `Plausible site ${ctx.oldDomain} → ${ctx.newDomain} (stats history preserved)`,
    detail: cacheMoved ? undefined : ["keychain domain cache pointed elsewhere — left alone"],
  };
};

// ---------------------------------------------------------------------------
// Search Console
// ---------------------------------------------------------------------------

export const stepSearchConsoleCreate: StepFn = async (ctx) => {
  const manifest = manifestOf(ctx);
  const { provisionSearchConsoleForDomain } = await import("../provision/search-console.js");
  const res = await provisionSearchConsoleForDomain(ctx.newDomain);
  writeManifest(ctx.projectDir, {
    ...manifest,
    integrations: {
      ...manifest.integrations,
      searchConsole: {
        domain: res.domain,
        siteUrl: res.siteUrl,
        verifiedAt: new Date().toISOString(),
      },
    },
  });
  return {
    status: "done",
    message: `Search Console property ${res.siteUrl} verified`,
    detail: ["the old property keeps collecting until you run the cleanup phase"],
  };
};

export const stepSearchConsoleRetire: StepFn = async (ctx) => {
  const { unprovisionSearchConsoleForDomain } = await import("../provision/search-console.js");
  const result = await unprovisionSearchConsoleForDomain(ctx.oldDomain);
  return {
    status: result === "deleted" ? "done" : "skipped",
    message:
      result === "deleted"
        ? `removed Search Console property sc-domain:${ctx.oldDomain}`
        : `no Search Console property for ${ctx.oldDomain}`,
  };
};

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------

/** Repoint both webhook endpoints. Updating in place keeps the `whsec_`
 *  signing secret, so `.env.production` stays correct and no event
 *  arrives signed by a key the deployed app doesn't hold. */
export const stepStripeWebhook: StepFn = async (ctx) => {
  const manifest = manifestOf(ctx);
  const { updateStripeProjectWebhookUrl } = await import("../provision/stripe.js");
  const url = `https://${ctx.newDomain}/api/stripe/webhook`;
  const detail: string[] = [];
  let changed = 0;

  for (const mode of ["test", "live"] as const) {
    const res = await updateStripeProjectWebhookUrl(manifest.name, mode, url);
    if (res.result === "updated") {
      changed += 1;
      detail.push(`${mode}: ${res.endpointId} → ${url}`);
    } else if (res.result === "unchanged") {
      detail.push(`${mode}: already ${url}`);
    } else {
      detail.push(`${mode}: no hatchkit-registered endpoint — nothing to move`);
    }
  }
  detail.push("signing secret unchanged — STRIPE_WEBHOOK_SECRET stays valid");
  return {
    status: changed > 0 ? "done" : "skipped",
    message:
      changed > 0
        ? `${changed} Stripe webhook endpoint(s) repointed`
        : "no Stripe webhook needed moving",
    detail,
  };
};

// ---------------------------------------------------------------------------
// Registry — action id → executor
// ---------------------------------------------------------------------------

export const STEPS: Record<string, StepFn> = {
  "files:rewrite": stepFilesRewrite,
  "dns:publish": stepDnsPublish,
  "coolify:sync": stepCoolifySync,
  "ses:identity": stepSesPrepare,
  "ses:cutover": stepSesCutover,
  "ses:retire": stepSesRetire,
  "email-routing:setup": stepEmailRoutingSetup,
  "listmonk:from": stepListmonkFrom,
  "r2:custom-domain": stepR2Prepare,
  "r2:publicurl": stepR2Cutover,
  "r2:cors-retire": stepR2CorsRetire,
  "r2:retire": stepR2Retire,
  "plausible:rename": stepPlausibleRename,
  "search-console:create": stepSearchConsoleCreate,
  "search-console:retire": stepSearchConsoleRetire,
  "stripe:webhook": stepStripeWebhook,
};

/** Every planned action must have an executor. A plan that emits an id
 *  nothing implements would silently do nothing, which is the worst
 *  possible failure mode for a migration — the run reports success and
 *  the provider never moved. The orchestrator asserts against this. */
export function executorFor(id: string): StepFn {
  const step = STEPS[id];
  if (!step) {
    throw new Error(
      `Internal: no executor registered for migration action "${id}". This is a bug — please file an issue.`,
    );
  }
  return step;
}
