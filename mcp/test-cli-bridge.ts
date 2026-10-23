import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseHatchkitResult,
  parseJsonOutput,
  runHatchkit,
  scrubCliDiagnostic,
} from "./src/cli-bridge.js";

test("parses JSON after migration notices", () => {
  assert.deepEqual(parseJsonOutput('Seeded email intent: { old: true }\n{\n  "ok": true\n}\n'), {
    ok: true,
  });
});

test("returns child exit status and output", async () => {
  const result = await runHatchkit(
    ["-e", "process.stdout.write('{\"ok\":true}');process.exit(7)"],
    {
      bin: process.execPath,
    },
  );
  assert.equal(result.code, 7);
  assert.deepEqual(parseJsonOutput(result.stdout), { ok: true });
});

test("stops a hung child", async () => {
  await assert.rejects(
    runHatchkit(["-e", "setInterval(() => {}, 1000)"], {
      bin: process.execPath,
      timeoutMs: 400,
    }),
    /timed out/,
  );
});

test("bounds child output", async () => {
  await assert.rejects(
    runHatchkit(["-e", "process.stdout.write('x'.repeat(4096))"], {
      bin: process.execPath,
      maxOutputBytes: 128,
    }),
    /output exceeded/,
  );
});

test("returns structured failure JSON even when the CLI exits nonzero", () => {
  const payload = { project: "demo", found: false, error: "No stored key" };
  assert.deepEqual(
    parseHatchkitResult({
      stdout: JSON.stringify(payload),
      stderr: "notice",
      code: 1,
    }),
    payload,
  );
  const requestedKey = { project: "demo", found: true, key: "a".repeat(64) };
  assert.deepEqual(
    parseHatchkitResult({
      stdout: JSON.stringify(requestedKey),
      stderr: "",
      code: 0,
    }),
    requestedKey,
  );
});

test("preserves the actionable stderr diagnosis when the CLI produces no JSON", async () => {
  const result = await runHatchkit(
    [
      "-e",
      'console.error("OS keychain access is disabled. Run in an interactive terminal."); process.exit(1)',
    ],
    {
      bin: process.execPath,
    },
  );
  assert.throws(
    () => parseHatchkitResult(result),
    /status 1.*\nOS keychain access is disabled\. Run in an interactive terminal\./,
  );
});

test("scrubs secret values before returning bounded CLI diagnostics", () => {
  const secret = "opaque-environment-credential";
  const diagnostic = scrubCliDiagnostic(
    [
      `provider rejected ${secret}`,
      'API_TOKEN="quoted value with spaces"',
      "Authorization: Bearer bearer-credential",
      "https://user:password@example.test/path?token=query-secret",
      "-----BEGIN PRIVATE KEY-----\nprivate material\n-----END PRIVATE KEY-----",
      "DOTENV_PRIVATE_KEY_PRODUCTION=" + "b".repeat(64),
      "HATCHKIT_KEYCHAIN_ACCESS=allow",
    ].join("\n"),
    { EXAMPLE_TOKEN: secret },
  );
  for (const value of [
    secret,
    "quoted value",
    "bearer-credential",
    "user:password",
    "query-secret",
    "private material",
    "b".repeat(64),
  ]) {
    assert.equal(diagnostic.includes(value), false, value);
  }
  assert.match(diagnostic, /HATCHKIT_KEYCHAIN_ACCESS=allow/);
  assert.match(scrubCliDiagnostic("x".repeat(8_000), {}), /\[diagnostic truncated\]$/);
  assert.ok(scrubCliDiagnostic("x".repeat(8_000), {}).length < 4_100);
});

test("invalid stdout is scrubbed too, including when parsing it directly", () => {
  const stdout = "PRIVATE_KEY=do-not-echo-this";
  assert.throws(
    () => parseHatchkitResult({ stdout, stderr: "", code: 1 }),
    (error: Error) => {
      assert.equal(error.message.includes("do-not-echo-this"), false);
      assert.match(error.message, /\[redacted\]/);
      return true;
    },
  );
  assert.throws(() => parseJsonOutput(stdout), /^Error: hatchkit produced no JSON$/);
});
