/**
 * Bundle-ID validator + slug derivation unit tests.
 *
 * Covers the pure-function corner cases for {@link validateBundleId}
 * and {@link suggestBundleId}. The stepper itself is interactive and
 * exercised by the integration tests; here we lock down the validation
 * rules.
 *
 * Run: pnpm --filter hatchkit test:signing-stepper
 */

import {
  projectKebab,
  suggestBundleId,
  validateBundleId,
} from "./src/features/signing/project-config.js";
import { renderSigningString } from "./src/features/signing/render.js";

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (!cond) {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function expectOk(input: string, expected: string): void {
  try {
    const out = validateBundleId(input);
    assert(out === expected, `validateBundleId(${input}) → ${out}, expected ${expected}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ validateBundleId(${input}) threw: ${(err as Error).message}`);
  }
}

function expectFail(input: string, substr: string): void {
  try {
    validateBundleId(input);
    failed++;
    console.error(`  ✗ validateBundleId(${input}) should have failed`);
  } catch (err) {
    const msg = (err as Error).message;
    assert(msg.includes(substr), `validateBundleId(${input}) error includes "${substr}": ${msg}`);
  }
}

// Happy path.
expectOk("com.example.app", "com.example.app");
expectOk("com.mesozoicprotocol.app", "com.mesozoicprotocol.app");
expectOk("io.ricoslabs.tiao", "io.ricoslabs.tiao");
expectOk("  io.ricoslabs.tiao  ", "io.ricoslabs.tiao");

// Failure modes.
expectFail("", "required");
expectFail("Com.Example.App", "lowercase");
expectFail("example", "2 dot-separated segments");
expectFail("com.example-app.demo", "hyphens");
expectFail("com.1example.app", "start with a letter");
expectFail("com..app", "start with a letter");

// Slug derivation.
assert(projectKebab("Mesozoic Protocol") === "mesozoic-protocol", `kebab: Mesozoic Protocol`);
assert(projectKebab("tiao") === "tiao", `kebab: tiao`);
assert(projectKebab("my_cool_app!") === "my-cool-app", `kebab: my_cool_app!`);

// Bundle-ID suggestion.
assert(
  suggestBundleId("com.mesozoicprotocol", "Tiao Game") === "com.mesozoicprotocol.tiaogame",
  `suggestBundleId with prefix`,
);
assert(
  suggestBundleId(undefined, "raptor-runner") === "com.example.raptorrunner",
  `suggestBundleId without prefix`,
);

// Render token substitution.
const tpl = `name: __HATCHKIT_APP_NAME__\nid: __HATCHKIT_BUNDLE_ID__\nuntouched: \${{ secrets.X }}\napple: __APPLE_TEAM_ID__\n`;
const rendered = renderSigningString(tpl, {
  BUNDLE_ID: "com.example.tiao",
  APP_NAME: "Tiao",
});
assert(rendered.includes("id: com.example.tiao"), `render: bundle id`);
assert(rendered.includes("name: Tiao"), `render: app name`);
assert(rendered.includes("${{ secrets.X }}"), `render: leaves $\\{\\{ secrets.X }} alone`);
assert(rendered.includes("__APPLE_TEAM_ID__"), `render: leaves __APPLE_TEAM_ID__ alone for CI sed`);

if (failed === 0) {
  console.log("test-signing-stepper: ok");
  process.exit(0);
} else {
  console.error(`test-signing-stepper: ${failed} assertion(s) failed`);
  process.exit(1);
}
