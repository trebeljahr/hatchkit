import childProcess from "node:child_process";
import { registerHooks, syncBuiltinESMExports } from "node:module";

if (!process.env.HATCHKIT_TEST_KEYCHAIN_DIR) {
  throw new Error("Run CLI tests with node scripts/test.mjs [test-file.ts].");
}

// Synchronous hooks also catch require(). The native addon is never loaded.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "keytar") {
      return {
        url: new URL("./keytar.mjs", import.meta.url).href,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});
globalThis[Symbol.for("hatchkit.test-keychain-loaded")] = true;

// Fail if a test tries the shell fallback, instead of displaying a dialog.
for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync"]) {
  const original = childProcess[name];
  childProcess[name] = function (command, ...args) {
    if (
      typeof command === "string" &&
      /(?:^|[\s/])(?:security|secret-tool)(?:$|\s)/.test(command)
    ) {
      throw new Error("Tests cannot invoke the OS keychain CLI; use the fixture store.");
    }
    return original.call(this, command, ...args);
  };
}
syncBuiltinESMExports();
