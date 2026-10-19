/*
 * `hatchkit audit cloudflare` — does the Cloudflare account hold anything
 * hatchkit did not create?
 *
 * hatchkit's one operator token (`hatchkit-cloudflare`) can mint account
 * API tokens, so whoever holds it owns the account. An attacker's first
 * move is a second token: revoking the leaked one does not remove the
 * tokens it created. This check lists what is there and diffs it
 * against what hatchkit knows (see `expected.ts`):
 *
 *   · every account-owned and user-owned API token, by id;
 *   · audit log v2 entries of the last 25 h, by credential: the operator
 *     outside a recorded hatchkit run, an unknown token, the Global API
 *     Key or an OAuth app nobody allowed;
 *   · Workers, R2 buckets, zones, Email Routing destinations and rules,
 *     members and OAuth clients nobody accepted.
 *
 * It runs with its OWN read-only token (`hatchkit-audit`, a user token),
 * never the operator token: daily from a GitHub Action in a private repo,
 * and on demand on the laptop. Every call here is a GET.
 *
 * Design and incident runbook: ai-work-notes
 * projects/hatchkit/cloudflare-daily-audit-design.md.
 */

export const API_BASE = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 30_000;
const MAX_PAGES = 50;

/** What hatchkit expects on the account. Published as JSON (no secrets)
 *  so the scheduled check can read it where it runs. */
export interface CloudflareExpected {
  version: 1;
  accountId: string;
  generatedAt: string;
  /** Id of `hatchkit-cloudflare`. Its audit-log entries must fall in a run window. */
  operatorTokenId?: string;
  tokens: ExpectedToken[];
  workers: string[];
  buckets: string[];
  zones: string[];
  emailDestinations: string[];
  members: string[];
  oauthClients: string[];
  /** Connected OAuth apps (by the token name the audit log shows) allowed to make changes. */
  oauthApps: string[];
  /** When hatchkit used the operator token (see `operator-uses.ts`). */
  runs: RunWindow[];
}

export type ExpectedTokenKind = "worker" | "r2" | "accepted";

export interface ExpectedToken {
  id: string;
  kind: ExpectedTokenKind;
  /** Where hatchkit knows it from — a Worker, a project, or Rico's note. */
  note?: string;
}

export interface RunWindow {
  start: string;
  end?: string;
}

export const DEFAULT_OAUTH_APPS = [
  "Wrangler",
  "Cloudflare MCP Server",
  "Cloudflare Workers Builds MCP Server",
] as const;

export type AuditCheck =
  | "tokens"
  | "audit-log"
  | "workers"
  | "buckets"
  | "zones"
  | "email-destinations"
  | "email-rules"
  | "members"
  | "oauth-clients"
  | "watchdog";

export interface AuditFinding {
  /** `alert` fails the run; `info` is reported only. */
  severity: "alert" | "info";
  check: AuditCheck;
  subject: string;
  detail: string;
  hint?: string;
}

export interface AuditCheckStatus {
  check: AuditCheck;
  status: "ok" | "alert" | "error" | "skipped";
  detail: string;
}

export interface CloudflareAuditReport {
  accountId: string;
  checkedAt: string;
  window: { since: string; before: string };
  /** Id of the token this check ran with, when Cloudflare told us. */
  auditTokenId?: string;
  summary: { alerts: number; info: number; errors: number };
  checks: AuditCheckStatus[];
  findings: AuditFinding[];
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface CfEnvelope<T> {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result: T;
  result_info?: {
    page?: number;
    per_page?: number;
    total_pages?: number;
    count?: number | string;
    cursor?: string;
    cursors?: { after?: string };
  };
}

export class CloudflareReadError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** GET-only Cloudflare client with page and cursor pagination. */
export class CloudflareReader {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async get<T>(path: string, query: Record<string, string> = {}): Promise<CfEnvelope<T>> {
    const qs = new URLSearchParams(query).toString();
    const url = `${API_BASE}${path}${qs ? `?${qs}` : ""}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new CloudflareReadError(`GET ${path}: ${(err as Error).message}`, 0);
    }
    const json = (await res.json().catch(() => null)) as CfEnvelope<T> | null;
    if (!res.ok || !json?.success) {
      const why = json?.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") || res.statusText;
      throw new CloudflareReadError(`GET ${path}: HTTP ${res.status} ${why}`, res.status);
    }
    return json;
  }

  /** All items of a `page`/`per_page` list. */
  async pages<T>(path: string, query: Record<string, string> = {}, perPage = 50): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const env = await this.get<T[]>(path, {
        ...query,
        page: String(page),
        per_page: String(perPage),
      });
      const items = Array.isArray(env.result) ? env.result : [];
      out.push(...items);
      const total = env.result_info?.total_pages;
      if (total !== undefined ? page >= total : items.length < perPage) return out;
    }
    // A cut-off list must fail, never read as complete.
    throw new CloudflareReadError(`GET ${path}: more than ${MAX_PAGES} pages`, 0);
  }

  /** All items of a cursor list. `pick` takes the items out of `result`. */
  async cursor<T, R = T[]>(
    path: string,
    query: Record<string, string>,
    pick: (result: R) => T[] = (r) => (Array.isArray(r) ? (r as T[]) : []),
  ): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const env = await this.get<R>(path, cursor ? { ...query, cursor } : query);
      const items = pick(env.result);
      out.push(...items);
      const next = env.result_info?.cursor || env.result_info?.cursors?.after;
      if (!next || items.length === 0 || next === cursor) return out;
      cursor = next;
    }
    // Flooding the log with cheap entries must not push real ones past the cap.
    throw new CloudflareReadError(`GET ${path}: more than ${MAX_PAGES} pages`, 0);
  }
}

export interface ListedToken {
  id: string;
  name: string;
  status?: string;
  issued_on?: string;
  last_used_on?: string;
  expires_on?: string;
  creator_email_at_creation?: string;
  policies?: Array<{ effect?: string; permission_groups?: Array<{ name?: string }> }>;
}

export interface AuditLogEntry {
  id?: string;
  action?: { type?: string; description?: string; result?: string; time?: string };
  actor?: {
    type?: string;
    context?: string;
    email?: string;
    id?: string;
    ip_address?: string;
    token_id?: string;
    token_name?: string;
  };
  raw?: { method?: string; uri?: string; status_code?: number };
  resource?: { id?: string; product?: string; type?: string };
  zone?: { id?: string; name?: string };
}

export interface EmailRule {
  id?: string;
  name?: string;
  enabled?: boolean;
  matchers?: Array<{ type?: string; field?: string; value?: string }>;
  actions?: Array<{ type?: string; value?: string[] }>;
}

type Listing<T> = { ok: true; items: T } | { ok: false; error: string; status: number };

/** Everything the diff looks at, read once. */
export interface CloudflareSnapshot {
  auditTokenId?: string;
  accountTokens: Listing<ListedToken[]>;
  userTokens: Listing<ListedToken[]>;
  auditLog: Listing<AuditLogEntry[]>;
  workers: Listing<string[]>;
  buckets: Listing<string[]>;
  zones: Listing<Array<{ id: string; name: string }>>;
  emailDestinations: Listing<string[]>;
  emailRules: Listing<Array<{ zone: string; rules: EmailRule[]; errors: string[] }>>;
  members: Listing<string[]>;
  oauthClients: Listing<Array<{ id: string; name?: string }>>;
}

const rfc3339 = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, "Z");

async function listing<T>(read: () => Promise<T>): Promise<Listing<T>> {
  try {
    return { ok: true, items: await read() };
  } catch (err) {
    const status = err instanceof CloudflareReadError ? err.status : 0;
    return { ok: false, error: (err as Error).message, status };
  }
}

export async function collectCloudflareSnapshot(params: {
  reader: CloudflareReader;
  accountId: string;
  since: Date;
  before: Date;
}): Promise<CloudflareSnapshot> {
  const { reader, accountId } = params;
  const a = `/accounts/${accountId}`;

  // The audit token is a user token; an account token answers on the account path.
  let auditTokenId: string | undefined;
  for (const path of ["/user/tokens/verify", `${a}/tokens/verify`]) {
    try {
      auditTokenId = (await reader.get<{ id?: string }>(path)).result?.id;
      if (auditTokenId) break;
    } catch {
      // Not this kind of token; the next path or none.
    }
  }

  const zones = await listing(async () =>
    (await reader.pages<{ id: string; name: string }>("/zones", { "account.id": accountId })).map(
      (z) => ({ id: z.id, name: z.name }),
    ),
  );

  const [
    accountTokens,
    userTokens,
    auditLog,
    workers,
    buckets,
    emailDestinations,
    members,
    oauthClients,
  ] = await Promise.all([
    listing(() => reader.pages<ListedToken>(`${a}/tokens`)),
    listing(() => reader.pages<ListedToken>("/user/tokens")),
    listing(() =>
      reader.cursor<AuditLogEntry>(`${a}/logs/audit`, {
        since: rfc3339(params.since),
        before: rfc3339(params.before),
        limit: "1000",
        direction: "asc",
        "action_type.not": "view",
      }),
    ),
    listing(async () =>
      (await reader.get<Array<{ id: string }>>(`${a}/workers/scripts`)).result.map((w) => w.id),
    ),
    listing(async () =>
      (
        await reader.cursor<{ name: string }, { buckets?: Array<{ name: string }> }>(
          `${a}/r2/buckets`,
          { per_page: "1000" },
          (r) => r?.buckets ?? [],
        )
      ).map((b) => b.name),
    ),
    listing(async () =>
      (await reader.pages<{ email: string }>(`${a}/email/routing/addresses`)).map((d) => d.email),
    ),
    listing(async () =>
      (
        await reader.pages<{ id?: string; user?: { email?: string }; email?: string }>(
          `${a}/members`,
        )
      ).map(
        // No shared placeholder: accepting one would accept every such member.
        (m) => m.user?.email ?? m.email ?? `member-id:${m.id ?? "missing"}`,
      ),
    ),
    listing(async () =>
      (
        await reader.pages<{
          id?: string;
          client_id?: string;
          name?: string;
          client_name?: string;
        }>(`${a}/oauth_clients`)
      ).map((c) => ({ id: c.id ?? c.client_id ?? "", name: c.name ?? c.client_name })),
    ),
  ]);

  const emailRules: CloudflareSnapshot["emailRules"] = !zones.ok
    ? zones
    : {
        ok: true,
        items: await Promise.all(
          zones.items.map(async (zone) => {
            const errors: string[] = [];
            const rules: EmailRule[] = [];
            try {
              rules.push(
                ...(await reader.pages<EmailRule>(`/zones/${zone.id}/email/routing/rules`)),
              );
            } catch (err) {
              errors.push((err as Error).message);
            }
            try {
              const catchAll = (
                await reader.get<EmailRule>(`/zones/${zone.id}/email/routing/rules/catch_all`)
              ).result;
              if (catchAll) rules.push({ ...catchAll, name: catchAll.name || "catch-all" });
            } catch (err) {
              errors.push((err as Error).message);
            }
            return { zone: zone.name, rules, errors };
          }),
        ),
      };

  return {
    auditTokenId,
    accountTokens,
    userTokens,
    auditLog,
    workers,
    buckets,
    zones,
    emailDestinations,
    emailRules,
    members,
    oauthClients,
  };
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/** Name hatchkit gives the per-run Terraform token (deploy/terraform-token.ts). */
export const TERRAFORM_TOKEN_NAME = /^hatchkit-terraform-.+-\d{8}T\d{6}Z$/;
const TERRAFORM_TOKEN_MAX_AGE_MS = 60 * 60 * 1000;
const WINDOW_SLACK_MS = 5 * 60 * 1000;
/** A window with no recorded end (the process was killed) counts this
 *  long, and no window counts longer: a process left open for days must
 *  not vouch for the operator token for days. */
const MAX_WINDOW_MS = 2 * 60 * 60 * 1000;

export function inRunWindow(at: string | undefined, runs: readonly RunWindow[]): boolean {
  const t = at ? Date.parse(at) : Number.NaN;
  if (Number.isNaN(t)) return false;
  return runs.some((run) => {
    const start = Date.parse(run.start);
    if (Number.isNaN(start)) return false;
    const recorded = run.end ? Date.parse(run.end) : Number.NaN;
    const end = Math.min(
      Number.isNaN(recorded) ? start + MAX_WINDOW_MS : recorded,
      start + MAX_WINDOW_MS,
    );
    return t >= start - WINDOW_SLACK_MS && t <= end + WINDOW_SLACK_MS;
  });
}

/** Quote a value for a hint the reader may paste into a shell: names and
 *  addresses on the account are the attacker's choice. */
export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

const lower = (values: readonly string[]): Set<string> =>
  new Set(values.map((v) => v.trim().toLowerCase()));

function grants(token: ListedToken): string {
  const names = (token.policies ?? []).flatMap((p) =>
    (p.permission_groups ?? []).map((g) => g.name).filter(Boolean),
  );
  return names.length ? [...new Set(names)].join(", ") : "no policies listed";
}

function describeToken(token: ListedToken, owner: "account" | "user"): string {
  return [
    `${owner} token, status ${token.status ?? "?"}`,
    token.issued_on ? `issued ${token.issued_on}` : null,
    token.creator_email_at_creation ? `by ${token.creator_email_at_creation}` : null,
    token.last_used_on ? `last used ${token.last_used_on}` : "never used",
    `grants: ${grants(token)}`,
  ]
    .filter(Boolean)
    .join("; ");
}

function diffTokens(
  snap: CloudflareSnapshot,
  expected: CloudflareExpected,
  now: Date,
  findings: AuditFinding[],
): void {
  const known = new Map(expected.tokens.map((t) => [t.id, t]));
  for (const [owner, list] of [
    ["account", snap.accountTokens],
    ["user", snap.userTokens],
  ] as const) {
    if (!list.ok) continue;
    for (const token of list.items) {
      if (token.id === snap.auditTokenId || token.id === expected.operatorTokenId) continue;
      if (known.has(token.id)) continue;
      const subject = `${token.name} (${token.id})`;
      if (TERRAFORM_TOKEN_NAME.test(token.name)) {
        const age = now.getTime() - Date.parse(token.issued_on ?? "");
        if (age <= TERRAFORM_TOKEN_MAX_AGE_MS) {
          findings.push({
            severity: "info",
            check: "tokens",
            subject,
            detail: "per-run Terraform token, younger than 1 h",
          });
          continue;
        }
        findings.push({
          severity: "alert",
          check: "tokens",
          subject,
          detail: `Terraform-named token older than 1 h — the revoke failed, or someone copied the name. ${describeToken(token, owner)}`,
          hint: "Revoke it unless a hatchkit run is still going.",
        });
        continue;
      }
      findings.push({
        severity: "alert",
        check: "tokens",
        subject,
        // Disabled counts too: the operator can switch it on after the run.
        detail: `token hatchkit does not know. ${describeToken(token, owner)}`,
        hint:
          token.name === "hatchkit-cloudflare" && !expected.operatorTokenId
            ? `If this is the operator token: hatchkit audit cloudflare accept operator:${token.id}`
            : `Revoke it, or keep it: hatchkit audit cloudflare accept 'token:${token.id}=<why>'`,
      });
    }
  }
}

interface ActorGroup {
  severity: "alert" | "info";
  subject: string;
  why: string;
  entries: AuditLogEntry[];
}

function classifyEntry(
  entry: AuditLogEntry,
  expected: CloudflareExpected,
  knownTokens: Map<string, ExpectedToken>,
): { severity: "alert" | "info"; key: string; subject: string; why: string } {
  const actor = entry.actor ?? {};
  const ctx = actor.context ?? "";
  const tokenLabel = `${actor.token_name ?? "?"} (${actor.token_id ?? "no id"})`;
  if (actor.type && actor.type !== "user" && actor.type !== "account") {
    return {
      severity: "info",
      key: `actor:${actor.type}`,
      subject: `${actor.type} actor`,
      why: "Cloudflare-side actor",
    };
  }
  if (ctx === "dash") {
    return {
      severity: "info",
      key: `dash:${actor.email}`,
      subject: `dashboard: ${actor.email ?? "?"}`,
      why: "a person in the dashboard (a leaked token cannot use it)",
    };
  }
  if (ctx === "api_key") {
    return {
      severity: "alert",
      key: `api_key:${actor.email}`,
      subject: `Global API Key of ${actor.email ?? "?"}`,
      why: "the Global API Key made changes; hatchkit never uses it",
    };
  }
  if (ctx === "oauth") {
    const allowed = lower(expected.oauthApps).has((actor.token_name ?? "").toLowerCase());
    return {
      severity: allowed ? "info" : "alert",
      key: `oauth:${actor.token_name}`,
      subject: `OAuth app ${actor.token_name ?? "?"}`,
      why: allowed ? "allowed OAuth app" : "an OAuth app nobody allowed made changes",
    };
  }
  const tokenId = actor.token_id;
  if (tokenId && tokenId === expected.operatorTokenId) {
    const inside = inRunWindow(entry.action?.time, expected.runs);
    return {
      severity: inside ? "info" : "alert",
      key: `operator:${inside}`,
      subject: `operator token ${tokenLabel}`,
      why: inside
        ? "inside a recorded hatchkit run"
        : "outside every recorded hatchkit run — check the IPs",
    };
  }
  if (TERRAFORM_TOKEN_NAME.test(actor.token_name ?? "")) {
    const inside = inRunWindow(entry.action?.time, expected.runs);
    return {
      severity: inside ? "info" : "alert",
      key: `terraform:${inside}`,
      subject: "per-run Terraform tokens",
      why: inside ? "inside a recorded hatchkit run" : "outside every recorded hatchkit run",
    };
  }
  if (tokenId && knownTokens.has(tokenId)) {
    const known = knownTokens.get(tokenId);
    return {
      severity: "info",
      key: `token:${tokenId}`,
      subject: `${known?.kind} token ${tokenLabel}`,
      why: known?.note ? `known: ${known.note}` : "known token",
    };
  }
  return {
    severity: "alert",
    key: `unknown:${tokenId ?? ctx}`,
    subject: tokenId
      ? `unknown token ${tokenLabel}`
      : `credential "${ctx || "?"}" of ${actor.email ?? "?"}`,
    why: tokenId
      ? "a token hatchkit does not know made changes"
      : "the credential was not recorded",
  };
}

function summarizeEntries(entries: AuditLogEntry[]): string {
  const times = entries.map((e) => e.action?.time).filter(Boolean) as string[];
  const ips = [...new Set(entries.map((e) => e.actor?.ip_address).filter(Boolean))];
  const what = new Map<string, number>();
  for (const e of entries) {
    const label = `${e.action?.type ?? e.raw?.method ?? "?"} ${e.resource?.product ?? e.resource?.type ?? "?"}${e.zone?.name ? ` (${e.zone.name})` : ""}`;
    what.set(label, (what.get(label) ?? 0) + 1);
  }
  const top = [...what.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, 6)
    .map(([label, n]) => `${n}× ${label}`)
    .join(", ");
  return [
    `${entries.length} change(s): ${top}`,
    times.length ? `from ${times[0]} to ${times[times.length - 1]}` : null,
    ips.length ? `IPs ${ips.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("; ");
}

function diffAuditLog(
  snap: CloudflareSnapshot,
  expected: CloudflareExpected,
  findings: AuditFinding[],
): void {
  if (!snap.auditLog.ok) return;
  const knownTokens = new Map(expected.tokens.map((t) => [t.id, t]));
  const groups = new Map<string, ActorGroup>();
  for (const entry of snap.auditLog.items) {
    if (entry.action?.type === "view") continue;
    const c = classifyEntry(entry, expected, knownTokens);
    const group = groups.get(c.key) ?? { ...c, entries: [] };
    group.entries.push(entry);
    groups.set(c.key, group);
  }
  for (const group of groups.values()) {
    findings.push({
      severity: group.severity,
      check: "audit-log",
      subject: group.subject,
      detail: `${group.why}. ${summarizeEntries(group.entries)}`,
      hint:
        group.severity === "alert"
          ? "Open Manage account → Audit Logs, filter by this actor, and follow the incident runbook if you did not do this."
          : undefined,
    });
  }
}

function diffSet(
  check: AuditCheck,
  live: Listing<string[]>,
  allowed: readonly string[],
  noun: string,
  acceptKind: string,
  findings: AuditFinding[],
  caseInsensitive = false,
): void {
  if (!live.ok) return;
  const known = caseInsensitive ? lower(allowed) : new Set(allowed);
  for (const item of live.items) {
    if (known.has(caseInsensitive ? item.toLowerCase() : item)) continue;
    findings.push({
      severity: "alert",
      check,
      subject: item,
      detail: `${noun} hatchkit does not know`,
      hint: `Remove it, or keep it: hatchkit audit cloudflare accept ${shellQuote(`${acceptKind}:${item}`)}`,
    });
  }
}

function diffEmailRules(
  snap: CloudflareSnapshot,
  expected: CloudflareExpected,
  findings: AuditFinding[],
): void {
  if (!snap.emailRules.ok) return;
  const destinations = lower(expected.emailDestinations);
  const workers = new Set(expected.workers);
  for (const zone of snap.emailRules.items) {
    for (const rule of zone.rules) {
      if (rule.enabled === false) continue;
      for (const action of rule.actions ?? []) {
        const targets = action.value ?? [];
        const bad =
          action.type === "forward"
            ? targets.filter((t) => !destinations.has(t.toLowerCase()))
            : action.type === "worker"
              ? targets.filter((t) => !workers.has(t))
              : [];
        if (!bad.length) continue;
        const match = (rule.matchers ?? []).map((m) => m.value ?? m.type).join(", ");
        findings.push({
          severity: "alert",
          check: "email-rules",
          subject: `${zone.zone}: ${rule.name || rule.id || "rule"}${match ? ` (${match})` : ""}`,
          detail: `${action.type === "forward" ? "forwards mail to" : "hands mail to Worker"} ${bad.join(", ")}, which hatchkit does not know`,
          hint:
            action.type === "forward"
              ? `Remove the rule, or keep it: hatchkit audit cloudflare accept ${bad.map((b) => shellQuote(`email:${b}`)).join(" ")}`
              : `Remove the rule, or keep it: hatchkit audit cloudflare accept ${bad.map((b) => shellQuote(`worker:${b}`)).join(" ")}`,
        });
      }
    }
    for (const error of zone.errors) {
      findings.push({
        // Only "Email Routing is off for this zone" may pass as info.
        severity: /HTTP 404\b/.test(error) ? "info" : "alert",
        check: "email-rules",
        subject: zone.zone,
        detail: `could not read Email Routing rules: ${error}`,
      });
    }
  }
}

/** Pure: snapshot + expected state → report. */
export function diffCloudflareAccount(params: {
  snapshot: CloudflareSnapshot;
  expected: CloudflareExpected;
  now: Date;
  since: Date;
}): CloudflareAuditReport {
  const { snapshot: snap, expected, now } = params;
  const findings: AuditFinding[] = [];
  diffTokens(snap, expected, now, findings);
  diffAuditLog(snap, expected, findings);
  diffSet("workers", snap.workers, expected.workers, "Worker", "worker", findings);
  diffSet("buckets", snap.buckets, expected.buckets, "R2 bucket", "bucket", findings);
  diffSet(
    "zones",
    snap.zones.ok ? { ok: true, items: snap.zones.items.map((z) => z.name) } : snap.zones,
    expected.zones,
    "zone",
    "zone",
    findings,
    true,
  );
  diffSet(
    "email-destinations",
    snap.emailDestinations,
    expected.emailDestinations,
    "Email Routing destination",
    "email",
    findings,
    true,
  );
  diffEmailRules(snap, expected, findings);
  diffSet("members", snap.members, expected.members, "account member", "member", findings, true);
  if (snap.oauthClients.ok) {
    const known = new Set(expected.oauthClients);
    for (const client of snap.oauthClients.items) {
      // By id only: the client's name is the attacker's choice.
      if (client.id && known.has(client.id)) continue;
      findings.push({
        severity: "alert",
        check: "oauth-clients",
        subject: `${client.name ?? "?"} (${client.id})`,
        detail: "OAuth client hatchkit does not know",
        hint: client.id
          ? `Delete it, or keep it: hatchkit audit cloudflare accept ${shellQuote(`oauth-client:${client.id}`)}`
          : "Cloudflare listed it without an id; review it in the dashboard.",
      });
    }
  }

  const checks: AuditCheckStatus[] = [];
  const health = (
    check: AuditCheck,
    listings: Array<Listing<unknown>>,
    what: string,
    optional = false,
  ): void => {
    const failed = listings.find((l): l is Extract<Listing<unknown>, { ok: false }> => !l.ok);
    if (failed) {
      // A check that cannot run must not read as all clear.
      checks.push({
        check,
        status: optional ? "skipped" : "error",
        detail: `could not list ${what}: ${failed.error}`,
      });
      return;
    }
    const alerts = findings.filter((f) => f.check === check && f.severity === "alert").length;
    checks.push({
      check,
      status: alerts ? "alert" : "ok",
      detail: alerts ? `${alerts} alert(s)` : `nothing unexpected in ${what}`,
    });
  };
  health("tokens", [snap.accountTokens, snap.userTokens], "account and user API tokens");
  health("audit-log", [snap.auditLog], "audit log entries");
  if (snap.workers.ok && snap.workers.items.length === 0 && expected.workers.length > 0) {
    // Without Workers Scripts Read the list answers 200 and empty
    // (per-Worker roles, 2026-09) — that must not read as "no Workers".
    checks.push({
      check: "workers",
      status: "error",
      detail: `the Workers list is empty but hatchkit knows ${expected.workers.length}; does the audit token have Workers Scripts · Read?`,
    });
  } else health("workers", [snap.workers], "Workers");
  health("buckets", [snap.buckets], "R2 buckets");
  health("zones", [snap.zones], "zones");
  health("email-destinations", [snap.emailDestinations], "Email Routing destinations");
  health("email-rules", [snap.emailRules], "Email Routing rules");
  health("members", [snap.members], "account members");
  health("oauth-clients", [snap.oauthClients], "OAuth clients", true);

  const order = { alert: 0, info: 1 } as const;
  findings.sort((x, y) => order[x.severity] - order[y.severity]);
  return {
    accountId: expected.accountId,
    checkedAt: now.toISOString(),
    window: { since: params.since.toISOString(), before: now.toISOString() },
    auditTokenId: snap.auditTokenId,
    summary: {
      alerts: findings.filter((f) => f.severity === "alert").length,
      info: findings.filter((f) => f.severity === "info").length,
      errors: checks.filter((c) => c.status === "error").length,
    },
    checks,
    findings,
  };
}

/** Exit 1 on any alert or required check that could not run. */
export function auditFailed(report: CloudflareAuditReport): boolean {
  return report.summary.alerts > 0 || report.summary.errors > 0;
}

/** Throws when `value` is not expected-state JSON this version reads. */
export function parseExpected(value: string, source: string): CloudflareExpected {
  let parsed: Partial<CloudflareExpected>;
  try {
    parsed = JSON.parse(value) as Partial<CloudflareExpected>;
  } catch (err) {
    throw new Error(`${source} is not valid JSON: ${(err as Error).message}`);
  }
  if (parsed?.version !== 1 || !/^[0-9a-f]{32}$/i.test(parsed.accountId ?? "")) {
    throw new Error(`${source} is not hatchkit expected-state JSON (version 1 with an accountId).`);
  }
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return {
    version: 1,
    accountId: parsed.accountId as string,
    generatedAt: parsed.generatedAt ?? "",
    operatorTokenId: parsed.operatorTokenId || undefined,
    tokens: Array.isArray(parsed.tokens)
      ? parsed.tokens.filter((t) => typeof t?.id === "string")
      : [],
    workers: strings(parsed.workers),
    buckets: strings(parsed.buckets),
    zones: strings(parsed.zones),
    emailDestinations: strings(parsed.emailDestinations),
    members: strings(parsed.members),
    oauthClients: strings(parsed.oauthClients),
    oauthApps: parsed.oauthApps ? strings(parsed.oauthApps) : [...DEFAULT_OAUTH_APPS],
    runs: Array.isArray(parsed.runs) ? parsed.runs.filter((r) => typeof r?.start === "string") : [],
  };
}
