import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseMembershipCsv,
  prepareTransfer,
} from "./src/templates/listmonk-isolated/prepare-transfer.mjs";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const plan = {
  project: "alpha",
  publicUrl: "https://news.alpha.example.com",
  scope: { from: ["noreply@mail.alpha.example.com"] },
};
const review = {
  version: 1,
  reviewed: true,
  project: "alpha",
  sourceOrigin: "https://news.shared.example.com",
  targetOrigin: plan.publicUrl,
  lists: [
    { role: "live", sourceId: 3, sourceUuid: id(3), targetUuid: id(13) },
    { role: "test", sourceId: 4, sourceUuid: id(4), targetUuid: id(14) },
  ],
  expectedSubscribers: 3,
  expectedMemberships: 4,
};
const header =
  "source_subscriber_id,source_subscriber_uuid,email,subscriber_status,subscriber_created_at,subscriber_updated_at,source_list_id,source_list_uuid,subscription_status,membership_created_at,membership_updated_at,membership_evidence";
const date = "2026-09-29 01:02:03.123456+00";
const field = (v: unknown) => `"${String(v).replaceAll('"', '""')}"`;
const record = (
  n: number,
  list: number,
  global = "enabled",
  membership = "confirmed",
  evidence = {},
) => [
  n,
  id(n),
  `reader${n}@example.com`,
  global,
  date,
  date,
  list,
  id(list),
  membership,
  date,
  date,
  JSON.stringify(evidence),
];
const rows = [
  record(21, 3),
  record(21, 4, "enabled", "unsubscribed"),
  record(22, 3, "disabled", "unconfirmed"),
  record(23, 3, "blocklisted", "confirmed", {
    consent_note: "comma, quote\" newline\n O'Brien \\ end $guard$",
  }),
];
const csv = (records: unknown[][]) =>
  `${header}\n${records.map((r) => r.map(field).join(",")).join("\n")}\n`;
const input = csv(rows);
const result = prepareTransfer(plan, review, input);
assert.equal(result.summary.subscribers, 3);
assert.equal(result.summary.memberships, 4);
assert.match(result.sql, /BEGIN;/);
assert.match(result.sql, /LOCK TABLE/);
assert.match(result.sql, /ON_ERROR_STOP on/);
assert.match(result.sql, /COMMIT;/);
assert.match(result.sql, /O''Brien/);
assert.match(result.sql, /2026-09-29 01:02:03.123456\+00/);
assert(!result.sql.includes("ON CONFLICT"));
assert(!result.sql.includes("CREATE USER"));
assert(!result.sql.includes("DELETE FROM"));
assert.equal(prepareTransfer(plan, review, input).summary.sha256, result.summary.sha256);
assert.equal(parseMembershipCsv(input.replaceAll("\n", "\r\n")).length, 4);
const quotedMultiline = input.replace('comma, quote"" newline\\n', 'comma, quote"" newline\n');
assert.equal(parseMembershipCsv(quotedMultiline).length, 4);
for (const bad of [
  '"unterminated',
  `${header}\n\"a\"suffix\n`,
  `${header},settings\n`,
  input.replace("reader21@example.com", "bad address"),
]) {
  assert.throws(() => prepareTransfer(plan, review, bad));
}
for (const mutate of [
  (r: unknown[][]) => {
    r[0][7] = id(999);
  },
  (r: unknown[][]) => {
    r[0][6] = 999;
  },
  (r: unknown[][]) => {
    r[0][3] = "active";
  },
  (r: unknown[][]) => {
    r[0][8] = "consented";
  },
  (r: unknown[][]) => {
    r[1][3] = "enabled-wrong";
  },
  (r: unknown[][]) => {
    r[1][5] = "2026-09-28 01:02:03+00";
  },
  (r: unknown[][]) => {
    r[0][4] = "yesterday";
  },
  (r: unknown[][]) => {
    r[2][2] = "READER21@example.com";
  },
  (r: unknown[][]) => {
    r[0][11] = "[]";
  },
  (r: unknown[][]) => {
    r[0][0] = "2147483648";
  },
  (r: unknown[][]) => {
    r.push([...r[0]]);
  },
]) {
  const copy = structuredClone(rows);
  mutate(copy);
  assert.throws(() => prepareTransfer(plan, review, csv(copy)));
}
for (const patch of [
  { reviewed: false },
  { targetOrigin: review.sourceOrigin },
  { expectedSubscribers: 4 },
  { expectedMemberships: 3 },
  { lists: [review.lists[0], review.lists[0]] },
]) {
  assert.throws(() => prepareTransfer(plan, { ...review, ...patch }, input));
}
assert.throws(() =>
  prepareTransfer(
    plan,
    { ...review, expectedSubscribers: 0, expectedMemberships: 0 },
    `${header}\n`,
  ),
);
const unknownDates = structuredClone(rows);
unknownDates[2][4] = "";
unknownDates[2][5] = "";
unknownDates[2][10] = "";
assert.match(prepareTransfer(plan, review, csv(unknownDates)).sql, /"membership_updated_at":null/);

// Execute only the offline compiler CLI with synthetic input; output stays private.
const scratch = mkdtempSync(join(tmpdir(), "hatchkit-transfer-fixture-"));
try {
  cpSync(
    new URL("./src/templates/listmonk-isolated/prepare-transfer.mjs", import.meta.url),
    join(scratch, "prepare-transfer.mjs"),
  );
  writeFileSync(join(scratch, "plan.json"), JSON.stringify(plan));
  writeFileSync(join(scratch, "review.json"), JSON.stringify(review));
  writeFileSync(join(scratch, "input.csv"), input);
  const args = [
    join(scratch, "prepare-transfer.mjs"),
    join(scratch, "review.json"),
    join(scratch, "input.csv"),
    join(scratch, "output.sql"),
  ];
  const run = () => spawnSync(process.execPath, args, { encoding: "utf8", timeout: 5000 });
  const first = run();
  assert.equal(first.status, 0);
  assert.equal(JSON.parse(first.stdout).memberships, 4);
  assert(!first.stdout.includes("reader"));
  assert.equal(statSync(join(scratch, "output.sql")).mode & 0o777, 0o600);
  const before = readFileSync(join(scratch, "output.sql"), "utf8");
  assert.equal(run().status, 1);
  assert.equal(readFileSync(join(scratch, "output.sql"), "utf8"), before);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(
  "PASS: offline transfer validation, consent/suppression preservation, mixed-project rejection, SQL escaping and private no-overwrite output. PostgreSQL execution remains a separate rehearsal.",
);
