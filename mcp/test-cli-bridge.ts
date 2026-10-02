import assert from "node:assert/strict";
import { test } from "node:test";
import { parseJsonOutput, runHatchkit } from "./src/cli-bridge.js";

test("parses JSON after migration notices", () => {
  assert.deepEqual(parseJsonOutput('Seeded email intent: { old: true }\n{\n  "ok": true\n}\n'), { ok: true });
});

test("returns child exit status and output", async () => {
  const result = await runHatchkit(["-e", "process.stdout.write('{\"ok\":true}');process.exit(7)"], {
    bin: process.execPath,
  });
  assert.equal(result.code, 7);
  assert.deepEqual(parseJsonOutput(result.stdout), { ok: true });
});

test("stops a hung child", async () => {
  await assert.rejects(
    runHatchkit(["-e", "setInterval(() => {}, 1000)"], { bin: process.execPath, timeoutMs: 400 }),
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
