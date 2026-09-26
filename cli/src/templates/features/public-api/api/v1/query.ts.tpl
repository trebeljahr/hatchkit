// Turning an HTTP request into something a zod schema will accept — the query
// string via `coerceQuery`, the body via `asObject`.
//
// Everything in a query string is a string. The schemas this API validates
// with are the SAME ones the tRPC procedures use, and those expect real
// numbers, booleans and arrays because tRPC's transport carries types. Rather
// than fork a second set of "REST flavoured" schemas — which is how two
// surfaces start disagreeing about what `limit=0` means — the strings are
// coerced on the way in.
//
// The coercion is SCHEMA-DIRECTED, never a guess. Blindly turning anything
// numeric-looking into a number would rewrite `search=2024` into a number and
// `id=0123` into 123, losing a leading zero that was part of an id. The shapes
// are read off the schema itself, via the same `z.toJSONSchema` call the
// OpenAPI document is built from — so a field can never be coerced one way
// here and documented another way there.
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { formatZodError } from "./problem.js";

/** How one query field should be read before validation. */
type FieldKind = "number" | "boolean" | "array" | "string";

/**
 * JSON Schema for a field can be a bare `{ type }` or an `anyOf` — that is
 * what `.nullish()` and a union compile to — so the reachable types are
 * collected rather than read off the top level.
 */
type JsonSchemaNode = {
  type?: string | string[];
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
  properties?: Record<string, JsonSchemaNode>;
};

function collectTypes(node: JsonSchemaNode, into: Set<string>): void {
  if (typeof node.type === "string") into.add(node.type);
  else if (Array.isArray(node.type)) for (const t of node.type) into.add(t);
  for (const branch of [...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])]) {
    collectTypes(branch, into);
  }
}

/**
 * `null` is what a `.nullish()` field contributes and says nothing about the
 * wire form, so it is dropped before deciding. `array` wins over everything
 * because a repeated key is unambiguous; `string` loses to everything because
 * a string needs no coercion at all.
 */
function kindOf(node: JsonSchemaNode): FieldKind {
  const types = new Set<string>();
  collectTypes(node, types);
  types.delete("null");
  if (types.has("array")) return "array";
  if (types.has("boolean")) return "boolean";
  if (types.has("number") || types.has("integer")) return "number";
  return "string";
}

/**
 * Kinds are derived once per schema and cached.
 *
 * Keyed on the schema object itself, so two routes sharing a schema share the
 * derivation. A WeakMap, so the cache cannot pin a schema alive.
 */
const kindCache = new WeakMap<object, Readonly<Record<string, FieldKind>>>();

export function queryFieldKinds(schema: z.ZodType): Readonly<Record<string, FieldKind>> {
  const cached = kindCache.get(schema);
  if (cached) return cached;

  const json = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "input",
  }) as JsonSchemaNode;

  const kinds: Record<string, FieldKind> = {};
  for (const [name, node] of Object.entries(json.properties ?? {})) {
    kinds[name] = kindOf(node);
  }
  kindCache.set(schema, kinds);
  return kinds;
}

function toStrings(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return typeof value === "string" ? [value] : [];
}

/**
 * Coerce a raw query object against the schema that will validate it.
 *
 * A value that will not coerce is passed through UNCHANGED rather than turned
 * into `NaN` or dropped: zod then reports "expected number, received string"
 * naming the field, which is a usable error message. Inventing a NaN here
 * surfaces later as a mystery 500 from deep inside a service.
 */
export function coerceQuery(
  raw: Record<string, unknown>,
  schema: z.ZodType,
): Record<string, unknown> {
  const kinds = queryFieldKinds(schema);
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    const kind = kinds[key];
    if (kind === undefined) {
      // Unknown to the schema. Copied through so zod — which strips unknown
      // keys — makes the decision, not this function.
      out[key] = value;
      continue;
    }

    if (kind === "array") {
      // Both spellings a client might reach for: repeated keys, and one key
      // holding a comma-separated list.
      const parts = toStrings(value).flatMap((item) =>
        item.includes(",") ? item.split(",") : [item],
      );
      out[key] = parts.map((part) => part.trim()).filter((part) => part !== "");
      continue;
    }

    const single = Array.isArray(value) ? value[value.length - 1] : value;
    if (typeof single !== "string") {
      out[key] = single;
      continue;
    }

    if (kind === "boolean") {
      if (single === "true") out[key] = true;
      else if (single === "false") out[key] = false;
      else out[key] = single;
      continue;
    }

    if (kind === "number") {
      const parsed = Number(single);
      out[key] = single.trim() !== "" && Number.isFinite(parsed) ? parsed : single;
      continue;
    }

    out[key] = single;
  }

  return out;
}

/**
 * The request body as an object, whatever arrived.
 *
 * Express 5 leaves `req.body` UNDEFINED when no body was sent, and several of
 * these schemas have only optional fields — so a PATCH with an empty body is a
 * legitimate no-op rather than a malformed request. Passing `undefined`
 * straight to zod would answer 400 for it.
 */
export function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Validate, or throw the BAD_REQUEST a validation failure is.
 *
 * A `TRPCError` rather than a bespoke type, so the one mapping function in
 * `problem.ts` covers both this and anything the shared services throw. A
 * second error taxonomy is a second thing to keep in step, and the first
 * refusal somebody forgets to map becomes a 500.
 */
export function parseWith<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new TRPCError({ code: "BAD_REQUEST", message: formatZodError(result.error) });
  }
  return result.data;
}
