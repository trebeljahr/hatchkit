import childProcess from "node:child_process";
import { constants, accessSync, realpathSync, statSync } from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, delimiter, resolve, sep } from "node:path";
import { promisify } from "node:util";

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

// ssh, scp, sftp and `tailscale ssh` reach real hosts. `tailscale status`
// and `serve status` read this machine's daemon, whose answer changes
// with the tailnet up or down and on CI, and `serve --bg` changes it. So
// a test may run them only as a fixture it wrote into the temp dir. The
// call throws, and the process exits 1 even when the caller swallows the
// error: `backup status` and `backup sources` report an unreachable host,
// and the tailscale probes report the daemon offline, instead of failing.
const FIXTURE_ONLY = new Set(["ssh", "scp", "sftp", "tailscale"]);
const tempRoots = [...new Set([tmpdir(), realpathSync(tmpdir())])].map((root) =>
  root.endsWith(sep) ? root : root + sep,
);
const realHostSpawns = [];
process.on("exit", () => {
  if (realHostSpawns.length) process.exitCode = 1;
});

function findExecutable(command, options) {
  const cwd = String(options?.cwd ?? process.cwd());
  if (command.includes("/")) return resolve(cwd, command);
  // libuv searches /usr/bin:/bin when a given env has no PATH.
  const path = options?.env ? (options.env.PATH ?? "/usr/bin:/bin") : (process.env.PATH ?? "");
  for (const dir of path.split(delimiter)) {
    const candidate = resolve(cwd, dir || ".", command);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not here; keep looking along PATH.
    }
  }
  return null;
}

function isFixture(path) {
  let real = path;
  try {
    real = realpathSync(path);
  } catch {
    // A missing file is not a fixture either.
  }
  return [path, real].every((p) => tempRoots.some((root) => p.startsWith(root)));
}

/** Each command a shell line runs, split on ; & | ( and $(, as words. */
function shellCommands(line) {
  return line
    .split(/\$\(|[;&|()\n]/)
    .map((part) => part.trim().split(/\s+/))
    .filter((words) => words[0]);
}

function assertNoRealHost(name, command, rest) {
  if (typeof command !== "string") return;
  const options = rest.find((arg) => arg && typeof arg === "object" && !Array.isArray(arg));
  const shell = name === "exec" || name === "execSync" || options?.shell;
  const args = Array.isArray(rest[0]) ? rest[0].map(String) : [];
  const runs = shell ? shellCommands([command, ...args].join(" ")) : [[command]];
  for (const [word] of runs) {
    if (!FIXTURE_ONLY.has(basename(word))) continue;
    const path = findExecutable(word, options);
    if (path && isFixture(path)) continue;
    realHostSpawns.push(path ?? word);
    const message = `Tests cannot run a real ${basename(word)}: ${word} resolves to ${path ?? "nothing on PATH"}. Put a fake ${basename(word)} in a temp dir on PATH.`;
    process.stderr.write(`${message}\n`);
    throw new Error(message);
  }
}

function assertAllowed(name, command, args) {
  // Fail if a test tries the shell fallback, instead of displaying a dialog.
  if (typeof command === "string" && /(?:^|[\s/])(?:security|secret-tool)(?:$|\s)/.test(command)) {
    throw new Error("Tests cannot invoke the OS keychain CLI; use the fixture store.");
  }
  assertNoRealHost(name, command, args);
}

for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync"]) {
  const original = childProcess[name];
  const guarded = function (command, ...args) {
    assertAllowed(name, command, args);
    return original.call(this, command, ...args);
  };
  // promisify(execFile) resolves { stdout, stderr } only through this
  // hook. Without it the promise resolves stdout alone, so
  // tailscaleIdentity() read every answer as "daemon offline".
  const custom = original[promisify.custom];
  if (custom) {
    guarded[promisify.custom] = (command, ...args) => {
      assertAllowed(name, command, args);
      return custom(command, ...args);
    };
  }
  childProcess[name] = guarded;
}
syncBuiltinESMExports();
