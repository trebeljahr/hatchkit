/*
 * `hatchkit add <project> lead-magnet` — list, add, change or remove an
 * entry in the project's newsletter `magnets.json`: the allowlist of free
 * files a signup form may ask for (see the starter's
 * services/newsletter/magnets.ts, or the newsletter Worker template).
 *
 * Local files only. It never uploads the file and never touches Listmonk,
 * R2, Coolify or the env files: it reads the env files to warn about what
 * a delivery needs (the token secret, the API URL, the bucket keys), and
 * prints the remaining steps. Rollback is `git checkout` on magnets.json.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import chalk from "chalk";
import { readEnvKeys } from "../../provision/write-env.js";
import { resolveServerDir } from "../server-platform/kit.js";

export interface LeadMagnetEntry {
  title: string;
  object?: string;
  url?: string;
  filename?: string;
}

export interface LeadMagnetOptions {
  projectDir: string;
  key?: string;
  title?: string;
  object?: string;
  url?: string;
  filename?: string;
  remove?: boolean;
  dryRun?: boolean;
}

export interface LeadMagnetResult {
  ok: boolean;
  /** magnets.json, relative to the project. */
  file?: string;
  /** "listed" when no key was given. */
  action?: "listed" | "added" | "updated" | "removed" | "unchanged";
  magnets: Record<string, LeadMagnetEntry>;
  /** Problems that stopped the run. */
  errors: string[];
  /** Things a delivery still needs. */
  warnings: string[];
  nextSteps: string[];
}

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const FILENAME_RE = /^[^/\\"\r\n]{1,200}$/;

/** Where the newsletter keeps magnets.json: the starter's server, or the
 *  newsletter Worker of a static site. */
export function findMagnetsFile(
  projectDir: string,
): { path: string; kind: "server" | "worker" } | null {
  const serverDir = resolveServerDir(projectDir);
  if (serverDir) {
    const path = join(serverDir, "src", "services", "newsletter", "magnets.json");
    if (existsSync(path)) return { path, kind: "server" };
  }
  const worker = join(projectDir, "workers", "newsletter", "src", "magnets.json");
  if (existsSync(worker)) return { path: worker, kind: "worker" };
  return null;
}

/** The same rules the starter's parseMagnets applies at runtime. */
export function leadMagnetProblem(key: string, entry: LeadMagnetEntry): string | null {
  if (!KEY_RE.test(key)) return "the key must be lowercase letters, digits and dashes (max 48)";
  if (!entry.title?.trim()) return "a magnet needs --title";
  if ((entry.object === undefined) === (entry.url === undefined)) {
    return "give exactly one of --object <bucket key> or --url <https url>";
  }
  if (
    entry.object !== undefined &&
    (entry.object === "" || entry.object.startsWith("/") || entry.object.split("/").includes(".."))
  ) {
    return "--object must be a bucket key such as magnets/file.zip";
  }
  if (entry.url !== undefined) {
    let protocol = "";
    try {
      protocol = new URL(entry.url).protocol;
    } catch {
      // reported below
    }
    if (protocol !== "https:") return "--url must be an https URL";
  }
  if (entry.filename !== undefined && !FILENAME_RE.test(entry.filename)) {
    return "--filename must be a plain file name";
  }
  return null;
}

export function applyLeadMagnet(opts: LeadMagnetOptions): LeadMagnetResult {
  const result: LeadMagnetResult = {
    ok: false,
    magnets: {},
    errors: [],
    warnings: [],
    nextSteps: [],
  };
  const found = findMagnetsFile(opts.projectDir);
  if (!found) {
    const oldNewsletter = [
      join(
        resolveServerDir(opts.projectDir) ?? opts.projectDir,
        "src",
        "services",
        "newsletter",
        "routes.ts",
      ),
      join(opts.projectDir, "workers", "newsletter", "src", "newsletter.ts"),
    ].find((p) => existsSync(p));
    result.errors.push(
      oldNewsletter
        ? `${relative(opts.projectDir, oldNewsletter)} predates lead magnets (no magnets.json next to it). Port the newsletter files from hatchkit's starter (packages/server/src/services/newsletter) or its newsletter Worker template first.`
        : "This project has no newsletter service. `hatchkit add <project> listmonk-ses` sets up the mailing list; a static site uses the newsletter Worker template (see hatchkit's email docs).",
    );
    return result;
  }
  result.file = relative(opts.projectDir, found.path);

  let magnets: Record<string, LeadMagnetEntry>;
  try {
    const parsed = JSON.parse(readFileSync(found.path, "utf-8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error("not a JSON object");
    magnets = parsed as Record<string, LeadMagnetEntry>;
  } catch (err) {
    result.errors.push(`${result.file} is not valid: ${(err as Error).message}`);
    return result;
  }

  if (!opts.key) {
    result.ok = true;
    result.action = "listed";
    result.magnets = magnets;
    return result;
  }
  const key = opts.key;

  const before = JSON.stringify(magnets);
  if (opts.remove) {
    if (!(key in magnets)) {
      result.errors.push(`No magnet "${key}" in ${result.file}.`);
      return result;
    }
    delete magnets[key];
    result.action = "removed";
    result.nextSteps.push(
      "Every download link already sent for it stops working once this is deployed, until a magnet with the same key is added again. Remove the form's `magnet` value in the same change.",
    );
  } else {
    const previous = magnets[key];
    if (opts.object !== undefined && opts.url !== undefined) {
      result.errors.push("give exactly one of --object <bucket key> or --url <https url>");
      return result;
    }
    // Changing one field of an existing magnet keeps the others; a new
    // --object or --url replaces the old source.
    let source: Pick<LeadMagnetEntry, "object" | "url"> = {};
    if (opts.object !== undefined) source = { object: opts.object };
    else if (opts.url !== undefined) source = { url: opts.url };
    else if (previous?.object !== undefined) source = { object: previous.object };
    else if (previous?.url !== undefined) source = { url: previous.url };
    if (opts.filename !== undefined && source.object === undefined) {
      result.errors.push("--filename applies only to an --object magnet");
      return result;
    }
    const filename =
      source.object !== undefined ? (opts.filename ?? previous?.filename) : undefined;
    const entry: LeadMagnetEntry = {
      title: opts.title ?? previous?.title ?? "",
      ...source,
      ...(filename !== undefined ? { filename } : {}),
    };
    const problem = leadMagnetProblem(key, entry);
    if (problem) {
      result.errors.push(problem);
      return result;
    }
    magnets[key] = entry;
    result.action = previous ? "updated" : "added";
    result.warnings.push(...deliveryWarnings(opts.projectDir, found, entry));
    result.nextSteps.push(...addSteps(found.kind, key, entry));
  }

  if (JSON.stringify(magnets) === before) result.action = "unchanged";
  else if (!opts.dryRun) writeFileSync(found.path, `${JSON.stringify(magnets, null, 2)}\n`);
  result.magnets = magnets;
  result.ok = true;
  return result;
}

/** Read-only checks of what a delivery of `entry` needs. */
function deliveryWarnings(
  projectDir: string,
  found: { path: string; kind: "server" | "worker" },
  entry: LeadMagnetEntry,
): string[] {
  const warnings: string[] = [];
  if (found.kind === "worker") {
    const wrangler = join(projectDir, "workers", "newsletter", "wrangler.jsonc");
    const config = existsSync(wrangler) ? readFileSync(wrangler, "utf-8") : "";
    const bound = config
      .split("\n")
      .some((line) => !line.trim().startsWith("//") && /"binding"\s*:\s*"MAGNETS"/.test(line));
    if (entry.object && !bound) {
      warnings.push(
        'workers/newsletter/wrangler.jsonc binds no R2 bucket as MAGNETS, so the download route cannot read the object. Add "r2_buckets": [{ "binding": "MAGNETS", "bucket_name": "<bucket>" }].',
      );
    }
    return warnings;
  }
  const serverDir = resolveServerDir(projectDir) ?? projectDir;
  const prod = join(serverDir, ".env.production");
  const keys = readEnvKeys(prod);
  const where = relative(projectDir, prod);
  if (!existsSync(prod)) return [`No ${where}, so nothing could be checked.`];
  if (!keys.has("NEWSLETTER_TOKEN_SECRET") && !keys.has("CRON_SECRET")) {
    warnings.push(
      `${where} has neither NEWSLETTER_TOKEN_SECRET nor CRON_SECRET; the confirm and download links are signed with it.`,
    );
  }
  if (!keys.has("BETTER_AUTH_URL")) {
    warnings.push(`${where} has no BETTER_AUTH_URL; the download link is built on it.`);
  }
  if (entry.object) {
    const missing = ["S3_BUCKET_NAME", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"].filter(
      (k) => !keys.has(k),
    );
    if (missing.length) {
      warnings.push(
        `${where} has no ${missing.join(", ")}; an \`object\` magnet is served from the project's bucket with a presigned URL. Run \`hatchkit add <project> s3\`, or use --url.`,
      );
    }
  }
  return warnings;
}

function addSteps(kind: "server" | "worker", key: string, entry: LeadMagnetEntry): string[] {
  const steps: string[] = [];
  if (entry.object) {
    const bucket =
      kind === "worker" ? "the MAGNETS bucket" : "the project's bucket (S3_BUCKET_NAME)";
    steps.push(
      `Upload the file to ${bucket} as \`${entry.object}\`: Cloudflare dashboard → R2, or \`wrangler r2 object put <bucket>/${entry.object} --file <path> --remote\`.`,
    );
  }
  steps.push(
    kind === "worker"
      ? `Add \`<input type="hidden" name="magnet" value="${key}">\` to the signup form.`
      : `Use it in a form: \`<SubscribeForm magnet="${key}" source="<where-the-form-is>" />\`.`,
  );
  steps.push(
    kind === "worker"
      ? "Commit, then deploy the Worker (`pnpm --dir workers/newsletter exec wrangler deploy`)."
      : `Commit and deploy, then \`pnpm newsletter:verify --magnet ${key}\` checks the file and mails you the download.`,
  );
  return steps;
}

export function printLeadMagnetResult(result: LeadMagnetResult, dryRun: boolean): void {
  if (!result.ok) {
    for (const error of result.errors) console.log(chalk.red(`  ${error}`));
    return;
  }
  const keys = Object.keys(result.magnets);
  if (result.action === "listed") {
    console.log(chalk.bold(`\n  Lead magnets in ${result.file}:`));
    if (keys.length === 0) console.log(chalk.dim("    none"));
    for (const key of keys) {
      const m = result.magnets[key];
      console.log(
        `    ${chalk.cyan(key)}  ${m.title}  ${chalk.dim(m.object ? `object ${m.object}` : `url ${m.url}`)}`,
      );
    }
    console.log(
      chalk.dim(
        "\n  Add one: hatchkit add <project> lead-magnet --key <key> --title <title> (--object <bucket key> | --url <https url>) [--filename <name>]\n  Remove:  hatchkit add <project> lead-magnet --key <key> --remove\n",
      ),
    );
    return;
  }
  const verb =
    dryRun && result.action !== "unchanged" ? `would be ${result.action}` : result.action;
  console.log(
    chalk.green(
      `\n  ✓ ${result.file}: magnet ${verb}${dryRun ? chalk.dim(" (--dry-run, nothing written)") : ""}`,
    ),
  );
  for (const warning of result.warnings) console.log(chalk.yellow(`  ! ${warning}`));
  if (result.nextSteps.length) {
    console.log(chalk.bold("\n  Next:"));
    for (const step of result.nextSteps) console.log(`    · ${step}`);
  }
  console.log("");
}
