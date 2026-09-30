import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { runInNewContext } from "node:vm";
import { applyPostgresOverlay } from "./src/scaffold/postgres-overlay.js";

// Exercise generated output for both legacy and secured Compose inputs.
for (const loopback of [false, true]) {
  const dir = mkdtempSync(join(tmpdir(), "security-postgres-"));
  try {
    mkdirSync(join(dir, "e2e"), { recursive: true });
    for (const part of ["auth", "db", "models", "trpc/routers"]) {
      mkdirSync(join(dir, "packages/server/src", part), { recursive: true });
    }
    const compose = readFileSync(new URL("../starter/docker-compose.dev.yml", import.meta.url), "utf8");
    writeFileSync(join(dir, "docker-compose.dev.yml"), loopback ? compose : compose.replaceAll("127.0.0.1:", ""));
    applyPostgresOverlay(dir);
    const generated = readFileSync(join(dir, "docker-compose.dev.yml"), "utf8");
    assert.match(generated, /image: postgres:16-alpine/);
    assert.match(generated, /127\.0\.0\.1:5432:5432/);
    assert.doesNotMatch(generated, /mongo:7|mongo-data/);
    const auth = readFileSync(join(dir, "packages/server/src/auth/auth.ts"), "utf8");
    assert.match(auth, /requireEmailVerification: requireEmailVerification\(isEmailConfigured\(\)\)/);
    assert.doesNotMatch(auth, /console\.log/);
    const tree = ts.createSourceFile("auth.ts", auth, ts.ScriptTarget.Latest, true);
    let verificationCallback = false;
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node) && node.name.getText(tree) === "emailAndPassword") {
        assert.doesNotMatch(node.initializer.getText(tree), /sendVerificationEmail/);
      }
      if (ts.isPropertyAssignment(node) && node.name.getText(tree) === "emailVerification") {
        assert.match(node.initializer.getText(tree), /sendVerificationEmail/);
        assert.match(node.initializer.getText(tree), /autoSignInAfterVerification: false/);
        verificationCallback = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    assert.ok(verificationCallback);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log("Security baseline: PostgreSQL generation checks passed");

// Exercise the feature template's actual logger, including its production opt-in.
const template = readFileSync(new URL("./src/templates/auth-account-security/server/account-security.ts.tpl", import.meta.url), "utf8");
const logger = template.slice(template.indexOf("export function logAuthUrl"), template.indexOf("export function verificationEmailBody"));
const compiled = ts.transpileModule(logger, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
for (const allowed of [false, true]) {
  const lines: string[] = [];
  const context = {
    exports: {} as { logAuthUrl: (label: string, recipient: string, url: string) => void },
    process: { env: { NODE_ENV: "production", AUTH_LOG_LINKS: allowed ? "true" : "false" } },
    console: { log: (line: string) => lines.push(line) },
  };
  runInNewContext(compiled, context);
  const call = (): void => context.exports.logAuthUrl("Reset", "owner@example.test", "https://example.test/fixture");
  if (allowed) call();
  else assert.throws(call, /Auth email unavailable/);
  assert.equal(lines.length, allowed ? 1 : 0);
}
console.log("Security baseline: account-security template link policy passed");
