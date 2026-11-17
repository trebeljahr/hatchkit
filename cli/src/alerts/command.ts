/* `hatchkit alerts setup|open|resolve`: the operator's side of the pooled digest.
 *
 * Hosts with `alerts.pool` post their open items to the security monitor Worker
 * (cli/src/templates/security-controller/digest-pool.mjs), which sends one mail a
 * day for every host. Each item in that mail carries an ID. `resolve` marks items
 * done from this machine only: the Worker accepts it with RESOLVER_KEY, which is
 * kept in this machine's keychain. A resolved item stays hidden while the checks
 * rescan (26 h) and comes back flagged if a host still reports it. */
import { randomBytes } from "node:crypto";
import chalk from "chalk";
import { getCloudflareProvisioner, getStore } from "../config.js";
import { getSecret, SECRET_KEYS, setSecret } from "../utils/secrets.js";

export const ALERTS_USAGE = `Usage:
  hatchkit alerts setup --url <https://monitor> --worker <script name> [--dry-run]
  hatchkit alerts open [--json]
  hatchkit alerts resolve <ID…> [--note <text>] [--json]

Unattended sessions read the resolver key only with HATCHKIT_KEYCHAIN_ACCESS=allow.`;

type Item = { id: string; what: string; flags?: string[]; deadline?: string; command?: string };
type Open = {
  checkedAt: string;
  received: Record<string, string | null>;
  sections: Record<string, Item[]>;
  weekly: Record<string, Item[]>;
  notes: string[];
};

export function monitorUrl(): string {
  const url = (getStore().get("securityMonitor") as { url?: string } | undefined)?.url;
  if (!url)
    throw new Error(
      "No security monitor recorded: run hatchkit alerts setup --url <https://monitor> first.",
    );
  return url;
}

async function resolverKey(): Promise<string> {
  const key =
    process.env.HATCHKIT_SECRET_SECURITY_MONITOR_RESOLVER_KEY ??
    (await getSecret(SECRET_KEYS.securityMonitorResolverKey));
  if (!key) throw new Error("No resolver key in the keychain: run hatchkit alerts setup.");
  return key;
}

async function call(
  path: string,
  init: RequestInit = {},
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  const response = await fetcher(monitorUrl() + path, {
    ...init,
    redirect: "error",
    headers: { Authorization: `Bearer ${await resolverKey()}`, "Content-Type": "application/json" },
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {}
  if (!response.ok)
    throw new Error(
      `Monitor answered ${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`,
    );
  return body;
}

const LABELS: [string, string][] = [
  ["needs", "Needs you"],
  ["unchecked", "Not checked"],
  ["waiting", "Waiting on vendor"],
  ["fixed", "Fixed automatically"],
];

export function formatOpen(open: Open): string {
  const lines: string[] = [];
  for (const [key, label] of LABELS) {
    const items = [...(open.sections[key] ?? []), ...(open.weekly[key] ?? [])];
    if (!items.length) continue;
    lines.push(chalk.bold(`\n  ${label}`));
    for (const item of items) {
      lines.push(`  ${chalk.cyan(item.id)}  ${item.what}`);
      if (item.flags?.length) lines.push(`                ${item.flags.join(", ")}`);
      if (item.command) lines.push(`                ${chalk.dim(item.command)}`);
    }
  }
  if (!lines.length) lines.push("\n  Nothing open.");
  const stale = Object.entries(open.received)
    .filter(([, at]) => !at)
    .map(([host]) => host);
  if (stale.length)
    lines.push(chalk.yellow(`\n  No digest received yet from: ${stale.join(", ")}`));
  return lines.join("\n") + "\n";
}

export async function runAlertsCommand(
  argv: string[],
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const [sub, ...rest] = argv;
  const json = rest.includes("--json");
  if (sub === "open") {
    const open = (await call("/open", { method: "GET" }, fetcher)) as Open;
    console.log(json ? JSON.stringify(open, null, 2) : formatOpen(open));
    return;
  }
  if (sub === "resolve") {
    const ids: string[] = [];
    let note: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--note" && rest[i + 1]) note = rest[++i];
      else if (rest[i] === "--json") continue;
      else if (/^[0-9a-f]{12}$/.test(rest[i])) ids.push(rest[i]);
      else throw new Error(`Not an item ID: ${rest[i]}\n${ALERTS_USAGE}`);
    }
    if (!ids.length) throw new Error(ALERTS_USAGE);
    const result = (await call(
      "/resolve",
      { method: "POST", body: JSON.stringify({ ids, note }) },
      fetcher,
    )) as {
      resolved: { id: string; what: string }[];
      hiddenUntil: string;
    };
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      for (const row of result.resolved) console.log(chalk.green(`  ✓ ${row.id}  ${row.what}`));
      console.log(
        chalk.dim(
          `  Hidden until ${result.hiddenUntil}; it comes back if a host still reports it then.`,
        ),
      );
    }
    return;
  }
  if (sub === "setup") {
    let url: string | undefined;
    let worker: string | undefined;
    let dryRun = false;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--url" && rest[i + 1]) url = rest[++i];
      else if (rest[i] === "--worker" && rest[i + 1]) worker = rest[++i];
      else if (rest[i] === "--dry-run") dryRun = true;
      else throw new Error(`Unknown argument ${rest[i]}.\n${ALERTS_USAGE}`);
    }
    if (!url || !/^https:\/\/[^/]+$/.test(url) || !worker) throw new Error(ALERTS_USAGE);
    const existing = await getSecret(SECRET_KEYS.securityMonitorResolverKey);
    const key = existing ?? randomBytes(32).toString("base64url");
    if (dryRun) {
      console.log(
        `  would record ${url}, ${existing ? "keep" : "create"} the resolver key, and set RESOLVER_KEY on Worker ${worker}`,
      );
      return;
    }
    const op = await getCloudflareProvisioner();
    if (!op?.token || !op.accountId)
      throw new Error(
        "No Cloudflare operator token: run hatchkit config add cloudflare in your own terminal.",
      );
    if (!existing) await setSecret(SECRET_KEYS.securityMonitorResolverKey, key);
    const response = await fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${op.accountId}/workers/scripts/${encodeURIComponent(worker)}/secrets`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${op.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "RESOLVER_KEY", text: key, type: "secret_text" }),
      },
    );
    if (!response.ok) throw new Error(`Cloudflare refused the Worker secret (${response.status}).`);
    getStore().set("securityMonitor", { url, worker });
    console.log(
      chalk.green(
        `  ✓ Resolver key in the keychain and on Worker ${worker}; monitor ${url} recorded.`,
      ),
    );
    return;
  }
  throw new Error(ALERTS_USAGE);
}
