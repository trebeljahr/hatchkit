// The host integrity script on a real kernel, against real containers.
// Opt-in (needs Docker, pulls small images):
//
//   pnpm --filter hatchkit run test:host-integrity-docker
//
// The acceptance case from the 2026-10-19 security audit: a container
// copies `sleep` to /var/tmp/x, runs it and deletes the binary. Detectors
// 1-3 must flag it. A busy loop must trip the CPU detector, and three clean
// containers must raise nothing. The scan runs in a privileged container
// that shares the Docker host's PID and cgroup namespaces, which is what
// the script sees as root on the Coolify host.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const docker = (args: string[], input?: string) =>
  spawnSync("docker", args, { encoding: "utf8", input, timeout: 600_000 });

if (docker(["info", "--format", "{{.ServerVersion}}"]).status !== 0) {
  console.error("Docker is not reachable. Start it (for example `colima start`) and rerun.");
  process.exit(1);
}

const tag = `hk-integrity-${randomBytes(3).toString("hex")}`;
const names = {
  dirty: `${tag}-dirty`,
  busy: `${tag}-busy`,
  sleep: `${tag}-clean-sleep`,
  redis: `${tag}-clean-redis`,
  node: `${tag}-clean-node`,
};

function start(name: string, image: string, ...command: string[]) {
  const run = docker(["run", "-d", "--name", name, image, ...command]);
  assert.equal(run.status, 0, run.stderr);
}

try {
  start(
    names.dirty,
    "debian:bookworm-slim",
    "sh",
    "-c",
    "cp /bin/sleep /var/tmp/x && /var/tmp/x 3600 & sleep 1; rm /var/tmp/x; exec sleep 3600",
  );
  start(names.busy, "debian:bookworm-slim", "sh", "-c", "while :; do :; done");
  start(names.sleep, "debian:bookworm-slim", "sleep", "3600");
  start(names.redis, "redis:7-alpine");
  start(names.node, "node:22-alpine", "node", "-e", "setInterval(() => {}, 1000)");
  spawnSync("sleep", ["3"]);

  const scan = docker(
    [
      "run",
      "--rm",
      "-i",
      "--privileged",
      "--pid=host",
      "--cgroupns=host",
      "-v",
      "/var/run/docker.sock:/var/run/docker.sock",
      "docker:27-cli",
      "sh",
      "-c",
      `apk add --no-cache -q python3 >/dev/null && python3 - scan --cpu-window 5 --only '${tag}-*'`,
    ],
    readFileSync("src/templates/host-integrity/host-integrity.py", "utf8"),
  );
  assert.equal(scan.status, 0, `${scan.stdout}\n${scan.stderr}`);
  const report = JSON.parse(scan.stdout.trim().split("\n").pop() ?? "");
  for (const finding of report.findings) console.log(`  ${finding.detector}: ${finding.summary}`);
  const detectors = (name: string) =>
    [
      ...new Set(
        (report.findings as { container: string; detector: string }[])
          .filter((f) => f.container === name)
          .map((f) => f.detector),
      ),
    ].sort();

  assert.equal(report.containers, 5);
  assert.equal(report.cpuWindowSeconds, 5);
  assert.deepEqual(detectors(names.dirty), ["deleted-binary", "temp-file", "unexpected-process"]);
  assert.deepEqual(detectors(names.busy), ["cpu"]);
  for (const clean of [names.sleep, names.redis, names.node])
    assert.deepEqual(detectors(clean), [], `${clean} must raise nothing`);
  assert.equal(report.findings.length, 4, "x: deleted, unexpected, run from /var/tmp; busy: cpu");
  console.log(
    "Host integrity flags the renamed, deleted sleep and the busy loop; clean containers pass.",
  );
} finally {
  docker(["rm", "-f", ...Object.values(names)]);
}
