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
 *   3. SES feedback notifications: opt-in. Required only when the user
 *      wants Listmonk's bounce/complaint webhook to be informed —
 *      otherwise SES silently logs bounces but doesn't notify anyone.
 *   4. Listmonk: create the `<project>` and `<project>-test` lists.
 *      Two lists let the runtime broadcast to the live audience in
 *      prod and a developer-only `<project>-test` list in dev without
 *      runtime branching — just pick the right LISTMONK_LIST_ID per
 *      env file.
 *
 * Returns the materialized state the caller renders into env files
 * plus per-resource event records the run-ledger consumes.
 */

import {
  type ListmonkAuth,
  type ListmonkList,
  applySesSmtpToListmonk,
  createListmonkList,
  listListmonkLists,
} from "./listmonk.js";
import {
  type CreatedDnsRecord,
  type PublishDnsRecord,
  publishDnsRecordsToCloudflare,
} from "./cloudflare-dns-publish.js";
import {
  type SesAuth,
  type SesIdentity,
  createSesDomain,
  enableSesFeedbackNotifications,
  sesSmtpCredentials,
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
  /** Enable SES SNS feedback notifications on the identity. Off by
   *  default — turning this on is a 2-step process (the SNS topic
   *  has to exist first), so most users will wire it later. */
  enableFeedback?: boolean;
  /** Pre-resolved SES + Listmonk credentials. When omitted the
   *  orchestrator falls back to the global config (ensureSes /
   *  ensureListmonk). Tests pass overrides to avoid keychain. */
  sesAuth?: SesAuth;
  listmonkAuth?: ListmonkAuth;
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
}

export interface ListmonkSesProvisionResult {
  ses: SesIdentity;
  smtp: ReturnType<typeof sesSmtpCredentials>;
  fromEmail: string;
  liveList: ListmonkList;
  testList: ListmonkList;
  dnsPublish: {
    zoneId: string;
    zoneName: string;
    createdRecords: CreatedDnsRecord[];
    mergedSpf: Array<{ name: string }>;
  } | null;
  /** Whether Listmonk's runtime SMTP settings + from-email got auto-
   *  configured via `/api/settings` PUT this run. `false + reason` lets
   *  the caller surface the manual-paste fallback when the API user
   *  lacked `Settings: All` permission. */
  smtpApplied: { written: boolean; reason?: string };
}

/** Compute the sending subdomain hatchkit uses for this project's SES
 *  identity — `mail.<domain>`. Kept as a named function so renames are
 *  trivial and so destroy can produce the same name from a manifest
 *  without depending on the orchestrator. */
export function sesSendingSubdomain(projectDomain: string): string {
  return `mail.${projectDomain}`;
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

  // 2. Optional: enable SNS feedback notifications. Best-effort —
  //    failing here doesn't block the rest of the provision.
  if (opts.enableFeedback) {
    try {
      await enableSesFeedbackNotifications(sendingDomain, opts.sesAuth);
    } catch (err) {
      console.warn(
        `  SES feedback notifications could not be enabled on ${sendingDomain}: ${
          (err as Error).message
        }`,
      );
    }
  }

  // 3. DKIM publish into Cloudflare. Skipped when the caller already
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

  // 5. SMTP credentials are deterministic from the SES IAM secret +
  //    region — derive them now so the env-render step has the values
  //    without a second round-trip.
  let smtp: ListmonkSesProvisionResult["smtp"];
  if (opts.sesAuth) {
    smtp = sesSmtpCredentials(opts.sesAuth);
  } else {
    const { ensureSes } = await import("../config.js");
    const cfg = await ensureSes();
    smtp = sesSmtpCredentials({
      region: cfg.region,
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    });
  }

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

  return {
    ses: identity,
    smtp,
    fromEmail,
    liveList,
    testList,
    dnsPublish,
    smtpApplied,
  };
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
  const created = await createListmonkList(name, {
    type: "private",
    optin: "single",
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
  smtpHost: string;
  smtpPort: number;
  smtpUsername: string;
  smtpPassword: string;
  fromEmail: string;
  region: string;
}

/** Render the env quartets for prod vs dev. Both surfaces share
 *  identical LISTMONK_URL / LISTMONK_API_USER / LISTMONK_API_TOKEN /
 *  SES_SMTP_* values; the only thing that differs is which list id
 *  receives broadcasts. Mirrors the Resend audience-split pattern. */
export function renderListmonkSesEnv(opts: RenderListmonkSesEnvOptions): {
  prod: string[];
  dev: string[];
} {
  const shared = [
    `LISTMONK_URL=${opts.listmonkUrl}`,
    `LISTMONK_API_USER=${opts.listmonkApiUser}`,
    `LISTMONK_API_TOKEN=${opts.listmonkApiToken}`,
    `SES_SMTP_HOST=${opts.smtpHost}`,
    `SES_SMTP_PORT=${opts.smtpPort}`,
    `SES_SMTP_USERNAME=${opts.smtpUsername}`,
    `SES_SMTP_PASSWORD=${opts.smtpPassword}`,
    `SES_FROM_EMAIL=${opts.fromEmail}`,
    `SES_REGION=${opts.region}`,
  ];
  return {
    prod: [...shared, `LISTMONK_LIST_ID=${opts.liveListId}`],
    dev: [...shared, `LISTMONK_LIST_ID=${opts.testListId}`],
  };
}
