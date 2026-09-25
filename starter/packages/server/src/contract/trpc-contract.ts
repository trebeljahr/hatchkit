// The tRPC contract snapshot: what a client built against this server may send,
// and which sync events it may receive.
//
// `packages/server/contract/trpc-contract.json` is COMMITTED.
// `tests/trpc-contract.test.ts` regenerates it and, when the two differ,
// classifies the difference so the failure says which versioning rule applies
// (docs/versioning.md → "The contract snapshot"):
//
//  - BREAKING — an existing client can send something this server now refuses,
//    or stops receiving something it relies on. Raise MIN_CLIENT_API_LEVEL and
//    API_LEVEL in the same change.
//  - ADDITIVE — something new a newer client may rely on. Bump API_LEVEL.
//  - NEUTRAL — neither (a removed input property is stripped, not refused).
//
// Why bother, when the client and the server are typechecked together in one
// repo: they are not deployed together. A self-hosted server lags the store
// clients by months, so an input narrowing that typechecks green here is a
// refusal on somebody's phone that no test of this repo would ever see. The
// snapshot turns that into a diff in a pull request.
//
// Outputs are deliberately NOT snapshotted: they are TypeScript types and
// clients never validate them, so a changed output shape cannot refuse a
// request — at worst a field reads as undefined. Inputs are zod schemas, which
// is exactly what the server refuses a request with.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { API_LEVEL, MIN_CLIENT_API_LEVEL } from "@starter/shared";
import { syncEventSchemas } from "./sync-events.js";

const here = dirname(fileURLToPath(import.meta.url));

/** packages/server/src/contract → packages/server/contract. */
export const TRPC_CONTRACT_PATH = resolve(here, "../../contract/trpc-contract.json");

export type JsonSchema = Record<string, unknown>;

export type ProcedureContract = {
  type: "query" | "mutation" | "subscription";
  /** `null` when the procedure takes no input. */
  input: JsonSchema | null;
};

export type TrpcContract = {
  apiLevel: number;
  minClientApiLevel: number;
  procedures: Record<string, ProcedureContract>;
  /** Kind → the event object's schema. */
  syncEvents: Record<string, JsonSchema>;
};

type ProcedureDef = { _def: { type: ProcedureContract["type"]; inputs: readonly z.ZodType[] } };

function toSchema(schema: z.ZodType, io: "input" | "output"): JsonSchema {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io,
    unrepresentable: "any",
  }) as JsonSchema;
  return rest;
}

/**
 * tRPC merges several `.input()` parsers into one object. The snapshot does
 * the same with their schemas, so chaining an input onto a base procedure does
 * not read as a change.
 */
function mergeInputs(inputs: readonly z.ZodType[]): JsonSchema | null {
  if (inputs.length === 0) return null;
  const schemas = inputs.map((input) => toSchema(input, "input"));
  if (schemas.length === 1) return schemas[0] ?? null;
  if (!schemas.every((schema) => schema.type === "object")) return { allOf: schemas };
  const properties: Record<string, unknown> = {};
  const required = new Set<string>();
  for (const schema of schemas) {
    Object.assign(properties, schema.properties ?? {});
    for (const name of (schema.required as string[] | undefined) ?? []) required.add(name);
  }
  return { type: "object", properties, required: [...required] };
}

/** Recursively sorted object keys, so the file is byte-stable. Arrays keep their order. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
  );
}

export function buildTrpcContract(router: unknown): TrpcContract {
  const procedures = (router as { _def: { procedures: Record<string, ProcedureDef> } })._def
    .procedures;
  const contract: TrpcContract = {
    apiLevel: API_LEVEL,
    minClientApiLevel: MIN_CLIENT_API_LEVEL,
    procedures: Object.fromEntries(
      Object.entries(procedures).map(([path, procedure]) => [
        path,
        { type: procedure._def.type, input: mergeInputs(procedure._def.inputs) },
      ]),
    ),
    syncEvents: Object.fromEntries(
      Object.entries(syncEventSchemas).map(([kind, schema]) => [kind, toSchema(schema, "output")]),
    ),
  };
  return sortKeys(contract) as TrpcContract;
}

/** The exact bytes of the committed file. */
export function trpcContractJson(contract: TrpcContract): string {
  return `${JSON.stringify(contract, null, 2)}\n`;
}

// ── Classification ───────────────────────────────────────────────────

export type ContractChangeKind = "breaking" | "additive" | "neutral";

export type ContractChange = { kind: ContractChangeKind; at: string; detail: string };

/**
 * Which side of the wire reads the value. An input is written by an older
 * client and read by this server; a sync event is written by this server and
 * read by an older client. What narrows one widens the other.
 */
type Direction = "input" | "output";

/** Keywords that document a schema without changing what it accepts. */
const ANNOTATIONS = new Set(["description", "title", "default", "examples", "$schema", "id"]);

/** Keywords compared in their own right; everything else is compared by value. */
const STRUCTURAL = new Set([
  "type",
  "anyOf",
  "oneOf",
  "enum",
  "const",
  "properties",
  "required",
  "items",
  "additionalProperties",
]);

const LOWER_BOUNDS = new Set([
  "minLength",
  "minimum",
  "exclusiveMinimum",
  "minItems",
  "minProperties",
]);
const UPPER_BOUNDS = new Set([
  "maxLength",
  "maximum",
  "exclusiveMaximum",
  "maxItems",
  "maxProperties",
]);

function isRecord(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

/** `anyOf` branches keyed by what tells them apart — nearly always their type. */
function branches(schema: JsonSchema): Map<string, JsonSchema> | null {
  const list = schema.anyOf ?? schema.oneOf;
  if (!Array.isArray(list)) return null;
  const keyed = new Map<string, JsonSchema>();
  for (const branch of list) {
    if (!isRecord(branch)) continue;
    const key =
      "const" in branch
        ? `const:${JSON.stringify(branch.const)}`
        : typeof branch.type === "string"
          ? branch.type
          : JSON.stringify(sortKeys(branch));
    keyed.set(keyed.has(key) ? `${key}#${keyed.size}` : key, branch);
  }
  return keyed;
}

/** The values a schema allows, when it is an enumeration. */
function enumeration(schema: JsonSchema): unknown[] | null {
  if (Array.isArray(schema.enum)) return schema.enum;
  if ("const" in schema) return [schema.const];
  return null;
}

function typeSet(schema: JsonSchema): Set<string> | null {
  if (typeof schema.type === "string") return new Set([schema.type]);
  if (Array.isArray(schema.type)) return new Set(schema.type as string[]);
  return null;
}

/**
 * A narrowing of the accepted values: breaking for an input, harmless for an
 * output. A widening is the reverse — additive for an input (a newer client
 * may send it), breaking for an output (an older client receives it).
 */
function narrowed(direction: Direction): ContractChangeKind {
  return direction === "input" ? "breaking" : "neutral";
}
function widened(direction: Direction): ContractChangeKind {
  return direction === "input" ? "additive" : "breaking";
}

export function compareSchemas(
  before: JsonSchema,
  after: JsonSchema,
  at: string,
  direction: Direction,
): ContractChange[] {
  const changes: ContractChange[] = [];
  const push = (kind: ContractChangeKind, where: string, detail: string): void => {
    changes.push({ kind, at: where, detail });
  };

  const beforeBranches = branches(before);
  const afterBranches = branches(after);
  if (beforeBranches || afterBranches) {
    const b =
      beforeBranches ?? new Map([[typeof before.type === "string" ? before.type : "?", before]]);
    const a =
      afterBranches ?? new Map([[typeof after.type === "string" ? after.type : "?", after]]);
    for (const [key, branch] of b) {
      const next = a.get(key);
      if (!next) push(narrowed(direction), at, `no longer accepts ${key}`);
      else changes.push(...compareSchemas(branch, next, at, direction));
    }
    for (const key of a.keys()) {
      if (!b.has(key)) push(widened(direction), at, `now accepts ${key}`);
    }
    return changes;
  }

  const beforeTypes = typeSet(before);
  const afterTypes = typeSet(after);
  if (beforeTypes && afterTypes) {
    for (const type of beforeTypes) {
      if (!afterTypes.has(type)) push(narrowed(direction), at, `type ${type} removed`);
    }
    for (const type of afterTypes) {
      if (!beforeTypes.has(type)) push(widened(direction), at, `type ${type} added`);
    }
  } else if (!beforeTypes !== !afterTypes) {
    // `{}` (anything) to a typed schema narrows it; the reverse widens it.
    push(beforeTypes ? widened(direction) : narrowed(direction), at, "type constraint changed");
  }

  const beforeValues = enumeration(before);
  const afterValues = enumeration(after);
  if (beforeValues && afterValues) {
    for (const value of beforeValues) {
      if (!afterValues.some((v) => same(v, value))) {
        push(narrowed(direction), at, `enum value ${JSON.stringify(value)} removed`);
      }
    }
    for (const value of afterValues) {
      if (!beforeValues.some((v) => same(v, value))) {
        // An added value an older client has never heard of is still additive
        // on a sync event: clients treat an unknown value as "refetch" rather
        // than ignoring it (docs/versioning.md).
        push("additive", at, `enum value ${JSON.stringify(value)} added`);
      }
    }
  } else if (beforeValues && !afterValues) {
    push(widened(direction), at, "enumeration lifted");
  } else if (!beforeValues && afterValues) {
    push(narrowed(direction), at, "enumeration imposed");
  }

  const beforeProps = isRecord(before.properties) ? before.properties : {};
  const afterProps = isRecord(after.properties) ? after.properties : {};
  const beforeRequired = new Set((before.required as string[] | undefined) ?? []);
  const afterRequired = new Set((after.required as string[] | undefined) ?? []);
  for (const [name, schema] of Object.entries(beforeProps)) {
    const where = `${at}.${name}`;
    const next = afterProps[name];
    if (next === undefined) {
      if (direction === "input") {
        push("neutral", where, "property removed (stripped, never refused)");
      } else {
        push(beforeRequired.has(name) ? "breaking" : "neutral", where, "property removed");
      }
      continue;
    }
    if (!beforeRequired.has(name) && afterRequired.has(name)) {
      push(narrowed(direction), where, "optional → required");
    } else if (beforeRequired.has(name) && !afterRequired.has(name)) {
      push(widened(direction), where, "required → optional");
    }
    if (isRecord(schema) && isRecord(next)) {
      changes.push(...compareSchemas(schema, next, where, direction));
    }
  }
  for (const name of Object.keys(afterProps)) {
    if (name in beforeProps) continue;
    const where = `${at}.${name}`;
    if (afterRequired.has(name)) {
      push(direction === "input" ? "breaking" : "additive", where, "required property added");
    } else {
      push("additive", where, "optional property added");
    }
  }

  for (const key of ["items", "additionalProperties"] as const) {
    const b = before[key];
    const a = after[key];
    if (isRecord(b) && isRecord(a)) {
      changes.push(...compareSchemas(b, a, `${at}[${key}]`, direction));
    } else if (!same(b, a)) {
      // `false` ↔ a schema, or one side missing: compare as a plain value.
      push("breaking", at, `${key} changed`);
    }
  }

  const keywords = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const keyword of keywords) {
    if (ANNOTATIONS.has(keyword) || STRUCTURAL.has(keyword)) continue;
    const b = before[keyword];
    const a = after[keyword];
    if (same(b, a)) continue;
    if (
      (LOWER_BOUNDS.has(keyword) || UPPER_BOUNDS.has(keyword)) &&
      (b === undefined || typeof b === "number") &&
      (a === undefined || typeof a === "number")
    ) {
      const lower = LOWER_BOUNDS.has(keyword);
      // A bound appearing, or moving inward, narrows what is accepted.
      const tighter =
        a !== undefined && (b === undefined || (lower ? a > (b as number) : a < (b as number)));
      push(
        tighter ? narrowed(direction) : widened(direction),
        at,
        `${keyword} ${b ?? "∅"} → ${a ?? "∅"}`,
      );
      continue;
    }
    // A pattern, a format or anything unrecognised: cannot tell which way it
    // moved, so assume the worst.
    push("breaking", at, `${keyword} changed`);
  }

  return changes;
}

/** Every difference between two snapshots, apart from the two level numbers. */
export function classifyContractDiff(before: TrpcContract, after: TrpcContract): ContractChange[] {
  const changes: ContractChange[] = [];

  for (const [path, procedure] of Object.entries(before.procedures)) {
    const next = after.procedures[path];
    if (!next) {
      changes.push({ kind: "breaking", at: path, detail: "procedure removed or renamed" });
      continue;
    }
    if (procedure.type !== next.type) {
      changes.push({
        kind: "breaking",
        at: path,
        detail: `type ${procedure.type} → ${next.type}`,
      });
    }
    if (procedure.input && next.input) {
      changes.push(...compareSchemas(procedure.input, next.input, `${path}(input)`, "input"));
    } else if (!procedure.input && next.input) {
      // An older client sends no input at all, which an object parser refuses.
      changes.push({ kind: "breaking", at: `${path}(input)`, detail: "input added" });
    } else if (procedure.input && !next.input) {
      changes.push({ kind: "neutral", at: `${path}(input)`, detail: "input removed (ignored)" });
    }
  }
  for (const path of Object.keys(after.procedures)) {
    if (!(path in before.procedures)) {
      changes.push({ kind: "additive", at: path, detail: "procedure added" });
    }
  }

  for (const [kind, schema] of Object.entries(before.syncEvents)) {
    const next = after.syncEvents[kind];
    if (!next) {
      changes.push({ kind: "breaking", at: `sync:${kind}`, detail: "sync event kind removed" });
      continue;
    }
    changes.push(...compareSchemas(schema, next, `sync:${kind}`, "output"));
  }
  for (const kind of Object.keys(after.syncEvents)) {
    if (!(kind in before.syncEvents)) {
      changes.push({ kind: "additive", at: `sync:${kind}`, detail: "sync event kind added" });
    }
  }

  return changes;
}

const REGENERATE =
  "run `pnpm run contract:emit` and commit packages/server/contract/trpc-contract.json";

/**
 * The failure message for a stale snapshot, or `null` when there is nothing to
 * say. Levels are read from both sides: a breaking change is acceptable once
 * the generated snapshot carries a raised floor AND a raised level.
 */
export function contractVerdict(committed: TrpcContract, generated: TrpcContract): string | null {
  if (trpcContractJson(committed) === trpcContractJson(generated)) return null;

  const changes = classifyContractDiff(committed, generated);
  const list = (kind: ContractChangeKind): string =>
    changes
      .filter((change) => change.kind === kind)
      .map((change) => `  - ${change.at}: ${change.detail}`)
      .join("\n");
  const has = (kind: ContractChangeKind): boolean => changes.some((c) => c.kind === kind);
  const levelRaised = generated.apiLevel > committed.apiLevel;
  const floorRaised = generated.minClientApiLevel > committed.minClientApiLevel;

  if (has("breaking") && !(levelRaised && floorRaised)) {
    return [
      "The tRPC contract has BREAKING changes:",
      list("breaking"),
      "Raise MIN_CLIENT_API_LEVEL and API_LEVEL in the same change, see docs/versioning.md.",
      `Then ${REGENERATE}.`,
    ].join("\n");
  }
  if (has("additive") && !levelRaised) {
    return [
      "The tRPC contract has ADDITIVE changes:",
      list("additive"),
      "Bump API_LEVEL and add an API_LEVEL_CHANGES entry (packages/shared/src/api-level.ts).",
      `Then ${REGENERATE}.`,
    ].join("\n");
  }
  const summary = changes.map((change) => `  - [${change.kind}] ${change.at}: ${change.detail}`);
  return ["The committed tRPC contract is stale.", ...summary, `To fix it, ${REGENERATE}.`].join(
    "\n",
  );
}
