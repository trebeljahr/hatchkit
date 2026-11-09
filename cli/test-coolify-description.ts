/**
 * Coolify v4 validates descriptions against a character allow-list and
 * fails the whole request with a 422 otherwise:
 *
 *   Coolify API POST /projects failed: 422 — {"errors":{"description":
 *   ["The description may only contain letters (including Unicode),
 *   numbers, spaces, and common punctuation: - _ . , ! ? ( ) ' " + = * / @ &"]}}
 *
 * A one-liner like "A monthly pact: goals at stake; …" stopped a create
 * after Terraform had already run. Every description hatchkit sends goes
 * through `coolifyDescription`.
 */
import assert from "node:assert/strict";
import { coolifyDescription } from "./src/utils/coolify-api.js";

const failures: string[] = [];
function check(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`  ✗ ${label}: ${(err as Error).message}`);
  }
}

const ALLOWED = /^[\p{L}\p{N}\s\-_.,!?()'"+=*/@&]*$/u;

check("colons and semicolons become dashes", () => {
  assert.equal(
    coolifyDescription("A monthly pact: goals with money at stake; missed stakes go to Wikipedia."),
    "A monthly pact - goals with money at stake - missed stakes go to Wikipedia.",
  );
});

check("em and en dashes become plain dashes", () => {
  assert.equal(coolifyDescription("Scheduler — posts – stories"), "Scheduler - posts - stories");
});

check("other characters are dropped, Unicode letters kept", () => {
  const out = coolifyDescription("Größe #1 <b>bold</b> ✨ [beta] {x} ~50% $9");
  assert.match(out, ALLOWED);
  assert.ok(out.startsWith("Größe 1 bbold/b"), out);
});

check("allowed punctuation passes unchanged", () => {
  const text = `Tools & tips (v2) - "fast", isn't it? a+b=c * x/y @home!`;
  assert.equal(coolifyDescription(text), text);
});

if (failures.length > 0) {
  console.log("\nCoolify description test failures:");
  for (const f of failures) console.log(f);
  process.exit(1);
}
console.log("\nAll Coolify description cases passed.");
