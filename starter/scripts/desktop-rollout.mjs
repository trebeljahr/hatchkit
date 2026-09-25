#!/usr/bin/env node
/*
 * Change how many installed desktop apps are offered a release:
 *
 *   pnpm desktop:rollout v1.4.0 25          # 25 % of installs
 *   pnpm desktop:rollout v1.4.0 100         # everybody (removes the key)
 *   pnpm desktop:rollout v1.4.0 0           # halt: nobody new is offered it
 *   pnpm desktop:rollout v1.4.0 50 --dry-run
 *
 *   node scripts/desktop-rollout.mjs --check "<value>"   # CI: validate only
 *
 * A person's command, not CI's: it uses the `gh` CLI with the caller's own
 * login, and the checkout's own repository unless `--repo owner/name` names
 * another. It downloads the release's `latest*.yml` feeds, rewrites
 * `stagingPercentage` in each (scripts/lib/desktop-rollout.mjs → `rewriteFeed`,
 * which touches that one line and proves it), and uploads them again with
 * `--clobber`. Every feed is rewritten and checked before the first upload, so
 * a feed that does not parse leaves the release as it was.
 *
 * What it cannot do: take an update back from an install that already has it.
 * Fix forward with a higher version (docs/desktop.md → "Staged rollout").
 *
 * `--check` is the release workflow's early validation of the dispatch input or
 * DESKTOP_STAGING_PERCENTAGE: it prints the normalised value and, under
 * Actions, writes `percentage=<n or empty>` to $GITHUB_OUTPUT.
 */
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  describeStaging,
  feedAssetNames,
  loadFeedParser,
  parseRolloutArgs,
  parseStagingPercentage,
  rewriteFeed,
} from "./lib/desktop-rollout.mjs";

/** A refusal: printed without a stack, exit 1, after the temp dir is gone. */
class Refusal extends Error {}
const fail = (message) => {
  throw new Refusal(message);
};

const argv = process.argv.slice(2);

if (argv[0] === "--check") {
  let percent;
  try {
    percent = parseStagingPercentage(argv[1] ?? "");
  } catch (err) {
    console.log(
      `::error::${err.message} Set the dispatch input or DESKTOP_STAGING_PERCENTAGE to 0-100, or leave it empty.`,
    );
    process.exit(1);
  }
  console.log(`::notice::Update feeds will offer this release to ${describeStaging(percent)}.`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `percentage=${percent ?? ""}\n`);
  }
  process.exit(0);
}

function main() {
  let args;
  try {
    args = parseRolloutArgs(argv);
  } catch (err) {
    fail(err.message);
  }
  // No --repo: gh reads the checkout's own remote, so this template names no
  // repository anywhere.
  const repoArgs = args.repo ? ["--repo", args.repo] : [];
  const where = args.repo ? ` in ${args.repo}` : "";

  const gh = (ghArgs, options = {}) =>
    execFileSync("gh", ghArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const yaml = loadFeedParser(repoRoot);

  let release;
  try {
    const json = "tagName,isDraft,isPrerelease,assets,url";
    release = JSON.parse(gh(["release", "view", args.tag, ...repoArgs, "--json", json]));
  } catch (err) {
    // ENOENT is execFileSync failing to start `gh` at all (no `status`), not gh
    // answering "no such release".
    if (err.code === "ENOENT") {
      fail(
        "gh is not installed (https://cli.github.com); desktop:rollout is a person's command with their own gh login.",
      );
    }
    const detail = String(err.stderr ?? err.message).trim();
    fail(`No release ${args.tag}${where}${detail ? ` (${detail})` : ""}.`);
  }

  const feedNames = feedAssetNames(release.assets.map((asset) => asset.name));
  if (feedNames.length === 0) fail(`${args.tag} has no latest*.yml feeds; nothing to roll out.`);

  // electron-updater's GitHub provider reads the feeds of the newest published
  // release only. Staging an older one changes nothing for anybody.
  if (release.isDraft) {
    console.log(`Note: ${args.tag} is a draft. The percentage applies once it is published.`);
  } else if (release.isPrerelease) {
    console.log(`Note: ${args.tag} is a prerelease, which installed apps are never offered.`);
  } else {
    try {
      const own = ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"];
      const repo = args.repo ?? gh(own).trim();
      const latest = gh(["api", `repos/${repo}/releases/latest`, "--jq", ".tag_name"]).trim();
      if (latest !== args.tag) {
        console.log(
          `Note: the latest published release is ${latest}; apps read its feeds, not ${args.tag}'s.`,
        );
      }
    } catch {
      // Informational only.
    }
  }

  const dir = mkdtempSync(join(tmpdir(), "desktop-rollout-"));
  try {
    const patterns = feedNames.flatMap((name) => ["--pattern", name]);
    gh(["release", "download", args.tag, ...repoArgs, "--dir", dir, ...patterns]);
    const downloaded = readdirSync(dir).sort();
    const missing = feedNames.filter((name) => !downloaded.includes(name));
    if (missing.length > 0) fail(`Could not download ${missing.join(", ")}.`);

    // Rewrite and check every feed before uploading any.
    const rewritten = [];
    for (const name of feedNames) {
      try {
        const text = readFileSync(join(dir, name), "utf8");
        const percent = args.percent;
        rewritten.push({ name, ...rewriteFeed({ name, text, percent, parse: yaml.load }) });
      } catch (err) {
        fail(`${err.message} Nothing was uploaded.`);
      }
    }

    const show = (value) => (value === null ? "absent" : String(value));
    for (const { name, before, after } of rewritten) {
      console.log(`${name}: stagingPercentage ${show(before)} → ${show(after)}`);
    }
    console.log(`\n${args.tag} will be offered to ${describeStaging(args.percent)}.`);

    if (args.dryRun) {
      console.log("--dry-run: nothing uploaded.");
      return;
    }
    if (rewritten.every(({ before, after }) => before === after)) {
      console.log("Every feed already says that; nothing uploaded.");
      return;
    }

    for (const { name, text } of rewritten) writeFileSync(join(dir, name), text);
    const files = rewritten.map(({ name }) => join(dir, name));
    gh(["release", "upload", args.tag, ...repoArgs, "--clobber", ...files], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    console.log(`Uploaded ${rewritten.length} feeds to ${release.url}`);
  } catch (err) {
    // A gh call that exited non-zero: its own stderr says why.
    if (err && typeof err === "object" && "status" in err && !(err instanceof Refusal)) {
      fail(String(err.stderr ?? err.message).trim());
    }
    throw err;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

try {
  main();
} catch (err) {
  if (!(err instanceof Refusal)) throw err;
  console.error(`desktop:rollout: ${err.message}`);
  process.exit(1);
}
