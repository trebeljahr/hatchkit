import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../api-client.js";
import { decodeOfflineMutation, type OfflineMutation } from "../offline-ops.js";
import type { QueuedMutation } from "../offline-queue.js";
import {
  classifyReplayOutcome,
  flushVerdictFor,
  isUnknownProcedure,
  readReplayErrorFacts,
  replayOfflineMutation,
  serverLevelHold,
  UnresolvedTempIdError,
  type OfflineReplayMutators,
  type ReplayIdMap,
} from "../offline-replay.js";

const QUEUED_AT = "2026-09-14T09:00:00.000Z";

const A = "tenant-a";
const B = "tenant-b";

const createInput = (title: string): Record<string, unknown> => ({
  title,
  createdAt: QUEUED_AT,
  timeZone: "UTC",
  originId: "o",
});

/** A queue row as it comes off storage, decoded the way a flush decodes it. */
const decoded = (
  op: string,
  input: Record<string, unknown>,
  extra: Partial<QueuedMutation> & { tempId?: string } = {},
): OfflineMutation => {
  const { tempId, ...stamps } = extra;
  const mutation = decodeOfflineMutation({
    id: op,
    op,
    payload: { input, ...(tempId ? { tempId } : {}) },
    createdAt: QUEUED_AT,
    ...stamps,
  });
  assert.ok(mutation, `decodable: ${op}`);
  return mutation;
};

type Call = { op: string; input: Record<string, unknown> };

const recordingMutators = (calls: Call[]): OfflineReplayMutators => {
  const record =
    (op: string) =>
    async (input: object): Promise<unknown> => {
      calls.push({ op, input: input as Record<string, unknown> });
      return { id: `real-${calls.length}` };
    };
  return {
    "items.create": record("items.create"),
    "items.update": record("items.update"),
    "items.remove": record("items.remove"),
  };
};

const row = (overrides: { tenantId?: string; apiLevel?: number } = {}): {
  op: string;
  tenantId?: string;
  apiLevel?: number;
} => ({ op: "items.update", ...overrides });

const unknownPath = (path: string): ApiError =>
  new ApiError(`No procedure found on path "${path}"`, "NOT_FOUND", 404);

// ── the temp-id chain ────────────────────────────────────────────────

test("a create's temp id is renamed, and the update behind it is retargeted", async () => {
  const calls: Call[] = [];
  const renamed: Array<[string, string]> = [];
  const resolved: ReplayIdMap = new Map();
  const context = {
    createdAt: QUEUED_AT,
    resolved,
    onTempIdResolved: (tempId: string, realId: string): void => {
      renamed.push([tempId, realId]);
    },
  };
  const mutators = recordingMutators(calls);

  await replayOfflineMutation(
    mutators,
    decoded("items.create", createInput("Invoicing"), { tempId: "temp-1" }),
    context,
  );
  assert.deepEqual([...resolved.entries()], [["temp-1", "real-1"]]);
  // Anything a host claimed against the temp id can only be renamed here.
  assert.deepEqual(renamed, [["temp-1", "real-1"]]);

  await replayOfflineMutation(
    mutators,
    decoded("items.update", { id: "temp-1", title: "edited", originId: "o" }, { tempId: "temp-1" }),
    context,
  );
  assert.equal(calls[1]?.input.id, "real-1");

  await replayOfflineMutation(
    mutators,
    decoded("items.remove", { id: "temp-1", originId: "o" }, { tempId: "temp-1" }),
    context,
  );
  assert.equal(calls[2]?.input.id, "real-1");
});

test("a row that already names a real id is sent exactly as it was queued", async () => {
  const calls: Call[] = [];
  await replayOfflineMutation(
    recordingMutators(calls),
    decoded("items.update", { id: "i-1", title: "edited", originId: "o" }),
    { createdAt: QUEUED_AT, resolved: new Map() },
  );
  assert.equal(calls[0]?.input.id, "i-1");
});

test("an update whose temp id was never resolved is refused, not sent", async () => {
  const calls: Call[] = [];
  const mutation = decoded(
    "items.update",
    { id: "temp-9", title: "edited", originId: "o" },
    { tempId: "temp-9" },
  );
  const error = await replayOfflineMutation(recordingMutators(calls), mutation, {
    createdAt: QUEUED_AT,
    resolved: new Map(),
  }).catch((e: unknown) => e);

  assert.ok(error instanceof UnresolvedTempIdError);
  assert.equal(error.tempId, "temp-9");
  assert.equal(error.queuedAt, QUEUED_AT);
  assert.equal(calls.length, 0, "nothing was sent");
  // It travels the same path as a server refusal, so the row is dropped and
  // the person is told rather than some other item being edited.
  assert.deepEqual(await classifyReplayOutcome(error, row()), {
    kind: "drop",
    reason: "unresolved-temp-id",
  });
});

test("a remove whose temp id was never resolved is refused too", async () => {
  const calls: Call[] = [];
  const error = await replayOfflineMutation(
    recordingMutators(calls),
    decoded("items.remove", { id: "temp-9", originId: "o" }, { tempId: "temp-9" }),
    { createdAt: QUEUED_AT, resolved: new Map() },
  ).catch((e: unknown) => e);
  assert.ok(error instanceof UnresolvedTempIdError);
  assert.equal(calls.length, 0);
});

// ── the tenant stamp ─────────────────────────────────────────────────

test("replay sends the stamped tenant on every op, over anything in the payload", async () => {
  const calls: Call[] = [];
  const mutators = recordingMutators(calls);
  const ops: Array<[string, Record<string, unknown>]> = [
    ["items.create", createInput("created")],
    // A payload that somehow carries a different tenant loses to the stamp.
    ["items.update", { id: "i-1", title: "edited", originId: "o", tenantId: B }],
    ["items.remove", { id: "i-1", originId: "o" }],
  ];
  for (const [op, input] of ops) {
    await replayOfflineMutation(mutators, decoded(op, input, { tenantId: A }), {
      createdAt: QUEUED_AT,
      resolved: new Map(),
    });
  }
  assert.equal(calls.length, ops.length);
  for (const call of calls) assert.equal(call.input.tenantId, A, call.op);
});

test("replay of an unstamped row sends no tenant, leaving the client's own", async () => {
  const calls: Call[] = [];
  await replayOfflineMutation(
    recordingMutators(calls),
    decoded("items.create", createInput("legacy")),
    { createdAt: QUEUED_AT, resolved: new Map() },
  );
  assert.equal("tenantId" in (calls[0]?.input ?? {}), false);
});

test("decode carries the stamps only when the row has them", () => {
  const stamped = decoded("items.create", createInput("x"), { tenantId: A, apiLevel: 4 });
  assert.equal(stamped.tenantId, A);
  assert.equal(stamped.apiLevel, 4);
  const legacy = decoded("items.create", createInput("y"));
  assert.equal("tenantId" in legacy, false);
  assert.equal("apiLevel" in legacy, false);
  // An op this build does not know decodes to nothing at all.
  assert.equal(
    decodeOfflineMutation({
      id: "z",
      op: "items.archive",
      payload: { input: {} },
      createdAt: QUEUED_AT,
    }),
    null,
  );
});

// ── the single classifier ────────────────────────────────────────────

test("no answer at all keeps the row", async () => {
  assert.deepEqual(await classifyReplayOutcome(new TypeError("fetch failed"), row()), {
    kind: "retry-later",
    reason: "transport",
  });
  // A client whose transport test is narrower: an error that is no answer.
  assert.deepEqual(
    await classifyReplayOutcome(new Error("boom"), row(), { isTransportFailure: () => false }),
    { kind: "retry-later", reason: "server" },
  );
});

test("UNAUTHORIZED retries later with its own reason", async () => {
  assert.deepEqual(await classifyReplayOutcome(new ApiError("x", "UNAUTHORIZED", 401), row()), {
    kind: "retry-later",
    reason: "unauthorized",
  });
});

test("an unknown procedure holds; an application NOT_FOUND drops", async () => {
  assert.deepEqual(await classifyReplayOutcome(unknownPath("items.update"), row()), {
    kind: "hold",
    reason: "unknown-procedure",
  });
  assert.deepEqual(await classifyReplayOutcome(new ApiError("Item not found", "NOT_FOUND", 404), row()), {
    kind: "drop",
    reason: "refused",
  });
  // A message that merely mentions the phrase is not the router's own.
  assert.equal(
    isUnknownProcedure({
      code: "NOT_FOUND",
      httpStatus: 404,
      message: 'Oops: No procedure found on path "x"',
    }),
    false,
  );
});

test("an unknown procedure holds even for a stamped row whose membership is fine", async () => {
  let asked = false;
  const outcome = await classifyReplayOutcome(unknownPath("items.update"), row({ tenantId: A }), {
    stillMember: async () => {
      asked = true;
      return true;
    },
  });
  assert.deepEqual(outcome, { kind: "hold", reason: "unknown-procedure" });
  assert.equal(asked, false);
});

test("5xx, 429 and a non-tRPC body retry later", async () => {
  for (const [code, status] of [
    ["INTERNAL_SERVER_ERROR", 500],
    ["SERVICE_UNAVAILABLE", 503],
    ["TOO_MANY_REQUESTS", 429],
    // A WAF's HTML page or a proxy answering `/api` mid-deploy: no verdict.
    ["PARSE_ERROR", 404],
    ["PARSE_ERROR", 403],
  ] as const) {
    assert.deepEqual(
      await classifyReplayOutcome(new ApiError("x", code, status), row()),
      { kind: "retry-later", reason: "server" },
      `${code} ${status}`,
    );
  }
});

test("400, 403, 409, 410 and 422 are refusals on the merits", async () => {
  for (const [code, status] of [
    ["BAD_REQUEST", 400],
    ["FORBIDDEN", 403],
    ["CONFLICT", 409],
    ["GONE", 410],
    ["UNPROCESSABLE_CONTENT", 422],
  ] as const) {
    assert.deepEqual(
      await classifyReplayOutcome(new ApiError("no", code, status), row()),
      { kind: "drop", reason: "refused" },
      code,
    );
  }
});

test("a 400 on a row above the server's level is held, not dropped", async () => {
  const bad = new ApiError("unknown field", "BAD_REQUEST", 400);
  const ahead = row({ apiLevel: 4 });
  assert.deepEqual(await classifyReplayOutcome(bad, ahead, { serverApiLevel: 3 }), {
    kind: "hold",
    reason: "server-too-old",
  });
  // The server caught up: the refusal really is about the row.
  assert.deepEqual(await classifyReplayOutcome(bad, ahead, { serverApiLevel: 4 }), {
    kind: "drop",
    reason: "refused",
  });
  // A server of unknown level, or a row of unknown level, is sent as before.
  assert.deepEqual(await classifyReplayOutcome(bad, ahead), { kind: "drop", reason: "refused" });
  assert.deepEqual(await classifyReplayOutcome(bad, row(), { serverApiLevel: 1 }), {
    kind: "drop",
    reason: "refused",
  });

  assert.equal(serverLevelHold({ apiLevel: 4 }, 3), "server-too-old");
  assert.equal(serverLevelHold({ apiLevel: 4 }, 4), null);
  assert.equal(serverLevelHold({ apiLevel: 4 }, null), null);
  assert.equal(serverLevelHold({}, 1), null);
});

test("a NOT_FOUND on a tenant-stamped row is kept unless membership is confirmed", async () => {
  const notFound = new ApiError("Item not found", "NOT_FOUND", 404);
  const stamped = row({ tenantId: A });
  // Removed from the tenant while the flush ran: kept.
  assert.deepEqual(await classifyReplayOutcome(notFound, stamped, { stillMember: async () => false }), {
    kind: "retry-later",
    reason: "membership",
  });
  // The re-ask failed: kept — not knowing is no reason to delete.
  assert.deepEqual(
    await classifyReplayOutcome(notFound, stamped, {
      stillMember: async () => {
        throw new Error("offline");
      },
    }),
    { kind: "retry-later", reason: "membership" },
  );
  // Still a member, so the item really is gone.
  assert.deepEqual(await classifyReplayOutcome(notFound, stamped, { stillMember: async () => true }), {
    kind: "drop",
    reason: "refused",
  });
  // Nobody to ask, and nothing to ask about.
  assert.deepEqual(await classifyReplayOutcome(notFound, stamped), { kind: "drop", reason: "refused" });
  assert.deepEqual(await classifyReplayOutcome(notFound, row(), { stillMember: async () => false }), {
    kind: "drop",
    reason: "refused",
  });
});

test("holdRefusal can hold a refusal on the merits, and only that", async () => {
  const holdRefusal = (): "unknown-procedure" => "unknown-procedure";
  assert.deepEqual(
    await classifyReplayOutcome(new ApiError("bad", "BAD_REQUEST", 400), row(), { holdRefusal }),
    { kind: "hold", reason: "unknown-procedure" },
  );
  assert.deepEqual(
    await classifyReplayOutcome(new ApiError("x", "INTERNAL_SERVER_ERROR", 500), row(), { holdRefusal }),
    { kind: "retry-later", reason: "server" },
  );
});

test("a tRPC client error shape is read like an ApiError", async () => {
  const trpcLike = Object.assign(new Error('No procedure found on path "items.update"'), {
    data: { code: "NOT_FOUND", httpStatus: 404 },
  });
  assert.deepEqual(
    await classifyReplayOutcome(trpcLike, row(), { isTransportFailure: () => false }),
    { kind: "hold", reason: "unknown-procedure" },
  );
  // No status on the envelope: the code alone maps to one.
  const noStatus = Object.assign(new Error("bad"), { data: { code: "BAD_REQUEST" } });
  assert.deepEqual(
    await classifyReplayOutcome(noStatus, row(), { isTransportFailure: () => false }),
    { kind: "drop", reason: "refused" },
  );
  assert.equal(readReplayErrorFacts(new Error("plain")), null);
  assert.equal(readReplayErrorFacts(null), null);
  assert.deepEqual(readReplayErrorFacts(new ApiError("m", "CONFLICT", 409)), {
    code: "CONFLICT",
    httpStatus: 409,
    message: "m",
  });
});

test("flushVerdictFor rethrows retry-later and hands back holds", () => {
  const error = new Error("x");
  assert.throws(() => flushVerdictFor({ kind: "retry-later", reason: "server" }, error), /x/);
  assert.deepEqual(flushVerdictFor({ kind: "hold", reason: "unknown-op" }, error), {
    hold: "unknown-op",
  });
  assert.equal(flushVerdictFor({ kind: "drop", reason: "refused" }, error), undefined);
  assert.equal(flushVerdictFor({ kind: "drop", reason: "unresolved-temp-id" }, error), undefined);
  assert.equal(flushVerdictFor({ kind: "applied" }, error), undefined);
});
