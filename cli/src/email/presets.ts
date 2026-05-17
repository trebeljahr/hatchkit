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
