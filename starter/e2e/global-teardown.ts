import { execFileSync } from "node:child_process";
import { E2E_RUN_ID, E2E_RUN_LABEL } from "./infra";

/**
 * Removes the containers e2e/start-server.sh started for this run — and no
 * others.
 *
 * Each container that script starts carries `E2E_RUN_LABEL=<this run's id>`;
 * one it found already running (started by an earlier run of this project, or
 * by one still in progress) has another run's id, or none, and is left alone.
 * Removing by name instead would stop a container a parallel run is using.
 */
export default async function globalTeardown(): Promise<void> {
  if (process.env.CI) return;

  let ids: string[];
  try {
    ids = execFileSync(
      "docker",
      ["ps", "--all", "--quiet", "--filter", `label=${E2E_RUN_LABEL}=${E2E_RUN_ID}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    )
      .split("\n")
      .map((id) => id.trim())
      .filter(Boolean);
  } catch {
    // No Docker, or the daemon is gone: nothing this run can clean up.
    return;
  }
  if (ids.length === 0) return;

  console.log(`[e2e] Removing ${ids.length} test container(s) this run started...`);
  try {
    execFileSync("docker", ["rm", "--force", ...ids], { stdio: "ignore" });
  } catch {
    // Already gone.
  }
}
