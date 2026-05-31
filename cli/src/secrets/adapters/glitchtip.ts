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
 *     (owns GLITCHTIP_DSN) and `<name>-client` (owns PUBLIC_GLITCHTIP_DSN).
 *   · all other surfaces  — one project `<name>`; both env vars carry
 *     the same DSN.
 *
 * captureOld decrypts .env.production via the sanctioned `readEncryptedProd`
 * wrapper, parses each DSN, and resolves the upstream key id by listing
 * keys and matching on `public`. An old value that can't be parsed or
 * matched yields an empty handle for that env var — the orchestrator
 * downgrades revoke policy on empty captures.
 */

import type { GlitchtipConfig } from "../../config.js";
import { getGlitchtipConfig } from "../../config.js";
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

const SERVER_KEY = "GLITCHTIP_DSN";
const CLIENT_KEY = "PUBLIC_GLITCHTIP_DSN";

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
    return envKey === CLIENT_KEY ? `${ctx.projectName}-client` : `${ctx.projectName}-server`;
  }
  return ctx.projectName;
}

/** The env-var names this adapter manages for `ctx`, filtered to those
 *  the project actually has. Adapter call-sites use this so envKeys
 *  matches captureOld/createNew without re-deriving. */
function targetEnvKeys(ctx: RotationContext): string[] {
  const out: string[] = [];
  if (ctx.envPresence.has(SERVER_KEY)) out.push(SERVER_KEY);
  if (ctx.envPresence.has(CLIENT_KEY)) out.push(CLIENT_KEY);
  return out;
}

const glitchtipRotator: ProviderRotator = {
  name: "glitchtip",
  label: "GlitchTip DSN",

  detect(ctx: RotationContext): boolean {
    return ctx.envPresence.has(SERVER_KEY) || ctx.envPresence.has(CLIENT_KEY);
  },

  envKeys(ctx: RotationContext): ReadonlyArray<EnvKeySpec> {
    return targetEnvKeys(ctx).map((name) => ({
      name,
      scope: "production",
      secret: true,
    }));
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

    for (const envKey of targetEnvKeys(ctx)) {
      const dsn = prodEnv[envKey];
      if (!dsn) continue;
      values[envKey] = dsn;
      if (!cfg) continue;
      const parsed = parseDsn(dsn);
      if (!parsed) continue;
      const slug = projectSlugFor(envKey, ctx);
      try {
        const keys = await listProjectKeys(cfg, slug);
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

    if (ctx.manifest.surfaces === "split") {
      // Two distinct GlitchTip projects, two distinct DSNs.
      for (const envKey of targetEnvKeys(ctx)) {
        const slug = projectSlugFor(envKey, ctx);
        const label = `hatchkit-rotate-${new Date().toISOString().slice(0, 19)}`;
        const fresh = await createProjectKey(cfg, slug, label);
        const dsn = fresh.dsn?.public;
        if (!dsn) {
          throw new Error(`GlitchTip create key for ${slug} returned no DSN`);
        }
        values[envKey] = dsn;
        handle[handleKey("keyId", envKey)] = fresh.id;
        handle[handleKey("projectSlug", envKey)] = slug;
      }
    } else {
      // Shared-DSN: mint once, use the same value for both env vars.
      const slug = projectSlugFor(SERVER_KEY, ctx);
      const label = `hatchkit-rotate-${new Date().toISOString().slice(0, 19)}`;
      const fresh = await createProjectKey(cfg, slug, label);
      const dsn = fresh.dsn?.public;
      if (!dsn) {
        throw new Error(`GlitchTip create key for ${slug} returned no DSN`);
      }
      for (const envKey of targetEnvKeys(ctx)) {
        values[envKey] = dsn;
        handle[handleKey("keyId", envKey)] = fresh.id;
        handle[handleKey("projectSlug", envKey)] = slug;
      }
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
    for (const envKey of [SERVER_KEY, CLIENT_KEY]) {
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
