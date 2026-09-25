import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import { contentTypeFor, resolveAppPath, type EntryKind } from "./resolve-app-path.ts";

const ROOT = path.resolve("/export");

/** A fake export tree: paths relative to ROOT, files only; dirs are implied. */
function tree(files: string[]): (p: string) => EntryKind {
  const set = new Set(files.map((f) => path.join(ROOT, ...f.split("/"))));
  return (p) => {
    if (set.has(p)) return "file";
    const prefix = p + path.sep;
    for (const f of set) if (f.startsWith(prefix)) return "dir";
    return null;
  };
}

const exportTree = tree([
  "index.html",
  "404.html",
  "login/index.html",
  "login/index.txt",
  "settings/index.html",
  "privacy.html",
  "_next/static/chunks/main.js",
  "images/logo.png",
  "with space/index.html",
]);

const resolve = (url: string) => resolveAppPath(url, ROOT, exportTree);
const at = (...parts: string[]) => path.join(ROOT, ...parts);

describe("resolveAppPath", () => {
  it("serves index.html at the root", () => {
    assert.deepEqual(resolve("app://-/"), { status: 200, file: at("index.html") });
    assert.deepEqual(resolve("app://-"), { status: 200, file: at("index.html") });
  });

  it("resolves a trailing-slash route to its index.html", () => {
    assert.deepEqual(resolve("app://-/login/"), {
      status: 200,
      file: at("login", "index.html"),
    });
  });

  it("resolves a route without the trailing slash too", () => {
    assert.deepEqual(resolve("app://-/settings"), {
      status: 200,
      file: at("settings", "index.html"),
    });
  });

  it("falls back to <path>.html", () => {
    assert.deepEqual(resolve("app://-/privacy"), { status: 200, file: at("privacy.html") });
  });

  it("serves files as themselves", () => {
    assert.deepEqual(resolve("app://-/_next/static/chunks/main.js"), {
      status: 200,
      file: at("_next", "static", "chunks", "main.js"),
    });
    assert.deepEqual(resolve("app://-/login/index.txt"), {
      status: 200,
      file: at("login", "index.txt"),
    });
  });

  it("ignores query strings and fragments", () => {
    assert.deepEqual(resolve("app://-/login/index.txt?_rsc=abc123"), {
      status: 200,
      file: at("login", "index.txt"),
    });
    assert.deepEqual(resolve("app://-/login/?next=%2Fsettings#top"), {
      status: 200,
      file: at("login", "index.html"),
    });
  });

  it("decodes percent-encoding", () => {
    assert.deepEqual(resolve("app://-/with%20space/"), {
      status: 200,
      file: at("with space", "index.html"),
    });
  });

  it("answers an unknown path with 404.html and a 404 status", () => {
    assert.deepEqual(resolve("app://-/no/such/page/"), { status: 404, file: at("404.html") });
  });

  it("answers 404 with no file when the export has no 404 page", () => {
    const bare = tree(["index.html"]);
    assert.deepEqual(resolveAppPath("app://-/missing", ROOT, bare), { status: 404, file: null });
  });

  it("does not serve a directory that has no index.html", () => {
    assert.equal(resolve("app://-/_next/static/").status, 404);
  });

  it("never resolves outside the export", () => {
    // Depending on the form, the URL parser normalises the dot segments away
    // (and the request stays inside the root, answering 404) or they survive
    // decoding and are refused (400). Either way nothing outside is served.
    for (const url of [
      "app://-/%2e%2e/%2e%2e/etc/passwd",
      "app://-/login/%2E%2E/%2E%2E/secret",
      "app://-/..%2f..%2fsecret",
      "app://-/..%5c..%5csecret",
      "app://-/login/%2e%2e%2f%2e%2e%2f%2e%2e%2fsecret",
    ]) {
      const result = resolve(url);
      assert.notEqual(result.status, 200, url);
      assert.ok(result.file === null || result.file === at("404.html"), url);
    }
    // Encoded separators survive URL parsing, so these reach the segment check.
    assert.deepEqual(resolve("app://-/..%2f..%2fsecret"), { status: 400, file: null });
    assert.deepEqual(resolve("app://-/..%5c..%5csecret"), { status: 400, file: null });
    // A literal ".." is normalised by URL parsing and stays inside the root.
    assert.deepEqual(resolve("app://-/login/../index.html"), {
      status: 200,
      file: at("index.html"),
    });
  });

  it("refuses malformed escapes and NUL bytes", () => {
    assert.deepEqual(resolve("app://-/%E0%A4%A"), { status: 400, file: null });
    assert.deepEqual(resolve("app://-/index.html%00.png"), { status: 400, file: null });
  });

  it("does not answer another host from this export", () => {
    assert.deepEqual(resolve("app://evil/index.html"), { status: 404, file: at("404.html") });
  });

  it("refuses an unparseable URL", () => {
    assert.deepEqual(resolve("not a url"), { status: 400, file: null });
  });
});

describe("contentTypeFor", () => {
  it("knows the types the export contains", () => {
    assert.equal(contentTypeFor("a/index.html"), "text/html; charset=utf-8");
    assert.equal(contentTypeFor("x.JS"), "text/javascript; charset=utf-8");
    assert.equal(contentTypeFor("index.txt"), "text/plain; charset=utf-8");
    assert.equal(contentTypeFor("font.woff2"), "font/woff2");
    assert.equal(contentTypeFor("blob.bin"), "application/octet-stream");
  });
});
