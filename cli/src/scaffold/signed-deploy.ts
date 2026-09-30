/*
 * The deploy steps of a generated workflow, without a Coolify API token.
 *
 * Two steps replace the old "pin the image on Coolify, then POST
 * /api/v1/deploy" pair, both of which needed hatchkit's root token:
 *
 *   1. Promote. Point `<image>:live` at this commit's `<image>:<sha>`
 *      in GHCR, with the job's own GITHUB_TOKEN. Every Coolify app pulls
 *      `:live` (hatchkit sets that when it wires the app), so this is
 *      the pin: it decides which build the deploy starts, and it can
 *      only touch this repository's packages.
 *   2. Signed deploy. POST a `push` payload to Coolify's manual webhook,
 *      signed with the app's own deploy secret. It queues a deploy of
 *      that one app and can do nothing else. See
 *      deploy/coolify-deploy-hook.ts for why no Coolify token can be
 *      scoped this narrowly.
 *
 * The starter carries byte-identical copies of the multi-image step
 * constants (test-deploy-verification.ts asserts it), like the other
 * blocks in deploy-verification.ts.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  COOLIFY_MANUAL_WEBHOOK_PATH,
  DEPLOY_HOOK_WATCH_PATH,
  LIVE_TAG,
} from "../deploy/coolify-deploy-hook.js";
import { indentOf, stepRange } from "../utils/workflow-yaml.js";

/** `- name:` of the promote step. Also its idempotency marker. */
export const PROMOTE_STEP_NAME = `Promote this commit's images to :${LIVE_TAG}`;

/** `- name:` of the signed deploy step. Also its idempotency marker. */
export const SIGNED_DEPLOY_STEP_NAME = "Deploy via signed Coolify webhook";

const promoteComment = `      # Point \`:${LIVE_TAG}\` at the images this run built. Every Coolify app
      # pulls \`:${LIVE_TAG}\` (hatchkit sets that when it wires the app), so
      # this is what decides which build the deploy below starts — the
      # immutable \`:<sha>\` tag, re-published under the name the apps
      # read. It uses this job's own GITHUB_TOKEN (\`packages: write\`),
      # which can write this repository's packages and nothing else; no
      # Coolify credential is involved.
      #
      # A rollback is the same step with an older sha.
`;

/** Promote step for the starter's two images (`-server`, `-client`).
 *  An image this workflow did not build (a static project has no
 *  server) is skipped rather than failed. */
export const WORKFLOW_PROMOTE_STEP = `${promoteComment}      - name: ${PROMOTE_STEP_NAME}
        env:
          COOLIFY_BASE_URL: \${{ secrets.COOLIFY_BASE_URL }}
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        if: env.COOLIFY_BASE_URL != ''
        run: |
          set -euo pipefail
          printf '%s' "$GH_TOKEN" | docker login ghcr.io -u "\${{ github.actor }}" --password-stdin
          for half in server client; do
            image="ghcr.io/\${{ github.repository }}-$half"
            if ! docker buildx imagetools inspect "$image:\${{ github.sha }}" >/dev/null 2>&1; then
              echo "no $image:\${{ github.sha }} — this project has no $half image"
              continue
            fi
            docker buildx imagetools create --tag "$image:${LIVE_TAG}" "$image:\${{ github.sha }}"
            echo "promoted $image:\${{ github.sha }} to :${LIVE_TAG}"
          done
`;

/** Promote step for the single-image build pipeline (adopt's
 *  `deploy.yml`), whose image is `ghcr.io/<repo>`. */
export const WORKFLOW_PROMOTE_STEP_SINGLE = `${promoteComment}      - name: ${PROMOTE_STEP_NAME}
        env:
          COOLIFY_BASE_URL: \${{ secrets.COOLIFY_BASE_URL }}
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        if: env.COOLIFY_BASE_URL != ''
        run: |
          set -euo pipefail
          printf '%s' "$GH_TOKEN" | docker login ghcr.io -u "\${{ github.actor }}" --password-stdin
          image="ghcr.io/\${{ github.repository }}"
          docker buildx imagetools create --tag "$image:${LIVE_TAG}" "$image:\${{ github.sha }}"
          echo "promoted $image:\${{ github.sha }} to :${LIVE_TAG}"
`;

const hookEnv = (prefix: string) =>
  ["RESOURCE_UUID", "DEPLOY_SECRET", "DEPLOY_REPOSITORY", "DEPLOY_BRANCH"]
    .map((k) => `          ${prefix}${k}: \${{ secrets.${prefix}${k} }}`)
    .join("\n");

/** The signed deploy step. Deploys whichever apps the project's secrets
 *  name — the unprefixed set for a single-app project, the SERVER_ and
 *  CLIENT_ sets for a split one (server first, so the API is up before
 *  the client that calls it). hatchkit sets exactly one of the two, so
 *  nothing is deployed twice. */
export const WORKFLOW_SIGNED_DEPLOY_STEP = `      # Tell Coolify to deploy. There is no Coolify API token here: each
      # app has its own webhook secret (hatchkit mints it), and a \`push\`
      # payload signed with it queues a deploy of that one app — it can
      # read nothing and touch no other app. The payload names
      # \`${DEPLOY_HOOK_WATCH_PATH}\`, the app's only watch path, so an ordinary
      # push that reaches Coolify through its GitHub App never deploys a
      # build that does not exist yet; only this step does.
      #
      # Which apps: COOLIFY_RESOURCE_UUID for a single-app project, or
      # COOLIFY_SERVER_/COOLIFY_CLIENT_RESOURCE_UUID for a split one.
      # hatchkit sets one set and clears the other.
      - name: ${SIGNED_DEPLOY_STEP_NAME}
        env:
          COOLIFY_BASE_URL: \${{ secrets.COOLIFY_BASE_URL }}
${hookEnv("COOLIFY_")}
${hookEnv("COOLIFY_SERVER_")}
${hookEnv("COOLIFY_CLIENT_")}
        if: env.COOLIFY_BASE_URL != ''
        run: |
          set -euo pipefail
          deployed=0
          deploy() { # label, secret-name prefix
            local uuid_var="\${2}RESOURCE_UUID" secret_var="\${2}DEPLOY_SECRET"
            local repo_var="\${2}DEPLOY_REPOSITORY" branch_var="\${2}DEPLOY_BRANCH"
            local uuid="\${!uuid_var:-}" secret="\${!secret_var:-}"
            local repo="\${!repo_var:-}" branch="\${!branch_var:-}"
            [ -n "$uuid" ] || return 0
            if [ -z "$secret" ] || [ -z "$repo" ] || [ -z "$branch" ]; then
              echo "::error::\${2}DEPLOY_SECRET/_REPOSITORY/_BRANCH are not set — run \\\`hatchkit sync\\\` or \\\`hatchkit secrets isolate\\\`."
              exit 1
            fi
            local body sig answer
            body=$(jq -cn --arg ref "refs/heads/$branch" --arg sha "$GITHUB_SHA" --arg repo "$repo" \\
              '{ref: $ref, after: $sha, repository: {full_name: $repo}, commits: [{id: $sha, added: [], removed: [], modified: ["${DEPLOY_HOOK_WATCH_PATH}"]}]}')
            sig=$(printf '%s' "$body" | HOOK_SECRET="$secret" node -e \\
              'process.stdout.write(require("node:crypto").createHmac("sha256", process.env.HOOK_SECRET).update(require("node:fs").readFileSync(0)).digest("hex"))')
            answer=$(curl -fsS -X POST "$COOLIFY_BASE_URL${COOLIFY_MANUAL_WEBHOOK_PATH}" \\
              -H 'Content-Type: application/json' -H 'X-GitHub-Event: push' \\
              -H "X-Hub-Signature-256: sha256=$sig" --data-binary "$body")
            if printf '%s' "$answer" | jq -e --arg uuid "$uuid" \\
              'type == "array" and any(.[]; .application_uuid == $uuid and .status == "success")' \\
              >/dev/null 2>&1; then
              echo "deploy queued for the $1 app ($uuid)"
              deployed=$((deployed + 1))
            else
              # Other apps on the same repo answer "Invalid signature.";
              # they are left out so a public log names only this one.
              detail=$(printf '%s' "$answer" | jq -c '[.[]? | select(.message != "Invalid signature.") | {status, message}]' 2>/dev/null || printf '%s' "$answer" | head -c 200)
              echo "::error::Coolify did not queue a deploy of the $1 app: $detail"
              exit 1
            fi
          }
          deploy app COOLIFY_
          deploy server COOLIFY_SERVER_
          deploy client COOLIFY_CLIENT_
          if [ "$deployed" -eq 0 ]; then
            echo "::error::COOLIFY_BASE_URL is set but no COOLIFY_*RESOURCE_UUID is — nothing was deployed."
            exit 1
          fi
`;

/** Steps that deployed with hatchkit's Coolify token, in every shape a
 *  generated or adopted workflow has carried. */
const TOKEN_DEPLOY_STEPS = [
  "- name: Deploy via Coolify API",
  "- name: Deploy server app via Coolify API (split topology)",
  "- name: Deploy client app via Coolify API (split topology)",
  "- name: Deploy single app via Coolify API",
  "- name: Deploy via webhook (fallback)",
  "- name: Trigger Coolify deploy",
  "- name: Trigger Coolify deployment",
];

/** Steps that pinned the image on Coolify with the token. */
const TOKEN_PIN_STEPS = [
  "- name: Pin image tags to this commit",
  "- name: Pin the image tag to this commit",
];

/** Lines of `content` with every step named in `markers` removed, and
 *  the line index where the first removed step started (or -1). */
function withoutSteps(
  lines: string[],
  markers: readonly string[],
): { lines: string[]; at: number } {
  let at = -1;
  let out = lines;
  for (;;) {
    const found = markers
      .map((m) => stepRange(out, m, 0, out.length))
      .filter((r): r is [number, number] => r !== undefined)
      .sort((a, b) => a[0] - b[0])[0];
    if (!found) break;
    // Also swallow the blank line that separated it from the next step.
    let end = found[1];
    while (
      end < out.length &&
      out[end].trim() === "" &&
      found[0] > 0 &&
      out[found[0] - 1].trim() === ""
    ) {
      end += 1;
    }
    at = at === -1 ? found[0] : Math.min(at, found[0]);
    out = [...out.slice(0, found[0]), ...out.slice(end)];
  }
  return { lines: out, at };
}

/** Re-indent a step block (written at 6 spaces) to `indent`. */
function reindent(block: string, indent: number): string[] {
  const shift = indent - 6;
  return block
    .replace(/\n+$/, "")
    .split("\n")
    .map((l) => (l.trim() === "" ? l : shift >= 0 ? " ".repeat(shift) + l : l.slice(-shift)));
}

/**
 * Convert a workflow's deploy steps from "hatchkit's Coolify token" to
 * "promote in GHCR + signed per-app webhook". Idempotent; returns the
 * content unchanged when it has no known deploy step (a hand-rolled
 * workflow is left for a person, and doctor names it). Existing signed
 * steps also receive the current app-specific queue acceptance rule.
 *
 *   · A Coolify pin step becomes the promote step: the multi-image one
 *     when the old step pinned SERVER_/CLIENT_IMAGE, the single-image
 *     one when it pinned APP_IMAGE.
 *   · Every token deploy step (API POST, webhook-with-bearer, the
 *     "Trigger Coolify deploy" of older adopt workflows) collapses into
 *     one signed deploy step, placed where the first of them was.
 *   · The verify step stops keying on COOLIFY_WEBHOOK_URL, which no
 *     longer exists.
 *
 * A workflow with no pin step gets no promote step: its apps pull a
 * moving tag the build pushes (`:latest`, `:main`), and adding a promote
 * without also pointing the apps at `:live` would change nothing.
 */
export function upgradeWorkflowToSignedDeploy(originalContent: string): string {
  // Existing signed workflows need the same app-specific acceptance rule.
  // An unscoped skip can describe another app or a deployment never queued.
  const content = originalContent.replaceAll(
    'type == "array" and (any(.[]; .application_uuid == $uuid and .status == "success") or any(.[]; .status == "skipped"))',
    'type == "array" and any(.[]; .application_uuid == $uuid and .status == "success")',
  );
  if (
    !TOKEN_DEPLOY_STEPS.some((m) => content.includes(m)) &&
    !TOKEN_PIN_STEPS.some((m) => content.includes(m))
  ) {
    return content;
  }
  let lines = content.split("\n");

  // Pin → promote.
  const pinAt = TOKEN_PIN_STEPS.map((m) => stepRange(lines, m, 0, lines.length)).find(
    (r): r is [number, number] => r !== undefined,
  );
  let promote: string[] = [];
  if (pinAt) {
    const pinText = lines.slice(pinAt[0], pinAt[1]).join("\n");
    const nameLine = lines.slice(pinAt[0], pinAt[1]).find((l) => l.includes("- name:")) ?? "";
    const single = /APP_IMAGE/.test(pinText) && !/SERVER_IMAGE|CLIENT_IMAGE/.test(pinText);
    promote = reindent(
      single ? WORKFLOW_PROMOTE_STEP_SINGLE : WORKFLOW_PROMOTE_STEP,
      indentOf(nameLine),
    );
  }
  if (!content.includes(`- name: ${PROMOTE_STEP_NAME}`) && promote.length > 0) {
    const removed = withoutSteps(lines, TOKEN_PIN_STEPS);
    lines = [
      ...removed.lines.slice(0, removed.at),
      ...promote,
      "",
      ...removed.lines.slice(removed.at),
    ];
  } else {
    lines = withoutSteps(lines, TOKEN_PIN_STEPS).lines;
  }

  // Token deploys → one signed deploy.
  const firstDeploy = TOKEN_DEPLOY_STEPS.map((m) => stepRange(lines, m, 0, lines.length))
    .filter((r): r is [number, number] => r !== undefined)
    .sort((a, b) => a[0] - b[0])[0];
  if (firstDeploy) {
    const nameLine =
      lines.slice(firstDeploy[0], firstDeploy[1]).find((l) => l.includes("- name:")) ?? "";
    const removed = withoutSteps(lines, TOKEN_DEPLOY_STEPS);
    const insert = content.includes(`- name: ${SIGNED_DEPLOY_STEP_NAME}`)
      ? []
      : [...reindent(WORKFLOW_SIGNED_DEPLOY_STEP, indentOf(nameLine)), ""];
    lines = [...removed.lines.slice(0, removed.at), ...insert, ...removed.lines.slice(removed.at)];
  }

  let out = withoutOrphanedTokenEnv(lines.join("\n"));
  // The verify step used to run when either the base URL or the webhook
  // URL was set; only the base URL exists now.
  out = out
    .replace(/^([ \t]*)COOLIFY_WEBHOOK_URL: \$\{\{ secrets\.COOLIFY_WEBHOOK_URL \}\}\n/gm, "")
    .replace(
      /if: env\.COOLIFY_BASE_URL != '' \|\| env\.COOLIFY_WEBHOOK_URL != ''/g,
      "if: env.COOLIFY_BASE_URL != ''",
    );
  out = withTokenFreeHeader(out);
  // A blank line doubled by the removals collapses back to one.
  return out.replace(/\n{3,}/g, "\n\n");
}

/** Drop `COOLIFY_API_TOKEN` / `COOLIFY_TOKEN` / `COOLIFY_WEBHOOK_URL`
 *  env entries (job- or workflow-level too) once nothing in the file
 *  uses them — they would keep the token in every step's environment
 *  after the step that needed it is gone. An `env:` block left empty
 *  goes with them. A file that still reads one keeps all of them; doctor
 *  names it. */
export function withoutOrphanedTokenEnv(content: string): string {
  const names = ["COOLIFY_API_TOKEN", "COOLIFY_TOKEN", "COOLIFY_WEBHOOK_URL"];
  const entry = new RegExp(
    `^[ \\t]*(${names.join("|")}):[ \\t]*\\$\\{\\{ secrets\\.\\1 \\}\\}[ \\t]*$`,
  );
  const lines = content.split("\n");
  const rest = lines.filter((l) => !entry.test(l)).join("\n");
  if (
    names.some((n) => new RegExp(`(\\$\\{?${n}\\b|env\\.${n}\\b|secrets\\.${n}\\b)`).test(rest))
  ) {
    return content;
  }
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (entry.test(lines[i])) continue;
    const line = lines[i];
    if (/^\s*env:\s*$/.test(line)) {
      // Empty once its token entries are gone?
      const indent = indentOf(line);
      let j = i + 1;
      let kept = false;
      for (; j < lines.length; j++) {
        if (!lines[j].trim()) continue;
        if (indentOf(lines[j]) <= indent) break;
        if (!entry.test(lines[j])) {
          kept = true;
          break;
        }
      }
      if (!kept) continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/** Rewrite the "Required repo secrets" lines of an older workflow's
 *  header, which documented COOLIFY_WEBHOOK_URL / COOLIFY_TOKEN. The
 *  first such line becomes the new set; the rest go. */
export function withTokenFreeHeader(content: string): string {
  const lines = content.split("\n");
  const doc = /^#(\s+)(COOLIFY_WEBHOOK_URL|COOLIFY_TOKEN|COOLIFY_API_TOKEN)\s+—/;
  const hits = lines.map((l, i) => (doc.test(l) ? i : -1)).filter((i) => i !== -1);
  if (hits.length === 0) return content;
  const pad = lines[hits[0]].match(doc)?.[1] ?? "   ";
  const replacement = [
    `#${pad}COOLIFY_BASE_URL, COOLIFY_RESOURCE_UUID, COOLIFY_DEPLOY_SECRET,`,
    `#${pad}COOLIFY_DEPLOY_REPOSITORY, COOLIFY_DEPLOY_BRANCH — the Coolify`,
    `#${pad}  app's own signed deploy webhook, set by hatchkit. The secret`,
    `#${pad}  deploys that one app and nothing else; no Coolify API token.`,
  ];
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (i === hits[0]) out.push(...replacement);
    else if (!hits.includes(i)) out.push(l);
  });
  return out.join("\n");
}

/** Workflow files (repo-relative) whose deploy promotes `:live` — the
 *  projects whose Coolify apps should pull `:live`. */
export function workflowsPromotingLive(projectDir: string): string[] {
  const dir = join(projectDir, ".github", "workflows");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .filter((f) => {
      const text = readFileSync(join(dir, f), "utf8");
      return text.includes(`- name: ${PROMOTE_STEP_NAME}`) || text.includes("hatchkit-deploy.mjs");
    })
    .map((f) => `.github/workflows/${f}`);
}
