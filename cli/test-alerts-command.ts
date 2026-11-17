/* `hatchkit alerts open|resolve`: talks to the monitor with the resolver key, never prints it. */
import assert from "node:assert/strict";
import { formatOpen, runAlertsCommand } from "./src/alerts/command.js";
import { getStore } from "./src/config.js";

process.env.HATCHKIT_SECRET_SECURITY_MONITOR_RESOLVER_KEY = "k".repeat(43);
getStore().set("securityMonitor", { url: "https://monitor.example.com", worker: "monitor" });
const calls: { url: string; init: RequestInit }[] = [];
const open = {
  checkedAt: "2026-11-17T22:00:00Z",
  received: { "app-vps": "2026-11-17T21:00:00Z", "ops-vps": null },
  sections: {
    needs: [
      {
        id: "0123456789ab",
        what: "[app-vps] runc 1.5.2",
        command: "hatchkit host updates --host app-vps --json",
      },
    ],
    waiting: [],
    unchecked: [],
    fixed: [],
  },
  weekly: {
    needs: [],
    waiting: [{ id: "ba9876543210", what: "[ops-vps] CVE-1. No fix reported." }],
  },
  notes: [],
};
const fetcher = (async (url: string, init: RequestInit) => {
  calls.push({ url, init });
  if (url.endsWith("/open")) return new Response(JSON.stringify(open));
  return new Response(
    JSON.stringify({
      resolved: [{ id: "0123456789ab", what: "[app-vps] runc 1.5.2" }],
      hiddenUntil: "2026-11-19T00:00:00Z",
    }),
  );
}) as unknown as typeof fetch;

const out: string[] = [];
const log = console.log;
console.log = (...a: unknown[]) => out.push(a.join(" "));
try {
  await runAlertsCommand(["open"], fetcher);
  await runAlertsCommand(["resolve", "0123456789ab", "--note", "patched"], fetcher);
  await assert.rejects(runAlertsCommand(["resolve", "not-an-id"], fetcher), /Not an item ID/);
} finally {
  console.log = log;
}
assert.equal(calls[0].url, "https://monitor.example.com/open");
assert.equal(
  (calls[0].init.headers as Record<string, string>).Authorization,
  `Bearer ${"k".repeat(43)}`,
);
assert.equal(calls[0].init.redirect, "error");
assert.deepEqual(JSON.parse(calls[1].init.body as string), {
  ids: ["0123456789ab"],
  note: "patched",
});
const text = out.join("\n");
assert(text.includes("0123456789ab") && text.includes("ba9876543210") && text.includes("ops-vps"));
assert(!text.includes("k".repeat(43)), "the key is never printed");
assert(
  formatOpen({
    ...open,
    sections: { needs: [], waiting: [], unchecked: [], fixed: [] },
    weekly: { needs: [], waiting: [] },
    received: {},
  }).includes("Nothing open."),
);
console.log("alerts command: open, resolve, id checks and key secrecy passed.");
