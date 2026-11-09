/**
 * Which Coolify server a new app or database goes to when nothing names
 * one. The API lists servers in creation order; taking the first one
 * put every adopt and create since 6 November 2026 on the shared-services
 * box ("tools", reached over Tailscale) instead of the Coolify host that
 * runs every project app.
 */
import assert from "node:assert/strict";
import { type CoolifyServer, pickDefaultServer } from "./src/utils/coolify-api.js";

const tools: CoolifyServer = {
  id: 1,
  uuid: "t",
  name: "tools",
  ip: "192.0.2.10",
  isCoolifyHost: false,
  isUsable: true,
};
const apps: CoolifyServer = {
  id: 0,
  uuid: "a",
  name: "apps",
  ip: "host.docker.internal",
  isCoolifyHost: true,
  isUsable: true,
};

assert.equal(pickDefaultServer([tools, apps])?.name, "apps", "prefers the Coolify host");
assert.equal(pickDefaultServer([apps, tools])?.name, "apps");
assert.equal(pickDefaultServer([tools])?.name, "tools", "a single server is used as-is");
assert.equal(
  pickDefaultServer([tools, { ...apps, isUsable: false }])?.name,
  "tools",
  "skips an unusable Coolify host",
);
assert.equal(
  pickDefaultServer([
    { ...tools, isCoolifyHost: undefined },
    { ...apps, isCoolifyHost: undefined },
  ])?.name,
  "tools",
  "older Coolify builds without the flag keep the first server",
);
assert.equal(pickDefaultServer([]), undefined);

console.log("✓ default Coolify server");
