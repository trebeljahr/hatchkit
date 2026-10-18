/*
 * The deploy workflow of a project whose client is served by Cloudflare
 * Workers (`clientHost: "cloudflare"`), as a rewrite of the project's
 * existing `.github/workflows/build-and-deploy.yml`.
 *
 * Three changes, everything else in the file is kept as it is:
 *
 *   build-client   becomes a static build: export, check the API URL
 *                  reached the bundle, write /version.json, carry the
 *                  last two releases' hashed files, `wrangler versions
 *                  upload`. Nothing is live after this job.
 *   deploy         (the server) loses its client half: no
 *                  `deploy client COOLIFY_CLIENT_` webhook call, no web
 *                  check, and it says whether it deployed at all.
 *   deploy-client  new, after `deploy`: waits until the server reports
 *                  this commit, then `wrangler versions deploy`, then
 *                  polls /version.json. Server first: the client switch
 *                  is one atomic step, so it can wait for a verified
 *                  server, and an old tab calling a new server is the
 *                  direction the release compat suite covers.
 *   release-summary  always runs and says which half is live; the run is
 *                  red when either half failed.
 *
 * Upload in the build job, activate in the deploy job: a one-step
 * `wrangler deploy` left about 15 s of 404s on new chunks in the canary
 * test (2026-10-12); upload, wait, activate had none.
 *
 * The COOLIFY_CLIENT_* secrets are left set and unused, so reverting the
 * commit that carries this rewrite is the whole workflow rollback.
 */

import { CARRY_SCRIPT_REL_PATH, WRANGLER_PACKAGE } from "../scaffold/worker-assets.js";

export interface ClientWorkflowInput {
  /** Worker serving the client. */
  worker: string;
  /** `https://<domain>`. */
  siteUrl: string;
  /** API origin the bundle is built against (`https://<domain>` under
   *  single-origin, `https://api.<domain>` under split). */
  apiUrl: string;
  /** Commands that build the client export, in order, with
   *  `NEXT_FILE_EXPORT=1` in the environment. */
  buildCommands: string[];
  /** Repo-relative export directory (`packages/client/out`). */
  exportDir: string;
  /** `.nvmrc` or `.node-version`. */
  nodeVersionFile: string;
}

export interface WorkflowRewrite {
  text: string;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Job-level YAML surgery
// ---------------------------------------------------------------------------

interface JobBlock {
  name: string;
  start: number;
  /** Exclusive line index. */
  end: number;
}

/** Top-level jobs of a workflow: keys at two-space indent under `jobs:`. */
export function listJobs(lines: string[]): JobBlock[] {
  const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (jobsAt === -1) return [];
  const jobs: JobBlock[] = [];
  for (let i = jobsAt + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line) && !line.startsWith("#")) break;
    const m = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (m) {
      if (jobs.length) jobs[jobs.length - 1].end = i;
      jobs.push({ name: m[1], start: i, end: lines.length });
    }
  }
  // A job ends before the trailing blank/comment lines that precede the
  // next job, so a replacement keeps the file's spacing.
  for (const job of jobs) {
    while (job.end - 1 > job.start && /^\s*(#.*)?$/.test(lines[job.end - 1])) job.end--;
  }
  return jobs;
}

/** `needs:` of a job as written (`[a, b]` or a single name). */
function readNeeds(lines: string[], job: JobBlock): string[] {
  for (let i = job.start + 1; i < job.end; i++) {
    const m = lines[i].match(/^ {4}needs:\s*(.+?)\s*$/);
    if (!m) continue;
    const raw = m[1].replace(/^\[|\]$/g, "");
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/** The `build-args:` of a docker build step, as `KEY=VALUE` pairs. */
export function readBuildArgs(lines: string[], job: JobBlock): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = job.start + 1; i < job.end; i++) {
    const m = lines[i].match(/^(\s+)build-args:\s*\|\s*$/);
    if (!m) continue;
    const indent = m[1].length;
    for (let j = i + 1; j < job.end; j++) {
      const line = lines[j];
      if (!line.trim()) continue;
      const lead = line.match(/^(\s*)/)?.[1].length ?? 0;
      if (lead <= indent) break;
      const kv = line.trim().match(/^([A-Z0-9_]+)=(.*)$/);
      if (kv) out.push([kv[1], kv[2]]);
    }
    break;
  }
  return out;
}

/** The `if:` condition of the step that sends the Coolify webhook, and
 *  the `env:` lines that condition reads, so the client follows the same
 *  rollout gate as the server. The env lines matter: a step's `if:` sees
 *  that step's own `env:` block, so `env.COOLIFY_BASE_URL` is empty in a
 *  step that does not set it (mood-magic's first run skipped the switch
 *  that way, 2026-10-18). */
export function readWebhookGate(
  lines: string[],
  job: JobBlock,
): { condition: string; env: string[] } | undefined {
  let stepStart = -1;
  for (let i = job.start + 1; i < job.end; i++) {
    if (/^ {6}- /.test(lines[i])) stepStart = i;
    if (!/webhooks\/source\/github\/events\/manual/.test(lines[i]) || stepStart < 0) continue;
    let condition: string | undefined;
    const env = new Map<string, string>();
    let inEnv = false;
    for (let j = stepStart; j < job.end; j++) {
      if (j > stepStart && /^ {6}- /.test(lines[j])) break;
      const line = lines[j].replace(/^ {6}- /, "        ");
      const ifMatch = line.match(/^ {8}if:\s*(.+?)\s*$/);
      if (ifMatch) condition = ifMatch[1];
      if (/^ {8}env:\s*$/.test(line)) {
        inEnv = true;
        continue;
      }
      if (inEnv) {
        const kv = line.match(/^ {10}([A-Za-z_][A-Za-z0-9_]*):\s*.*$/);
        if (kv) env.set(kv[1], line);
        else if (!/^ {10}/.test(line)) inEnv = false;
      }
    }
    if (!condition) return undefined;
    const read = [...condition.matchAll(/\benv\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
    return { condition, env: read.flatMap((k) => (env.has(k) ? [env.get(k) as string] : [])) };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const yamlQuote = (v: string): string => (/^[A-Za-z0-9_./:@-]*$/.test(v) ? v : JSON.stringify(v));

/** A workflow rewritten before 2026-10-18 has a "Record that the server
 *  half was deployed" step with the webhook's `if:` but not the env that
 *  `if:` reads, so it never ran. Give it that env. */
export function fixRecordStepEnv(yaml: string): string {
  const lines = yaml.split("\n");
  const deploy = listJobs(lines).find((j) => j.name === "deploy");
  if (!deploy) return yaml;
  const gate = readWebhookGate(lines, deploy);
  if (!gate?.env.length) return yaml;
  const at = lines.findIndex(
    (l, i) => i > deploy.start && i < deploy.end && /^ {8}id: server-deployed\s*$/.test(l),
  );
  if (at < 0 || /^ {8}env:\s*$/.test(lines[at + 1] ?? "")) return yaml;
  lines.splice(at + 1, 0, "        env:", ...gate.env);
  return lines.join("\n");
}

export function renderBuildClientJob(
  input: ClientWorkflowInput,
  opts: { needs: string[]; env: Array<[string, string]> },
): string {
  const needs = opts.needs.length ? `\n    needs: [${opts.needs.join(", ")}]` : "";
  const env = opts.env
    .filter(([k]) => k !== "COMMIT_SHA" && k !== "NEXT_FILE_EXPORT")
    .map(([k, v]) => `          ${k}: ${yamlQuote(v)}`)
    .join("\n");
  const build = input.buildCommands.map((c) => `          ${c}`).join("\n");
  const out = input.exportDir;
  return `  # The client is a static export served by the Cloudflare Worker
  # ${input.worker} (hatchkit clientHost "cloudflare"). This job uploads a
  # Worker version and activates nothing; deploy-client switches to it
  # once the server reports this commit.
  build-client:
    runs-on: ubuntu-latest${needs}
    outputs:
      version_id: \${{ steps.upload.outputs.version_id }}
    env:
      SITE_URL: ${input.siteUrl}
      WRANGLER: ${WRANGLER_PACKAGE}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: ${input.nodeVersionFile}
          cache: pnpm
      - run: pnpm install --frozen-lockfile

      # NEXT_PUBLIC_* are inlined into the bundle at build time.
      - name: Build the static client
        env:
          NEXT_FILE_EXPORT: "1"
${env}
          COMMIT_SHA: \${{ github.sha }}
        run: |
          set -euo pipefail
${build}
          test -n "$NEXT_PUBLIC_API_URL" || { echo "::error::NEXT_PUBLIC_API_URL is empty"; exit 1; }
          # Set and still never inlined (a renamed variable, a server-only
          # reference) builds green and talks to the wrong API.
          grep -rqF "$NEXT_PUBLIC_API_URL" ${out}/_next/static \\
            || { echo "::error::NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL never reached the bundle"; exit 1; }
          # A relative asset prefix breaks every nested route's chunks.
          if grep -rlF '"./_next' ${out} --include='*.html' | grep -q .; then
            echo "::error::exported HTML references ./_next — drop the relative assetPrefix"; exit 1
          fi
          printf '{"commit":"%s","apiUrl":"%s"}\\n' "$COMMIT_SHA" "$NEXT_PUBLIC_API_URL" > ${out}/version.json

      # A Worker version serves only its own files. Carry the last two
      # releases' hashed files so tabs opened before this deploy keep
      # loading their chunks.
      - name: Carry earlier releases' hashed files
        run: node ${CARRY_SCRIPT_REL_PATH} --site "$SITE_URL" --out ${out}

      - name: Upload a new Worker version (not live yet)
        id: upload
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          WRANGLER_OUTPUT_FILE_PATH: \${{ runner.temp }}/wrangler-upload.ndjson
        run: |
          set -euo pipefail
          pnpm dlx "$WRANGLER" versions upload --tag "$GITHUB_SHA" --message "$GITHUB_SHA"
          id=$(node -e 'const rows=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\\n").map((l)=>JSON.parse(l));const row=rows.find((r)=>r.type==="version-upload");if(!row?.version_id)process.exit(1);console.log(row.version_id)' "$WRANGLER_OUTPUT_FILE_PATH")
          echo "version_id=$id" >> "$GITHUB_OUTPUT"
          echo "Uploaded Worker version $id (not live yet)"
`;
}

export function renderDeployClientJobs(
  input: ClientWorkflowInput,
  opts: { buildJobs: string[] },
): string {
  const site = input.siteUrl.replace(/\/$/, "");
  const api = input.apiUrl.replace(/\/$/, "");
  const summaryNeeds = [...opts.buildJobs, "deploy", "deploy-client"];
  return `
  # Server first, then the client: deploy-client waits until the server
  # reports this commit, switches the Worker in one step, and checks
  # /version.json.
  deploy-client:
    runs-on: ubuntu-latest
    needs: [build-client, deploy]
    if: needs.deploy.outputs.server_deployed == 'true'
    env:
      SITE_URL: ${site}
      API_URL: ${api}
      WRANGLER: ${WRANGLER_PACKAGE}
    steps:
      - name: Wait for the server at this commit
        run: |
          set -uo pipefail
          for i in $(seq 1 40); do
            got=$(curl -fsSL --max-time 10 "$API_URL/api/health?hatchkit_cb=$i$RANDOM" 2>/dev/null | jq -r '.version // empty' 2>/dev/null || true)
            if [ "$got" = "$GITHUB_SHA" ]; then echo "✓ server reports $GITHUB_SHA"; exit 0; fi
            echo "  server: \${got:-<no version>} — waiting ($i/40)"
            sleep 15
          done
          echo "::error::the server never reported $GITHUB_SHA on /api/health .version; the client was not switched."
          echo "::error::A server that reports no version needs \\\`version: process.env.COMMIT_SHA\\\` on /api/health."
          exit 1

      - name: Switch the client to this commit's Worker version
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          VERSION_ID: \${{ needs.build-client.outputs.version_id }}
        run: npx --yes "$WRANGLER" versions deploy "$VERSION_ID@100%" --name ${input.worker} --message "$GITHUB_SHA" --yes

      - name: Verify the client is live
        run: |
          set -uo pipefail
          for i in $(seq 1 24); do
            body=$(curl -fsSL --max-time 10 "$SITE_URL/version.json?hatchkit_cb=$i$RANDOM" 2>/dev/null || true)
            commit=$(printf '%s' "$body" | jq -r '.commit // empty' 2>/dev/null || true)
            if [ "$commit" = "$GITHUB_SHA" ]; then
              baked=$(printf '%s' "$body" | jq -r '.apiUrl // empty')
              if [ "$baked" != "$API_URL" ]; then
                echo "::error::client is built against '\${baked:-<empty>}', expected '$API_URL'"; exit 1
              fi
              echo "✓ $SITE_URL serves $GITHUB_SHA, built against $baked"; exit 0
            fi
            echo "  web: \${commit:-<no response>} — waiting ($i/24)"
            sleep 5
          done
          echo "::error::$SITE_URL/version.json never reported $GITHUB_SHA"; exit 1

  # Always runs, so a half-finished release says which half is live.
  release-summary:
    runs-on: ubuntu-latest
    if: always()
    needs: [${summaryNeeds.join(", ")}]
    steps:
      - name: Which half is live
        env:
          SERVER: \${{ needs.deploy.result }}
          SERVER_DEPLOYED: \${{ needs.deploy.outputs.server_deployed }}
          CLIENT: \${{ needs.deploy-client.result }}
          VERSION_ID: \${{ needs.build-client.outputs.version_id }}
        run: |
          say() { echo "$1"; echo "$1" >> "$GITHUB_STEP_SUMMARY"; }
          if [ "$SERVER" != "success" ]; then
            say "::error::Server deploy did not finish ($SERVER). The client was NOT switched: the previous Worker version still serves."
            exit 1
          fi
          if [ "$SERVER_DEPLOYED" != "true" ]; then
            say "Deploys are gated off: nothing went live. Worker version \${VERSION_ID:-<none>} was uploaded, not activated."
            exit 0
          fi
          if [ "$CLIENT" = "success" ]; then
            say "Server and client are both live at $GITHUB_SHA."
            exit 0
          fi
          say "::error::Server $GITHUB_SHA is LIVE. The client is NOT ($CLIENT): the previous Worker version still serves."
          say "To switch by hand: npx wrangler versions deploy \${VERSION_ID:-<id>}@100% --name ${input.worker} --yes"
          exit 1
`;
}

/**
 * Rewrite `yaml` for a client on Workers. Throws when the file does not
 * have the shape hatchkit writes (`build-client` and `deploy` jobs);
 * returns the text unchanged with a note when it is already rewritten.
 */
export function rewriteWorkflowForWorkerClient(
  yaml: string,
  input: ClientWorkflowInput,
): WorkflowRewrite {
  const notes: string[] = [];
  if (/^ {2}deploy-client:\s*$/m.test(yaml)) {
    const fixed = fixRecordStepEnv(yaml);
    return fixed === yaml
      ? { text: yaml, notes: ["workflow already deploys the client to Cloudflare"] }
      : {
          text: fixed,
          notes: ["deploy: the server-deployed step now sees the env its gate reads"],
        };
  }
  let lines = yaml.split("\n");
  let jobs = listJobs(lines);
  const buildClient = jobs.find((j) => j.name === "build-client");
  const deploy = jobs.find((j) => j.name === "deploy");
  if (!buildClient || !deploy) {
    throw new Error(
      "The workflow has no `build-client` and `deploy` jobs; write the Workers deploy by hand (see `hatchkit help migrate-client`).",
    );
  }

  const buildArgs = readBuildArgs(lines, buildClient);
  const env: Array<[string, string]> = buildArgs.length
    ? buildArgs
    : [
        ["NEXT_PUBLIC_API_URL", input.apiUrl],
        ["NEXT_PUBLIC_WS_URL", input.apiUrl.replace(/^http/, "ws")],
        ["NEXT_PUBLIC_PLAUSIBLE_DOMAIN", "${{ vars.NEXT_PUBLIC_PLAUSIBLE_DOMAIN }}"],
        ["NEXT_PUBLIC_PLAUSIBLE_SCRIPT_URL", "${{ vars.NEXT_PUBLIC_PLAUSIBLE_SCRIPT_URL }}"],
        ["NEXT_PUBLIC_SENTRY_DSN", "${{ vars.NEXT_PUBLIC_SENTRY_DSN }}"],
      ];
  const apiArg = env.find(([k]) => k === "NEXT_PUBLIC_API_URL")?.[1];
  if (apiArg && !apiArg.includes("${{") && apiArg !== input.apiUrl) {
    throw new Error(
      `build-client builds against NEXT_PUBLIC_API_URL=${apiArg}, but the manifest's API origin is ${input.apiUrl}.`,
    );
  }
  const webhookGate = readWebhookGate(lines, deploy);
  const replacement = renderBuildClientJob(input, {
    needs: readNeeds(lines, buildClient),
    env,
  })
    .replace(/\n$/, "")
    .split("\n");
  lines = [...lines.slice(0, buildClient.start), ...replacement, ...lines.slice(buildClient.end)];
  notes.push("build-client: static export + carry + `wrangler versions upload`");

  // Re-read: the replacement moved every later line.
  jobs = listJobs(lines);
  const dep = jobs.find((j) => j.name === "deploy");
  if (!dep) throw new Error("lost the deploy job while rewriting");
  const depLines = lines.slice(dep.start, dep.end);
  const rewritten: string[] = [];
  let droppedClientCall = false;
  for (const line of depLines) {
    if (/^\s*deploy client COOLIFY_CLIENT_\s*$/.test(line)) {
      droppedClientCall = true;
      continue;
    }
    // The web half is checked by deploy-client after its switch.
    const web = line.match(/^(\s+)HATCHKIT_WEB_URL:\s*.+$/);
    if (web) {
      rewritten.push(`${web[1]}HATCHKIT_WEB_URL: "" # client: checked by deploy-client`);
      continue;
    }
    rewritten.push(line);
  }
  if (droppedClientCall) notes.push("deploy: no longer calls the Coolify client webhook");
  // `deploy` says whether it deployed, so the client follows the same
  // rollout gate as the server.
  const needsAt = rewritten.findIndex((l) => /^ {4}needs:/.test(l));
  const insertAt = needsAt === -1 ? 1 : needsAt + 1;
  rewritten.splice(
    insertAt,
    0,
    "    outputs:",
    "      server_deployed: ${{ steps.server-deployed.outputs.deployed }}",
  );
  rewritten.push(
    "",
    "      - name: Record that the server half was deployed",
    "        id: server-deployed",
    ...(webhookGate?.env.length ? ["        env:", ...webhookGate.env] : []),
    ...(webhookGate ? [`        if: ${webhookGate.condition}`] : []),
    `        run: echo "deployed=true" >> "$GITHUB_OUTPUT"`,
  );
  lines = [...lines.slice(0, dep.start), ...rewritten, ...lines.slice(dep.end)];

  const buildJobs = listJobs(lines)
    .map((j) => j.name)
    .filter((n) => n.startsWith("build-"));
  const text = `${lines.join("\n").replace(/\n*$/, "\n")}${renderDeployClientJobs(input, { buildJobs })}`;
  notes.push("deploy-client + release-summary added (server first, then the Worker switch)");
  return { text, notes };
}
