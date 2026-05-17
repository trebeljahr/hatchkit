/**
 * Listmonk client smoke tests — pure helpers only.
 *
 *  - `listmonkAuthHeader` follows the Listmonk docs verbatim:
 *      Authorization: token <api_user>:<token>
 *    Format is parsed server-side by string match, so any drift here
 *    silently breaks every API call. Worth a golden test.
 *
 *  - `normalizeListmonkUrl` strips trailing slashes so that
 *    `${base}/api/lists` always renders one separator, regardless of
 *    whether the user pasted `https://newsletter.example.com` or
 *    `https://newsletter.example.com/`.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import { listmonkAuthHeader, normalizeListmonkUrl } from "./src/provision/listmonk.js";

const failures: string[] = [];

function expect(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}: ${(err as Error).message}`);
    console.log(`  ✗ ${label}`);
  }
}

console.log("listmonkAuthHeader:");

expect("formats as `token <user>:<token>` per Listmonk docs", () => {
  assert.equal(
    listmonkAuthHeader({ apiUser: "hatchkit", apiToken: "abc123" }),
    "token hatchkit:abc123",
  );
});

expect("does not URL-encode or otherwise transform the inputs", () => {
  assert.equal(
    listmonkAuthHeader({ apiUser: "user with spaces", apiToken: "tok+ /=" }),
    "token user with spaces:tok+ /=",
  );
});

console.log("\nnormalizeListmonkUrl:");

expect("strips a single trailing slash", () => {
  assert.equal(normalizeListmonkUrl("https://newsletter.example.com/"), "https://newsletter.example.com");
});

expect("strips multiple trailing slashes", () => {
  assert.equal(normalizeListmonkUrl("https://newsletter.example.com///"), "https://newsletter.example.com");
});

expect("leaves a slashless URL untouched", () => {
  assert.equal(normalizeListmonkUrl("https://newsletter.example.com"), "https://newsletter.example.com");
});

expect("trims surrounding whitespace", () => {
  assert.equal(normalizeListmonkUrl("  https://newsletter.example.com/  "), "https://newsletter.example.com");
});

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nAll listmonk client tests passed.");
