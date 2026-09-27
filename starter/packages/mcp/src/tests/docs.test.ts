/*
 * The README is the only thing a person reads before deciding which
 * capabilities to put on a token, and neither of its failure modes shows up
 * anywhere but in their hands: a table that overstates the tool set makes them
 * grant more than they need, one that understates it makes a correctly minted
 * token look broken.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { SERVER_NAME } from "../identity.js";
import { API_TOKEN_SCOPES } from "../routes.js";
import { TOOL_DEFINITIONS, renderCapabilityTable } from "../tools.js";
import { ORIGIN_VAR, TOKEN_VAR } from "../config.js";

const README = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "README.md"),
  "utf-8",
);

function markedBlock(name: string): string {
  const begin = `<!-- ${name}:begin -->`;
  const end = `<!-- ${name}:end -->`;
  const from = README.indexOf(begin);
  const to = README.indexOf(end);
  assert.ok(from !== -1 && to > from, `the README has no ${name} block`);
  return README.slice(from + begin.length, to).trim();
}

describe("the published capability table", () => {
  it("matches the registered tools exactly", () => {
    assert.equal(markedBlock("capability-table"), renderCapabilityTable());
  });

  it("names every tool that exists", () => {
    const table = markedBlock("capability-table");
    for (const tool of TOOL_DEFINITIONS) {
      assert.match(table, new RegExp(`\`${tool.name}\``), `${tool.name} is missing from the table`);
    }
  });

  it("names no capability the API does not declare", () => {
    // Anchored at the start of a line: the capability is the FIRST cell, and
    // an unanchored match would read the tool column of the free-tool row.
    for (const match of markedBlock("capability-table").matchAll(/^\| `([^`]+)` \|/gm)) {
      assert.ok(
        (API_TOKEN_SCOPES as readonly string[]).includes(match[1] as string),
        `${match[1]} is not a capability this API declares`,
      );
    }
  });
});

describe("the setup page", () => {
  it("states the tool count the verification step will print", () => {
    const stated = /· (\d+) tool\(s\) ·/.exec(README);
    assert.ok(stated, "the README shows no expected startup line");
    assert.equal(Number(stated[1]), TOOL_DEFINITIONS.length);
  });

  it("puts the verification step before the host configuration step", () => {
    // A misconfigured stdio server tells its host only that the process
    // exited, which cannot be diagnosed from inside the host.
    const verify = README.indexOf("## 3. Verify");
    const configure = README.indexOf("## 4. Configure your host");
    assert.ok(verify !== -1 && configure !== -1);
    assert.ok(verify < configure);
  });

  it("names both environment variables, and says the credential is stored in clear text", () => {
    assert.match(README, new RegExp(TOKEN_VAR));
    assert.match(README, new RegExp(ORIGIN_VAR));
    assert.match(README, /plain text/);
    assert.match(README, /revoke/);
  });

  it("says out loud that the only install path is this repository", () => {
    assert.match(README, /No published package/);
  });

  it("names the binary by the name the binary announces", () => {
    assert.match(README, new RegExp(SERVER_NAME));
  });
});
