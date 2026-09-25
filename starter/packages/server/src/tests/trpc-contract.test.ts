// Is the committed tRPC contract the one this code produces — and when it is
// not, does the failure name the versioning rule the change falls under?
//
// `packages/server/contract/trpc-contract.json` is a committed artifact. The
// client and the server are typechecked together here, but they are not
// deployed together: a self-hosted server lags the store clients by months, so
// a procedure's input narrowing is a refusal on somebody's phone that no test
// of this repo would ever see. The snapshot makes it a diff, and the classifier
// makes the diff say "raise the floor" or "bump the level".
//
// The second half of this file tests the classifier directly, on hand-written
// before/after snapshots. That is deliberate: reached only through the real
// snapshot, the rules would be exercised by whichever change happens to be in
// flight, so the interesting cases — optional → required, a removed input
// property, a removed sync kind — would be checked on the day they first
// happen and never again.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import {
  TRPC_CONTRACT_PATH,
  buildTrpcContract,
  classifyContractDiff,
  contractVerdict,
  trpcContractJson,
  type JsonSchema,
  type TrpcContract,
} from "../contract/trpc-contract.js";

/**
 * The router, imported lazily.
 *
 * Only the snapshot tests need it, and pulling in every domain router pulls in
 * the models and the service clients behind them. Loading that for the
 * classifier tests too would make a change in an unrelated service able to fail
 * the tests of a pure function.
 */
const generatedContract = async (): Promise<TrpcContract> => {
  const { appRouter } = await import("../trpc/router.js");
  return buildTrpcContract(appRouter);
};

const MISSING_SNAPSHOT = [
  `No committed tRPC contract at ${TRPC_CONTRACT_PATH}.`,
  "Generate it once and commit the result:",
  "",
  "    pnpm run contract:emit",
  "",
  "The file is the record of what a client built against this server may send.",
  "This test deliberately does not write it: a test that generates its own",
  "expectation cannot fail, and every later contract change would land",
  "unclassified.",
].join("\n");

test("the committed contract matches the router, the sync events and the levels", async () => {
  // A missing snapshot is a failure with instructions, never a skip. A skipped
  // test is a green suite that checks nothing, and this is the only check that
  // an input narrowing is ever noticed.
  assert.ok(existsSync(TRPC_CONTRACT_PATH), MISSING_SNAPSHOT);

  const generated = await generatedContract();
  const raw = readFileSync(TRPC_CONTRACT_PATH, "utf8");
  const committed = JSON.parse(raw) as TrpcContract;
  const verdict = contractVerdict(committed, generated);
  assert.equal(verdict, null, verdict ?? undefined);
  // Byte-for-byte too, so key order and formatting cannot drift.
  assert.equal(raw, trpcContractJson(generated));
});

test("the contract covers the routers and the sync events this build has", async () => {
  const generated = await generatedContract();
  assert.ok(Object.keys(generated.procedures).length > 0);
  assert.ok("health.check" in generated.procedures);
  assert.equal(generated.procedures["health.check"]?.type, "query");
  assert.equal(generated.procedures["items.update"]?.type, "mutation");
  assert.ok("items.changed" in generated.syncEvents);
  assert.ok("profile.changed" in generated.syncEvents);
});

test("the real contract against itself is no change at all", async () => {
  const generated = await generatedContract();
  assert.deepEqual(classifyContractDiff(generated, structuredClone(generated)), []);
});

// ── Classifier fixtures ──────────────────────────────────────────────

const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: "object",
  properties,
  required,
});
const str: JsonSchema = { type: "string" };
const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: "null" }] });

const contract = (overrides: Partial<TrpcContract> = {}): TrpcContract => ({
  apiLevel: 3,
  minClientApiLevel: 2,
  procedures: {
    "items.create": { type: "mutation", input: object({ title: str }, ["title"]) },
    "items.list": { type: "query", input: null },
  },
  syncEvents: {
    "items.changed": object({ kind: { type: "string", const: "items.changed" }, id: str }, ["kind"]),
  },
  ...overrides,
});

const withCreateInput = (input: JsonSchema): TrpcContract =>
  contract({
    procedures: { ...contract().procedures, "items.create": { type: "mutation", input } },
  });

const kinds = (before: TrpcContract, after: TrpcContract): string[] =>
  [...new Set(classifyContractDiff(before, after).map((change) => change.kind))].sort();

// ── breaking ─────────────────────────────────────────────────────────

test("a removed procedure is breaking", () => {
  // The client still calls it. tRPC answers NOT_FOUND, and the call fails for
  // every build in the field until it is updated.
  const after = contract({ procedures: { "items.list": { type: "query", input: null } } });
  assert.deepEqual(kinds(contract(), after), ["breaking"]);
});

test("a procedure whose type changed is breaking", () => {
  const after = contract({
    procedures: { ...contract().procedures, "items.list": { type: "mutation", input: null } },
  });
  assert.deepEqual(kinds(contract(), after), ["breaking"]);
});

test("an input property going optional → required is breaking", () => {
  const before = withCreateInput(object({ title: str, status: str }, ["title"]));
  const after = withCreateInput(object({ title: str, status: str }, ["title", "status"]));
  assert.deepEqual(kinds(before, after), ["breaking"]);
});

test("a required input property added is breaking", () => {
  assert.deepEqual(
    kinds(contract(), withCreateInput(object({ title: str, status: str }, ["title", "status"]))),
    ["breaking"],
  );
});

test("an enum value removed from an input is breaking", () => {
  const before = withCreateInput(object({ status: { type: "string", enum: ["draft", "published"] } }));
  const after = withCreateInput(object({ status: { type: "string", enum: ["draft"] } }));
  assert.deepEqual(kinds(before, after), ["breaking"]);
});

test("an input narrowed — nullable to non-null, or a tighter bound — is breaking", () => {
  const before = withCreateInput(object({ description: nullable(str) }));
  assert.deepEqual(kinds(before, withCreateInput(object({ description: str }))), ["breaking"]);
  const long = withCreateInput(object({ title: { type: "string", maxLength: 200 } }));
  const short = withCreateInput(object({ title: { type: "string", maxLength: 80 } }));
  assert.deepEqual(kinds(long, short), ["breaking"]);
});

test("a removed sync event kind is breaking", () => {
  // The direction is the point: a client written against this server relies on
  // hearing that kind, and silence is a screen that never refreshes.
  assert.deepEqual(kinds(contract(), contract({ syncEvents: {} })), ["breaking"]);
});

test("a required sync payload field removed is breaking", () => {
  const after = contract({
    syncEvents: { "items.changed": object({ id: str }, []) },
  });
  assert.deepEqual(kinds(contract(), after), ["breaking"]);
});

// ── additive ─────────────────────────────────────────────────────────

test("an added procedure is additive", () => {
  const after = contract({
    procedures: { ...contract().procedures, "items.update": { type: "mutation", input: object({ id: str }, ["id"]) } },
  });
  assert.deepEqual(kinds(contract(), after), ["additive"]);
});

test("a new optional input property is additive", () => {
  assert.deepEqual(kinds(contract(), withCreateInput(object({ title: str, status: str }, ["title"]))), [
    "additive",
  ]);
});

test("an enum value added, on an input or on a sync payload, is additive", () => {
  const before = withCreateInput(object({ status: { type: "string", enum: ["draft"] } }));
  const after = withCreateInput(object({ status: { type: "string", enum: ["draft", "archived"] } }));
  assert.deepEqual(kinds(before, after), ["additive"]);

  // On an OUTPUT a widening would normally be breaking — an older client
  // receives a value it has never heard of. It is additive anyway, because a
  // client's answer to an unknown value is "refetch", never "ignore".
  const scoped = (values: string[]): TrpcContract =>
    contract({
      syncEvents: {
        "items.changed": object(
          {
            kind: { type: "string", const: "items.changed" },
            id: str,
            scope: { type: "string", enum: values },
          },
          ["kind"],
        ),
      },
    });
  assert.deepEqual(kinds(scoped(["one"]), scoped(["one", "all"])), ["additive"]);
});

test("a new sync event kind is additive", () => {
  const after = contract({
    syncEvents: { ...contract().syncEvents, "profile.changed": object({}, []) },
  });
  assert.deepEqual(kinds(contract(), after), ["additive"]);
});

// ── neutral ──────────────────────────────────────────────────────────

test("a removed input property is neutral: stripped, never refused", () => {
  // zod strips an unknown key rather than refusing the object, so an old client
  // that still sends the field is served exactly as before.
  const changes = classifyContractDiff(contract(), withCreateInput(object({}, [])));
  assert.deepEqual(kinds(contract(), withCreateInput(object({}, []))), ["neutral"]);
  assert.match(changes[0]?.detail ?? "", /stripped, never refused/);
});

test("a description change is no change", () => {
  assert.deepEqual(
    kinds(
      contract(),
      withCreateInput(object({ title: { ...str, description: "What to call it" } }, ["title"])),
    ),
    [],
  );
});

// ── the verdict ──────────────────────────────────────────────────────

test("contractVerdict is null when nothing changed", () => {
  assert.equal(contractVerdict(contract(), contract()), null);
});

test("contractVerdict asks for both levels on a breaking change", () => {
  const after = contract({ syncEvents: {} });
  assert.match(
    contractVerdict(contract(), after) ?? "",
    /Raise MIN_CLIENT_API_LEVEL and API_LEVEL/,
  );
  // Only the level raised is not enough: the floor is what stops the old client
  // from reaching the procedure at all.
  assert.match(
    contractVerdict(contract(), { ...after, apiLevel: 4 }) ?? "",
    /Raise MIN_CLIENT_API_LEVEL/,
  );
});

test("a breaking change with BOTH levels raised leaves only the regeneration", () => {
  const after = contract({ syncEvents: {} });
  const verdict = contractVerdict(contract(), { ...after, apiLevel: 4, minClientApiLevel: 3 });
  assert.match(verdict ?? "", /^The committed tRPC contract is stale\./);
  assert.match(verdict ?? "", /contract:emit/);
  assert.doesNotMatch(verdict ?? "", /Raise MIN_CLIENT_API_LEVEL/);
});

test("contractVerdict asks for an API_LEVEL bump on an additive change", () => {
  const after = withCreateInput(object({ title: str, status: str }, ["title"]));
  assert.match(
    contractVerdict(contract(), after) ?? "",
    /Bump API_LEVEL and add an API_LEVEL_CHANGES entry/,
  );
  assert.match(contractVerdict(contract(), { ...after, apiLevel: 4 }) ?? "", /is stale/);
});

test("contractVerdict asks only for a regeneration on a neutral change", () => {
  assert.match(
    contractVerdict(contract(), withCreateInput(object({}, []))) ?? "",
    /is stale[\s\S]*pnpm run contract:emit/,
  );
});
