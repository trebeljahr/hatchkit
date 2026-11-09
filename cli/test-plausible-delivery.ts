/**
 * Plausible's site reaching the client build.
 *
 * The bug this encodes: `hatchkit add <project> plausible` wrote
 * NEXT_PUBLIC_PLAUSIBLE_DOMAIN to the client's `.env.production`, and the
 * client image build never reads that file (`.dockerignore` drops every
 * `.env.*`; the workflow passes the value from a repo VARIABLE that nothing
 * set). Every site it "wired" shipped with no tracker.
 *
 * The properties:
 *   1. The names delivered are exactly the names the starter's build passes
 *      in and the layout reads — checked against the starter's own
 *      workflow, Dockerfile and layout, not restated.
 *   2. Absent, empty and placeholder values are written and read back;
 *      a matching one is left alone; any other value is kept and reported
 *      with the command that would replace it.
 *   3. `write: false` changes nothing and prints both commands; with no
 *      GitHub remote, both commands are printed with the repo left open.
 *   4. A failed write is reported with its command, never thrown.
 *   5. A client that is not a Next app gets no NEXT_PUBLIC_* variables.
 *
 * `gh` is a fake: nothing here touches GitHub.
 *
 * Run: `pnpm exec tsx test-plausible-delivery.ts`
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.HATCHKIT_CONF_DIR = mkdtempSync(join(tmpdir(), "plausible-delivery-conf-"));

const {
  PLAUSIBLE_DOMAIN_VAR,
  PLAUSIBLE_SCRIPT_VAR,
  decideRepoVariableWrite,
  deliverPlausibleBuildVars,
  deliverProvisionedPlausible,
} = await import("./src/provision/plausible-delivery.js");
type GhRunner = import("./src/provision/plausible-delivery.js").GhRunner;

const failures: string[] = [];
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`  ✗ ${label}: ${(err as Error).message}`);
    console.log(`  ✗ ${label}`);
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const STARTER = join(HERE, "..", "starter");
const REPO = "acme/demo";
const SITE = { domain: "demo.example.com", scriptUrl: "https://stats.example.com/js/script.js" };

/** A fake `gh` over an in-memory variable store, recording every call. */
function fakeGh(initial: Record<string, string> = {}, opts: { failSet?: boolean } = {}) {
  const vars = new Map(Object.entries(initial));
  const calls: string[][] = [];
  const gh: GhRunner = async (args) => {
    calls.push(args);
    if (args[0] === "api") {
      const name = args[1].split("/").pop() ?? "";
      if (!vars.has(name)) return { exitCode: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
      return { exitCode: 0, stdout: JSON.stringify({ name, value: vars.get(name) }), stderr: "" };
    }
    if (args[0] === "variable" && args[1] === "set") {
      if (opts.failSet)
        return { exitCode: 1, stdout: "", stderr: "HTTP 403: Resource not accessible" };
      vars.set(args[2], args[args.indexOf("--body") + 1]);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
  };
  return { gh, vars, calls, sets: () => calls.filter((c) => c[0] === "variable") };
}

const quiet = (): void => undefined;

console.log("\nthe names the build reads\n");

await check("the starter's workflow, Dockerfile and layout use exactly these names", () => {
  const workflow = readFileSync(join(STARTER, ".github/workflows/build-and-deploy.yml"), "utf-8");
  const dockerfile = readFileSync(join(STARTER, "packages/client/Dockerfile"), "utf-8");
  const layout = readFileSync(join(STARTER, "packages/client/src/app/layout.tsx"), "utf-8");
  for (const name of [PLAUSIBLE_DOMAIN_VAR, PLAUSIBLE_SCRIPT_VAR]) {
    assert.ok(workflow.includes(`${name}=\${{ vars.${name} }}`), `workflow passes ${name}`);
    assert.match(dockerfile, new RegExp(`^ARG ${name}$`, "m"), `Dockerfile takes ${name}`);
    assert.ok(layout.includes(`process.env.${name}`), `layout reads ${name}`);
  }
  // And the reason the env file alone never worked.
  const dockerignore = readFileSync(join(STARTER, ".dockerignore"), "utf-8");
  assert.match(dockerignore, /^\*\*\/\.env\.\*$/m);
});

console.log("\nwhat gets written\n");

await check("decisions: absent/empty/placeholder are ours, anything else is kept", () => {
  assert.equal(decideRepoVariableWrite({ kind: "absent" }, "a.com"), "create");
  assert.equal(decideRepoVariableWrite({ kind: "value", value: "" }, "a.com"), "replace");
  assert.equal(
    decideRepoVariableWrite({ kind: "value", value: "CHANGE_ME_x" }, "a.com"),
    "replace",
  );
  assert.equal(decideRepoVariableWrite({ kind: "value", value: " a.com " }, "a.com"), "in-sync");
  assert.equal(decideRepoVariableWrite({ kind: "value", value: "b.com" }, "a.com"), "keep");
});

await check("absent variables are set and read back", async () => {
  const fake = fakeGh();
  const outcomes = await deliverPlausibleBuildVars({
    ...SITE,
    write: true,
    repoSlug: REPO,
    gh: fake.gh,
    log: quiet,
  });
  assert.deepEqual(
    outcomes.map((o) => [o.variable, o.status]),
    [
      [PLAUSIBLE_DOMAIN_VAR, "created"],
      [PLAUSIBLE_SCRIPT_VAR, "created"],
    ],
  );
  assert.equal(fake.vars.get(PLAUSIBLE_DOMAIN_VAR), SITE.domain);
  assert.equal(fake.vars.get(PLAUSIBLE_SCRIPT_VAR), SITE.scriptUrl);
  assert.deepEqual(fake.sets()[0], [
    "variable",
    "set",
    PLAUSIBLE_DOMAIN_VAR,
    "--repo",
    REPO,
    "--body",
    SITE.domain,
  ]);
});

await check("an empty variable is replaced; a matching one is not touched", async () => {
  const fake = fakeGh({ [PLAUSIBLE_DOMAIN_VAR]: "", [PLAUSIBLE_SCRIPT_VAR]: SITE.scriptUrl });
  const outcomes = await deliverPlausibleBuildVars({
    ...SITE,
    write: true,
    repoSlug: REPO,
    gh: fake.gh,
    log: quiet,
  });
  assert.deepEqual(
    outcomes.map((o) => o.status),
    ["updated", "in-sync"],
  );
  assert.equal(fake.sets().length, 1);
});

await check("another site's domain is kept and reported with the command", async () => {
  const fake = fakeGh({ [PLAUSIBLE_DOMAIN_VAR]: "other.example.com" });
  const outcomes = await deliverPlausibleBuildVars({
    ...SITE,
    write: true,
    repoSlug: REPO,
    gh: fake.gh,
    log: quiet,
  });
  assert.equal(outcomes[0].status, "kept");
  assert.equal(fake.vars.get(PLAUSIBLE_DOMAIN_VAR), "other.example.com");
  assert.equal(
    outcomes[0].command,
    `gh variable set ${PLAUSIBLE_DOMAIN_VAR} --repo ${REPO} --body demo.example.com`,
  );
  assert.match(outcomes[0].detail ?? "", /other\.example\.com/);
});

await check("--no-write changes nothing and prints both commands", async () => {
  const fake = fakeGh();
  const lines: string[] = [];
  const outcomes = await deliverPlausibleBuildVars({
    ...SITE,
    write: false,
    repoSlug: REPO,
    gh: fake.gh,
    log: (l) => lines.push(l),
  });
  assert.deepEqual(
    outcomes.map((o) => o.status),
    ["would-write", "would-write"],
  );
  assert.equal(fake.sets().length, 0);
  assert.ok(
    lines.some((l) => l.includes(`gh variable set ${PLAUSIBLE_SCRIPT_VAR} --repo ${REPO}`)),
  );
});

await check("no GitHub remote: both commands, repo left open, nothing run", async () => {
  const fake = fakeGh();
  const outcomes = await deliverPlausibleBuildVars({
    ...SITE,
    write: true,
    repoSlug: null,
    gh: fake.gh,
    log: quiet,
  });
  assert.deepEqual(
    outcomes.map((o) => o.status),
    ["skipped", "skipped"],
  );
  assert.match(outcomes[0].command, /--repo <owner\/name>/);
  assert.equal(fake.calls.length, 0);
});

await check("a refused write is reported with its command, not thrown", async () => {
  const fake = fakeGh({}, { failSet: true });
  const outcomes = await deliverPlausibleBuildVars({
    ...SITE,
    write: true,
    repoSlug: REPO,
    gh: fake.gh,
    log: quiet,
  });
  assert.deepEqual(
    outcomes.map((o) => o.status),
    ["failed", "failed"],
  );
  assert.match(outcomes[0].detail ?? "", /HTTP 403/);
  assert.match(outcomes[0].detail ?? "", /gh variable set/);
});

await check("a client that is not Next.js gets no NEXT_PUBLIC_* variables", async () => {
  const lines: string[] = [];
  const outcomes = await deliverProvisionedPlausible(
    { ...SITE, clientIsNext: false },
    { write: true, log: (l) => lines.push(l) },
  );
  assert.deepEqual(outcomes, []);
  assert.ok(lines.some((l) => l.includes("PUBLIC_PLAUSIBLE_DOMAIN")));
});

if (failures.length > 0) {
  console.error(`\n${failures.length} failed:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("\nall plausible-delivery checks passed");
