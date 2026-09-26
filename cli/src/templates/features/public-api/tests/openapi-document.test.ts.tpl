// Is the generated document actually a valid OpenAPI 3.1 document, and is the
// copy the docs site serves the one this code produces?
//
// Two different failures, both silent:
//
//  - A structurally wrong document still serves fine over HTTP. It breaks in
//    somebody else's client generator, weeks later, as an error message about
//    our spec that we never see. So the shape is asserted here rather than
//    trusted: 3.1.x, an operation under every path, a scope named on every
//    operation that needs one, and every `$ref` resolving.
//  - `docs-site/static/openapi.json` and `docs-site/docs/api/reference.md` are
//    COMMITTED artifacts. Nothing regenerates them at deploy time, on purpose —
//    a spec nobody reviews in a diff is a spec nobody reviews. The cost of that
//    choice is that they go stale in exactly one way: somebody changes a route
//    and does not re-run the emitter. That is what the last two tests catch.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { API_TOKEN_SCOPES } from "../auth/api-permissions.js";
import {
  OPENAPI_JSON_PATH,
  REFERENCE_MD_PATH,
  openApiJson,
  referenceMarkdown,
} from "../api/v1/emit-openapi.js";
import { buildOpenApiDocument } from "../api/v1/openapi.js";

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

/**
 * Routes that need a token but no scope. Written out, so that a route losing
 * its scope by accident fails here instead of quietly becoming reachable by
 * every token in the tenant.
 */
const SCOPE_FREE_OPERATIONS = new Set(["/api/v1/me get", "/api/v1/openapi.json get"]);

const doc = buildOpenApiDocument();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every `[path, method, operation]` in the document. */
function operations(): { path: string; method: string; operation: Record<string, unknown> }[] {
  const paths = doc.paths;
  assert.ok(isRecord(paths), "document has a paths object");
  const found: { path: string; method: string; operation: Record<string, unknown> }[] = [];
  for (const [path, item] of Object.entries(paths)) {
    assert.ok(isRecord(item), `${path} is a path item`);
    for (const [method, operation] of Object.entries(item)) {
      if (!HTTP_METHODS.includes(method)) continue;
      assert.ok(isRecord(operation), `${method} ${path} is an operation`);
      found.push({ path, method, operation });
    }
  }
  return found;
}

/** Walk everything, collecting `$ref` strings with where they were found. */
function refs(value: unknown, at = "#"): { pointer: string; at: string }[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => refs(item, `${at}/${index}`));
  }
  if (!isRecord(value)) return [];
  const found: { pointer: string; at: string }[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref" && typeof child === "string") {
      found.push({ pointer: child, at });
      continue;
    }
    found.push(...refs(child, `${at}/${key}`));
  }
  return found;
}

/** Resolve a local JSON pointer against the document, or return undefined. */
function resolvePointer(pointer: string): unknown {
  if (!pointer.startsWith("#/")) return undefined;
  let cursor: unknown = doc;
  for (const raw of pointer.slice(2).split("/")) {
    // JSON Pointer escaping: `~1` is a slash, `~0` a tilde. Unescaping in the
    // wrong order turns `~01` into a slash instead of the literal `~1`.
    const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[segment];
    if (cursor === undefined) return undefined;
  }
  return cursor;
}

describe("the OpenAPI document", () => {
  it("declares OpenAPI 3.1", () => {
    assert.match(String(doc.openapi), /^3\.1\.\d+$/);
  });

  it("carries the info and server blocks a generator needs", () => {
    const info = doc.info;
    assert.ok(isRecord(info));
    assert.ok(typeof info.title === "string" && info.title.length > 0);
    assert.ok(typeof info.version === "string" && info.version.length > 0);
    assert.ok(Array.isArray(doc.servers) && doc.servers.length > 0);
  });

  it("has at least one operation under every path", () => {
    const paths = doc.paths;
    assert.ok(isRecord(paths));
    assert.ok(Object.keys(paths).length > 0, "the document is not empty");
    for (const [path, item] of Object.entries(paths)) {
      assert.ok(isRecord(item));
      const methods = Object.keys(item).filter((key) => HTTP_METHODS.includes(key));
      assert.ok(methods.length > 0, `${path} has no operation — an unreachable path item`);
      assert.ok(path.startsWith("/api/v1"), `${path} is under the versioned base path`);
    }
  });

  it("gives every operation a unique id, a summary and a 200", () => {
    const ids = new Set<string>();
    for (const { path, method, operation } of operations()) {
      const where = `${method} ${path}`;
      const id = operation.operationId;
      assert.ok(typeof id === "string" && id.length > 0, `${where} has an operationId`);
      // A duplicate id makes a generated client overwrite one method with
      // another — the second route silently disappears from the SDK.
      assert.equal(ids.has(id), false, `${where} reuses operationId "${String(id)}"`);
      ids.add(id);
      assert.ok(
        typeof operation.summary === "string" && operation.summary.length > 0,
        `${where} has a summary`,
      );
      const responses = operation.responses;
      assert.ok(isRecord(responses) && "200" in responses, `${where} documents a 200`);
    }
  });

  it("names the scope every authenticated operation requires", () => {
    const scopes = new Set<string>(API_TOKEN_SCOPES);
    for (const { path, method, operation } of operations()) {
      const where = `${path} ${method}`;
      const declared = operation["x-required-scope"];
      if (SCOPE_FREE_OPERATIONS.has(where)) {
        assert.equal(declared, undefined, `${where} needs no scope`);
        continue;
      }
      assert.ok(
        typeof declared === "string" && scopes.has(declared),
        `${where} must name one of the API token scopes, got ${String(declared)}`,
      );
    }
  });

  it("requires the bearer scheme globally and opts out only the spec route", () => {
    assert.deepEqual(doc.security, [{ bearerAuth: [] }]);
    const components = doc.components;
    assert.ok(isRecord(components));
    assert.ok(isRecord(components.securitySchemes));
    assert.ok(isRecord(components.securitySchemes.bearerAuth));

    const anonymous = operations()
      .filter(({ operation }) => Array.isArray(operation.security))
      .map(({ path, method }) => `${method} ${path}`);
    // `security: []` is how OpenAPI spells "no credential" inside a document
    // that otherwise demands one. Exactly one route may say it.
    assert.deepEqual(anonymous, ["get /api/v1/openapi.json"]);
  });

  it("documents the rate-limit headers on the success and on the 429", () => {
    for (const { path, method, operation } of operations()) {
      if (Array.isArray(operation.security)) continue; // public: not rate-limited
      const where = `${method} ${path}`;
      const responses = operation.responses;
      assert.ok(isRecord(responses));

      const ok = responses["200"];
      assert.ok(isRecord(ok) && isRecord(ok.headers), `${where} 200 documents headers`);
      // On the success as much as the refusal: a client that can discover its
      // budget only by being refused has to hit the wall to learn where it is.
      for (const header of ["RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset"]) {
        assert.ok(header in ok.headers, `${where} 200 documents ${header}`);
      }

      const limited = responses["429"];
      assert.ok(isRecord(limited) && isRecord(limited.headers), `${where} documents a 429`);
      assert.ok("Retry-After" in limited.headers, `${where} 429 documents Retry-After`);
    }
  });

  it("resolves every $ref it contains", () => {
    const all = refs(doc);
    assert.ok(all.length > 0, "the Problem schema is referenced at least once");
    for (const { pointer, at } of all) {
      assert.notEqual(resolvePointer(pointer), undefined, `dangling $ref "${pointer}" at ${at}`);
    }
  });
});

describe("the committed docs artifacts", () => {
  const staleness = (file: string): string => `${file} is stale. Re-run: pnpm run openapi:emit`;

  it("match the generated spec", () => {
    assert.equal(readFileSync(OPENAPI_JSON_PATH, "utf8"), openApiJson(), staleness("openapi.json"));
  });

  it("match the generated reference page", () => {
    assert.equal(
      readFileSync(REFERENCE_MD_PATH, "utf8"),
      referenceMarkdown(),
      staleness("docs-site/docs/api/reference.md"),
    );
  });
});
