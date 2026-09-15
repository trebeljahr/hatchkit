/*
 * Local S3 for the E2E run.
 *
 * The starter's server talks to S3 through `services/storage.ts`. E2E
 * gives it a throwaway SeaweedFS container on :9002 — locally from
 * `e2e/start-server.sh`, in CI from a "Start SeaweedFS" step in
 * build-and-deploy.yml. `playwright.config.ts` hands the server the
 * matching endpoint, bucket and credentials.
 *
 * A project with neither the `s3` feature nor an ML service never
 * imports storage.ts, so the container is pure overhead there. This
 * module strips all three pieces for those projects, and retrofits the
 * old MinIO CI step (Docker Hub no longer serves `minio/minio`, so that
 * step fails the e2e job before any test runs).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { rewriteFile } from "./starter-files.js";

/** Pinned SeaweedFS image. The starter's start-server.sh,
 *  docker-compose.dev.yml and CI workflow, and the adopt workflow
 *  template, all carry this exact string — test-scaffold.ts checks it. */
export const SEAWEEDFS_IMAGE = "chrislusf/seaweedfs:4.47";

/** True when the project has code that talks to S3: the `s3` feature,
 *  or any ML service (services/ml.ts is storage.ts's only importer). */
export function needsLocalS3(opts: {
  features: readonly string[];
  mlServices?: readonly string[];
}): boolean {
  return opts.features.includes("s3") || (opts.mlServices?.length ?? 0) > 0;
}

/** The CI step, at the 6-space step indent both workflows use. */
export function seaweedfsCiStep(bucket: string): string {
  return [
    "      - name: Start SeaweedFS",
    "        run: |",
    "          docker run -d --name e2e-seaweedfs -p 9002:8333 \\",
    `            -e S3_BUCKET=${bucket} \\`,
    `            --tmpfs /data ${SEAWEEDFS_IMAGE}`,
    "          for i in $(seq 1 60); do",
    `            curl -sf -o /dev/null http://127.0.0.1:9002/${bucket} && exit 0`,
    "            sleep 1",
    "          done",
    `          echo "SeaweedFS did not serve bucket ${bucket} within 60s" >&2`,
    "          docker logs e2e-seaweedfs >&2",
    "          exit 1",
    "",
  ].join("\n");
}

const S3_STEP_HEADER = /^( *)- name: Start (?:MinIO|SeaweedFS)\s*$/;
const S3_ENV_LINE = /^ +(?:S3_[A-Z_]+|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_REGION): .*$/;

/** Locate a workflow's local-S3 step: `start`..`end` spans the step and
 *  its trailing blank line, `commentStart` also takes in a comment block
 *  directly above the header. `null` when there is no such step. */
function findS3Step(
  lines: string[],
): { start: number; end: number; commentStart: number; indent: string } | null {
  const start = lines.findIndex((l) => S3_STEP_HEADER.test(l));
  if (start < 0) return null;
  const indent = S3_STEP_HEADER.exec(lines[start])?.[1] ?? "";
  let end = start + 1;
  while (end < lines.length && lines[end] !== "" && lines[end].startsWith(`${indent}  `)) end += 1;
  // A trailing blank line belongs to the step (it separates it from the
  // next one).
  if (end < lines.length && lines[end] === "") end += 1;
  let commentStart = start;
  while (commentStart > 0 && lines[commentStart - 1].startsWith(`${indent}#`)) commentStart -= 1;
  return { start, end, commentStart, indent };
}

/** Drop the local-S3 step (and its comment) plus the S3_* / AWS_* env
 *  on the steps of the `e2e` job. Idempotent. */
export function stripWorkflowE2eS3(workflow: string): string {
  const lines = workflow.split("\n");
  const step = findS3Step(lines);
  if (step) lines.splice(step.commentStart, step.end - step.commentStart);
  return withinE2eJob(lines, (l) => !S3_ENV_LINE.test(l)).join("\n");
}

/** Keep only the lines of the `e2e:` job that pass `keep`. */
function withinE2eJob(lines: string[], keep: (line: string) => boolean): string[] {
  const out: string[] = [];
  let inE2e = false;
  for (const line of lines) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(line) || /^\S/.test(line)) inE2e = line === "  e2e:";
    if (inE2e && !keep(line)) continue;
    out.push(line);
  }
  return out;
}

/** Retrofit an existing workflow's local-S3 step to the current
 *  SeaweedFS step. The MinIO step it replaces fails on every run.
 *
 *  `bucket` is the name the E2E server uses. `s3Env` says where the
 *  server gets its S3 env from: `"playwright"` for `hatchkit create`
 *  projects (playwright.config.ts sets it, so the job env drops it),
 *  `"workflow"` for the adopt template (the job env keeps it, with the
 *  MinIO credentials swapped for placeholders). Projects without local
 *  S3 lose the step entirely. Idempotent. */
export function upgradeWorkflowE2eS3(
  workflow: string,
  opts: { bucket: string; s3Env: "playwright" | "workflow"; enabled: boolean },
): string {
  if (!opts.enabled) return stripWorkflowE2eS3(workflow);
  const lines = workflow.split("\n");
  const step = findS3Step(lines);
  if (!step) return workflow;
  const replacement = seaweedfsCiStep(opts.bucket).split("\n");
  lines.splice(step.start, step.end - step.start, ...replacement);
  const out =
    opts.s3Env === "playwright"
      ? withinE2eJob(lines, (l) => !S3_ENV_LINE.test(l))
      : lines.map((l) =>
          l.replace(/^( +AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY): )minioadmin$/, "$1hatchkit-dev"),
        );
  return out.join("\n");
}

/** Drop the SeaweedFS block from e2e/start-server.sh. Idempotent. */
export function stripStartServerE2eS3(script: string): string {
  return script.replace(
    /\n[ \t]*# SeaweedFS S3 on port 9002\n[\s\S]*?\n[ \t]*echo "\[e2e\] SeaweedFS bucket ready"\n[ \t]*fi\n/,
    "\n",
  );
}

/** Drop the S3 env the E2E server gets from playwright.config.ts.
 *  `S3_PUBLIC_URL` spans several lines, so match whole `KEY: value,`
 *  entries rather than single lines. Idempotent. */
export function stripPlaywrightE2eS3(config: string): string {
  return config.replace(
    /^[ \t]*(?:S3_[A-Z_]+|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_REGION):[^,]*,[ \t]*\r?\n/gm,
    "",
  );
}

/** `hatchkit create`: remove every local-S3 piece from a project that
 *  has no S3 code. No-op when the project needs S3 or the files are
 *  already gone (static surfaces drop e2e/ wholesale). */
export function applyE2eS3Gate(
  outputDir: string,
  opts: { features: readonly string[]; mlServices?: readonly string[] },
  modifications: string[],
): void {
  if (needsLocalS3(opts)) return;
  rewriteFile(join(outputDir, ".github/workflows/build-and-deploy.yml"), stripWorkflowE2eS3);
  rewriteFile(join(outputDir, "e2e/start-server.sh"), stripStartServerE2eS3);
  rewriteFile(join(outputDir, "playwright.config.ts"), stripPlaywrightE2eS3);
  modifications.push("removed: E2E SeaweedFS container (no S3 or ML code)");
}

/** `hatchkit regen-infra` entries for both workflow shapes: the
 *  create-flow build-and-deploy.yml, where playwright.config.ts owns
 *  the S3 env, and the adopt-flow deploy.yml, where the job env does.
 *  The bucket is read from whichever file owns it, so the container
 *  creates the bucket the E2E server actually uses. */
export function e2eS3Retrofits(
  projectDir: string,
  manifest: { name: string; features: readonly string[]; mlServices?: readonly string[] },
): Array<[label: string, relPath: string, fn: (c: string) => string]> {
  const enabled = needsLocalS3(manifest);
  const playwrightPath = join(projectDir, "playwright.config.ts");
  const playwrightBucket = existsSync(playwrightPath)
    ? /S3_BUCKET_NAME:\s*"([^"]+)"/.exec(readFileSync(playwrightPath, "utf-8"))?.[1]
    : undefined;
  const upgrade = (c: string): string => {
    const envBucket = /^ +S3_BUCKET_NAME: *"?([\w.-]+)"?\s*$/m.exec(c)?.[1];
    return upgradeWorkflowE2eS3(
      c,
      playwrightBucket
        ? { enabled, s3Env: "playwright", bucket: playwrightBucket }
        : { enabled, s3Env: "workflow", bucket: envBucket ?? `${manifest.name}-e2e` },
    );
  };
  return [
    ["E2E local S3 (build-and-deploy.yml)", ".github/workflows/build-and-deploy.yml", upgrade],
    ["E2E local S3 (deploy.yml)", ".github/workflows/deploy.yml", upgrade],
  ];
}
