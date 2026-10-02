/**
 * The shutdown drain (src/drain.ts), as `/api/health` serves it.
 *
 * Two claims, and getting either wrong costs a deploy its zero downtime:
 *
 *  - Once draining, the in-container health probe (a loopback request) gets a
 *    503. That is what makes Docker mark the stopping container unhealthy and
 *    Traefik drop it before it closes; answered 200, Traefik routes to it
 *    until it exits and the requests caught in between fail.
 *  - A request from anywhere else still gets the normal answer. Visitors, a
 *    monitor and the deploy job's /api/health poll all come through Traefik —
 *    a 503 for them would be an outage the drain itself caused. Checked over a
 *    non-loopback interface when the machine has one.
 */
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { after, test } from "node:test";

import { createApp } from "../app.js";
import { isDraining, isLoopback, startDraining } from "../drain.js";

const servers: Server[] = [];
after(() => {
  for (const s of servers) s.close();
});

function listen(host: string): Promise<number> {
  return new Promise((resolve) => {
    const server = createApp().listen(0, host, () =>
      resolve((server.address() as AddressInfo).port),
    );
    servers.push(server);
  });
}

function externalIPv4(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family === "IPv4" && !i.internal) return i.address;
    }
  }
  return undefined;
}

test("isLoopback knows every spelling of the container's own address", () => {
  assert.equal(isLoopback("127.0.0.1"), true);
  assert.equal(isLoopback("::1"), true);
  assert.equal(isLoopback("::ffff:127.0.0.1"), true);
  assert.equal(isLoopback("10.0.1.5"), false);
  assert.equal(isLoopback(undefined), false);
});

test("draining fails the loopback probe and nothing else", async () => {
  const port = await listen("0.0.0.0");
  const probe = `http://127.0.0.1:${port}/api/health`;

  assert.equal(isDraining(), false);
  const before = await fetch(probe);
  const beforeStatus = before.status;

  startDraining();
  const drained = await fetch(probe);
  assert.equal(drained.status, 503);
  assert.deepEqual(await drained.json(), { status: "draining" });

  const ip = externalIPv4();
  if (ip) {
    const outside = await fetch(`http://${ip}:${port}/api/health`);
    assert.equal(outside.status, beforeStatus, `a request from ${ip} must not see the drain`);
    assert.notEqual(((await outside.json()) as { status?: unknown }).status, "draining");
  }
});
