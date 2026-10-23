import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderCompletion } from "./src/completion.js";
import { SUPPORTED_ADDITIONS, additionsForSurface } from "./src/features/additions.js";
import { CLI_COMMANDS } from "./src/help-routing.js";
import { featurePromptChoices, mlPromptChoices } from "./src/prompts.js";
import {
  adoptRepositoryIsPrivate,
  parseGithubVisibility,
  signingProjectArgument,
} from "./src/utils/command-input.js";
import { KNOWN_FEATURES, KNOWN_ML_SERVICES } from "./src/utils/flags.js";

const cli = dirname(fileURLToPath(import.meta.url));
assert.equal(
  readFileSync(join(cli, "../.agents/skills/hatchkit/SKILL.md"), "utf8"),
  readFileSync(join(cli, "../.claude/skills/hatchkit/SKILL.md"), "utf8"),
  "Hatchkit agent skill copies must stay synchronized",
);
const source = readFileSync(join(cli, "src/index.ts"), "utf8");
const router = source.slice(
  source.indexOf("  switch (command)"),
  source.indexOf("async function handleNoArgs"),
);
const routed = [...router.matchAll(/^ {4}case "([^"]+)":/gm)].map((match) => match[1]);
assert.deepEqual(
  [...CLI_COMMANDS].sort(),
  [...routed, "help"].sort(),
  "completion catalog covers the actual router",
);
for (const shell of ["bash", "zsh", "fish"] as const) {
  const script = renderCompletion(shell);
  for (const command of CLI_COMMANDS) assert.ok(script.includes(command), `${shell}: ${command}`);
  if (shell !== "fish") {
    const syntax = spawnSync(shell, ["-n"], {
      input: script,
      encoding: "utf8",
    });
    if ((syntax.error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
      assert.equal(syntax.status, 0, `${shell} completion syntax: ${syntax.stderr}`);
    }
  }
  assert.ok(!script.includes("resend"));
  for (const name of [
    "restore-check",
    "add-host",
    "remove-host",
    "cloudflare-workers",
    "coolify-github-app",
    "pause",
    "resume",
  ])
    assert.ok(script.includes(name));
}
const selected = {
  features: [...KNOWN_FEATURES],
  surfaces: "fullstack" as const,
  mlServices: [...KNOWN_ML_SERVICES],
};
assert.deepEqual(
  featurePromptChoices(selected)
    .map((choice) => choice.value)
    .sort(),
  [...KNOWN_FEATURES].sort(),
);
assert.ok(featurePromptChoices(selected).every((choice) => choice.checked));
assert.deepEqual(
  mlPromptChoices(selected)
    .map((choice) => choice.value)
    .sort(),
  [...KNOWN_ML_SERVICES].sort(),
);
assert.ok(mlPromptChoices(selected).every((choice) => choice.checked));
assert.equal(new Set(SUPPORTED_ADDITIONS).size, SUPPORTED_ADDITIONS.length);
assert.ok(SUPPORTED_ADDITIONS.every((feature) => KNOWN_FEATURES.includes(feature)));
assert.deepEqual(additionsForSurface(), SUPPORTED_ADDITIONS);
assert.deepEqual(additionsForSurface("fullstack"), SUPPORTED_ADDITIONS);
assert.deepEqual(additionsForSurface("split"), SUPPORTED_ADDITIONS);
assert.deepEqual(additionsForSurface("static"), ["desktop", "mobile", "release", "i18n"]);
assert.deepEqual(additionsForSurface("backend"), [
  "workspaces",
  "release",
  "auth-account-security",
  "server-migrations",
  "scheduler",
  "public-api",
  "i18n",
]);
assert.equal(adoptRepositoryIsPrivate(undefined), true);
assert.equal(adoptRepositoryIsPrivate(undefined, "public"), false);
assert.equal(adoptRepositoryIsPrivate(true, "public"), true);
assert.equal(adoptRepositoryIsPrivate(false, "private"), false);
assert.equal(parseGithubVisibility("private"), "private");
assert.throws(() => parseGithubVisibility("published"), /private or public/);
assert.equal(signingProjectArgument(["--dry-run"]), ".");
assert.equal(signingProjectArgument(["--repo", "owner/repo", "--dry-run"]), ".");
assert.equal(signingProjectArgument(["--platforms", "ios,android", "app", "--dry-run"]), "app");
assert.equal(signingProjectArgument(["app", "--repo=owner/repo"]), "app");

const sandbox = mkdtempSync(join(tmpdir(), "hatchkit-contracts-"));
try {
  const { collectStatus } = await import("./src/status.js");
  const { MANIFEST_VERSION } = await import("./src/scaffold/manifest.js");
  for (const surfaces of ["fullstack", "split", "static", "backend"] as const) {
    writeFileSync(
      join(sandbox, ".hatchkit.json"),
      JSON.stringify({
        version: MANIFEST_VERSION,
        name: "contract-test",
        domain: "contract.example",
        surfaces,
        features: ["release"],
        deploymentMode: "scaffold-only",
        ports: { server: 3000, client: 5173 },
      }),
    );
    assert.deepEqual(
      collectStatus(sandbox).project?.addableFeatures,
      additionsForSurface(surfaces).filter((feature) => feature !== "release"),
      `status only offers applicable missing features for ${surfaces}`,
    );
  }
  for (const provider of ["aws", "hetzner", undefined]) {
    const run = spawnSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        "--import",
        join(cli, "test-help-no-network.probe.mjs"),
        join(cli, "src/index.ts"),
        "provision",
        "s3",
        "--provider",
        ...(provider ? [provider] : []),
      ],
      {
        cwd: sandbox,
        encoding: "utf8",
        timeout: 60_000,
        env: {
          ...process.env,
          HATCHKIT_CONF_DIR: join(sandbox, "conf"),
          HATCHKIT_KEYCHAIN_ACCESS: "deny",
          CI: "1",
          NO_COLOR: "1",
        },
      },
    );
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /supports only --provider r2/);
    assert.doesNotMatch(run.stderr, /PROVIDER_CALL_ATTEMPTED|Keychain access/);
  }
  for (const target of ["coolify", "gh", "both"]) {
    const run = spawnSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        "--import",
        join(cli, "test-help-no-network.probe.mjs"),
        join(cli, "src/index.ts"),
        "keys",
        "push",
        "missing-project",
        "--target",
        target,
        "--dry-run",
        "--json",
      ],
      {
        cwd: sandbox,
        encoding: "utf8",
        timeout: 60_000,
        env: {
          ...process.env,
          HATCHKIT_CONF_DIR: join(sandbox, "conf"),
          HATCHKIT_KEYCHAIN_ACCESS: "deny",
          CI: "1",
          NO_COLOR: "1",
        },
      },
    );
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.ok(!run.stderr.includes("PROVIDER_CALL_ATTEMPTED"));
    const plan = JSON.parse(run.stdout);
    assert.equal(plan.dryRun, true);
    assert.equal(plan.target, target);
    assert.equal(plan.actions.length, target === "both" ? 2 : 1);
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
console.log(
  "Documentation contracts passed: command coverage, choice preservation, safe defaults and zero-write key push.",
);
