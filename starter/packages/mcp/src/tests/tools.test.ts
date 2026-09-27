import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { updateItemSchema } from "@starter/shared";
import { z } from "zod";
import { API_ROUTES, API_TOKEN_SCOPES } from "../routes.js";
import { TOOL_DEFINITIONS, UNTOOLED_ROUTES } from "../tools.js";

describe("the tool list against the route table", () => {
  it("no tool crosses the declared surface boundary", () => {
    // Identity, not string equality: a tool holds the row itself, so it
    // cannot address a path that is merely spelled like one of the API's.
    for (const tool of TOOL_DEFINITIONS) {
      assert.ok(
        API_ROUTES.includes(tool.route),
        `${tool.name} calls a route that is not in the mirrored table`,
      );
    }
  });

  it("every tool maps to one declared capability or to none", () => {
    for (const tool of TOOL_DEFINITIONS) {
      const scope = tool.route.scope;
      assert.ok(
        scope === null || API_TOKEN_SCOPES.includes(scope),
        `${tool.name} requires ${scope}, which the API does not declare`,
      );
    }
  });

  it("every route is either a tool or a stated exclusion, never both and never neither", () => {
    for (const route of API_ROUTES) {
      const tools = TOOL_DEFINITIONS.filter((tool) => tool.route === route);
      const excluded = UNTOOLED_ROUTES.filter(
        (row) => row.method === route.method && row.path === route.path,
      );
      assert.equal(
        tools.length + excluded.length,
        1,
        `${route.method} ${route.path} is covered ${tools.length + excluded.length} times`,
      );
    }
    for (const row of UNTOOLED_ROUTES) {
      assert.ok(row.reason.length > 20, `${row.method} ${row.path} needs a real reason`);
    }
  });

  it("names are unique and in the shape a model expects", () => {
    const names = TOOL_DEFINITIONS.map((tool) => tool.name);
    assert.equal(new Set(names).size, names.length, "duplicate tool name");
    for (const name of names) assert.match(name, /^[a-z][a-z0-9_]*$/);
  });

  it("marks the two deletes destructive and every read read-only", () => {
    for (const tool of TOOL_DEFINITIONS) {
      const isDelete = tool.route.method === "delete";
      assert.equal(tool.annotations.destructiveHint, isDelete, `${tool.name} destructiveHint`);
      assert.equal(
        tool.annotations.readOnlyHint,
        tool.route.method === "get",
        `${tool.name} readOnlyHint`,
      );
    }
  });
});

describe("input schemas", () => {
  /** The object schema a tool's shape describes. */
  const objectFor = (name: string) => {
    const tool = TOOL_DEFINITIONS.find((candidate) => candidate.name === name);
    assert.ok(tool, `no tool named ${name}`);
    return z.object(tool.inputShape);
  };

  it("leaves the page size out rather than pinning this build's default", () => {
    // The trap: `.default()` survives `.optional()`, so a shape that passed
    // the shared field through would send `limit=20` on every call and the
    // server's own default could never apply again.
    const parsed = objectFor("list_items").parse({});
    assert.equal("limit" in parsed, false, "an omitted limit stays omitted");

    const json = z.toJSONSchema(objectFor("list_items"), { io: "input" }) as {
      properties?: Record<string, { default?: unknown }>;
      required?: string[];
    };
    assert.equal(json.properties?.limit?.default, undefined, "no default reaches the model");
    assert.equal(json.required?.includes("limit") ?? false, false);
  });

  it("still enforces the server's own bounds on the page size", () => {
    assert.throws(() => objectFor("list_items").parse({ limit: 0 }));
    assert.throws(() => objectFor("list_items").parse({ limit: 101 }));
    assert.doesNotThrow(() => objectFor("list_items").parse({ limit: 100 }));
  });

  it("takes the item status values from the shared validator, not a copy", () => {
    // Every value the shared schema accepts, and nothing else. A status added
    // to the shared enum therefore reaches the tool list with no edit here,
    // which is the whole reason the shape is read off `.shape`.
    const shared = updateItemSchema.shape.status.unwrap() as z.ZodEnum<Record<string, string>>;
    const values = Object.values(shared.enum);
    assert.ok(values.length > 0);
    for (const value of values) {
      assert.doesNotThrow(() => objectFor("list_items").parse({ status: value }), `accepts ${value}`);
    }
    assert.throws(() => objectFor("list_items").parse({ status: "nonexistent" }));
  });

  it("carries the shared title and description limits into create_item", () => {
    assert.throws(() => objectFor("create_item").parse({ title: "" }));
    assert.throws(() => objectFor("create_item").parse({ title: "x".repeat(201) }));
    assert.doesNotThrow(() => objectFor("create_item").parse({ title: "ok" }));
  });
});

describe("ambiguous boundary values", () => {
  it("no route takes a date boundary — the tripwire for the rule that would apply", () => {
    // The rule, when one appears: resolve both bounds IN THE TOOL, in the
    // caller's zone, against that route's documented convention, and send
    // fully qualified timestamps. Two routes can read a bare `to` differently
    // and neither is wrong, so a tool that forwards the raw value returns a
    // different answer depending on which route it happened to call.
    //
    // Nothing implements that today because nothing needs it. This assertion
    // is what stops "nothing needs it" from silently stopping being true.
    // Split on camel-case boundaries rather than matching substrings:
    // "updateItemSchema" contains "date" and is not a date bound.
    const boundWords = new Set(["date", "day", "from", "to", "since", "until", "range", "period"]);
    for (const route of API_ROUTES) {
      const schema = route.input?.schema ?? "";
      const words = schema.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z]+/);
      for (const word of words) {
        assert.equal(
          boundWords.has(word),
          false,
          `${route.method} ${route.path} takes ${schema}: if it carries a bare date bound, resolve both bounds in the tool`,
        );
      }
    }
  });
});
