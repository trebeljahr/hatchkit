/*
 * migrate-domain — the plan.
 *
 * Everything in this file is PURE. It reads a manifest plus a set of
 * "is this provider configured on this machine" booleans and returns
 * the list of actions a live migration would take. No network, no fs,
 * no prompts — so `--dry-run` and the real run compute the identical
 * plan, and the whole decision table is unit-testable without mocking
 * seven provider SDKs.
 *
 * ============================================================
 * WHY THREE PHASES AND NOT ONE
 * ============================================================
 *
 * A domain migration is not a rename. `rename-domain` swaps a string
 * in three files and is done; the provider identities that carry the
 * domain — a SES sending identity, an R2 custom domain, a Search
 * Console property — cannot be swapped, only created and retired, and
 * the creation half takes minutes-to-hours of out-of-band verification
 * that nothing local can hurry along:
 *
 *   · SES will not let you send from `mail.<new>` until it has seen the
 *     three DKIM CNAMEs in DNS. That is a poll, not a call.
 *   · An R2 custom domain does not serve HTTPS until Cloudflare has
 *     issued the certificate for it.
 *   · Google will not verify a Search Console property until the TXT
 *     row propagates.
 *
 * So the plan is split:
 *
 *   prepare  — additive only. Create the new identity ALONGSIDE the old
 *              one. Nothing that currently works stops working. Safe to
 *              run days before the actual switch, and safe to re-run.
 *   cutover  — flip the pointers: the FROM address, the assets origin,
 *              the webhook URL, the Coolify FQDN. Every action here is
 *              gated on the corresponding prepare step having verified,
 *              so `hatchkit migrate-domain --phase cutover` refuses
 *              rather than breaking email for a day because SES was
 *              still PENDING.
 *   cleanup  — retire the old side. Explicitly invoked, never implied.
 *              Runs only after the operator has seen the new side work.
 *
 * The alternative — destroy-then-create — has a window where neither
 * identity exists, and that window is however long AWS/Cloudflare/Google
 * feel like taking. This ordering has no such window.
 *
 * ============================================================
 * WHY EACH PROVIDER RE-DERIVES ITS OWN "CURRENT"
 * ============================================================
 *
 * There is no single `oldDomain` field to migrate away from. A project
 * that was half-migrated by hand — which is the case this command
 * exists for — has a manifest whose `domain` is already the NEW domain
 * while `ses.identity` and `s3Buckets.assets.publicUrl` still name the
 * OLD one. `tracktime` is exactly that:
 *
 *     domain:                  trackyourtime.dev          (new)
 *     ses.identity:            mail.tracktime.trebeljahr.com   (old)
 *     assets.publicUrl:  https://assets.tracktime.trebeljahr.com (old)
 *
 * So every planner below compares ITS OWN recorded state against what
 * the new domain implies, and emits a no-op when they already agree.
 * That makes resume free: re-running after a partial migration plans
 * only the parts that are still behind. `oldDomain` is used for two
 * things and no more — the file-rewrite phase, and naming the cleanup
 * targets.
 *
 * The cleanup targets are the exception to "compare current against
 * desired". After cutover every recorded field already names the new
 * domain, so current == desired and a planner that only looked at that
 * would conclude there is nothing left to retire — while `mail.<old>`
 * and `assets.<old>` are still very much alive. Nothing in the manifest
 * remembers them at that point, so the operator names the old domain
 * with `--from`, and the retire actions are planned from `oldDomain`
 * alone. Their executors are idempotent (an already-deleted identity is
 * a skip), so planning them on every `--from` run costs nothing.
 */

import { STATIC_FORWARD_PRESETS } from "../email/presets.js";
import type { EmailRoutingFacts } from "../email/routing-access.js";
import { sesSendingSubdomain } from "../provision/listmonk-ses.js";
import { defaultBucketHostname, existingCustomHostname } from "../provision/s3-buckets.js";
import { sesMailFromSubdomain } from "../provision/ses.js";
import type { ProjectManifest } from "../scaffold/manifest.js";

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type MigrationPhase = "prepare" | "cutover" | "cleanup";

/** Provider slug. Doubles as the `--only <provider>` selector and as
 *  the deferral-key namespace (`migrate:<provider>`). */
export type MigrationProvider =
  | "files"
  | "dns"
  | "coolify"
  | "ses"
  | "email-routing"
  | "listmonk"
  | "r2"
  | "plausible"
  | "search-console"
  | "stripe"
  | "manual";

export type ActionKind =
  /** Additive: brings something new into existence next to the old. */
  | "create"
  /** In-place pointer flip. The moment traffic/mail actually moves. */
  | "update"
  /** Destructive: removes the old side. Cleanup phase only. */
  | "retire"
  /** Already correct — printed so the plan accounts for everything,
   *  never executed. */
  | "noop"
  /** Hatchkit has no API for this. Printed as a checklist item. */
  | "manual";

export interface MigrationAction {
  provider: MigrationProvider;
  /** Stable, unique within a plan. Used by `--only` (via provider) and
   *  as the deferral key so a failed step resumes as itself. */
  id: string;
  phase: MigrationPhase;
  kind: ActionKind;
  /** One line for the plan table. */
  summary: string;
  /** Extra lines rendered under the summary, dimmed. */
  detail?: string[];
  /** Precondition re-checked at execute time. Present on cutover
   *  actions whose prepare step verifies asynchronously — the executor
   *  refuses (and defers) rather than proceeding when it fails. */
  gate?: string;
}

export interface MigrationPlan {
  projectName: string;
  oldDomain: string;
  newDomain: string;
  /** Where `oldDomain` came from. Worth printing: on a half-migrated
   *  project it is NOT `manifest.domain`, and the operator should see
   *  which field the command trusted. */
  oldDomainSource: string;
  actions: MigrationAction[];
}

/** Which global providers have usable credentials on this machine.
 *  A missing credential does not drop the step — it downgrades it to
 *  `manual`, so the plan still shows the full blast radius. */
export type ConfiguredProviders = Partial<Record<MigrationProvider, boolean>>;

export interface MigrationPlanInput {
  manifest: ProjectManifest;
  newDomain: string;
  oldDomain: string;
  oldDomainSource: string;
  configured: ConfiguredProviders;
  /** Plan the cleanup phase too. Off by default — retiring the old side
   *  is a separate, explicitly-invoked decision. */
  includeCleanup?: boolean;
  /** Live Email Routing state for both sides, read (GET-only) by the
   *  orchestrator before planning. Absent when nothing was probed — the
   *  planner then plans the step and lets the idempotent executor find
   *  out. */
  emailRouting?: { newDomain?: EmailRoutingFacts; oldDomain?: EmailRoutingFacts };
}

// ---------------------------------------------------------------------------
// Old-domain inference
// ---------------------------------------------------------------------------

/** Strip a known leading label off a hostname, or return null when it
 *  isn't there. `unprefix("mail.a.b", "mail")` → `"a.b"`. */
function unprefix(host: string, label: string): string | null {
  const prefix = `${label}.`;
  return host.startsWith(prefix) ? host.slice(prefix.length) : null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Work out which domain we are migrating AWAY from.
 *
 * `manifest.domain` is the obvious answer and the right one for a
 * migration that hasn't started. It is the WRONG one the moment
 * `rename-domain` has already run (or the user edited the manifest),
 * because then `manifest.domain` IS the new domain and the actual old
 * domain survives only inside the provider identities.
 *
 * So: prefer `manifest.domain` when it still differs from the target,
 * and otherwise recover the old domain from whichever identity is
 * lagging. Returns null when nothing anywhere names a different domain
 * — which means there is genuinely nothing to migrate.
 */
export function inferOldDomain(
  manifest: Pick<ProjectManifest, "domain" | "ses" | "s3Buckets">,
  newDomain: string,
): { domain: string; source: string } | null {
  const target = newDomain.trim().toLowerCase();

  const declared = manifest.domain?.trim().toLowerCase();
  if (declared && declared !== target) {
    return { domain: declared, source: "manifest.domain" };
  }

  const identity = manifest.ses?.identity?.trim().toLowerCase();
  if (identity) {
    const fromSes = unprefix(identity, "mail");
    if (fromSes && fromSes !== target) {
      return { domain: fromSes, source: "manifest.ses.identity" };
    }
  }

  const assetsHost = manifest.s3Buckets?.assets?.publicUrl
    ? hostOf(manifest.s3Buckets.assets.publicUrl)
    : null;
  // An r2.dev managed URL carries no project domain — skip it rather
  // than inferring "pub-<hash>.r2" as somebody's old domain.
  if (assetsHost && !assetsHost.endsWith(".r2.dev")) {
    const fromAssets = unprefix(assetsHost, "assets");
    if (fromAssets && fromAssets !== target) {
      return { domain: fromAssets, source: "manifest.s3Buckets.assets.publicUrl" };
    }
  }

  return null;
}

/** True when this plan moves between two different domains. False for
 *  a settled project re-planned without `--from`, where `oldDomain`
 *  falls back to `manifest.domain` — which is already the target. */
function isMigrating(input: MigrationPlanInput): boolean {
  return input.oldDomain.trim().toLowerCase() !== input.newDomain.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Per-provider planners
//
// Each takes the manifest + the target domain and answers one question:
// "what would have to happen for THIS provider to be on the new
// domain?". They never consult each other, and they always emit at
// least one action (a `noop` when there's nothing to do) so the plan
// table doubles as an inventory of everything that was considered.
// ---------------------------------------------------------------------------

/** Wrap a step as `manual` when the credential for it isn't on this
 *  machine. Keeps the row in the plan (so the blast radius stays
 *  honest) while making clear hatchkit won't be the one doing it. */
function gatedOnCredential(
  action: MigrationAction,
  configured: boolean | undefined,
  setupCommand: string,
): MigrationAction {
  if (configured !== false) return action;
  return {
    ...action,
    kind: "manual",
    detail: [...(action.detail ?? []), `not configured here — run \`${setupCommand}\` first`],
  };
}

/**
 * Local files. Delegates to `rename-domain`, which already knows every
 * file hatchkit owns that hard-codes the domain (manifest, tfvars,
 * Coolify stack env, CI client build-args). Duplicating that list here
 * would guarantee the two drift.
 */
export function planFiles(input: MigrationPlanInput): MigrationAction[] {
  const current = input.manifest.domain?.trim().toLowerCase();
  if (current === input.newDomain.trim().toLowerCase()) {
    return [
      {
        provider: "files",
        id: "files:rewrite",
        phase: "prepare",
        kind: "noop",
        summary: `manifest + tfvars + stack env already on ${input.newDomain}`,
      },
    ];
  }
  return [
    {
      provider: "files",
      id: "files:rewrite",
      phase: "prepare",
      kind: "update",
      summary: `rewrite local files ${input.oldDomain} → ${input.newDomain}`,
      detail: [
        ".hatchkit.json, infra tfvars, infra/stacks/<name>.env, CI client build-args",
        "runs `hatchkit rename-domain` — review the git diff afterwards",
      ],
    },
  ];
}

/** DNS records for the new hostnames. `dns publish` is already the
 *  reconciler for this and is idempotent per hostname, so the action is
 *  just "call it". Additive: publishing A/AAAA for the new hostnames
 *  leaves the old ones answering. */
export function planDns(input: MigrationPlanInput): MigrationAction[] {
  const hosts = [input.newDomain, ...(input.manifest.aliases ?? [])];
  return [
    gatedOnCredential(
      {
        provider: "dns",
        id: "dns:publish",
        phase: "prepare",
        kind: "create",
        summary: `publish A/AAAA for ${hosts.length} hostname(s) at the Coolify box`,
        detail: [hosts.join(", ")],
      },
      input.configured.dns,
      "hatchkit config add dns",
    ),
  ];
}

/** Coolify routing. `sync` pushes `domain` + `aliases[]` onto the app's
 *  `docker_compose_domains`, which is what makes Traefik answer for the
 *  new hostname and request a certificate. This is a cutover step, not
 *  a prepare one: Coolify's Domain field is a replace, not an append —
 *  the moment it lands the old hostname stops routing. */
export function planCoolify(input: MigrationPlanInput): MigrationAction[] {
  if (input.manifest.deploymentMode === "gh-pages") {
    return [
      {
        provider: "coolify",
        id: "coolify:sync",
        phase: "cutover",
        kind: "manual",
        summary: "GitHub Pages deployment — update the CNAME file, not Coolify",
        detail: [`set the repo's CNAME to ${input.newDomain} and re-run \`hatchkit gh-pages\``],
      },
    ];
  }
  return [
    gatedOnCredential(
      {
        provider: "coolify",
        id: "coolify:sync",
        phase: "cutover",
        kind: "update",
        summary: `point the Coolify app's domain(s) at ${input.newDomain}`,
        detail: [
          "runs `hatchkit sync` — Coolify's Domain field is a replace, so the",
          "old hostname stops routing at this moment. New TLS cert: 1-3 min.",
          "Rebuild the client image afterwards — NEXT_PUBLIC_* URLs are baked in.",
        ],
      },
      input.configured.coolify,
      "hatchkit config add coolify",
    ),
  ];
}

/**
 * SES. The long pole, and the reason the whole command is phased.
 *
 * A SES sending identity is not renameable — `mail.<old>` and
 * `mail.<new>` are two independent identities, each with its own DKIM
 * key pair and its own MAIL FROM attribute. The new one is useless
 * until AWS has seen its three DKIM CNAMEs in the new zone, which is a
 * poll on AWS's schedule.
 *
 * So: create + publish DKIM + set MAIL FROM in `prepare`; switch the
 * FROM address only in `cutover`, gated on the new identity reporting
 * `VerifiedForSendingStatus: true`. Sending from an unverified identity
 * is not a soft failure — SES rejects the message outright.
 */
export function planSes(input: MigrationPlanInput): MigrationAction[] {
  const wantsEmail =
    !!input.manifest.ses ||
    input.manifest.email?.transactional === "listmonk-ses" ||
    input.manifest.email?.mailingList === "listmonk-ses";
  if (!wantsEmail) {
    return [
      {
        provider: "ses",
        id: "ses:identity",
        phase: "prepare",
        kind: "noop",
        summary: "no SES identity for this project",
      },
    ];
  }

  const current = input.manifest.ses?.identity ?? sesSendingSubdomain(input.manifest.domain);
  const desired = sesSendingSubdomain(input.newDomain);
  const oldIdentity = sesSendingSubdomain(input.oldDomain);
  const retire: MigrationAction = {
    provider: "ses",
    id: "ses:retire",
    phase: "cleanup",
    kind: "retire",
    summary: `delete SES identity ${oldIdentity}`,
    detail: [
      "also deletes the DKIM CNAMEs and the MAIL FROM MX/SPF rows",
      "hatchkit published for it (matched by content, not just name)",
      "in-flight bounces addressed to the old MAIL FROM stop being",
      "delivered — leave a few days between cutover and this",
      "refuses while SES_FROM_EMAIL / LISTMONK_FROM still name it",
    ],
  };

  if (current.toLowerCase() === desired.toLowerCase()) {
    const actions: MigrationAction[] = [
      {
        provider: "ses",
        id: "ses:identity",
        phase: "prepare",
        kind: "noop",
        summary: `SES identity already ${desired}`,
      },
    ];
    // Cut over already — but only in the manifest, as far as a pure
    // planner can tell. The env files the app sends from may still name
    // the old identity (older hatchkit moved only the manifest), so a
    // `--from` run re-checks them. Idempotent: nothing left to move is
    // a skip.
    if (isMigrating(input)) {
      actions.push({
        provider: "ses",
        id: "ses:cutover",
        phase: "cutover",
        kind: "update",
        summary: `make sure the app's from-address is on ${desired}`,
        detail: [`SES_FROM_EMAIL / LISTMONK_FROM: @${oldIdentity} → @${desired}, if still there`],
        gate: `SES reports VerifiedForSendingStatus=true for ${desired}`,
      });
      if (input.includeCleanup) actions.push(retire);
    }
    return actions;
  }

  const label = input.manifest.ses?.mailFromLabel ?? "bounce";
  const newMailFrom = sesMailFromSubdomain(desired, label);
  const actions: MigrationAction[] = [
    gatedOnCredential(
      {
        provider: "ses",
        id: "ses:identity",
        phase: "prepare",
        kind: "create",
        summary: `create SES identity ${desired} (alongside ${current})`,
        detail: [
          "publishes 3 DKIM CNAMEs into the new zone",
          `sets MAIL FROM ${newMailFrom} + its MX and SPF TXT`,
          "the old identity keeps sending until cutover",
        ],
      },
      input.configured.ses,
      "hatchkit config add ses",
    ),
    {
      provider: "ses",
      id: "ses:cutover",
      phase: "cutover",
      kind: "update",
      summary: `switch the sending identity to ${desired}`,
      detail: [
        `manifest.ses.identity: ${current} → ${desired}`,
        `SES_FROM_EMAIL / LISTMONK_FROM in the env files: @${current} → @${desired}`,
      ],
      gate: `SES reports VerifiedForSendingStatus=true for ${desired}`,
    },
  ];

  if (input.includeCleanup) actions.push(retire);
  return actions;
}

/**
 * Listmonk's `app.from_email`. Separate from the SES step because it is
 * a different system that merely happens to quote the SES identity.
 *
 * Note the trap: `applySesSmtpToListmonk` short-circuits when the SMTP
 * host/user/password already match, and the from-email is only written
 * on the far side of that check. A domain migration keeps the same IAM
 * key, so the SMTP block always matches and that helper would be a
 * silent no-op — the FROM address would never move. The executor uses
 * `setListmonkFromEmail` instead, which writes only that field.
 */
export function planListmonk(input: MigrationPlanInput): MigrationAction[] {
  const usesListmonk =
    input.manifest.email?.transactional === "listmonk-ses" ||
    input.manifest.email?.mailingList === "listmonk-ses";
  if (!usesListmonk) {
    return [
      {
        provider: "listmonk",
        id: "listmonk:from",
        phase: "cutover",
        kind: "noop",
        summary: "project does not use Listmonk",
      },
    ];
  }
  const current = input.manifest.ses?.identity ?? sesSendingSubdomain(input.manifest.domain);
  const desired = sesSendingSubdomain(input.newDomain);
  if (current.toLowerCase() === desired.toLowerCase()) {
    return [
      {
        provider: "listmonk",
        id: "listmonk:from",
        phase: "cutover",
        kind: "noop",
        summary: `Listmonk from-address already on ${desired}`,
      },
    ];
  }
  return [
    gatedOnCredential(
      {
        provider: "listmonk",
        id: "listmonk:from",
        phase: "cutover",
        kind: "update",
        summary: `Listmonk from-address noreply@${current} → noreply@${desired}`,
        detail: ["SMTP relay credentials are unchanged — only app.from_email moves"],
        gate: `SES reports VerifiedForSendingStatus=true for ${desired}`,
      },
      input.configured.listmonk,
      "hatchkit config add listmonk",
    ),
  ];
}

/**
 * Cloudflare Email Routing — inbound mail on the new domain.
 *
 * The SES steps move OUTBOUND mail. Nothing else makes `@<new>` able to
 * RECEIVE mail, and a migrated site whose legal notice names
 * `imprint@<new>` is advertising an address that bounces (the
 * collection-of-beauty migration shipped exactly that: no MX at all on
 * the new apex). So this plans the same work `hatchkit email setup`
 * does, non-interactively, on the new domain.
 *
 * Additive: it only adds MX/SPF/DMARC and rules on the NEW zone, and it
 * stands down when the new domain's MX already points at another mail
 * provider — Cloudflare MX next to Google's would split delivery. There
 * is deliberately no retire step: the old side is often a subdomain of
 * a shared zone (`beauty.trebeljahr.com` lives in `trebeljahr.com`)
 * whose routing serves far more than this project.
 *
 * When to plan it rather than no-op:
 *   · the manifest records forwarding (`integrations.email`), or
 *   · Email Routing is on for the old domain's zone, or
 *   · the state can't be read (token scope, not probed) — the executor
 *     re-probes and either skips or fails with the fix, which beats
 *     silently deciding a legal contact doesn't need to work.
 */
export function planEmailRouting(input: MigrationPlanInput): MigrationAction[] {
  const newDomain = input.newDomain.trim().toLowerCase();
  const facts: EmailRoutingFacts = input.emailRouting?.newDomain ?? {
    state: "unknown",
    reason: "not probed",
  };
  const old = input.emailRouting?.oldDomain;
  const recorded = input.manifest.integrations?.email;
  const base = { provider: "email-routing", id: "email-routing:setup", phase: "prepare" } as const;

  if (facts.state === "receiving") {
    return [
      { ...base, kind: "noop", summary: `Email Routing already receives mail for ${newDomain}` },
    ];
  }
  if (facts.state === "foreign-mx") {
    return [
      {
        ...base,
        kind: "noop",
        summary: `inbound mail for ${newDomain} already goes to ${facts.mxHosts.join(", ")}`,
        detail: [
          "Email Routing left alone — Cloudflare MX beside another provider's splits delivery",
        ],
      },
    ];
  }

  const oldUsesRouting =
    old?.state === "receiving" || (old?.state === "not-receiving" && old.enabled);
  const unreadable = facts.state === "unauthorized" || facts.state === "unknown";
  if (!recorded && !oldUsesRouting && !unreadable) {
    return [
      {
        ...base,
        kind: "noop",
        summary: `no inbound mail to carry over — ${input.oldDomain} has no Email Routing`,
        detail: [
          `mail to @${newDomain} bounces until you run \`hatchkit email setup --domain ${newDomain}\``,
        ],
      },
    ];
  }

  const why = recorded
    ? `forwarding recorded for ${recorded.domain} in .hatchkit.json`
    : oldUsesRouting && old && "zone" in old
      ? `Email Routing is on for ${old.zone}, which serves ${input.oldDomain}`
      : facts.state === "unauthorized"
        ? `could not read Email Routing on ${facts.zone} — the DNS token lacks the scopes`
        : "Email Routing state not read — the step checks the zone first";
  const rules = recorded?.addresses
    ? recorded.addresses.length > 0
      ? recorded.addresses.map((a) => `${a}@`).join(", ")
      : "(none)"
    : `those on @${input.oldDomain}, else the defaults (${STATIC_FORWARD_PRESETS.filter(
        (p) => p.defaultChecked,
      )
        .map((p) => `${p.localPart}@`)
        .join(", ")})`;
  const detail = [
    why,
    `enables routing, verifies ${recorded?.destinationEmail ?? "the saved forwarding destination"}`,
    "MX + SPF (existing includes kept) + DMARC (an existing one is kept)",
    `rules: ${rules}; catch-all ${(recorded?.catchAll ?? true) ? "on" : "off"}`,
  ];
  if (facts.state === "unauthorized") {
    detail.push(
      "needs Zone → Email Routing Rules → Edit + Account → Email Routing Addresses → Edit on the DNS token",
    );
  }

  return [
    gatedOnCredential(
      {
        ...base,
        kind: "create",
        summary: `set up Cloudflare Email Routing so mail to @${newDomain} is forwarded`,
        detail,
      },
      input.configured.dns,
      "hatchkit config add dns",
    ),
  ];
}

/**
 * R2 assets bucket custom domain.
 *
 * R2 allows several custom domains on one bucket, which is what makes
 * the additive shape possible: attach `assets.<new>` while
 * `assets.<old>` is still serving, wait for Cloudflare to issue the
 * certificate, then move `publicUrl` and let the old one linger until
 * cleanup. Every already-deployed client bundle keeps resolving its
 * baked-in `assets.<old>` URL through the whole transition.
 *
 * The CORS origin list moves with the WEB origin, not the bucket
 * hostname — it lists who may fetch, which is `https://<newDomain>`.
 * `reconcileAssetsCorsFromManifest` recomputes it from the manifest, so
 * that half is a re-run of existing code once the manifest is rewritten.
 */
export function planR2(input: MigrationPlanInput): MigrationAction[] {
  const assets = input.manifest.s3Buckets?.assets;
  if (!assets?.name) {
    return [
      {
        provider: "r2",
        id: "r2:custom-domain",
        phase: "prepare",
        kind: "noop",
        summary: "no assets bucket for this project",
      },
    ];
  }

  const currentHost = existingCustomHostname(input.manifest as ProjectManifest);
  const desiredHost = defaultBucketHostname(input.newDomain);
  const oldHost = defaultBucketHostname(input.oldDomain);
  const cleanup = input.includeCleanup && isMigrating(input);
  const corsCleanup = cleanup ? planR2CorsCleanup(input) : [];

  if (!currentHost) {
    return [
      {
        provider: "r2",
        id: "r2:custom-domain",
        phase: "prepare",
        kind: "noop",
        summary: `${assets.name} serves from a managed r2.dev URL — no custom domain to move`,
        detail: [`attach one with \`hatchkit provision s3\` if you want ${desiredHost}`],
      },
      ...corsCleanup,
    ];
  }

  if (currentHost.toLowerCase() === desiredHost.toLowerCase()) {
    return [
      {
        provider: "r2",
        id: "r2:custom-domain",
        phase: "prepare",
        kind: "noop",
        summary: `assets bucket already on ${desiredHost}`,
      },
      ...corsCleanup,
      // publicUrl already moved, so nothing recorded names the old host
      // any more — it is derived from `--from`. The executor treats a
      // host that isn't attached as a skip.
      ...(cleanup ? [r2RetireAction(assets.name, oldHost)] : []),
    ];
  }

  const actions: MigrationAction[] = [
    gatedOnCredential(
      {
        provider: "r2",
        id: "r2:custom-domain",
        phase: "prepare",
        kind: "create",
        summary: `attach ${desiredHost} to bucket ${assets.name} (alongside ${currentHost})`,
        detail: [
          "R2 buckets accept multiple custom domains, so both serve at once",
          "deployed client bundles keep resolving the old hostname",
        ],
      },
      input.configured.r2,
      "hatchkit config add s3 r2",
    ),
    {
      provider: "r2",
      id: "r2:publicurl",
      phase: "cutover",
      kind: "update",
      summary: `assets publicUrl → https://${desiredHost}`,
      detail: [
        "rewrites the manifest and the *_ASSETS_BASE_URL env entry",
        `CORS origins recomputed for https://${input.newDomain} (https://${input.oldDomain} kept until cleanup)`,
        "the client image must be rebuilt for this to reach browsers",
      ],
      gate: `Cloudflare reports the certificate for ${desiredHost} as active`,
    },
  ];

  actions.push(...corsCleanup);
  if (input.includeCleanup) actions.push(r2RetireAction(assets.name, oldHost));
  return actions;
}

function r2RetireAction(bucket: string, oldHost: string): MigrationAction {
  return {
    provider: "r2",
    id: "r2:retire",
    phase: "cleanup",
    kind: "retire",
    summary: `detach ${oldHost} from bucket ${bucket}`,
    detail: [
      "any client bundle still baked with the old URL 404s from here on",
      "wait until the rebuilt image is live everywhere",
    ],
  };
}

/** The old web origin on the assets bucket's CORS rule. Prepare and
 *  cutover keep it there on purpose, so the old site keeps loading its
 *  assets until the operator retires it. A no-op when the recorded rule
 *  shows it already gone, or when CORS is not hatchkit's to manage. */
function planR2CorsCleanup(input: MigrationPlanInput): MigrationAction[] {
  const assets = input.manifest.s3Buckets?.assets;
  const cors = assets?.cors;
  if (!assets?.name || cors?.skipped === true) return [];
  const oldOrigin = `https://${input.oldDomain.trim().toLowerCase()}`;
  const names = (list?: string[]) =>
    (list ?? []).some((o) => o.trim().replace(/\/+$/, "").toLowerCase() === oldOrigin);
  // No recorded origin list means hatchkit never saw the live rule —
  // plan the reconcile rather than guess it is clean.
  const recorded = cors?.origins !== undefined || cors?.extraOrigins !== undefined;
  if (recorded && !names(cors?.origins) && !names(cors?.extraOrigins)) {
    return [
      {
        provider: "r2",
        id: "r2:cors-retire",
        phase: "cleanup",
        kind: "noop",
        summary: `bucket CORS no longer lists ${oldOrigin}`,
      },
    ];
  }
  return [
    {
      provider: "r2",
      id: "r2:cors-retire",
      phase: "cleanup",
      kind: "retire",
      summary: `remove ${oldOrigin} from ${assets.name} CORS origins`,
      detail: ["the old site can no longer fetch assets cross-origin from here on"],
    },
  ];
}

/** Plausible. The one provider with a real rename: a PUT on the site
 *  moves the domain and keeps the stats history, so there is nothing to
 *  prepare and nothing to clean up. */
export function planPlausible(input: MigrationPlanInput): MigrationAction[] {
  if (!input.manifest.features.includes("analytics")) {
    return [
      {
        provider: "plausible",
        id: "plausible:rename",
        phase: "cutover",
        kind: "noop",
        summary: "project has no analytics feature",
      },
    ];
  }
  return [
    gatedOnCredential(
      {
        provider: "plausible",
        id: "plausible:rename",
        phase: "cutover",
        kind: "update",
        summary: `rename Plausible site ${input.oldDomain} → ${input.newDomain}`,
        detail: ["history-preserving PUT — no new site, no lost stats"],
      },
      input.configured.plausible,
      "hatchkit config add plausible",
    ),
  ];
}

/** Search Console. A property's domain is its identity — Google has no
 *  rename. So: add the new property in prepare (its own DNS TXT +
 *  verification poll), and delete the old one in cleanup. The two never
 *  interfere, so there is no cutover step. */
export function planSearchConsole(input: MigrationPlanInput): MigrationAction[] {
  const existing = input.manifest.integrations?.searchConsole;
  if (!existing) {
    return [
      {
        provider: "search-console",
        id: "search-console:create",
        phase: "prepare",
        kind: "noop",
        summary: "no Search Console property recorded for this project",
      },
    ];
  }
  if (existing.domain.toLowerCase() === input.newDomain.toLowerCase()) {
    return [
      {
        provider: "search-console",
        id: "search-console:create",
        phase: "prepare",
        kind: "noop",
        summary: `Search Console property already sc-domain:${input.newDomain}`,
      },
    ];
  }
  const actions: MigrationAction[] = [
    gatedOnCredential(
      {
        provider: "search-console",
        id: "search-console:create",
        phase: "prepare",
        kind: "create",
        summary: `add Search Console property sc-domain:${input.newDomain}`,
        detail: [
          "publishes the verification TXT and polls Google until it verifies",
          "the old property keeps collecting until you retire it",
        ],
      },
      input.configured["search-console"],
      "hatchkit config add search-console",
    ),
  ];
  if (input.includeCleanup) {
    actions.push({
      provider: "search-console",
      id: "search-console:retire",
      phase: "cleanup",
      kind: "retire",
      summary: `remove Search Console property sc-domain:${existing.domain}`,
      detail: ["historical data for the old property is dropped by Google, not archived"],
    });
  }
  return actions;
}

/** Stripe webhook endpoints. Updating an endpoint's URL keeps its
 *  signing secret, so nothing in `.env` has to change and there is no
 *  window where an event arrives signed by a key the app doesn't hold.
 *  That makes this a pure cutover step with no prepare and no cleanup. */
export function planStripe(input: MigrationPlanInput): MigrationAction[] {
  if (!input.manifest.features.includes("stripe")) {
    return [
      {
        provider: "stripe",
        id: "stripe:webhook",
        phase: "cutover",
        kind: "noop",
        summary: "project has no stripe feature",
      },
    ];
  }
  return [
    gatedOnCredential(
      {
        provider: "stripe",
        id: "stripe:webhook",
        phase: "cutover",
        kind: "update",
        summary: `webhook URL → https://${input.newDomain}/api/stripe/webhook`,
        detail: [
          "test + live endpoints, whichever hatchkit registered",
          "the whsec_ signing secret survives the update — no env rewrite",
        ],
      },
      input.configured.stripe,
      "hatchkit config add stripe",
    ),
  ];
}

/**
 * The honest list. Each of these is something a domain migration
 * genuinely requires and hatchkit genuinely cannot do, with the reason
 * why rather than a vague "check your settings".
 */
export function planManual(input: MigrationPlanInput): MigrationAction[] {
  const { baseDomain } = splitApex(input.newDomain);
  const out: MigrationAction[] = [
    {
      provider: "manual",
      id: "manual:zone",
      phase: "prepare",
      kind: "manual",
      summary: `the Cloudflare zone ${baseDomain} must already exist`,
      detail: [
        "hatchkit has no create-zone path: CloudflareApi has no POST /zones,",
        'the terraform module uses a `data "cloudflare_zone"` lookup, and the',
        "standard DNS token lacks com.cloudflare.api.account.zone.create.",
        "Add the zone in the dashboard, then `hatchkit dns link-to-cloudflare`",
        "to point the registrar's NS at Cloudflare.",
      ],
    },
    {
      provider: "manual",
      id: "manual:oauth",
      phase: "cutover",
      kind: "manual",
      summary: "OAuth redirect URIs at Google / GitHub / Discord",
      detail: [
        "these live in consoles with no API suitable for it — add the new",
        `https://${input.newDomain}/... callback BEFORE cutover and remove the`,
        "old one after, so neither login breaks mid-migration",
      ],
    },
    {
      provider: "manual",
      id: "manual:code",
      phase: "cutover",
      kind: "manual",
      summary: `grep the app for hardcoded ${input.oldDomain}`,
      detail: ["README, OG tags, sitemap, canonical URLs, seed data, docs links"],
    },
    {
      provider: "manual",
      id: "manual:www",
      phase: "cutover",
      kind: "manual",
      summary: `a www.${baseDomain} → apex redirect, if you want one`,
      detail: [
        "needs a Cloudflare redirect rule, which needs Rulesets:Edit —",
        "a permission the standard hatchkit DNS token does not carry",
      ],
    },
  ];
  return out;
}

/** Registrable apex — last two labels. Mirrors `parseDomain`'s
 *  `baseDomain`, restated locally so the plan module stays pure and
 *  dependency-light. */
function splitApex(domain: string): { baseDomain: string } {
  const parts = domain.replace(/\.$/, "").split(".");
  return { baseDomain: parts.length <= 2 ? parts.join(".") : parts.slice(-2).join(".") };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

const PLANNERS: Array<(input: MigrationPlanInput) => MigrationAction[]> = [
  planFiles,
  planManual,
  planDns,
  planSes,
  planEmailRouting,
  planR2,
  planCoolify,
  planListmonk,
  planPlausible,
  planSearchConsole,
  planStripe,
];

/** Phase ordering. `prepare` before `cutover` before `cleanup` is the
 *  whole safety property, so it is encoded once here rather than
 *  reconstructed at each call site. */
export const PHASE_ORDER: MigrationPhase[] = ["prepare", "cutover", "cleanup"];

export function planDomainMigration(input: MigrationPlanInput): MigrationPlan {
  const actions = PLANNERS.flatMap((plan) => plan(input));
  actions.sort((a, b) => PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase));
  return {
    projectName: input.manifest.name,
    oldDomain: input.oldDomain,
    newDomain: input.newDomain,
    oldDomainSource: input.oldDomainSource,
    actions,
  };
}

/** Actions this run would actually execute: the requested phase, minus
 *  no-ops and manual items, optionally narrowed to one provider. */
export function selectActions(
  plan: MigrationPlan,
  opts: { phase: MigrationPhase; only?: MigrationProvider },
): MigrationAction[] {
  return plan.actions.filter(
    (a) =>
      a.phase === opts.phase &&
      a.kind !== "noop" &&
      a.kind !== "manual" &&
      (!opts.only || a.provider === opts.only),
  );
}

/** Every provider slug a `--only` value may take. Exported so the CLI
 *  can validate the flag against one list instead of a second copy. */
export const MIGRATION_PROVIDERS: MigrationProvider[] = [
  "files",
  "dns",
  "coolify",
  "ses",
  "email-routing",
  "listmonk",
  "r2",
  "plausible",
  "search-console",
  "stripe",
];
