/*
 * cli/src/secrets/adapters/glitchtip.ts — GlitchTip DSN rotation.
 *
 * GlitchTip is Sentry-compatible. Each "project" can hold multiple
 * "client keys" (DSNs). Rotation mints a fresh key, swaps the env
 * var, verifies via a probe event sent against the new DSN, then
 * deletes the old key by id.
 *
 * Endpoints (Sentry-compatible API surface):
 *   POST   /api/0/projects/{org}/{project-slug}/keys/        — mint key
 *   GET    /api/0/projects/{org}/{project-slug}/keys/        — list keys
 *   DELETE /api/0/projects/{org}/{project-slug}/keys/{id}/   — revoke key
 *
 * Auth: Bearer <personal-auth-token> from `glitchtip:auth-token` in
 * the keychain, via `getGlitchtipConfig` (returns null when not set).
 *
 * Verify probe: POST <dsn-host>/api/<project-id>/store/ with a minimal
 * Sentry envelope and the new DSN's public key in `X-Sentry-Auth`.
 *
 * Project-slug shape:
 *   · surfaces === "split" — two GlitchTip projects: `<name>-server`
 *     (owns GLITCHTIP_DSN + SENTRY_DSN) and `<name>-client` (owns
 *     PUBLIC_GLITCHTIP_DSN + NEXT_PUBLIC_SENTRY_DSN).
 *   · all other surfaces  — one project `<name>`; every name carries the
 *     same DSN.
 *
 * Which names rotate (`planFor`):
 *   · GLITCHTIP_DSN / PUBLIC_GLITCHTIP_DSN — whenever present; only
 *     hatchkit writes them.
 *   · SENTRY_DSN / NEXT_PUBLIC_SENTRY_DSN — the starter's names, which a
 *     project can just as well point at sentry.io. They rotate only when
 *     `.env.production` holds a DSN on the configured GlitchTip host, the
 *     same DSN as the GLITCHTIP_* name beside it, or a `CHANGE_ME_`
 *     placeholder next to an owned GLITCHTIP_* name (the scaffold seeds
 *     one, and `hatchkit add` used to leave it).
 *   · A name of a rotating DSN that is NOT in `.env.production` is
 *     `deployOnly`: the new DSN goes only to deploy targets that hold the
 *     OLD DSN under that name — a Coolify SENTRY_DSN, or the
 *     NEXT_PUBLIC_SENTRY_DSN repo variable the client build reads. In a
 *     starter layout the client names live in packages/client, which
 *     this file never reads, so this is how the repo variable follows.
 *
 * captureOld decrypts .env.production via the sanctioned `readEncryptedProd`
 * wrapper, parses each DSN, and resolves the upstream key id by listing
 * keys and matching on `public`. An old value that can't be parsed or
 * matched yields an empty handle for that env var — the orchestrator
 * downgrades revoke policy on empty captures.
 */

import type { GlitchtipConfig, GlitchtipMeta } from "../../config.js";
import { getGlitchtipConfig, getStore } from "../../config.js";
import {
  GLITCHTIP_CLIENT_ENV_KEYS,
  GLITCHTIP_SERVER_ENV_KEYS,
  assertDsnHost,
  dsnHostMismatch,
} from "../../provision/glitchtip.js";
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

const SERVER_KEYS: readonly string[] = GLITCHTIP_SERVER_ENV_KEYS;
const CLIENT_KEYS: readonly string[] = GLITCHTIP_CLIENT_ENV_KEYS;
const ALL_KEYS: readonly string[] = [...SERVER_KEYS, ...CLIENT_KEYS];
/** The hatchkit-only name per side; index 0 of each list. */
const LEGACY_KEY = { server: SERVER_KEYS[0], client: CLIENT_KEYS[0] } as const;

type Side = "server" | "client";

function sideOf(envKey: string): Side {
  return CLIENT_KEYS.includes(envKey) ? "client" : "server";
}

interface ParsedDsn {
  /** Public key portion (the `<key>` in `https://<key>@host/<id>`). */
  publicKey: string;
  /** Origin (scheme + host[:port]), no trailing slash. */
  origin: string;
  /** Numeric or slug project id from the DSN path. */
  projectId: string;
}

interface GlitchtipKeyRecord {
  id: string;
  public: string;
  dsn: { public: string };
  label?: string;
}

/** Per-env-key handle: which GlitchTip project minted the key, and the
 *  key id needed to revoke it. Encoded into the flat `handle` record
 *  with `<field>:<envKeyName>` keys (NewCred/OldCred.handle is
 *  `Record<string, string>`). */
function handleKey(field: "keyId" | "projectSlug", envKey: string): string {
  return `${field}:${envKey}`;
}

function parseDsn(dsn: string): ParsedDsn | undefined {
  try {
    const u = new URL(dsn);
    if (!u.username) return undefined;
    const projectId = u.pathname.replace(/^\/+/, "").split("/")[0];
    if (!projectId) return undefined;
    const port = u.port ? `:${u.port}` : "";
    return {
      publicKey: u.username,
      origin: `${u.protocol}//${u.hostname}${port}`,
      projectId,
    };
  } catch {
    return undefined;
  }
}

async function listProjectKeys(
  cfg: GlitchtipConfig,
  projectSlug: string,
): Promise<GlitchtipKeyRecord[]> {
  const { url, organizationSlug, token } = cfg;
  if (!organizationSlug) {
    throw new Error(
      "GlitchTip config is missing organization slug. Run `hatchkit config add glitchtip`.",
    );
  }
  const res = await fetch(`${url}/api/0/projects/${organizationSlug}/${projectSlug}/keys/`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return [];
  if (!res.ok) {
    throw new Error(`GlitchTip list keys failed: HTTP ${res.status}`);
  }
  return (await res.json()) as GlitchtipKeyRecord[];
}

async function createProjectKey(
  cfg: GlitchtipConfig,
  projectSlug: string,
  label: string,
): Promise<GlitchtipKeyRecord> {
  const { url, organizationSlug, token } = cfg;
  if (!organizationSlug) {
    throw new Error(
      "GlitchTip config is missing organization slug. Run `hatchkit config add glitchtip`.",
    );
  }
  const res = await fetch(`${url}/api/0/projects/${organizationSlug}/${projectSlug}/keys/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: label }),
  });
  if (!res.ok) {
    throw new Error(`GlitchTip create key failed: HTTP ${res.status}`);
  }
  return (await res.json()) as GlitchtipKeyRecord;
}

async function deleteProjectKey(
  cfg: GlitchtipConfig,
  projectSlug: string,
  keyId: string,
): Promise<void> {
  const { url, organizationSlug, token } = cfg;
  if (!organizationSlug) {
    throw new Error(
      "GlitchTip config is missing organization slug. Run `hatchkit config add glitchtip`.",
    );
  }
  const res = await fetch(
    `${url}/api/0/projects/${organizationSlug}/${projectSlug}/keys/${keyId}/`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  if (res.status === 404) return;
  if (!res.ok) {
    throw new Error(`GlitchTip delete key failed: HTTP ${res.status}`);
  }
}

/** Map an env-key NAME → GlitchTip project slug for this hatchkit
 *  project. Split-surface projects own two GlitchTip projects (one per
 *  side); all other surfaces share a single project. */
function projectSlugFor(envKey: string, ctx: RotationContext): string {
  if (ctx.manifest.surfaces === "split") {
    return sideOf(envKey) === "client"
      ? `${ctx.projectName}-client`
      : `${ctx.projectName}-server`;
  }
  return ctx.projectName;
}

interface RotationPlan {
  /** Names in the env file whose value rotates. */
  inFile: string[];
  /** Names of a rotating DSN that only deploy targets may hold. */
  deployOnly: string[];
  /** The OLD value behind each name in `inFile` (absent when the file
   *  can't be read) and the old DSN behind each `deployOnly` name. */
  oldDsn: Record<string, string>;
}

function isPlaceholder(value: string | undefined): boolean {
  return value !== undefined && (value.trim() === "" || value.startsWith("CHANGE_ME"));
}

/** Which names rotate, and from which old DSN — see the module header.
 *  Read-only (one decrypt, no network) and cached on `ctx.scratch`, so
 *  detect / envKeys / captureOld / createNew can never disagree. */
function planFor(ctx: RotationContext): RotationPlan {
  const cached = ctx.scratch.glitchtipPlan as RotationPlan | undefined;
  if (cached) return cached;
  let env: Record<string, string> = {};
  try {
    env = readEncryptedProd(ctx.projectDir);
  } catch {
    // Unreadable: GLITCHTIP_* names still rotate by presence, as before.
  }
  const meta = getStore().get("providers.glitchtip") as GlitchtipMeta | undefined;
  const glitchtipUrl = meta?.status === "configured" ? meta.url : undefined;
  const isOurDsn = (value: string | undefined): boolean =>
    !!value && !!parseDsn(value) && !!glitchtipUrl && !dsnHostMismatch(value, glitchtipUrl);

  const owned = new Set<string>();
  for (const side of ["server", "client"] as const) {
    const legacy = LEGACY_KEY[side];
    const legacyOwned = ctx.envPresence.has(legacy);
    if (legacyOwned) owned.add(legacy);
    for (const key of side === "server" ? SERVER_KEYS : CLIENT_KEYS) {
      if (key === legacy || !ctx.envPresence.has(key)) continue;
      const value = env[key];
      const sameAsLegacy = !!value && !!parseDsn(value) && value === env[legacy];
      if (isOurDsn(value) || sameAsLegacy || (legacyOwned && isPlaceholder(value))) {
        owned.add(key);
      }
    }
  }

  // Rotating groups: one DSN for the whole project, or one per side.
  const split = ctx.manifest.surfaces === "split";
  const groups: string[][] = split ? [[...SERVER_KEYS], [...CLIENT_KEYS]] : [[...ALL_KEYS]];
  const plan: RotationPlan = { inFile: [], deployOnly: [], oldDsn: {} };
  for (const group of groups) {
    const inFile = group.filter((key) => owned.has(key));
    if (inFile.length === 0) continue;
    const old = inFile.map((key) => env[key]).find((v) => !!v && !!parseDsn(v));
    for (const key of group) {
      if (owned.has(key)) {
        plan.inFile.push(key);
        if (env[key]) plan.oldDsn[key] = env[key];
      } else if (!ctx.envPresence.has(key) && old) {
        // A name in the file that isn't ours (a sentry.io DSN) is left
        // alone everywhere; a name that isn't in the file follows on
        // deploy targets only, matched against the old DSN. Without an
        // old DSN to match there is nothing to follow, and no key to mint.
        plan.deployOnly.push(key);
        plan.oldDsn[key] = old;
      }
    }
  }
  ctx.scratch.glitchtipPlan = plan;
  return plan;
}

/** The env-var names this adapter manages for `ctx`, filtered to those
 *  the project actually has. Adapter call-sites use this so envKeys
 *  matches captureOld/createNew without re-deriving. */
function targetEnvKeys(ctx: RotationContext): string[] {
  return planFor(ctx).inFile;
}

/** Every name the new DSN is handed to: the file's and the deploy-only. */
function deliveredKeys(ctx: RotationContext): string[] {
  const plan = planFor(ctx);
  return [...plan.inFile, ...plan.deployOnly];
}

const glitchtipRotator: ProviderRotator = {
  name: "glitchtip",
  label: "GlitchTip DSN",

  detect(ctx: RotationContext): boolean {
    return targetEnvKeys(ctx).length > 0;
  },

  envKeys(ctx: RotationContext): ReadonlyArray<EnvKeySpec> {
    const plan = planFor(ctx);
    // Client names are build-time values shipped in the bundle, so they
    // may live in a repo VARIABLE (`secret: false` lets push update one).
    const spec = (name: string, deployOnly: boolean): EnvKeySpec => ({
      name,
      scope: "production",
      secret: sideOf(name) === "server",
      ...(deployOnly ? { deployOnly: true } : {}),
    });
    return [
      ...plan.inFile.map((name) => spec(name, false)),
      ...plan.deployOnly.map((name) => spec(name, true)),
    ];
  },

  sideEffects(ctx: RotationContext): string[] {
    const plan = planFor(ctx);
    if (plan.deployOnly.length === 0) return [];
    return [
      `${plan.deployOnly.join(", ")}: not in .env.production; updated on Coolify and the repo's Actions variables only where they hold the old DSN.`,
    ];
  },

  async captureOld(ctx: RotationContext): Promise<OldCred> {
    const values: Record<string, string> = {};
    const handle: Record<string, string> = {};

    let prodEnv: Record<string, string>;
    try {
      prodEnv = readEncryptedProd(ctx.projectDir);
    } catch {
      return { values, handle };
    }

    const cfg = await getGlitchtipConfig();
    const plan = planFor(ctx);
    // Up to four names share one project; list its keys once.
    const keysBySlug = new Map<string, Promise<GlitchtipKeyRecord[]>>();

    for (const envKey of deliveredKeys(ctx)) {
      // Deploy-only names carry the old DSN of their group: push uses it
      // to update only targets that still hold exactly that value.
      const dsn = plan.inFile.includes(envKey) ? prodEnv[envKey] : plan.oldDsn[envKey];
      if (!dsn) continue;
      values[envKey] = dsn;
      if (!cfg) continue;
      const parsed = parseDsn(dsn);
      if (!parsed) continue;
      const slug = projectSlugFor(envKey, ctx);
      try {
        let listed = keysBySlug.get(slug);
        if (!listed) {
          listed = listProjectKeys(cfg, slug);
          keysBySlug.set(slug, listed);
        }
        const keys = await listed;
        const match = keys.find(
          (k) => k.public === parsed.publicKey || k.dsn?.public === dsn,
        );
        if (match) {
          handle[handleKey("keyId", envKey)] = match.id;
          handle[handleKey("projectSlug", envKey)] = slug;
        }
      } catch {
        // best-effort — empty handle for this env key downgrades revoke.
      }
    }

    return { values, handle };
  },

  async createNew(ctx: RotationContext): Promise<NewCred> {
    const cfg = await getGlitchtipConfig();
    if (!cfg) {
      throw new Error(
        "GlitchTip is not configured. Run `hatchkit config add glitchtip`.",
      );
    }

    const values: Record<string, string> = {};
    const handle: Record<string, string> = {};

    // One key per GlitchTip project: two for a split project (one per
    // side), one shared by every name otherwise.
    const minted = new Map<string, { id: string; dsn: string }>();
    const label = `hatchkit-rotate-${new Date().toISOString().slice(0, 19)}`;
    for (const envKey of deliveredKeys(ctx)) {
      const slug = projectSlugFor(envKey, ctx);
      let fresh = minted.get(slug);
      if (!fresh) {
        const created = await createProjectKey(cfg, slug, label);
        const dsn = created.dsn?.public;
        if (!dsn) {
          throw new Error(`GlitchTip create key for ${slug} returned no DSN`);
        }
        assertDsnHost(
          cfg,
          dsn,
          `re-run \`hatchkit secrets rotate --only glitchtip\`. Nothing was written; delete key ${created.id} of ${slug} in GlitchTip.`,
        );
        fresh = { id: created.id, dsn };
        minted.set(slug, fresh);
      }
      values[envKey] = fresh.dsn;
      handle[handleKey("keyId", envKey)] = fresh.id;
      handle[handleKey("projectSlug", envKey)] = slug;
    }

    return { values, handle };
  },

  async verify(_ctx: RotationContext, fresh: NewCred): Promise<VerifyOutcome> {
    // Probe each unique new DSN. A DSN is considered live when the
    // upstream accepts a minimal store event (HTTP 2xx). Deduped so a
    // shared DSN across two env vars only probes once.
    const seen = new Set<string>();
    const dsns = Object.values(fresh.values).filter((d) => {
      if (seen.has(d)) return false;
      seen.add(d);
      return true;
    });
    if (dsns.length === 0) return "skipped";

    for (const dsn of dsns) {
      const parsed = parseDsn(dsn);
      if (!parsed) return "failed";
      const eventId = randomHex(32);
      const body = JSON.stringify({
        event_id: eventId,
        timestamp: new Date().toISOString(),
        level: "debug",
        logger: "hatchkit",
        message: "hatchkit secrets rotate verify probe",
        platform: "other",
      });
      const auth = [
        "Sentry sentry_version=7",
        `sentry_key=${parsed.publicKey}`,
        "sentry_client=hatchkit-rotate/1.0",
      ].join(", ");
      try {
        const res = await fetch(`${parsed.origin}/api/${parsed.projectId}/store/`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Sentry-Auth": auth,
            "User-Agent": "hatchkit-rotate/1.0",
          },
          body,
        });
        if (!res.ok) return "failed";
      } catch {
        return "failed";
      }
    }
    return "ok";
  },

  async revoke(_ctx: RotationContext, old: OldCred): Promise<void> {
    const cfg = await getGlitchtipConfig();
    if (!cfg) {
      throw new Error(
        "GlitchTip is not configured — cannot revoke. Run `hatchkit config add glitchtip`.",
      );
    }
    // Dedup (keyId, projectSlug) tuples so a shared DSN doesn't double-delete.
    const seen = new Set<string>();
    for (const envKey of ALL_KEYS) {
      const keyId = old.handle[handleKey("keyId", envKey)];
      const slug = old.handle[handleKey("projectSlug", envKey)];
      if (!keyId || !slug) continue;
      const sig = `${slug}::${keyId}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      await deleteProjectKey(cfg, slug, keyId);
    }
  },
};

function randomHex(len: number): string {
  const bytes = new Uint8Array(len / 2);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

register(glitchtipRotator);
