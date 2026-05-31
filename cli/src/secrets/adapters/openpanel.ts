/*
 * cli/src/secrets/adapters/openpanel.ts — Rotation adapter for OpenPanel
 * write-client credentials.
 *
 * Strategy: mint a NEW write client against the same upstream project,
 * verify it can hit `/manage/projects`, then DELETE the OLD client.
 * Per the OpenPanel Management API contract (see
 * cli/src/provision/openpanel.ts), a "project" can have multiple
 * "clients" and each client carries its own id+secret. Rotation is
 * therefore additive — the new client exists alongside the old one
 * until revoke runs, which keeps the rotation crash-safe.
 *
 * Adapter-private keychain cache (`openpanel:<name>:client-secret`,
 * `:id`, `:project-id`) is updated on the revoke path so re-runs of
 * `hatchkit add <project> openpanel` continue to be idempotent against
 * the NEW client. The orchestrator owns env/disk/deploy writes; the
 * adapter owns upstream API calls + this private cache.
 */

import { ensureOpenpanel } from "../../config.js";
import { SECRET_KEYS, getSecret, setSecret } from "../../utils/secrets.js";
import { register } from "../registry.js";
import type {
  EnvKeySpec,
  NewCred,
  OldCred,
  ProviderRotator,
  RotationContext,
  VerifyOutcome,
} from "../types.js";

const ADAPTER_NAME = "openpanel";

/** Mirrors `provision/openpanel.ts` — the cache slots `provision`
 *  already uses to remember the upstream identifiers. Kept in sync
 *  with that module on purpose so rotate and provision agree on
 *  account names. */
const projectIdKey = (clientName: string) =>
  SECRET_KEYS.openpanelClientSecret(`${clientName}:project-id`);
const clientIdKey = (clientName: string) =>
  SECRET_KEYS.openpanelClientSecret(`${clientName}:id`);
const clientSecretKey = (clientName: string) =>
  SECRET_KEYS.openpanelClientSecret(clientName);

function buildHeaders(
  clientId: string,
  clientSecret: string,
  options: { jsonBody?: boolean } = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    "openpanel-client-id": clientId,
    "openpanel-client-secret": clientSecret,
    Accept: "application/json",
  };
  if (options.jsonBody) headers["Content-Type"] = "application/json";
  return headers;
}

function resolveManageBase(url: string, apiUrl: string | undefined): string {
  return `${(apiUrl ?? url).replace(/\/$/, "")}/manage`;
}

/** Scratchpad shape stashed on `ctx.scratch[ADAPTER_NAME]` so the
 *  three adapter methods (captureOld → createNew → verify/revoke)
 *  don't refetch config or re-resolve the API base. */
interface OpenpanelScratch {
  manageBase: string;
  rootClientId: string;
  rootClientSecret: string;
  /** The upstream project id this rotation targets. Set in
   *  captureOld so createNew/revoke don't have to refetch. */
  projectId?: string;
  /** Newly-minted client identifiers, set in createNew so revoke
   *  can update the adapter-private keychain mirror. The orchestrator
   *  never inspects scratch. */
  newClientId?: string;
  newClientSecret?: string;
}

async function ensureScratch(ctx: RotationContext): Promise<OpenpanelScratch> {
  const existing = ctx.scratch[ADAPTER_NAME] as OpenpanelScratch | undefined;
  if (existing) return existing;
  const cfg = await ensureOpenpanel();
  const scratch: OpenpanelScratch = {
    manageBase: resolveManageBase(cfg.url, cfg.apiUrl),
    rootClientId: cfg.rootClientId,
    rootClientSecret: cfg.rootClientSecret,
  };
  ctx.scratch[ADAPTER_NAME] = scratch;
  return scratch;
}

const ENV_KEYS: ReadonlyArray<EnvKeySpec> = [
  { name: "OPENPANEL_CLIENT_ID", scope: "both", secret: false },
  { name: "OPENPANEL_CLIENT_SECRET", scope: "both", secret: true },
  // Browser mirror — Vite/Astro/SvelteKit/Remix convention. The
  // starter also reads NEXT_PUBLIC_OPENPANEL_CLIENT_ID via docker-
  // compose env mapping (see starter/docker-compose.yml), so the
  // generic PUBLIC_ name is the single source of truth in env files.
  { name: "PUBLIC_OPENPANEL_CLIENT_ID", scope: "both", secret: false },
];

const openpanelRotator: ProviderRotator = {
  name: ADAPTER_NAME,
  label: "OpenPanel write client",

  detect(ctx: RotationContext): boolean {
    // Same fusion `servicesAlreadyAdded` uses (cli/src/index.ts:617):
    // any of the canonical OPENPANEL env-var names being present is
    // enough — the manifest carries no openpanel-specific signal, so
    // env presence is the only fact to combine.
    return (
      ctx.envPresence.has("OPENPANEL_CLIENT_ID") ||
      ctx.envPresence.has("OPENPANEL_CLIENT_SECRET") ||
      ctx.envPresence.has("PUBLIC_OPENPANEL_CLIENT_ID")
    );
  },

  envKeys(ctx: RotationContext): ReadonlyArray<EnvKeySpec> {
    // Filter to env keys actually present in the project — avoids
    // writing PUBLIC_OPENPANEL_CLIENT_ID into a backend-only repo that
    // never had it, and skips server-side keys for a static-only
    // surface. envPresence is the canonical signal.
    return ENV_KEYS.filter((spec) => ctx.envPresence.has(spec.name));
  },

  async captureOld(ctx: RotationContext): Promise<OldCred> {
    const scratch = await ensureScratch(ctx);
    const cachedSecret = await getSecret(clientSecretKey(ctx.projectName));
    const cachedClientId = await getSecret(clientIdKey(ctx.projectName));
    const cachedProjectId = await getSecret(projectIdKey(ctx.projectName));

    const handle: Record<string, string> = {};
    const values: Record<string, string> = {};

    if (cachedClientId) {
      handle.clientId = cachedClientId;
      values.OPENPANEL_CLIENT_ID = cachedClientId;
      if (ctx.envPresence.has("PUBLIC_OPENPANEL_CLIENT_ID")) {
        values.PUBLIC_OPENPANEL_CLIENT_ID = cachedClientId;
      }
    }
    if (cachedSecret) {
      handle.clientSecret = cachedSecret;
      values.OPENPANEL_CLIENT_SECRET = cachedSecret;
    }
    if (cachedProjectId) {
      handle.projectId = cachedProjectId;
      scratch.projectId = cachedProjectId;
    }

    return { values, handle };
  },

  async createNew(ctx: RotationContext): Promise<NewCred> {
    const scratch = await ensureScratch(ctx);
    if (!scratch.projectId) {
      // Without a project id we can't target the same upstream
      // project. Fail loudly — the operator needs to either re-provision
      // (which seeds the project-id cache) or pass --revoke=never and
      // rotate manually via the OpenPanel dashboard.
      throw new Error(
        `OpenPanel: no cached project-id for "${ctx.projectName}". ` +
          `Run \`hatchkit add ${ctx.projectName} openpanel\` first so the ` +
          `project-id is cached, then retry rotate.`,
      );
    }

    const headers = buildHeaders(scratch.rootClientId, scratch.rootClientSecret, {
      jsonBody: true,
    });
    const res = await fetch(`${scratch.manageBase}/clients`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: ctx.projectName,
        type: "write",
        projectId: scratch.projectId,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `OpenPanel mint client failed: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`,
      );
    }
    const body = (await res.json()) as { data?: { id?: string; secret?: string } };
    const clientId = body.data?.id;
    const clientSecret = body.data?.secret;
    if (!clientId || !clientSecret) {
      throw new Error("OpenPanel mint client: response lacked id/secret.");
    }

    // Stash on scratch so revoke() can update the keychain mirror
    // without re-deriving from the env file or asking the orchestrator
    // for the cred back.
    scratch.newClientId = clientId;
    scratch.newClientSecret = clientSecret;

    const values: Record<string, string> = {
      OPENPANEL_CLIENT_ID: clientId,
      OPENPANEL_CLIENT_SECRET: clientSecret,
    };
    if (ctx.envPresence.has("PUBLIC_OPENPANEL_CLIENT_ID")) {
      values.PUBLIC_OPENPANEL_CLIENT_ID = clientId;
    }

    return {
      values,
      handle: {
        clientId,
        clientSecret,
        projectId: scratch.projectId,
      },
    };
  },

  async verify(ctx: RotationContext, fresh: NewCred): Promise<VerifyOutcome> {
    const scratch = await ensureScratch(ctx);
    const clientId = fresh.handle.clientId;
    const clientSecret = fresh.handle.clientSecret;
    if (!clientId || !clientSecret) return "failed";
    try {
      const res = await fetch(`${scratch.manageBase}/projects`, {
        headers: buildHeaders(clientId, clientSecret),
      });
      return res.ok ? "ok" : "failed";
    } catch {
      return "failed";
    }
  },

  async revoke(ctx: RotationContext, old: OldCred): Promise<void> {
    const scratch = await ensureScratch(ctx);
    const oldClientId = old.handle.clientId;

    // Update the adapter-private keychain cache so future provision
    // re-runs (`hatchkit add <project> openpanel`) hand back the NEW
    // credentials. createNew stashed them on scratch on its way through.
    if (scratch.newClientId && scratch.newClientSecret) {
      await setSecret(clientSecretKey(ctx.projectName), scratch.newClientSecret);
      await setSecret(clientIdKey(ctx.projectName), scratch.newClientId);
      if (scratch.projectId) {
        await setSecret(projectIdKey(ctx.projectName), scratch.projectId);
      }
    }

    if (!oldClientId) {
      // Nothing to revoke upstream — captureOld returned no cached id.
      // The orchestrator's effectivePolicy downgrade normally prevents
      // revoke() from running in that case (empty handle → never), so
      // this branch is defensive.
      return;
    }

    const headers = buildHeaders(scratch.rootClientId, scratch.rootClientSecret);
    const res = await fetch(`${scratch.manageBase}/clients/${oldClientId}`, {
      method: "DELETE",
      headers,
    });
    if (res.status === 404) {
      // Already gone — idempotent success.
      return;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `OpenPanel delete client failed: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`,
      );
    }
  },
};

register(openpanelRotator);

export { openpanelRotator };
