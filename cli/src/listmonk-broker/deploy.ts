/*
 * `hatchkit listmonk broker [--dry-run]`: set up the confirm broker once
 * per Listmonk instance (see worker.ts for why it exists).
 *
 *   1. A user role `hatchkit-confirm-broker` with exactly
 *      `subscribers:get_all`, `subscribers:manage` and `lists:manage_all`,
 *      and an API user of the same name. Found by name on a re-run; the
 *      role's permissions are reset to that set when they drifted.
 *      Listmonk shows an API user's token once, so it goes to the keychain
 *      (`listmonk:confirm-broker:api-token`) before anything else.
 *   2. The Worker `hatchkit-listmonk-broker` on the operator's Cloudflare
 *      account: one module (the compiled worker.js), LISTMONK_URL as a
 *      plain var, the token as a secret. With `--hostname`, a Custom
 *      Domain in one of the account's zones serves it; otherwise its
 *      workers.dev route. Use a hostname when Listmonk sits behind a WAF
 *      rule that lets only Workers on your own zones reach `/api/*`
 *      (`cf.worker.upstream_zone`): a workers.dev Worker reports none, and
 *      every call then fails as 401.
 *   3. The broker URL in hatchkit's config, for LISTMONK_CONFIRM_BROKER_URL.
 *
 * Writes need the hatchkit-admin Listmonk credential and the Cloudflare
 * operator token, like the other admin commands. The broker token never
 * reaches a project.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BROKER_NAME = "hatchkit-confirm-broker";
export const BROKER_WORKER_NAME = "hatchkit-listmonk-broker";
export const BROKER_PERMISSIONS = [
  "subscribers:get_all",
  "subscribers:manage",
  "lists:manage_all",
] as const;
export const BROKER_TOKEN_SECRET = "listmonk:confirm-broker:api-token";
const COMPATIBILITY_DATE = "2026-10-01";
const CF_API = "https://api.cloudflare.com/client/v4";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface BrokerListmonkClient {
  listUserRoles(): Promise<Array<{ id: number; name: string; permissions: string[] }>>;
  createUserRole(name: string, permissions: string[]): Promise<{ id: number }>;
  updateUserRole(id: number, name: string, permissions: string[]): Promise<void>;
  listUsers(): Promise<Array<{ id: number; username: string; userRoleId: number }>>;
  createApiUser(username: string, userRoleId: number): Promise<{ token: string }>;
}

export interface BrokerDeployDeps {
  listmonkUrl: string;
  listmonk: BrokerListmonkClient;
  cloudflare: { token: string; accountId: string };
  fetch?: FetchLike;
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, value: string): Promise<void>;
  saveBrokerUrl(url: string): void;
  readModule?: () => string;
  dryRun?: boolean;
  /** Serve the broker on this Custom Domain instead of workers.dev. */
  hostname?: string;
  log?: (line: string) => void;
}

export interface BrokerDeployResult {
  steps: string[];
  url: string | null;
}

function defaultReadModule(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  try {
    return readFileSync(join(here, "worker.js"), "utf-8");
  } catch {
    throw new Error(
      `Compiled broker module worker.js not found next to ${here}. Deploy from the built CLI (pnpm --filter hatchkit build, or the installed hatchkit).`,
    );
  }
}

function samePermissions(a: string[], b: readonly string[]): boolean {
  return a.length === b.length && b.every((p) => a.includes(p));
}

async function cf(
  deps: BrokerDeployDeps,
  method: string,
  path: string,
  body?: BodyInit,
  contentType?: string,
): Promise<unknown> {
  const res = await (deps.fetch ?? fetch)(`${CF_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${deps.cloudflare.token}`,
      ...(contentType ? { "Content-Type": contentType } : {}),
    },
    body,
  });
  const json = (await res.json().catch(() => null)) as {
    success?: boolean;
    result?: unknown;
    errors?: Array<{ message?: string }>;
  } | null;
  if (!res.ok || json?.success === false) {
    const msg = json?.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
    throw new Error(`Cloudflare ${method} ${path}: ${msg}`);
  }
  return json?.result;
}

export async function deployListmonkBroker(deps: BrokerDeployDeps): Promise<BrokerDeployResult> {
  const dry = deps.dryRun === true;
  const steps: string[] = [];
  const say = (line: string) => {
    steps.push(line);
    deps.log?.(line);
  };
  const lm = deps.listmonk;

  // 1. Role + API user, least privilege.
  const roles = await lm.listUserRoles();
  let role = roles.find((r) => r.name === BROKER_NAME);
  if (!role) {
    say(`create Listmonk user role ${BROKER_NAME} (${BROKER_PERMISSIONS.join(", ")})`);
    if (!dry) {
      const created = await lm.createUserRole(BROKER_NAME, [...BROKER_PERMISSIONS]);
      role = { id: created.id, name: BROKER_NAME, permissions: [...BROKER_PERMISSIONS] };
    }
  } else if (!samePermissions(role.permissions, BROKER_PERMISSIONS)) {
    say(
      `reset Listmonk user role ${BROKER_NAME} to ${BROKER_PERMISSIONS.join(", ")} (was ${role.permissions.join(", ") || "none"})`,
    );
    if (!dry) await lm.updateUserRole(role.id, BROKER_NAME, [...BROKER_PERMISSIONS]);
  }

  const users = await lm.listUsers();
  const user = users.find((u) => u.username === BROKER_NAME);
  let token = await deps.getSecret(BROKER_TOKEN_SECRET);
  if (user) {
    if (role && user.userRoleId !== role.id) {
      throw new Error(
        `Listmonk user ${BROKER_NAME} exists with another role (id ${user.userRoleId}). Give it role ${BROKER_NAME} in Listmonk → Admin → Users, then re-run.`,
      );
    }
    if (!token) {
      throw new Error(
        `Listmonk user ${BROKER_NAME} exists but the keychain has no token for it (${BROKER_TOKEN_SECRET}). Listmonk shows a token only once: delete the user in Listmonk → Admin → Users and re-run.`,
      );
    }
  } else {
    say(`create Listmonk API user ${BROKER_NAME}; token → keychain ${BROKER_TOKEN_SECRET}`);
    if (!dry) {
      const created = await lm.createApiUser(BROKER_NAME, role!.id);
      await deps.setSecret(BROKER_TOKEN_SECRET, created.token);
      token = created.token;
    }
  }

  // 2. The Worker.
  const accountPath = `/accounts/${deps.cloudflare.accountId}`;
  const script = `${accountPath}/workers/scripts/${BROKER_WORKER_NAME}`;
  const source = (deps.readModule ?? defaultReadModule)();
  say(
    `upload Worker ${BROKER_WORKER_NAME} (LISTMONK_URL=${deps.listmonkUrl}, BROKER_API_USER=${BROKER_NAME}), secret BROKER_API_TOKEN, ${deps.hostname ? `Custom Domain ${deps.hostname}` : "workers.dev route on"}`,
  );
  if (dry) return { steps, url: null };

  const form = new FormData();
  form.append(
    "metadata",
    new Blob(
      [
        JSON.stringify({
          main_module: "worker.js",
          compatibility_date: COMPATIBILITY_DATE,
          bindings: [
            { type: "plain_text", name: "LISTMONK_URL", text: deps.listmonkUrl },
            { type: "plain_text", name: "BROKER_API_USER", text: BROKER_NAME },
          ],
          keep_bindings: ["secret_text"],
        }),
      ],
      { type: "application/json" },
    ),
  );
  form.append(
    "worker.js",
    new Blob([source], { type: "application/javascript+module" }),
    "worker.js",
  );
  await cf(deps, "PUT", script, form);
  await cf(
    deps,
    "PUT",
    `${script}/secrets`,
    JSON.stringify({ name: "BROKER_API_TOKEN", text: token, type: "secret_text" }),
    "application/json",
  );
  let url: string;
  if (deps.hostname) {
    const host = deps.hostname.toLowerCase();
    const zones = (await cf(
      deps,
      "GET",
      `/zones?per_page=50&account.id=${deps.cloudflare.accountId}`,
    )) as Array<{
      id: string;
      name: string;
    }>;
    const zone = zones
      .filter((z) => host === z.name || host.endsWith(`.${z.name}`))
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (!zone) throw new Error(`No zone on the Cloudflare account holds ${host}.`);
    await cf(
      deps,
      "PUT",
      `${accountPath}/workers/domains`,
      JSON.stringify({
        hostname: host,
        service: BROKER_WORKER_NAME,
        zone_id: zone.id,
        environment: "production",
      }),
      "application/json",
    );
    url = `https://${host}`;
  } else {
    await cf(
      deps,
      "POST",
      `${script}/subdomain`,
      JSON.stringify({ enabled: true }),
      "application/json",
    );
    const sub = (await cf(deps, "GET", `${accountPath}/workers/subdomain`)) as {
      subdomain?: string;
    };
    if (!sub?.subdomain)
      throw new Error(
        "The account has no workers.dev subdomain; set one in the Cloudflare dashboard.",
      );
    url = `https://${BROKER_WORKER_NAME}.${sub.subdomain}.workers.dev`;
  }
  deps.saveBrokerUrl(url);
  say(`broker at ${url}`);
  return { steps, url };
}
