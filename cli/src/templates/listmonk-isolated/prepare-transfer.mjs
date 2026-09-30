/** Offline only. Compiles a reviewed, selective export into a guarded SQL transaction. */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const columns = [
  'source_subscriber_id', 'source_subscriber_uuid', 'email', 'subscriber_status',
  'subscriber_created_at', 'subscriber_updated_at', 'source_list_id', 'source_list_uuid',
  'subscription_status', 'membership_created_at', 'membership_updated_at', 'membership_evidence',
];
class TransferInputError extends Error {}
const fail = message => { throw new TransferInputError(message); };
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const origin = value => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) fail('Expected an exact HTTPS origin');
  return value;
};
const literal = value => `'${String(value).replaceAll("'", "''")}'`;
const jsonLiteral = value => `${literal(JSON.stringify(value))}::jsonb`;

/** Strict RFC-style CSV quoting, including PostgreSQL JSON fields and embedded newlines. */
export function parseMembershipCsv(text) {
  if (Buffer.byteLength(text) > 10 * 1024 * 1024 || text.includes('\0')) fail('Export is too large or contains NUL');
  const rows = [];
  let row = [], field = '', quoted = false, closed = false;
  const finishField = () => { row.push(field); field = ''; closed = false; };
  const finishRow = () => { finishField(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; closed = true; }
      } else field += char;
    } else if (char === ',') finishField();
    else if (char === '\n') finishRow();
    else if (char === '\r' && text[i + 1] === '\n') { finishRow(); i++; }
    else if (char === '"' && !field && !closed) quoted = true;
    else {
      if (closed || char === '"' || char === '\r') fail('Malformed CSV quoting');
      field += char;
    }
  }
  if (quoted) fail('Unterminated CSV field');
  if (row.length || field || closed) finishRow();
  if (JSON.stringify(rows.shift()) !== JSON.stringify(columns)) fail('Unexpected export columns');
  return rows.map((values, index) => {
    if (values.length !== columns.length) fail(`Unexpected field count at row ${index + 2}`);
    return Object.fromEntries(columns.map((key, i) => [key, values[i]]));
  });
}

/** No network, database, environment credentials or Keychain calls. */
export function prepareTransfer(plan, review, csv) {
  if (!plan || !review || review.version !== 1 || review.reviewed !== true) fail('A version 1 reviewed mapping is required');
  if (review.project !== plan.project || review.targetOrigin !== plan.publicUrl) fail('Review does not match this staging bundle');
  origin(review.sourceOrigin); origin(review.targetOrigin);
  if (review.sourceOrigin === review.targetOrigin) fail('Source and destination must differ');
  if (!Array.isArray(plan.scope?.from) || plan.scope.from.length !== 1 || !/^[a-z0-9][a-z0-9._+-]*@[a-z0-9.-]+$/.test(plan.scope.from[0])) fail('Expected one pinned bare sender');
  if (!Array.isArray(review.lists) || review.lists.length !== 2 ||
      review.lists.map(x => x.role).sort().join(',') !== 'live,test') fail('Exactly live and test list mappings are required');
  const sourceLists = new Map(), targetLists = new Set();
  for (const list of review.lists) {
    if (!uuid(list.sourceUuid) || !uuid(list.targetUuid) || !Number.isSafeInteger(list.sourceId) || list.sourceId < 1 || list.sourceId > 2147483647) fail('Invalid list mapping');
    if (sourceLists.has(list.sourceUuid) || targetLists.has(list.targetUuid) || [...sourceLists.values()].some(x => x.sourceId === list.sourceId)) fail('Duplicate list mapping');
    sourceLists.set(list.sourceUuid, list); targetLists.add(list.targetUuid);
  }
  const rows = parseMembershipCsv(csv);
  const subscribers = new Map(), emails = new Map(), sourceIds = new Map(), memberships = new Set();
  for (const [i, row] of rows.entries()) {
    const invalid = reason => fail(`Invalid transfer row ${i + 2}: ${reason}`); // Never echo personal data.
    if (!uuid(row.source_subscriber_uuid) || !uuid(row.source_list_uuid)) invalid('UUID');
    const list = sourceLists.get(row.source_list_uuid);
    if (!list || String(list.sourceId) !== row.source_list_id) invalid('foreign list');
    if (!/^[1-9][0-9]*$/.test(row.source_subscriber_id) || !Number.isSafeInteger(Number(row.source_subscriber_id)) || Number(row.source_subscriber_id) > 2147483647) invalid('subscriber ID');
    if (row.email.length > 254 || !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(row.email)) invalid('mailbox');
    if (!['enabled', 'disabled', 'blocklisted'].includes(row.subscriber_status) ||
        !['unconfirmed', 'confirmed', 'unsubscribed'].includes(row.subscription_status)) invalid('status');
    for (const key of ['subscriber_created_at', 'subscriber_updated_at', 'membership_created_at', 'membership_updated_at']) {
      if (row[key] === '') row[key] = null; // Unknown stays unknown, never NOW().
      else if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(row[key]) || !Number.isFinite(Date.parse(row[key]))) invalid('timestamp');
    }
    try { row.membership_evidence = JSON.parse(row.membership_evidence); } catch { invalid('membership evidence JSON'); }
    if (!row.membership_evidence || typeof row.membership_evidence !== 'object' || Array.isArray(row.membership_evidence)) invalid('membership evidence object');
    const normalizedEmail = row.email.toLowerCase();
    if (emails.has(normalizedEmail) && emails.get(normalizedEmail) !== row.source_subscriber_uuid) invalid('ambiguous email ownership');
    if (sourceIds.has(row.source_subscriber_id) && sourceIds.get(row.source_subscriber_id) !== row.source_subscriber_uuid) invalid('ambiguous source ID');
    const identity = JSON.stringify(columns.slice(0, 6).map(key => row[key]));
    if (subscribers.has(row.source_subscriber_uuid) && subscribers.get(row.source_subscriber_uuid) !== identity) invalid('conflicting subscriber state');
    const key = `${row.source_subscriber_uuid}/${row.source_list_uuid}`;
    if (memberships.has(key)) invalid('duplicate membership');
    memberships.add(key); subscribers.set(row.source_subscriber_uuid, identity);
    emails.set(normalizedEmail, row.source_subscriber_uuid); sourceIds.set(row.source_subscriber_id, row.source_subscriber_uuid);
  }
  if (!rows.length || review.expectedSubscribers !== subscribers.size || review.expectedMemberships !== rows.length) fail('Export counts do not match independent reviewed counts, or export is empty');
  const digest = createHash('sha256').update(JSON.stringify({ review, rows })).digest('hex');
  const listMap = review.lists.map(x => ({ source_uuid: x.sourceUuid, target_uuid: x.targetUuid, role: x.role }));
  const manifest = { version: 1, project: review.project, source_origin: review.sourceOrigin, target_origin: review.targetOrigin,
    sha256: digest, subscribers: subscribers.size, memberships: rows.length };
  const sql = `-- PRIVATE: contains project subscriber data. Generated offline; review before execution.
-- Initial import only. A second run refuses; never upsert over new suppressions.
-- Execute only against the approved empty dedicated database with app writes/sends paused.
\\set ON_ERROR_STOP on
BEGIN;
SET LOCAL standard_conforming_strings = on;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
LOCK TABLE settings, lists, subscribers, subscriber_lists, campaigns IN ACCESS EXCLUSIVE MODE;
CREATE TEMP TABLE transfer_scope ON COMMIT DROP AS SELECT ${jsonLiteral({ target: review.targetOrigin, from: plan.scope.from[0] })} AS data;
DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM settings WHERE key='app.root_url' AND value=(SELECT data->'target' FROM transfer_scope))
     OR NOT EXISTS (SELECT 1 FROM settings WHERE key='app.from_email' AND value=(SELECT data->'from' FROM transfer_scope))
     OR NOT EXISTS (SELECT 1 FROM settings WHERE key='smtp' AND value='[]'::jsonb) THEN
    RAISE EXCEPTION 'Destination origin/sender/SMTP does not match the isolated staging plan';
  END IF;
  IF EXISTS (SELECT 1 FROM subscribers) OR EXISTS (SELECT 1 FROM campaigns) THEN
    RAISE EXCEPTION 'Destination contains subscribers or campaigns; initial import refused';
  END IF;
END $guard$;
CREATE TEMP TABLE transfer_lists ON COMMIT DROP AS
  SELECT * FROM jsonb_to_recordset(${jsonLiteral(listMap)}) AS x(source_uuid uuid, target_uuid uuid, role text);
DO $guard$
BEGIN
  IF (SELECT count(*) FROM lists) <> 2 OR
     (SELECT count(*) FROM lists l JOIN transfer_lists m ON l.uuid=m.target_uuid WHERE l.optin='double' AND l.status='active') <> 2 THEN
    RAISE EXCEPTION 'Destination must contain exactly the two approved active double-opt-in lists';
  END IF;
END $guard$;
CREATE TEMP TABLE transfer_rows ON COMMIT DROP AS
  SELECT * FROM jsonb_to_recordset(${jsonLiteral(rows)}) AS x(
    source_subscriber_id integer, source_subscriber_uuid uuid, email text, subscriber_status text,
    subscriber_created_at timestamptz, subscriber_updated_at timestamptz,
    source_list_id integer, source_list_uuid uuid, subscription_status text,
    membership_created_at timestamptz, membership_updated_at timestamptz, membership_evidence jsonb);
-- Existing schema is a collision, including a previous successful import: refuse adoption.
CREATE SCHEMA hatchkit_newsletter_transfer;
CREATE TABLE hatchkit_newsletter_transfer.manifest (data jsonb NOT NULL);
INSERT INTO hatchkit_newsletter_transfer.manifest VALUES (${jsonLiteral(manifest)});
CREATE TABLE hatchkit_newsletter_transfer.subscribers (
  source_uuid uuid PRIMARY KEY, source_id integer UNIQUE NOT NULL,
  target_uuid uuid UNIQUE NOT NULL, target_id integer UNIQUE NOT NULL);
CREATE TABLE hatchkit_newsletter_transfer.lists AS
  SELECT m.source_uuid, m.target_uuid, m.role, l.id AS target_id FROM transfer_lists m JOIN lists l ON l.uuid=m.target_uuid;
INSERT INTO subscribers (uuid,email,name,status,created_at,updated_at)
  SELECT gen_random_uuid(), email, email, subscriber_status::subscriber_status, subscriber_created_at, subscriber_updated_at
  FROM transfer_rows GROUP BY email, subscriber_status, subscriber_created_at, subscriber_updated_at;
INSERT INTO hatchkit_newsletter_transfer.subscribers
  SELECT DISTINCT r.source_subscriber_uuid,r.source_subscriber_id,s.uuid,s.id
  FROM transfer_rows r JOIN subscribers s ON s.email=r.email;
INSERT INTO subscriber_lists (subscriber_id,list_id,status,created_at,updated_at,meta)
  SELECT s.target_id,l.target_id,r.subscription_status::subscription_status,
         r.membership_created_at,r.membership_updated_at,r.membership_evidence
  FROM transfer_rows r JOIN hatchkit_newsletter_transfer.subscribers s ON s.source_uuid=r.source_subscriber_uuid
  JOIN hatchkit_newsletter_transfer.lists l ON l.source_uuid=r.source_list_uuid;
DO $verify$
BEGIN
  IF (SELECT count(*) FROM subscribers) <> ${subscribers.size} OR
     (SELECT count(*) FROM subscriber_lists) <> ${rows.length} OR
     EXISTS (
       SELECT 1 FROM transfer_rows r
       LEFT JOIN hatchkit_newsletter_transfer.subscribers m ON m.source_uuid=r.source_subscriber_uuid
       LEFT JOIN subscribers s ON s.id=m.target_id
       LEFT JOIN hatchkit_newsletter_transfer.lists l ON l.source_uuid=r.source_list_uuid
       LEFT JOIN subscriber_lists sl ON sl.subscriber_id=s.id AND sl.list_id=l.target_id
       WHERE s.email IS DISTINCT FROM r.email OR s.status::text IS DISTINCT FROM r.subscriber_status
         OR s.created_at IS DISTINCT FROM r.subscriber_created_at OR s.updated_at IS DISTINCT FROM r.subscriber_updated_at
         OR sl.status::text IS DISTINCT FROM r.subscription_status
         OR sl.created_at IS DISTINCT FROM r.membership_created_at OR sl.updated_at IS DISTINCT FROM r.membership_updated_at
         OR sl.meta IS DISTINCT FROM r.membership_evidence
     ) THEN RAISE EXCEPTION 'Imported state differs from the reviewed source; rollback required';
  END IF;
END $verify$;
COMMIT;
`;
  return { sql, summary: { sha256: digest, subscribers: subscribers.size, memberships: rows.length, status: 'prepared-only; SQL execution/rehearsal required' } };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [reviewPath, csvPath, output, ...extra] = process.argv.slice(2);
    if (!reviewPath || !csvPath || !output || extra.length) fail('Usage: node prepare-transfer.mjs reviewed-mapping.json memberships.csv NEW-output.sql');
    for (const path of [reviewPath, csvPath]) if (statSync(path).size > 10 * 1024 * 1024) fail('Input exceeds 10 MiB');
    const bundle = dirname(fileURLToPath(import.meta.url));
    const result = prepareTransfer(JSON.parse(readFileSync(resolve(bundle, 'plan.json'), 'utf8')),
      JSON.parse(readFileSync(reviewPath, 'utf8')), readFileSync(csvPath, 'utf8'));
    writeFileSync(output, result.sql, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify(result.summary));
  } catch (error) {
    // Parser/fs errors can echo input snippets or private paths; do not expose them.
    if (error instanceof TransferInputError) console.error(error.message);
    console.error('Transfer preparation failed. Review mapping, CSV, bundle plan and new output path locally; no database was changed.');
    process.exitCode = 1;
  }
}
