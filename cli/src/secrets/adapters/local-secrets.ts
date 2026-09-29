/*
 * cli/src/secrets/adapters/local-secrets.ts — random values hatchkit or
 * the app generated itself: `CRON_SECRET`, `NEWSLETTER_TOKEN_SECRET`,
 * `BETTER_AUTH_SECRET` / `AUTH_SECRET`.
 *
 * No upstream provider stands behind these, so there is nothing to mint
 * or revoke: the new value is 32 random bytes as hex, verify is
 * "skipped", and the old value stops working once every consumer holds
 * the new one (`revocable: false`).
 *
 * A key rotates only when it already exists in `.env.production` — the
 * adapter never introduces a secret the app does not read. Rotating one
 * is not free for users, so each key carries its consequence in
 * `sideEffects`, which the plan and `--dry-run` print.
 *
 * Keys that share a value keep sharing one. The scaffold seeds
 * `AUTH_SECRET` with the same value as `BETTER_AUTH_SECRET`
 * (scaffold/dotenvx.ts), and code reading either must agree.
 */

import { randomBytes } from "node:crypto";
import { readEncryptedProd } from "../env-writer.js";
import { register } from "../registry.js";
import type {
  EnvKeySpec,
  NewCred,
  OldCred,
  ProviderRotator,
  RotationContext,
  VerifyOutcome,
} from "../types.js";

const AUTH_EFFECT =
  "signs every user out (sessions signed with the old secret stop validating). Better Auth also encrypts two-factor (TOTP) secrets and backup codes with it, so users with an authenticator app enrolled must enroll again.";

const KEYS: ReadonlyArray<{ name: string; effect: (ctx: RotationContext) => string }> = [
  { name: "BETTER_AUTH_SECRET", effect: () => AUTH_EFFECT },
  { name: "AUTH_SECRET", effect: () => AUTH_EFFECT },
  {
    name: "NEWSLETTER_TOKEN_SECRET",
    effect: () =>
      "confirm and unsubscribe links in emails already sent stop working (their HMAC was signed with the old secret).",
  },
  {
    name: "CRON_SECRET",
    effect: (ctx) =>
      "a scheduler that calls the cron endpoint with the old secret is rejected until it holds the new one." +
      (ctx.prodEnvPresence.has("NEWSLETTER_TOKEN_SECRET")
        ? ""
        : " With no NEWSLETTER_TOKEN_SECRET set, newsletter links fall back to CRON_SECRET, so confirm and unsubscribe links already sent stop working too."),
  },
];

/** Aliases by design: when their old values can't be read, they still
 *  get one new value between them. */
const AUTH_ALIASES = new Set(["BETTER_AUTH_SECRET", "AUTH_SECRET"]);

function presentKeys(ctx: RotationContext): string[] {
  return KEYS.map((k) => k.name).filter((name) => ctx.prodEnvPresence.has(name));
}

/** Old values captured by captureOld, for the shared-value grouping. */
function oldValues(ctx: RotationContext): Record<string, string> {
  return (ctx.scratch["local-secrets"] as Record<string, string> | undefined) ?? {};
}

const localSecretsRotator: ProviderRotator = {
  name: "local-secrets",
  label: "Locally generated secrets",
  revocable: false,

  detect(ctx: RotationContext): boolean {
    return presentKeys(ctx).length > 0;
  },

  envKeys(ctx: RotationContext): ReadonlyArray<EnvKeySpec> {
    return presentKeys(ctx).map((name) => ({ name, scope: "production", secret: true }));
  },

  sideEffects(ctx: RotationContext): string[] {
    // One line per distinct consequence, naming every key it covers.
    const byEffect = new Map<string, string[]>();
    for (const k of KEYS) {
      if (!ctx.prodEnvPresence.has(k.name)) continue;
      const effect = k.effect(ctx);
      byEffect.set(effect, [...(byEffect.get(effect) ?? []), k.name]);
    }
    return [...byEffect].map(([effect, names]) => `${names.join(", ")}: ${effect}`);
  },

  async captureOld(ctx: RotationContext): Promise<OldCred> {
    const values: Record<string, string> = {};
    try {
      const env = readEncryptedProd(ctx.projectDir);
      for (const name of presentKeys(ctx)) {
        if (env[name]) values[name] = env[name];
      }
    } catch {
      // Undecryptable: nothing to roll back to; the rotation still runs.
    }
    ctx.scratch["local-secrets"] = values;
    return { values, handle: {} };
  },

  async createNew(ctx: RotationContext): Promise<NewCred> {
    const old = oldValues(ctx);
    const fresh = new Map<string, string>();
    const values: Record<string, string> = {};
    for (const name of presentKeys(ctx)) {
      const group = old[name] !== undefined ? `value:${old[name]}` : AUTH_ALIASES.has(name) ? "auth" : name;
      let value = fresh.get(group);
      if (!value) {
        value = randomBytes(32).toString("hex");
        fresh.set(group, value);
      }
      values[name] = value;
    }
    return { values, handle: {} };
  },

  async verify(): Promise<VerifyOutcome> {
    return "skipped";
  },

  async revoke(): Promise<void> {
    // Nothing upstream. The old value dies when the app redeploys.
  },
};

register(localSecretsRotator);
