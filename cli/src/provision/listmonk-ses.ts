/*
 * Per-project Listmonk + SES provisioning orchestrator.
 *
 * The "listmonk-ses" choice in the email-intent prompt collapses into
 * one provisioner step because the two services are complementary:
 * SES owns delivery + IP reputation (and gets pasted into Listmonk's
 * SMTP settings out-of-band), Listmonk owns subscribe/confirm/
 * broadcast UI. From the project's runtime view it's a single bundle
 * of env vars — LISTMONK_* + SES_* — that the app reads to send mail
 * via either route.
 *
 * Sequencing (all idempotent on re-run):
 *
 *   1. SES: verify (or fetch existing) `mail.<projectDomain>`
 *      identity. Returns 3 DKIM CNAMEs that must be live in DNS for
 *      verification to flip to "Verified".
 *   2. SES → Cloudflare DNS: publish the DKIM CNAMEs into the project's
 *      Cloudflare zone. Reuses the shared `publishDnsRecordsToCloudflare`
 *      helper — same plumbing as Resend, so SPF-merge + per-record
 *      tracking + auto-rollback all work identically.
 *   3. Listmonk: create the `<project>` and `<project>-test` lists.
 *      Two lists let the runtime broadcast to the live audience in
 *      prod and a developer-only `<project>-test` list in dev without
 *      runtime branching — just pick the right LISTMONK_LIST_ID per
 *      env file. Both are created `optin: double`; an existing list
 *      that is still single opt-in is adopted as-is and reported in
 *      `singleOptinLists`, never switched from here.
 *   4. SES bounce + complaint feedback (after the SMTP apply, which
 *      reloads Listmonk): the identity's Bounce/Complaint topics point at
 *      the shared `ses-feedback-listmonk` SNS topic, which is subscribed
 *      to Listmonk's SES webhook. See `ses-feedback.ts`. Without it
 *      bounce notices go by email to `noreply@`, which nobody reads,
 *      and Listmonk never blocklists a dead address.
 *
 * Returns the materialized state the caller renders into env files
 * plus per-resource event records the run-ledger consumes.
 */

import {
  type CreatedDnsRecord,
  type PublishDnsRecord,
  publishDnsRecordsToCloudflare,
} from "./cloudflare-dns-publish.js";
import {
  type ListmonkAuth,
  type ListmonkList,
  type ListmonkTemplate,
  addListmonkSubscriberToList,
  applySesSmtpToListmonk,
  createListmonkList,
  createListmonkTemplate,
  getListmonkTemplate,
  listListmonkLists,
  listListmonkTemplates,
  updateListmonkTemplate,
} from "./listmonk.js";
import {
  type SesFeedbackResult,
  createSesFeedbackAws,
  createSesFeedbackListmonk,
  ensureSesFeedback,
} from "./ses-feedback.js";
import {
  SES_MAIL_FROM_SPF,
  type SesAuth,
  type SesIdentity,
  type SesMailFromBehaviorOnMxFailure,
  type SesMailFromState,
  createSesDomain,
  decideMailFromPlan,
  getSesMailFromDomain,
  sesMailFromMxTarget,
  sesMailFromSubdomain,
  sesSmtpCredentials,
  setSesMailFromDomain,
} from "./ses.js";

export interface ListmonkSesProvisionOptions {
  /** Project base name — used to name the live + test Listmonk lists
   *  (`<projectName>` + `<projectName>-test`). */
  projectName: string;
  /** Project domain (e.g. `playtiao.com`). The SES verified identity
   *  is `mail.<projectDomain>`; the from-address is
   *  `noreply@mail.<projectDomain>`. */
  projectDomain: string;
  /** Skip the DKIM auto-publish step. Defaults to publishing when
   *  the user has a Cloudflare token configured. */
  publishDns?: boolean;
  /** Pre-resolved Cloudflare API for DKIM publish. When omitted the
   *  caller is expected to set `publishDns: false`. */
  cf?: import("../utils/cloudflare-api.js").CloudflareApi;
  /** Route the identity's bounces + complaints into Listmonk through the
   *  shared SNS topic (see `ses-feedback.ts`). On by default; each
   *  failed piece degrades to a warning in `result.feedback`. */
  configureBounceFeedback?: boolean;
  /** How long to wait for Listmonk to confirm a new SNS subscription.
   *  Defaults to 20 s. */
  feedbackConfirmTimeoutMs?: number;
  /** Email address to auto-subscribe to the project's `-test` list as
   *  `confirmed`. Hatchkit passes the global default forwarding email
   *  here so the first `pnpm newsletter:verify` run lands a real send
   *  in the user's own inbox with zero manual list-management work.
   *  Also gets rendered as `LISTMONK_TEST_RECIPIENT` in the dev env so
   *  the bundled test scripts know which address to target. Skipped
   *  when not set. */
  seedSubscriberEmail?: string;
  /** Pre-resolved SES + Listmonk credentials. When omitted the
   *  orchestrator falls back to the global config (ensureSes /
   *  ensureListmonk). Tests pass overrides to avoid keychain. */
  sesAuth?: SesAuth;
  listmonkAuth?: ListmonkAuth;
  /** Subdomain label prepended to the sending domain to form the
   *  custom MAIL FROM domain (default `"bounce"` →
   *  `bounce.mail.<projectDomain>`). Recorded into the manifest so a
   *  re-run keeps the same name even if the default label later
   *  changes. */
  mailFromLabel?: string;
  /** Toggle for SES's `BehaviorOnMxFailure`. Default
   *  `"UseDefaultValue"` so a misconfigured DNS state degrades to
   *  `amazonses.com` instead of bouncing mail. Strict-alignment setups
   *  can flip to `"RejectMessage"`. */
  mailFromBehaviorOnMxFailure?: SesMailFromBehaviorOnMxFailure;
  /** Skip the MAIL FROM step entirely. Defaults to running. Useful
   *  for tests + callers that explicitly opted out via project config. */
  configureMailFrom?: boolean;
  /** Soft-timeout for the `getSesMailFromDomain` poll that waits for
   *  the status to flip to `SUCCESS`. Defaults to 5 minutes. Set to 0
   *  to skip the poll entirely — the next `hatchkit update` re-checks. */
  mailFromPollTimeoutMs?: number;
}

export interface ListmonkSesProvisionEvents {
  /** Fires once the SES identity exists. Either we created it this
   *  run or it existed already; the DKIM tokens are returned in both
   *  cases so DNS publish can proceed. */
  onSesDomain?: (event: { domain: string; dkimRecords: SesIdentity["dkimRecords"] }) => void;
  /** Fires after each Listmonk list is created or detected. `kind`
   *  distinguishes the live audience from the test audience so the
   *  caller can pick which list-id lands in prod vs dev env. */
  onListmonkList?: (event: {
    listmonkUrl: string;
    listName: string;
    listId: number;
    kind: "live" | "test";
    createdThisRun: boolean;
  }) => void;
  /** Fires after each Listmonk template (tx + campaign) is created or
   *  detected. The runtime needs both ids in env so the ledger has to
   *  know which we minted this run for the undo path. */
  onListmonkTemplate?: (event: {
    listmonkUrl: string;
    templateName: string;
    templateId: number;
    kind: "tx" | "campaign";
    createdThisRun: boolean;
  }) => void;
  /** Fires after `seedSubscriberEmail` lands on the `-test` list.
   *  `createdThisRun` is true only when this run *created* the
   *  subscriber row (vs. promoted an existing row to confirmed on the
   *  list) — the ledger uses the flag to decide whether destroy
   *  should remove the subscriber entirely. */
  onListmonkSubscriber?: (event: {
    listmonkUrl: string;
    email: string;
    subscriberId: number;
    listId: number;
    listName: string;
    createdThisRun: boolean;
  }) => void;
  /** Fires after the DKIM CNAMEs are upserted into Cloudflare.
   *  `createdRecords` is the per-record handle list for everything
   *  THIS run created — auto-rollback uses it to DELETE only what we
   *  added. */
  onSesDns?: (event: {
    domainName: string;
    zoneId: string;
    zoneName: string;
    createdRecords: CreatedDnsRecord[];
    mergedSpf: Array<{ name: string }>;
  }) => void;
  /** Fires once the Custom MAIL FROM attribute is set on the SES
   *  identity AND the matching MX + SPF TXT records are published.
   *  `status` is SES's view at the moment of the call — usually
   *  `PENDING` immediately after the first set, flipping to `SUCCESS`
   *  within minutes once DNS propagates. */
  onSesMailFromConfigured?: (event: {
    identity: string;
    mailFromDomain: string;
    region: string;
    behaviorOnMxFailure: SesMailFromBehaviorOnMxFailure;
    status: SesMailFromState["status"];
    /** Per-record handles for everything THIS run CREATED in
     *  Cloudflare. Excludes updates + unchanged rows so a later
     *  rollback only removes records Hatchkit introduced. */
    createdRecords: CreatedDnsRecord[];
    /** Cloudflare zone covering the MAIL FROM subdomain. */
    zoneId: string;
    zoneName: string;
  }) => void;
  /** Fires after the bounce-feedback step. `typesSetThisRun` lists the
   *  notification types this run pointed at the shared topic; the ledger
   *  records only those, so destroy clears only what this run set and
   *  never the shared topic itself. */
  onSesFeedback?: (event: {
    identity: string;
    topicArn: string | null;
    typesSetThisRun: SesFeedbackResult["typesSetThisRun"];
  }) => void;
}

export interface ListmonkSesProvisionResult {
  ses: SesIdentity;
  smtp: ReturnType<typeof sesSmtpCredentials>;
  fromEmail: string;
  /** `"<projectName> <noreply@mail.<domain>>"` — the value Listmonk's
   *  campaign send wants in its `from_email` field and the runtime reads
   *  as `LISTMONK_FROM`. Distinct from `fromEmail` (the bare SMTP
   *  envelope sender, exported as `SES_FROM_EMAIL`). */
  fromDisplay: string;
  liveList: ListmonkList;
  testList: ListmonkList;
  txTemplate: ListmonkTemplate;
  campaignTemplate: ListmonkTemplate;
  dnsPublish: {
    zoneId: string;
    zoneName: string;
    createdRecords: CreatedDnsRecord[];
    mergedSpf: Array<{ name: string }>;
  } | null;
  /** Custom MAIL FROM state after the orchestrator's set + DNS publish
   *  step. Null when the caller opted out via `configureMailFrom:
   *  false`, when the orchestrator adopted a user-set MAIL FROM
   *  (mailFromDomain populated, dnsPublish skipped), or when the SES
   *  side failed soft (e.g. IAM gap). The status field reflects SES's
   *  view at the moment of the call — `PENDING` immediately after the
   *  first set, flipping to `SUCCESS` after DNS propagation. */
  mailFrom: {
    identity: string;
    mailFromDomain: string;
    region: string;
    behaviorOnMxFailure: SesMailFromBehaviorOnMxFailure;
    status: SesMailFromState["status"];
    /** Per-record handles for everything THIS run CREATED in
     *  Cloudflare at the MAIL FROM subdomain. Excludes updates +
     *  unchanged rows so auto-rollback only removes records Hatchkit
     *  introduced. */
    createdRecords: CreatedDnsRecord[];
    /** Whether Hatchkit adopted a user-set custom MAIL FROM (and only
     *  ensured DNS) vs. set it from scratch. Used by callers to print
     *  a different message ("adopted existing" vs. "configured"). */
    adoptedExisting: boolean;
    /** Cloudflare zone covering the MAIL FROM subdomain. Null when
     *  DNS publish was skipped (no CF token, adopt path with no
     *  matching records to verify, etc.). */
    zoneId: string | null;
    zoneName: string | null;
  } | null;
  /** Whether Listmonk's runtime SMTP settings + from-email got auto-
   *  configured via `/api/settings` PUT this run. `false + reason` lets
   *  the caller surface the manual-paste fallback when the API user
   *  lacked `Settings: All` permission. */
  smtpApplied: { written: boolean; reason?: string };
  /** Bounce + complaint feedback state. Null when the caller opted out
   *  via `configureBounceFeedback: false`. */
  feedback: SesFeedbackResult | null;
  /** Adopted lists that are still `optin: single`. A campaign on such
   *  a list reaches every member not `unsubscribed`, `unconfirmed`
   *  included. Reported, never switched here: an app that still adds
   *  `unconfirmed` members before the confirm click would then make
   *  Listmonk send its own opt-in email next to the app's. See
   *  `singleOptinHint`. */
  singleOptinLists: ListmonkList[];
  /** Subscriber seeded onto the `-test` list (if any). Null when the
   *  caller didn't pass `seedSubscriberEmail`. The runtime reads the
   *  email as `LISTMONK_TEST_RECIPIENT` in dev so bundled scripts have
   *  a default target for tx + welcome sends. */
  seededSubscriber: {
    email: string;
    subscriberId: number;
    createdThisRun: boolean;
  } | null;
}

/** Compute the sending subdomain hatchkit uses for this project's SES
 *  identity — `mail.<domain>`. Kept as a named function so renames are
 *  trivial and so destroy can produce the same name from a manifest
 *  without depending on the orchestrator. */
export function sesSendingSubdomain(projectDomain: string): string {
  return `mail.${projectDomain}`;
}

/** The lists that are not double opt-in. Listmonk sends a campaign on
 *  a single-opt-in list to every member not `unsubscribed`,
 *  `unconfirmed` included, so any address typed into the signup form
 *  gets every issue without confirming. */
export function singleOptinLists(lists: ListmonkList[]): ListmonkList[] {
  return lists.filter((l) => l.optin !== "double");
}

/** How to fix single-opt-in lists, in the order that avoids a second
 *  confirmation email. Shared by the provisioner and `hatchkit doctor`. */
export function singleOptinHint(lists: ListmonkList[]): string[] {
  const names = lists.map((l) => `${l.name} (id ${l.id})`).join(", ");
  return [
    `Switch ${names} to double opt-in, in this order:`,
    "1. Deploy the app with the confirm-only subscribe code: the form creates the subscriber on no list, and only the confirm link adds it, as `confirmed` (starter `ensureSubscriber` + `confirmSubscription`).",
    "   Code that still adds an `unconfirmed` member first makes Listmonk send its own opt-in email next to the app's once the list is double.",
    "2. Then Listmonk → Lists → edit → Opt-in: Double. Campaigns then reach `confirmed` members only.",
  ];
}

/** A bare `{{ .Tx.Data.body }}` action, trim markers allowed. Hatchkit
 *  seeded tx templates with this body before it piped it through `Safe`. */
const BARE_TX_BODY_ACTION = /\{\{(-?\s*)\.Tx\.Data\.body(\s*-?)\}\}/g;

/** Pipe every bare `{{ .Tx.Data.body }}` in a tx template body through
 *  `Safe`, leaving the rest of the body as it is. Listmonk renders the
 *  bare form HTML-escaped, so the app's HTML arrives as visible markup.
 *  A body with nothing to fix comes back unchanged, so a second run is a
 *  no-op. */
export function repairTxTemplateBody(body: string): string {
  return body.replace(BARE_TX_BODY_ACTION, "{{$1.Tx.Data.body | Safe$2}}");
}

/** Whether a tx template body renders `.Tx.Data.body` HTML-escaped. */
export function txBodyRendersEscaped(body: string): boolean {
  return repairTxTemplateBody(body) !== body;
}

/** How to fix a tx template whose body renders escaped. Shared by
 *  `hatchkit doctor` and its `--fix` repair. */
export function escapedTxTemplateHint(template: ListmonkTemplate): string[] {
  return [
    `${template.name} (id ${template.id}) renders \`{{ .Tx.Data.body }}\`. Listmonk HTML-escapes it, so every email sent through it arrives as visible markup.`,
    "Run `hatchkit doctor --fix` in this project to pipe it through `Safe`, or edit the template in Listmonk → Campaigns → Templates:",
    "  `{{ .Tx.Data.body }}` → `{{ .Tx.Data.body | Safe }}`",
  ];
}

/** Repair one tx template in place. Reads the template again right
 *  before the write, so an edit made since the doctor check is kept,
 *  and only the bare `.Tx.Data.body` actions change. Idempotent: a
 *  template that is already safe is not written. */
export async function repairEscapedTxTemplate(
  id: number,
  auth: ListmonkAuth,
): Promise<"repaired" | "already-safe"> {
  const current = await getListmonkTemplate(id, auth);
  const body = current.body ?? "";
  if (!txBodyRendersEscaped(body)) return "already-safe";
  await updateListmonkTemplate(id, {
    name: current.name,
    type: "tx",
    subject: current.subject,
    body: repairTxTemplateBody(body),
    auth,
  });
  return "repaired";
}

export async function provisionListmonkSesForProject(
  opts: ListmonkSesProvisionOptions,
  events: ListmonkSesProvisionEvents = {},
): Promise<ListmonkSesProvisionResult> {
  const sendingDomain = sesSendingSubdomain(opts.projectDomain);
  const fromEmail = `noreply@${sendingDomain}`;

  // 1. SES identity (idempotent: createSesDomain falls through to
  //    GetEmailIdentity on AlreadyExistsException, so re-runs are
  //    safe and still return the DKIM tokens).
  const identity = await createSesDomain(sendingDomain, opts.sesAuth);
  events.onSesDomain?.({ domain: sendingDomain, dkimRecords: identity.dkimRecords });

  // 2. DKIM publish into Cloudflare. Skipped when the caller already
  //    knows DNS is somewhere else (e.g. tests, or a Cloudflare-less
  //    setup). The shared helper handles SPF merge + per-record
  //    tracking the same way Resend's does.
  let dnsPublish: ListmonkSesProvisionResult["dnsPublish"] = null;
  if (opts.publishDns !== false && opts.cf && identity.dkimRecords.length > 0) {
    const records: PublishDnsRecord[] = identity.dkimRecords.map((r) => ({
      type: r.type,
      name: r.name,
      value: r.value,
      label: "DKIM",
    }));
    const publishRes = await publishDnsRecordsToCloudflare(records, {
      cf: opts.cf,
      domain: sendingDomain,
      logTag: "SES",
    });
    dnsPublish = {
      zoneId: publishRes.zoneId,
      zoneName: publishRes.zoneName,
      createdRecords: publishRes.createdRecords,
      mergedSpf: publishRes.mergedSpf,
    };
    events.onSesDns?.({
      domainName: sendingDomain,
      zoneId: publishRes.zoneId,
      zoneName: publishRes.zoneName,
      createdRecords: publishRes.createdRecords,
      mergedSpf: publishRes.mergedSpf,
    });
  }

  // 3. Custom MAIL FROM Domain. Without this, Gmail surfaces
  //    `mailed-by: <region>.amazonses.com` on every send and SPF
  //    alignment for DMARC fails (SPF passes for amazonses.com, not
  //    for the From: domain). Setting a custom MAIL FROM
  //    (`<label>.<sendingDomain>`) hides the AWS infrastructure name
  //    and lets SPF align with the From: domain. Idempotent on re-run;
  //    adopt-path when SES already holds a user-set MAIL FROM.
  const mailFromResult = await configureMailFromStep({
    opts,
    sendingDomain,
    region: await resolveSesRegion(opts.sesAuth),
    cf: opts.cf,
    events,
  });

  // 4. Listmonk lists — live + test. Idempotent by-name: if the user
  //    re-runs and the list already exists, we adopt it instead of
  //    creating a duplicate. The "createdThisRun" flag tells the
  //    ledger whether to record an undo step.
  const existingLists = await listListmonkLists(opts.listmonkAuth);
  const listmonkUrl = opts.listmonkAuth?.url ?? existingListmonkUrlFromExisting();

  const liveList = await getOrCreateList(
    opts.projectName,
    "live",
    existingLists,
    opts,
    events,
    listmonkUrl,
  );
  const testList = await getOrCreateList(
    `${opts.projectName}-test`,
    "test",
    existingLists,
    opts,
    events,
    listmonkUrl,
  );
  // Hatchkit creates lists double opt-in. A list adopted from an older
  // run may still be single: report it, don't switch it (see
  // `singleOptinHint` for why the order matters).
  const driftedLists = singleOptinLists([liveList, testList]);

  // 4b. Listmonk templates — tx + campaign. Same idempotency contract as
  //     lists: look up by `<projectName>-tx` / `<projectName>-campaign`
  //     first, only POST when missing. Both default bodies are minimal
  //     passthrough wrappers — the calling app supplies the real HTML
  //     and we only need an id the runtime can hand to `/api/tx` and
  //     `/api/campaigns`.
  const existingTemplates = await listListmonkTemplates(opts.listmonkAuth);
  const txTemplate = await getOrCreateTemplate(
    `${opts.projectName}-tx`,
    "tx",
    existingTemplates,
    opts,
    events,
    listmonkUrl,
  );
  const campaignTemplate = await getOrCreateTemplate(
    `${opts.projectName}-campaign`,
    "campaign",
    existingTemplates,
    opts,
    events,
    listmonkUrl,
  );

  // 5. SMTP credentials are deterministic from the SES IAM secret +
  //    region — derive them now so the env-render step has the values
  //    without a second round-trip.
  const smtp = sesSmtpCredentials(opts.sesAuth ?? (await globalSesAuth()));

  // 6. Push the SES SMTP relay + from-email into Listmonk's runtime
  //    settings so the user doesn't have to paste them into Settings →
  //    SMTP by hand. Best-effort: when the API user's role doesn't
  //    cover `Settings: All` the helper throws — downgrade to a warning
  //    and let the caller print the manual-paste fallback.
  let smtpApplied: { written: boolean; reason?: string };
  try {
    smtpApplied = await applySesSmtpToListmonk(
      {
        host: smtp.host,
        port: smtp.port,
        username: smtp.username,
        password: smtp.password,
        fromEmail,
        fromName: opts.projectName,
      },
      opts.listmonkAuth,
    );
  } catch (err) {
    const msg = (err as Error).message;
    const isPerm = /permission denied|403/.test(msg);
    smtpApplied = {
      written: false,
      reason: isPerm
        ? "API user lacks `Settings: All` — widen the role in Listmonk → Admin → Users, or paste SES SMTP creds into Settings → SMTP manually."
        : msg,
    };
  }

  // 6b. Bounce + complaint feedback. After the SMTP apply, whose
  //     whole-settings PUT reloads Listmonk; the feedback step PUTs only
  //     the bounce keys that are still off. Never throws: each piece
  //     that fails (usually a missing IAM action) lands in `warnings`.
  let feedback: SesFeedbackResult | null = null;
  if (opts.configureBounceFeedback !== false) {
    const sesAuth = opts.sesAuth ?? (await globalSesAuth());
    const listmonkAuth =
      opts.listmonkAuth ?? (await (await import("../config.js")).ensureListmonk());
    feedback = await ensureSesFeedback({
      identity: sendingDomain,
      listmonkUrl: listmonkAuth.url,
      aws: createSesFeedbackAws(sesAuth),
      listmonk: createSesFeedbackListmonk(listmonkAuth),
      confirmTimeoutMs: opts.feedbackConfirmTimeoutMs,
    });
    events.onSesFeedback?.({
      identity: sendingDomain,
      topicArn: feedback.topicArn,
      typesSetThisRun: feedback.typesSetThisRun,
    });
  }

  // 7. Optional: seed the user's own address onto the `-test` list as a
  //    confirmed subscriber. Best-effort — a Listmonk hiccup here
  //    shouldn't roll back a successful SES + lists + templates run.
  //    Wires the verify scripts in the starter to a real inbox without
  //    any post-install setup.
  let seededSubscriber: ListmonkSesProvisionResult["seededSubscriber"] = null;
  if (opts.seedSubscriberEmail) {
    try {
      const seeded = await addListmonkSubscriberToList({
        email: opts.seedSubscriberEmail,
        listId: testList.id,
        auth: opts.listmonkAuth,
      });
      seededSubscriber = {
        email: opts.seedSubscriberEmail,
        subscriberId: seeded.subscriberId,
        createdThisRun: seeded.createdThisRun,
      };
      events.onListmonkSubscriber?.({
        listmonkUrl,
        email: opts.seedSubscriberEmail,
        subscriberId: seeded.subscriberId,
        listId: testList.id,
        listName: testList.name,
        createdThisRun: seeded.createdThisRun,
      });
    } catch (err) {
      console.warn(
        `  Could not seed ${opts.seedSubscriberEmail} onto ${testList.name}: ${(err as Error).message}`,
      );
    }
  }

  return {
    ses: identity,
    smtp,
    fromEmail,
    fromDisplay: `${opts.projectName} <${fromEmail}>`,
    liveList,
    testList,
    txTemplate,
    campaignTemplate,
    dnsPublish,
    smtpApplied,
    singleOptinLists: driftedLists,
    seededSubscriber,
    mailFrom: mailFromResult,
    feedback,
  };
}

async function globalSesAuth(): Promise<SesAuth> {
  const { ensureSes } = await import("../config.js");
  const cfg = await ensureSes();
  return {
    region: cfg.region,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
  };
}

/** Resolve the SES region, honoring an explicit auth override and
 *  falling back to the global config. Pulled out so the MAIL FROM step
 *  can reference it without a second `ensureSes` round-trip. */
async function resolveSesRegion(auth: SesAuth | undefined): Promise<string> {
  if (auth?.region) return auth.region;
  const { ensureSes } = await import("../config.js");
  const cfg = await ensureSes();
  return cfg.region;
}

interface ConfigureMailFromStepInput {
  opts: ListmonkSesProvisionOptions;
  sendingDomain: string;
  region: string;
  cf: import("../utils/cloudflare-api.js").CloudflareApi | undefined;
  events: ListmonkSesProvisionEvents;
}

/**
 * Step 3b — set Custom MAIL FROM on the SES identity AND publish the
 * matching MX + SPF TXT into Cloudflare. Splits cleanly into three
 * paths:
 *
 *   1. Opt-out      — caller passed `configureMailFrom: false`. No-op.
 *   2. Adopt        — SES already holds a user-set MAIL FROM. Hatchkit
 *                     adopts that name; DNS publish ensures the matching
 *                     records exist but does NOT override a different
 *                     value. The manifest is recorded by the caller.
 *   3. Set + publish — Default. Compute `<label>.<sendingDomain>`, call
 *                      `setSesMailFromDomain`, publish MX + SPF TXT,
 *                      optionally poll until SUCCESS.
 *
 * Returns `null` only on opt-out or a soft-fail in the SES call (IAM
 * gap, transient API error). DNS publish errors propagate — they're the
 * same class of fatal as the DKIM publish above.
 */
async function configureMailFromStep(
  input: ConfigureMailFromStepInput,
): Promise<ListmonkSesProvisionResult["mailFrom"]> {
  const { opts, sendingDomain, region, cf, events } = input;
  if (opts.configureMailFrom === false) return null;

  const desiredLabel = (opts.mailFromLabel ?? "bounce").trim();
  if (!desiredLabel) return null;
  const desiredBehavior: SesMailFromBehaviorOnMxFailure =
    opts.mailFromBehaviorOnMxFailure ?? "UseDefaultValue";

  // 1. Inspect the SES side first. Adopt path: if a user manually set
  //    a custom MAIL FROM in the AWS console before Hatchkit got here,
  //    we use THAT name (not the computed default). Hatchkit must
  //    never overwrite a user-set value silently — adopt is the
  //    explicit contract.
  let currentState: SesMailFromState;
  try {
    currentState = await getSesMailFromDomain(sendingDomain, opts.sesAuth);
  } catch (err) {
    console.warn(
      `  MAIL FROM lookup failed for ${sendingDomain}: ${(err as Error).message} — skipping.`,
    );
    return null;
  }

  const computedMailFrom = sesMailFromSubdomain(sendingDomain, desiredLabel);
  const plan = decideMailFromPlan(currentState, computedMailFrom, desiredBehavior);
  const { mailFromDomain, adoptedExisting, behaviorOnMxFailure: behaviorToApply, needsSet } = plan;

  // 2. Apply the SES attribute. Skipped on the pure-adopt path when
  //    the behavior already matches what we'd set — no point burning
  //    a quota-counted API call to re-write the same value.
  let stateAfter: SesMailFromState = currentState;
  if (needsSet) {
    try {
      stateAfter = await setSesMailFromDomain(
        sendingDomain,
        mailFromDomain,
        behaviorToApply,
        opts.sesAuth,
      );
    } catch (err) {
      const msg = (err as Error).message;
      // IAM gap on `ses:PutEmailIdentityMailFromAttributes` is the most
      // common cause — surface clearly so the operator widens the policy.
      console.warn(
        `  MAIL FROM set failed for ${sendingDomain} → ${mailFromDomain}: ${msg}\n` +
          `    Most likely cause: missing IAM action ses:PutEmailIdentityMailFromAttributes.\n` +
          `    Re-run after widening the SES IAM user's policy.`,
      );
      return null;
    }
  }

  // 3. Publish MX + SPF TXT into Cloudflare. Skipped only when the
  //    caller has no CF token at all — same gate as the DKIM publish.
  //    The records are tagged "MAIL-FROM" so the per-record log line
  //    visually separates from DKIM rows.
  let zoneId: string | null = null;
  let zoneName: string | null = null;
  let createdRecords: CreatedDnsRecord[] = [];
  if (cf) {
    const records: PublishDnsRecord[] = [
      {
        type: "MX",
        name: mailFromDomain,
        value: sesMailFromMxTarget(region),
        priority: 10,
        label: "MAIL-FROM",
      },
      {
        type: "TXT",
        name: mailFromDomain,
        value: SES_MAIL_FROM_SPF,
        label: "MAIL-FROM-SPF",
      },
    ];
    const publishRes = await publishDnsRecordsToCloudflare(records, {
      cf,
      domain: sendingDomain,
      logTag: "MAIL-FROM",
    });
    zoneId = publishRes.zoneId;
    zoneName = publishRes.zoneName;
    createdRecords = publishRes.createdRecords;
  }

  // 4. Optional poll for status flip. PENDING is the expected state
  //    right after the first set; SES re-checks DNS every minute or so
  //    and flips to SUCCESS once the MX record resolves. The poll is
  //    soft — on timeout we return PENDING and the next `hatchkit
  //    update` re-checks.
  const pollTimeoutMs = opts.mailFromPollTimeoutMs ?? 5 * 60 * 1000;
  if (pollTimeoutMs > 0 && stateAfter.status !== "SUCCESS") {
    const deadline = pollNow() + pollTimeoutMs;
    while (pollNow() < deadline) {
      await sleep(15_000);
      try {
        const polled = await getSesMailFromDomain(sendingDomain, opts.sesAuth);
        stateAfter = polled;
        if (polled.status === "SUCCESS" || polled.status === "FAILED") break;
      } catch {
        // Transient — keep polling.
      }
    }
  }

  events.onSesMailFromConfigured?.({
    identity: sendingDomain,
    mailFromDomain,
    region,
    behaviorOnMxFailure: behaviorToApply,
    status: stateAfter.status,
    createdRecords,
    zoneId: zoneId ?? "",
    zoneName: zoneName ?? "",
  });

  return {
    identity: sendingDomain,
    mailFromDomain,
    region,
    behaviorOnMxFailure: behaviorToApply,
    status: stateAfter.status,
    createdRecords,
    adoptedExisting,
    zoneId,
    zoneName,
  };
}

// pollNow + sleep — pulled out so they're trivial to monkey-patch from
// the test suite. Date.now() is fine here (we're not in a workflow
// script).
function pollNow(): number {
  return Date.now();
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getOrCreateList(
  name: string,
  kind: "live" | "test",
  existing: ListmonkList[],
  opts: ListmonkSesProvisionOptions,
  events: ListmonkSesProvisionEvents,
  listmonkUrl: string,
): Promise<ListmonkList> {
  const found = existing.find((l) => l.name === name);
  if (found) {
    events.onListmonkList?.({
      listmonkUrl,
      listName: name,
      listId: found.id,
      kind,
      createdThisRun: false,
    });
    return found;
  }
  // Double opt-in: campaigns reach `confirmed` members only. The
  // starter's signup form adds the list only on the confirm click, as
  // `confirmed`, so Listmonk never sends an opt-in email of its own.
  const created = await createListmonkList(name, {
    type: "private",
    optin: "double",
    auth: opts.listmonkAuth,
  });
  events.onListmonkList?.({
    listmonkUrl,
    listName: name,
    listId: created.id,
    kind,
    createdThisRun: true,
  });
  return created;
}

/** Minimal passthrough bodies for the seeded templates. The calling app
 *  supplies the real HTML at send-time — these scaffolds only have to be
 *  valid Listmonk Go templates that render the runtime's input. The tx
 *  template's subject expects `{{ .Tx.Data.subject }}` and the body
 *  renders `{{ .Tx.Data.body | Safe }}`. Listmonk parses a tx body with
 *  Go's `html/template` (only the subject goes through `text/template`),
 *  so a bare `{{ .Tx.Data.body }}` is HTML-escaped and the email arrives
 *  as visible markup. `Safe` is the helper Listmonk registers for tx
 *  templates to pass a string through as HTML (`safeHTML` is not
 *  registered and fails to compile). The calling app is responsible for
 *  the HTML it passes. The campaign template is a pure passthrough so
 *  the digest HTML the app already wraps lands verbatim with
 *  per-recipient `{{ UnsubscribeURL }}` substitution. */
const DEFAULT_TX_TEMPLATE_SUBJECT = "{{ .Tx.Data.subject }}";
export const DEFAULT_TX_TEMPLATE_BODY = `<!doctype html>
<html>
  <body>
    {{ .Tx.Data.body | Safe }}
  </body>
</html>
`;
const DEFAULT_CAMPAIGN_TEMPLATE_BODY = `<!doctype html>
<html>
  <body>
    {{ template "content" . }}
  </body>
</html>
`;

async function getOrCreateTemplate(
  name: string,
  kind: "tx" | "campaign",
  existing: ListmonkTemplate[],
  opts: ListmonkSesProvisionOptions,
  events: ListmonkSesProvisionEvents,
  listmonkUrl: string,
): Promise<ListmonkTemplate> {
  const found = existing.find((t) => t.name === name && t.type === kind);
  if (found) {
    events.onListmonkTemplate?.({
      listmonkUrl,
      templateName: name,
      templateId: found.id,
      kind,
      createdThisRun: false,
    });
    return found;
  }
  const created = await createListmonkTemplate({
    name,
    type: kind,
    subject: kind === "tx" ? DEFAULT_TX_TEMPLATE_SUBJECT : "",
    body: kind === "tx" ? DEFAULT_TX_TEMPLATE_BODY : DEFAULT_CAMPAIGN_TEMPLATE_BODY,
    auth: opts.listmonkAuth,
  });
  events.onListmonkTemplate?.({
    listmonkUrl,
    templateName: name,
    templateId: created.id,
    kind,
    createdThisRun: true,
  });
  return created;
}

/** Hatchkit only knows the Listmonk URL via `ensureListmonk`. When the
 *  caller doesn't pass an override the orchestrator pulls the URL from
 *  the global config at first use; this helper is the fallback for
 *  events that fire before the ensure call lands. */
function existingListmonkUrlFromExisting(): string {
  // Best-effort placeholder. The real URL is recorded again inside the
  // env-render step, so this string is only ever read by the
  // events callback for diagnostic display.
  return "";
}

// ────────────────────────────────────────────────────────────────────────────
// Env-rendering
// ────────────────────────────────────────────────────────────────────────────

export interface RenderListmonkSesEnvOptions {
  listmonkUrl: string;
  listmonkApiUser: string;
  listmonkApiToken: string;
  liveListId: number;
  testListId: number;
  txTemplateId: number;
  campaignTemplateId: number;
  /** Listmonk-style display sender — `"<name> <email>"`. Used as
   *  `LISTMONK_FROM` for `/api/campaigns`'s `from_email` field. Distinct
   *  from `fromEmail` (the SMTP-level envelope sender exported as
   *  `SES_FROM_EMAIL`); the two can drift when the project's display name
   *  differs from the bare mailbox. */
  listmonkFrom: string;
  smtpHost: string;
  smtpPort: number;
  smtpUsername: string;
  smtpPassword: string;
  fromEmail: string;
  region: string;
  /** Optional default-recipient for the bundled `newsletter:test-tx` /
   *  `newsletter:welcome` / `newsletter:verify` scripts. Rendered into
   *  `.env.development` ONLY — production never auto-targets a single
   *  inbox. Typically the user's `defaults.forwardingEmail` from
   *  `hatchkit setup`. */
  testRecipient?: string;
}

/** Render the env quartets for prod vs dev. Both surfaces share
 *  identical LISTMONK_URL / LISTMONK_API_USER / LISTMONK_API_TOKEN /
 *  LISTMONK_TEST_LIST_ID / LISTMONK_TX_TEMPLATE_ID /
 *  LISTMONK_CAMPAIGN_TEMPLATE_ID / LISTMONK_FROM / SES_SMTP_* values; the
 *  only thing that differs is which list id lands in `LISTMONK_LIST_ID`
 *  (live in prod, test in dev — mirrors Resend's audience-split pattern).
 *  `LISTMONK_TEST_LIST_ID` is written explicitly in both surfaces so the
 *  app can send to the test audience from prod when an opt-in flow needs
 *  to rehearse without depending on `NODE_ENV` to swap the bucket. */
export function renderListmonkSesEnv(opts: RenderListmonkSesEnvOptions): {
  prod: string[];
  dev: string[];
} {
  const shared = [
    `LISTMONK_URL=${opts.listmonkUrl}`,
    `LISTMONK_API_USER=${opts.listmonkApiUser}`,
    `LISTMONK_API_TOKEN=${opts.listmonkApiToken}`,
    `LISTMONK_TEST_LIST_ID=${opts.testListId}`,
    `LISTMONK_TX_TEMPLATE_ID=${opts.txTemplateId}`,
    `LISTMONK_CAMPAIGN_TEMPLATE_ID=${opts.campaignTemplateId}`,
    `LISTMONK_FROM=${opts.listmonkFrom}`,
    `SES_SMTP_HOST=${opts.smtpHost}`,
    `SES_SMTP_PORT=${opts.smtpPort}`,
    `SES_SMTP_USERNAME=${opts.smtpUsername}`,
    `SES_SMTP_PASSWORD=${opts.smtpPassword}`,
    `SES_FROM_EMAIL=${opts.fromEmail}`,
    `SES_REGION=${opts.region}`,
  ];
  const devOnly = opts.testRecipient ? [`LISTMONK_TEST_RECIPIENT=${opts.testRecipient}`] : [];
  return {
    prod: [...shared, `LISTMONK_LIST_ID=${opts.liveListId}`],
    dev: [...shared, `LISTMONK_LIST_ID=${opts.testListId}`, ...devOnly],
  };
}
