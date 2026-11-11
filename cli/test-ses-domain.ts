/** Pure tests for `hatchkit ses domain`: flag parsing and the printed
 * plan. No AWS, Cloudflare, keychain or ledger calls. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSesDomainFlags, sesDomainPlan } from "./src/provision/ses-domain-cli.js";

assert.deepEqual(parseSesDomainFlags([]), { dryRun: false, projectDir: "" });
const parsed = parseSesDomainFlags(["--dry-run", "/tmp/app"]);
assert.equal(parsed.dryRun, true);
assert.equal(parsed.projectDir, "/tmp/app");
assert.throws(() => parseSesDomainFlags(["--yes"]), /Unknown/);
assert.throws(() => parseSesDomainFlags(["/a", "/b"]), /extra/);

const plan = sesDomainPlan("app.example.com", "eu-west-1").join("\n");
assert.match(plan, /SES identity mail\.app\.example\.com in eu-west-1/);
assert.match(plan, /_domainkey\.mail\.app\.example\.com/);
assert.match(
  plan,
  /MAIL FROM bounce\.mail\.app\.example\.com: MX 10 feedback-smtp\.eu-west-1\.amazonses\.com/,
);
assert.match(plan, /no Listmonk/);

// The Listmonk path runs the same SES steps, so the two cannot drift.
const src = readFileSync(join(import.meta.dirname, "src/provision/listmonk-ses.ts"), "utf8");
const fn = src.slice(src.indexOf("export async function provisionListmonkSesForProject"));
assert(fn.includes("await provisionSesSendingDomain(opts, events)"));
assert(!fn.slice(0, 2000).includes("createSesDomain("));
console.log("✓ ses domain: flags, plan, shared SES steps with listmonk-ses");
