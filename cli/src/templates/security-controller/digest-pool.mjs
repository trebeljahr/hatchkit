// One digest mail for every host.
//
// Each pooled host posts its open items every hour (`POST /digest/<host>`, the
// host's ping key; backups/ops_digest.py). The Worker keeps the latest post per
// host in R2 and, once a day at the digest hour, mails the items anyone can act
// on, merged across hosts: the same finding on two hosts is one line. The day's
// mail is skipped when nothing needs anyone, so a quiet day sends nothing.
// Once a week (the weekly day) it also lists what waits on a vendor, the fixes
// that landed, and the raw scanner matches each host holds for review.
//
// Items are the text the host's own mail would hold: package, advisory, container
// name, deadline, command. No application records, logs or secrets.
//
// `POST /resolve` (RESOLVER_KEY) marks items done from the operator's machine.
// A resolved item is hidden for RESOLVE_HOLD, long enough for every check to
// rescan; if a host still reports it after that, it comes back flagged.
import {renderMail,summaryLine} from './mail-core.mjs';

export const DIGEST_LIMIT = 2*1024*1024;
export const DIGEST_STALE = 3*3600000;
export const RESOLVE_HOLD = 26*3600000;
export const WEEKLY_UTC_DAY = 0; // Sunday 22:00 UTC is Monday morning in eastern Australia.
const SECTION_KEYS = ['needs','waiting','unchecked','fixed'];
const LIMITS = {what: 2000, detail: 2000, command: 500, deadline: 120, flag: 80};

export function weeklyDay(env) {
  const day = Number(env.WEEKLY_UTC_DAY ?? WEEKLY_UTC_DAY);
  return Number.isInteger(day) && day >= 0 && day < 7 ? day : WEEKLY_UTC_DAY;
}
const iso = ms => new Date(ms).toISOString();
const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : undefined;

function cleanItem(item) {
  if (!item || typeof item !== 'object' || typeof item.what !== 'string' || !item.what.trim()) throw new Error('invalid item');
  const out = {what: text(item.what, LIMITS.what)};
  for (const field of ['detail','command','deadline']) {
    const value = text(item[field], LIMITS[field]);
    if (value) out[field] = value;
  }
  if (Array.isArray(item.flags)) {
    const flags = item.flags.filter(f => typeof f === 'string').slice(0, 5).map(f => f.slice(0, LIMITS.flag));
    if (flags.length) out.flags = flags;
  }
  return out;
}
function cleanList(list, max=2000) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > max) throw new Error('invalid list');
  return list.map(cleanItem);
}

/** A host's digest post -> what is stored. Throws on anything that is not the expected shape. */
export function sanitizeDigest(body, host, now=Date.now()) {
  if (!body || typeof body !== 'object' || body.schema !== 1 || body.host !== host) throw new Error('invalid digest');
  const generated = Date.parse(body.generatedAt);
  if (!Number.isFinite(generated) || generated > now+300000) throw new Error('invalid time');
  const sections = {};
  for (const key of SECTION_KEYS) sections[key] = cleanList(body.sections?.[key]);
  const weekly = {needs: cleanList(body.weekly?.needs), waiting: cleanList(body.weekly?.waiting)};
  const counts = {};
  for (const key of ['rawCount','reviewedCount','packageCount','groupCount']) {
    const value = body.counts?.[key];
    counts[key] = Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }
  const paste = Array.isArray(body.paste) ? body.paste.filter(r => typeof r === 'string').slice(0, 3000).map(r => r.slice(0, 1000)) : [];
  return {receivedAt: iso(now), generatedAt: iso(generated), sections, weekly, counts, paste,
    ledger: text(body.ledger, 200) || null};
}

export async function itemId(section, what) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(section+'\n'+what));
  return Array.from(new Uint8Array(digest).slice(0, 6), b => b.toString(16).padStart(2,'0')).join('');
}

function monitorItems(issues) {
  // The VPS monitor's own findings: a check that went dark or failed needs someone;
  // coverage that is only incomplete is "not checked".
  const needs = [], unchecked = [];
  for (const issue of issues) (issue.endsWith(' incomplete') ? unchecked : needs).push({what: issue, command: monitorCommand(issue)});
  return {needs, unchecked};
}
function monitorCommand(issue) {
  const host=issue.split(':')[0];
  if(/publisher missing/.test(issue))return `tailscale ssh ${host} systemctl status hatchkit-health-publisher.timer`;
  if(/digest not received/.test(issue))return `tailscale ssh ${host} systemctl status hatchkit-backup-alerts.service`;
  if(/backups|restore/.test(issue))return `hatchkit backup status --host ${host} --json`;
  if(/process|full|file integrity|files/.test(issue))return `hatchkit host integrity --host ${host} --json`;
  if(/advisory|images|digest/.test(issue))return `hatchkit host updates --host ${host} --json`;
  return 'hatchkit doctor --json';
}

/** Merge the hosts' posts and the monitor's issues into sections of items with stable ids.
 *  -> {sections:{needs,waiting,unchecked,fixed}, weekly:{needs,waiting}, hosts, notes, paste} */
export async function mergeOpen(digests, monitorIssues, now=Date.now()) {
  const buckets = {needs: new Map(), waiting: new Map(), unchecked: new Map(), fixed: new Map(),
    weeklyNeeds: new Map(), weeklyWaiting: new Map()};
  const add = (bucket, section, host, item) => {
    const key = section+'\n'+item.what;
    const row = bucket.get(key) || {item: {...item}, what: item.what, section, hosts: [], commands: []};
    if (host && !row.hosts.includes(host)) row.hosts.push(host);
    if (item.command && !row.commands.includes(item.command)) row.commands.push(item.command);
    bucket.set(key, row);
  };
  const notes = [], paste = [], hosts = [];
  for (const [host, digest] of Object.entries(digests)) {
    if (!digest) continue;
    hosts.push(host);
    for (const key of SECTION_KEYS) for (const item of digest.sections[key]) add(buckets[key], key, host, item);
    for (const item of digest.weekly.needs) add(buckets.weeklyNeeds, 'needs', host, item);
    for (const item of digest.weekly.waiting) add(buckets.weeklyWaiting, 'waiting', host, item);
    if (digest.counts.rawCount) notes.push(`${host}: ${digest.counts.rawCount} unreviewed scanner matches stay in its ledger with their deadlines; they are listed in the weekly review.`);
    if (digest.counts.reviewedCount) notes.push(`${host}: ${digest.counts.reviewedCount} scanner matches have a current reviewed assessment.`);
    if (digest.paste.length) paste.push(`## ${host}`, ...digest.paste, '');
  }
  const monitor = monitorItems(monitorIssues);
  for (const item of monitor.needs) add(buckets.needs, 'needs', null, item);
  for (const item of monitor.unchecked) add(buckets.unchecked, 'unchecked', null, item);
  const finish = async bucket => Promise.all([...bucket.values()].map(async row => {
    const item = row.item;
    if (row.hosts.length) item.what = `[${row.hosts.join(', ')}] ${item.what}`;
    if (row.commands.length > 1) item.command = row.commands.join(' ; ');
    item.id = await itemId(row.section, row.what); // host-independent: one id however many hosts report it
    return item;
  }));
  return {sections: {needs: await finish(buckets.needs), waiting: await finish(buckets.waiting),
      unchecked: await finish(buckets.unchecked), fixed: await finish(buckets.fixed)},
    weekly: {needs: await finish(buckets.weeklyNeeds), waiting: await finish(buckets.weeklyWaiting)},
    hosts, notes, paste};
}

/** Drop items resolved less than RESOLVE_HOLD ago; flag items that outlived their resolve.
 *  -> {open, resolved (pruned)} */
export function applyResolved(open, resolved, now=Date.now()) {
  const kept = {};
  const filter = items => items.flatMap(item => {
    const entry = resolved[item.id];
    if (!entry) return [item];
    if (now-Date.parse(entry.at) < RESOLVE_HOLD) { kept[item.id] = entry; return []; }
    return [{...item, flags: [...(item.flags||[]), 'Still reported after it was resolved']}];
  });
  const sections = {}, weekly = {};
  for (const key of SECTION_KEYS) sections[key] = filter(open.sections[key]);
  for (const key of ['needs','waiting']) weekly[key] = filter(open.weekly[key]);
  return {open: {...open, sections, weekly}, resolved: kept};
}

const FOOTER = ['One mail for every host. A day with nothing to act on sends no mail.',
  'Mark an item done from your machine: hatchkit alerts resolve <ID>. It returns if a host still reports it after the next scans.',
  'Server access remains Tailscale-only.'];
const withId = item => ({...item, flags: [...(item.flags||[]), `ID ${item.id}`]});

/** -> mail document, or null when there is nothing to send. */
export function digestDocument(open, weekly, now=Date.now()) {
  const needs = open.sections.needs, unchecked = open.sections.unchecked;
  const sections = {needs: needs.map(withId), unchecked: unchecked.map(withId)};
  if (weekly) {
    sections.needs = [...sections.needs, ...open.weekly.needs.map(withId)];
    sections.waiting = [...open.sections.waiting, ...open.weekly.waiting].map(withId);
    sections.fixed = open.sections.fixed.map(withId);
  }
  const count = Object.values(sections).reduce((sum, list) => sum + list.length, 0);
  if (!weekly && !needs.length && !unchecked.length) return null;
  if (weekly && !count) return null;
  const doc = {title: weekly ? 'Weekly review' : 'Daily digest', host: open.hosts.join(', ') || 'all hosts',
    notes: weekly ? [...open.notes, 'Scanner matches are not confirmed incidents. Check vendor guidance and real exposure before a rollout, and keep the original deadlines.'] : open.notes,
    sections, footer: FOOTER};
  if (!weekly && open.sections.waiting.length) doc.notes = [...doc.notes, `${open.sections.waiting.length} item(s) wait on a vendor fix; they are listed in the weekly review and move here once a fix exists.`];
  if (open.paste.length) doc.paste = {
    instruction: 'Help me fix these Hatchkit findings. Check vendor guidance first, keep every deadline, never suppress a finding, and list each change you make.',
    meta: ['Hosts: '+open.hosts.join(', '), 'Generated: '+new Date(now).toISOString().slice(0,16).replace('T',' ')+' UTC'],
    rows: open.paste, ledger: 'each host\'s /var/lib/hatchkit-backups/update-watch-status.json'};
  return doc;
}
export const digestSubject = doc => `[Hatchkit] ${doc.title}: ${summaryLine(doc)}`;

export async function readDigests(env, hosts) {
  const out = {};
  for (const host of hosts) {
    const value = await env.STATE.get(`digests/${host}.json`);
    out[host] = value ? await value.json() : null;
  }
  return out;
}

/** Monitor issues about the digest feed itself: a host that posted once and then stopped. */
export function digestIssues(digests, now=Date.now()) {
  return Object.entries(digests).filter(([, d]) => d && now-Date.parse(d.receivedAt) > DIGEST_STALE)
    .map(([host]) => `${host}: daily digest not received for more than 3 hours`);
}

/** The once-a-day decision. `previous` is the pool state; returns {state, doc|null}. */
export function dueKind(env, previous, now, hour) {
  const date = new Date(now);
  if (date.getUTCHours() !== hour) return null;
  const today = date.toISOString().slice(0,10);
  if (previous.lastEvaluatedDay === today) return null;
  return {today, weekly: date.getUTCDay() === weeklyDay(env)};
}

export async function poolSweep(env, hosts, monitorIssues, hour, now=Date.now()) {
  const previous = await readJson(env, 'pool.json') || {};
  const due = dueKind(env, previous, now, hour);
  if (!due && !previous.deliveryPending) return previous;
  const digests = await readDigests(env, hosts);
  const resolved = await readJson(env, 'resolved.json') || {};
  const merged = await mergeOpen(digests, [...monitorIssues, ...digestIssues(digests, now)], now);
  const {open, resolved: kept} = applyResolved(merged, resolved, now);
  await env.STATE.put('resolved.json', JSON.stringify(kept));
  const weekly = due ? due.weekly : !!previous.pendingWeekly;
  const doc = digestDocument(open, weekly, now);
  const state = {...previous, checkedAt: iso(now), lastEvaluatedDay: due ? due.today : previous.lastEvaluatedDay,
    deliveryPending: !!doc, pendingWeekly: !!doc && weekly};
  // Saved before delivery: a failed send stays pending and retries on the next sweep.
  await env.STATE.put('pool.json', JSON.stringify(state));
  if (doc) {
    const sent = await env.EMAIL.send({from: env.MAIL_FROM, to: env.MAIL_TO, subject: digestSubject(doc), ...renderMail(doc)});
    Object.assign(state, {deliveryPending: false, pendingWeekly: false, lastSentAt: iso(now), messageId: sent?.messageId || null,
      lastKind: weekly ? 'weekly' : 'daily'});
    await env.STATE.put('pool.json', JSON.stringify(state));
  }
  return state;
}
async function readJson(env, key) { const v = await env.STATE.get(key); return v ? v.json() : null; }

/** `GET /open`: the merged open items with ids, after resolves. */
export async function openItems(env, hosts, monitorIssues, now=Date.now()) {
  const digests = await readDigests(env, hosts);
  const merged = await mergeOpen(digests, [...monitorIssues, ...digestIssues(digests, now)], now);
  const {open} = applyResolved(merged, await readJson(env, 'resolved.json') || {}, now);
  const received = Object.fromEntries(Object.entries(digests).map(([h, d]) => [h, d?.receivedAt || null]));
  return {checkedAt: iso(now), received, sections: open.sections, weekly: open.weekly, notes: open.notes};
}

/** `POST /resolve {ids, note?}`: only ids that are open now; unknown ids are refused. */
export async function resolveItems(env, hosts, monitorIssues, body, now=Date.now()) {
  const ids = Array.isArray(body?.ids) ? body.ids : null;
  if (!ids || !ids.length || ids.length > 50 || !ids.every(id => typeof id === 'string' && /^[0-9a-f]{12}$/.test(id)))
    return {status: 400, body: {error: 'ids must be 1-50 item ids'}};
  const note = typeof body.note === 'string' ? body.note.slice(0, 200) : null;
  const current = await openItems(env, hosts, monitorIssues, now);
  const all = [...Object.values(current.sections), ...Object.values(current.weekly)].flat();
  const known = new Map(all.map(item => [item.id, item.what]));
  const unknown = ids.filter(id => !known.has(id));
  if (unknown.length) return {status: 404, body: {error: 'not open', unknown}};
  const resolved = await readJson(env, 'resolved.json') || {};
  for (const id of ids) resolved[id] = {at: iso(now), note, what: known.get(id).slice(0, 300)};
  await env.STATE.put('resolved.json', JSON.stringify(resolved));
  return {status: 200, body: {resolved: ids.map(id => ({id, what: known.get(id)})), hiddenUntil: iso(now+RESOLVE_HOLD)}};
}
