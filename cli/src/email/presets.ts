/*
 * Email forwarding presets.
 *
 * Default set of local-parts to offer when configuring Cloudflare Email
 * Routing on a new project's zone. The picker is multi-select so the
 * user can untick anything that doesn't apply, or add custom entries.
 *
 * Curated to cover the common public-facing aliases without bloating
 * the rule list (each rule is a distinct Email Routing entry):
 *   · hello@      — generic first-touch contact
 *   · admin@      — system / infrastructure correspondence (TLS notices,
 *                   registrar alerts, dotenvx/Github billing receipts)
 *   · support@    — customer-facing support inbox
 *   · hi@         — short personal alternative to hello@
 *   · imprint@    — the contact a legal notice (Impressum) names. Ticked
 *                   by default: a legal contact that bounces is a legal
 *                   problem, and relying on the catch-all for it breaks
 *                   the day someone turns the catch-all off.
 *   · privacy@    — data-protection contact for a privacy policy.
 *   · <personal>@ — optional, injected by {@link buildForwardPresets}
 *                   when the user has saved a personal alias in
 *                   `hatchkit setup` (or one is detected from git).
 *
 * A catch-all rule (`*@domain`) is offered separately because
 * Cloudflare's API treats it differently — it's exactly one rule per
 * zone (PUT semantics), not a list. The default is "enable catch-all"
 * so stray addresses (`careers@`, `dmarc@`, …) still reach the user.
 */

export interface EmailAddressPreset {
  /** Local part. Joined with `@<domain>` at apply time. */
  localPart: string;
  /** Human-readable description shown in the multi-select prompt. */
  description: string;
  /** Whether this preset is ticked by default in the picker. */
  defaultChecked: boolean;
}

/** Static aliases that apply to any operator — no personal data. */
export const STATIC_FORWARD_PRESETS: EmailAddressPreset[] = [
  { localPart: "hello", description: "general first-touch contact", defaultChecked: true },
  { localPart: "admin", description: "infrastructure / system alerts", defaultChecked: true },
  { localPart: "support", description: "customer-facing support", defaultChecked: true },
  { localPart: "hi", description: "short personal alias", defaultChecked: false },
  { localPart: "imprint", description: "legal notice / Impressum contact", defaultChecked: true },
  { localPart: "privacy", description: "privacy-policy / GDPR contact", defaultChecked: true },
];

/** Build the full preset list, optionally prepending a personal alias
 *  (e.g. `alice@`) configured during `hatchkit setup`. Skips the personal
 *  entry when it would duplicate one of the static aliases. */
export function buildForwardPresets(
  personalLocalPart: string | null | undefined,
): EmailAddressPreset[] {
  const normalized = personalLocalPart?.trim().toLowerCase();
  if (!normalized) return STATIC_FORWARD_PRESETS;
  const collides = STATIC_FORWARD_PRESETS.some((p) => p.localPart === normalized);
  if (collides) return STATIC_FORWARD_PRESETS;
  const personal: EmailAddressPreset = {
    localPart: normalized,
    description: "personal alias",
    defaultChecked: true,
  };
  // Place the personal alias right after `hello@` so the picker reads:
  // generic → personal → admin → support → short.
  const [hello, ...rest] = STATIC_FORWARD_PRESETS;
  return [hello, personal, ...rest];
}

/** Whether to enable a catch-all rule (`*@domain` → destination) by
 *  default. Catch-all is a safety net for anything not matched by an
 *  explicit rule — recommended for personal/operator domains. */
export const DEFAULT_CATCH_ALL = true;

/** Where {@link resolveCarriedForwarding} found the address list. */
export type CarriedForwardingSource = "manifest" | "old-domain-rules" | "defaults";

/**
 * Decide which forwarding rules a domain migration recreates on the new
 * domain. Nothing prompts during a migration, so this is the whole
 * decision, in precedence order:
 *
 *   1. What the manifest recorded when forwarding was last set up
 *      (`integrations.email.addresses` / `.catchAll`).
 *   2. The local parts that had literal rules on the OLD domain — the
 *      operator's own earlier choice, read back from Cloudflare.
 *   3. The default-ticked presets (plus the saved personal alias).
 *
 * Catch-all follows the manifest when recorded, and is otherwise the
 * usual default (on).
 */
export function resolveCarriedForwarding(input: {
  recorded?: { addresses?: string[]; catchAll?: boolean };
  oldDomainLocalParts?: string[] | null;
  personalLocalPart?: string | null;
}): { addresses: string[]; catchAll: boolean; source: CarriedForwardingSource } {
  const clean = (list: string[]) => [
    ...new Set(list.map((a) => a.trim().toLowerCase()).filter(Boolean)),
  ];
  const catchAll = input.recorded?.catchAll ?? DEFAULT_CATCH_ALL;
  if (input.recorded?.addresses !== undefined) {
    return { addresses: clean(input.recorded.addresses), catchAll, source: "manifest" };
  }
  const carried = clean(input.oldDomainLocalParts ?? []);
  if (carried.length > 0) {
    return { addresses: carried, catchAll, source: "old-domain-rules" };
  }
  return {
    addresses: buildForwardPresets(input.personalLocalPart)
      .filter((p) => p.defaultChecked)
      .map((p) => p.localPart),
    catchAll,
    source: "defaults",
  };
}
