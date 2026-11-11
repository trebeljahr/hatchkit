/**
 * The starter's local e2e stack: names, ports, and which containers a run
 * removes — `starter/e2e/{infra.ts,start-server.sh,global-teardown.ts}` and
 * `cli/src/scaffold/e2e-stack.ts`.
 *
 * Several projects and agent sessions run their browser suites on one machine
 * at once. With the starter's old global names (`starter-e2e-mongo` on 27018,
 * …) one project's run reused another's database container, and a teardown by
 * name removed a container a parallel run was still using.
 *
 * The behavioural half runs the REAL start-server.sh and global-teardown.ts
 * against a fake `docker` on PATH that keeps its containers in a directory and
 * logs every call. The machine it simulates holds a running container of this
 * project that another run started, a stopped leftover of this project, and
 * another project's container. Nothing reaches a real Docker daemon.
 *
 * Run: pnpm --filter hatchkit exec node scripts/test.mjs test-e2e-stack.ts
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const {
  STARTER_E2E_PORTS,
  e2ePortsFor,
  readE2eInfraPorts,
  setE2eInfraPorts,
  setWorkflowE2ePorts,
} = await import("./src/scaffold/e2e-stack.js");
const { seaweedfsCiStep, stripStartServerE2eS3 } = await import("./src/scaffold/e2e-s3.js");
const { rewriteStartServerForPostgres } = await import("./src/scaffold/postgres-overlay.js");

const CLI = import.meta.dirname;
const STARTER = resolve(join(CLI, "..", "starter"));
if (!existsSync(join(STARTER, "e2e/start-server.sh"))) {
  console.log(`\nSkipping: starter not populated at ${STARTER}\n`);
  process.exit(0);
}

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    console.log(`  ✓ ${msg}`);
    return;
  }
  failed++;
  console.error(`  ✗ ${msg}`);
}

// Under node_modules/.cache, not the OS temp dir: the fake `docker` and the
// stubs have to be executable, and a hardened host mounts /tmp noexec.
const SCRATCH = join(CLI, "node_modules/.cache/test-e2e-stack");
mkdirSync(SCRATCH, { recursive: true });
const temps: string[] = [];
function temp(prefix: string): string {
  const d = mkdtempSync(join(SCRATCH, prefix));
  temps.push(d);
  return d;
}

const startServer = readFileSync(join(STARTER, "e2e/start-server.sh"), "utf-8");
const infra = readFileSync(join(STARTER, "e2e/infra.ts"), "utf-8");
const workflow = readFileSync(join(STARTER, ".github/workflows/build-and-deploy.yml"), "utf-8");

/** A fake `docker`: one file per container under $FAKE_DOCKER/containers
 *  (line 1 running|stopped, line 2 the run label), every call appended to
 *  $FAKE_DOCKER/calls. Implements only what the two scripts use. */
const FAKE_DOCKER = `#!/usr/bin/env bash
set -u
state="$FAKE_DOCKER"
printf '%s\\n' "$*" >> "$state/calls"
c="$state/containers"
case "$1" in
  container)
    # container inspect -f <format> <name>
    name="\${5:-}"
    [ -f "$c/$name" ] || { echo "Error: No such container: $name" >&2; exit 1; }
    head -n 1 "$c/$name"
    ;;
  run)
    shift
    name="" label=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --name) name="$2"; shift 2 ;;
        --label) label="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    [ -f "$c/$name" ] && { echo "Conflict: $name is already in use" >&2; exit 125; }
    printf 'running\\n%s\\n' "$label" > "$c/$name"
    echo "$name"
    ;;
  rm)
    shift
    [ "\${1:-}" = "--force" ] && shift
    for name in "$@"; do rm -f "$c/$name"; done
    ;;
  ps)
    # ps --all --quiet --filter label=<key>=<value>
    want="\${5#label=}"
    for f in "$c"/*; do
      [ -f "$f" ] || continue
      [ "$(sed -n 2p "$f")" = "$want" ] && basename "$f"
    done
    exit 0
    ;;
  exec)
    echo PONG
    ;;
  *)
    echo "fake docker: unsupported: $*" >&2
    exit 64
    ;;
esac
`;

/** A machine: fake docker plus stubs for what start-server.sh calls after
 *  starting containers (node and curl wait loops, the final `exec pnpm`). */
function machine(): { state: string; dockerBin: string; stubBin: string } {
  const root = temp("e2e-stack-");
  const state = join(root, "docker");
  mkdirSync(join(state, "containers"), { recursive: true });
  writeFileSync(join(state, "calls"), "");
  const dockerBin = join(root, "docker-bin");
  const stubBin = join(root, "stub-bin");
  mkdirSync(dockerBin);
  mkdirSync(stubBin);
  writeFileSync(join(dockerBin, "docker"), FAKE_DOCKER);
  chmodSync(join(dockerBin, "docker"), 0o755);
  for (const tool of ["node", "curl", "pnpm"]) {
    writeFileSync(join(stubBin, tool), "#!/bin/sh\nexit 0\n");
    chmodSync(join(stubBin, tool), 0o755);
  }
  return { state, dockerBin, stubBin };
}

function container(state: string, name: string, status: "running" | "stopped", label: string): void {
  writeFileSync(join(state, "containers", name), `${status}\n${label}\n`);
}

const containers = (state: string): string[] => readdirSync(join(state, "containers")).sort();
const calls = (state: string): string[] =>
  readFileSync(join(state, "calls"), "utf-8").split("\n").filter(Boolean);

const LABEL = "dev.hatchkit.e2e-run";
const stackEnv = (runId: string): Record<string, string> => ({
  E2E_STACK: "proj-e2e",
  E2E_RUN_LABEL: LABEL,
  E2E_RUN_ID: runId,
  E2E_MONGO_PORT: "17042",
  E2E_REDIS_PORT: "18042",
  E2E_S3_PORT: "19042",
  E2E_POSTGRES_PORT: "20042",
});

function runScript(
  script: string,
  m: ReturnType<typeof machine>,
  env: Record<string, string>,
): ReturnType<typeof spawnSync> {
  const dir = temp("e2e-script-");
  const path = join(dir, "start-server.sh");
  writeFileSync(path, script);
  const base = { ...process.env };
  delete base.CI;
  return spawnSync("bash", [path], {
    encoding: "utf-8",
    env: {
      ...base,
      ...env,
      FAKE_DOCKER: m.state,
      PATH: `${m.stubBin}:${m.dockerBin}:${process.env.PATH ?? ""}`,
    },
  });
}

function runTeardown(m: ReturnType<typeof machine>, env: Record<string, string>) {
  const dir = temp("e2e-teardown-");
  const runner = join(dir, "run-teardown.mts");
  writeFileSync(
    runner,
    `const mod = await import(${JSON.stringify(join(STARTER, "e2e/global-teardown.ts"))});\n` +
      "await (mod.default.default ?? mod.default)();\n",
  );
  const base = { ...process.env };
  delete base.CI;
  return spawnSync(process.execPath, ["--import", "tsx", runner], {
    cwd: CLI,
    encoding: "utf-8",
    env: { ...base, ...env, FAKE_DOCKER: m.state, PATH: `${m.dockerBin}:${process.env.PATH ?? ""}` },
  });
}

try {
  // ── a run next to a parallel run and another project ─────────────────
  console.log("\n── start-server.sh + global-teardown.ts on a shared machine ─────────────");
  {
    const m = machine();
    // Started by a parallel run of this project: reused, never removed here.
    container(m.state, "proj-e2e-mongo", "running", `${LABEL}=other-run`);
    // A stopped leftover of this project: replaced.
    container(m.state, "proj-e2e-redis", "stopped", `${LABEL}=crashed-run`);
    // Another project's container with the same service.
    container(m.state, "other-e2e-mongo", "running", `${LABEL}=foreign-run`);

    const started = runScript(startServer, m, stackEnv("run-1"));
    assert(started.status === 0, `start-server.sh exits 0 (stderr: ${String(started.stderr).trim()})`);
    const log = calls(m.state);
    const runs = log.filter((c) => c.startsWith("run "));
    assert(
      !runs.some((c) => c.includes("--name proj-e2e-mongo")),
      "the running proj-e2e-mongo is reused, not started again",
    );
    assert(String(started.stdout).includes("Reusing running container proj-e2e-mongo"), "…and the log says so");
    assert(log.includes("rm proj-e2e-redis"), "the stopped proj-e2e-redis is replaced");
    assert(
      runs.some((c) => c.includes("--name proj-e2e-redis") && c.includes(`--label ${LABEL}=run-1`)),
      "proj-e2e-redis starts with this run's label",
    );
    assert(
      runs.some(
        (c) =>
          c.includes("--name proj-e2e-seaweedfs") &&
          c.includes(`--label ${LABEL}=run-1`) &&
          c.includes("-p 19042:8333"),
      ),
      "proj-e2e-seaweedfs starts on the project's S3 port with this run's label",
    );
    assert(runs.every((c) => c.includes(`--label ${LABEL}=run-1`)), "every container started carries the label");
    assert(!log.some((c) => c.includes("other-e2e")), "another project's container is never touched");

    const torn = runTeardown(m, { E2E_RUN_ID: "run-1" });
    assert(torn.status === 0, `teardown exits 0 (stderr: ${String(torn.stderr).trim()})`);
    assert(
      calls(m.state).includes(`ps --all --quiet --filter label=${LABEL}=run-1`),
      "teardown asks Docker for this run's label",
    );
    assert(
      JSON.stringify(containers(m.state)) === JSON.stringify(["other-e2e-mongo", "proj-e2e-mongo"]),
      `teardown removes only what this run started (left: ${containers(m.state).join(", ")})`,
    );

    // A teardown for a run that started nothing removes nothing.
    const before = containers(m.state);
    const idle = runTeardown(m, { E2E_RUN_ID: "run-2" });
    assert(idle.status === 0, "a teardown with nothing of its own exits 0");
    assert(JSON.stringify(containers(m.state)) === JSON.stringify(before), "…and removes nothing");
    assert(!calls(m.state).some((c) => c.startsWith("rm --force") && c.includes("proj-e2e-mongo")), "the parallel run's container was never in an rm");
  }

  // ── Postgres scaffolds ─────────────────────────────────────────────
  console.log("\n── the postgres overlay's start-server.sh ─────────────");
  {
    const pg = rewriteStartServerForPostgres(startServer);
    assert(!/mongo/i.test(pg), "no MongoDB left in the postgres variant");
    const m = machine();
    const started = runScript(pg, m, stackEnv("run-pg"));
    assert(started.status === 0, `it exits 0 (stderr: ${String(started.stderr).trim()})`);
    assert(
      calls(m.state).some(
        (c) =>
          c.startsWith("run ") &&
          c.includes("--name proj-e2e-postgres") &&
          c.includes("-p 20042:5432") &&
          c.includes(`--label ${LABEL}=run-pg`),
      ),
      "postgres starts as <stack>-postgres on the project's port with the run label",
    );
    assert(calls(m.state).includes("exec proj-e2e-postgres pg_isready -U postgres -d starter-e2e"), "the readiness check addresses that container");
  }

  // ── no S3 code: the SeaweedFS block goes, the rest still runs ─────────
  console.log("\n── start-server.sh without local S3 ─────────────");
  {
    const noS3 = stripStartServerE2eS3(startServer);
    assert(!/seaweedfs/i.test(noS3), "the SeaweedFS block is gone");
    const m = machine();
    const started = runScript(noS3, m, stackEnv("run-3"));
    assert(started.status === 0, "it still exits 0");
    assert(
      JSON.stringify(containers(m.state)) === JSON.stringify(["proj-e2e-mongo", "proj-e2e-redis"]),
      "only MongoDB and Redis are started",
    );
  }

  // ── guard rails ──────────────────────────────────────────────────────
  console.log("\n── guard rails ─────────────");
  {
    const m = machine();
    const unset = runScript(startServer, m, {});
    assert(unset.status !== 0, "without E2E_STACK (not run through Playwright) it refuses");
    assert(String(unset.stderr).includes("pnpm run test:e2e"), "…naming the command to use");
    assert(calls(m.state).length === 0, "…before touching Docker");

    const ci = runScript(startServer, m, { ...stackEnv("run-ci"), CI: "1" });
    assert(ci.status === 0, "in CI it starts no containers and exits 0");
    assert(calls(m.state).length === 0, "…and never calls Docker");

    const ciTeardown = runTeardown(m, { E2E_RUN_ID: "run-ci", CI: "1" });
    assert(ciTeardown.status === 0 && calls(m.state).length === 0, "in CI the teardown never calls Docker");
  }

  // ── the scaffold's half: infra.ts + workflow ports ───────────────────
  console.log("\n── e2e/infra.ts and the workflow, rewritten per project ─────────────");
  {
    assert(
      JSON.stringify(readE2eInfraPorts(infra)) === JSON.stringify(STARTER_E2E_PORTS),
      "the starter's infra.ts declares the starter's ports",
    );
    const e2e = e2ePortsFor({ server: 5042, client: 6317 });
    assert(
      JSON.stringify(e2e) ===
        JSON.stringify({ server: 15042, client: 16317, mongo: 17042, redis: 18042, s3: 19042, postgres: 20042 }),
      "ports derive from the assigned dev ports",
    );
    const rewritten = setE2eInfraPorts(infra, e2e);
    assert(JSON.stringify(readE2eInfraPorts(rewritten)) === JSON.stringify(e2e), "infra.ts takes the project's ports");
    assert(setE2eInfraPorts(rewritten, e2e) === rewritten, "…idempotently");
    const wf = setWorkflowE2ePorts(workflow, e2e);
    assert(wf.includes(seaweedfsCiStep("starter-e2e", 19042)), "the CI SeaweedFS step publishes the project's S3 port");
    assert(/^ +BETTER_AUTH_URL: http:\/\/127\.0\.0\.1:15042$/m.test(wf), "the CI job's API origin is the project's");
    assert(/^ +FRONTEND_URL: http:\/\/127\.0\.0\.1:16317$/m.test(wf), "the CI job's web origin is the project's");
    assert(setWorkflowE2ePorts(wf, e2e) === wf, "…idempotently");
    assert(wf.includes("- 27018:27017") && wf.includes("- 6380:6379"), "CI service containers keep their fixed ports (the job passes their URLs)");
  }

  if (failed === 0) {
    console.log("\ntest-e2e-stack: ok");
  } else {
    console.error(`\ntest-e2e-stack: ${failed} assertion(s) failed`);
    process.exitCode = 1;
  }
} finally {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
}
