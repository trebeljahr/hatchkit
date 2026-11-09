/*
 * `hatchkit map` — one page with every project, server, edge service and
 * background job, how they connect, and which of them hatchkit lists,
 * set up, or never touched. Read-only.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import chalk from "chalk";
import { execa } from "execa";
import { getConfigPath } from "../config.js";
import { resolveAssetRoot } from "../utils/asset-root.js";
import { getCliVersion } from "../utils/version.js";
import { buildFleetMap } from "./build.js";
import { collectFleetFacts } from "./collect.js";
import { loadExtras, resolveExtrasPath } from "./extras.js";
import { renderMapHtml } from "./render.js";
import { MAP_USAGE } from "./usage.js";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0) {
    const v = args[i + 1];
    if (!v || v.startsWith("--")) throw new Error(`${name} needs a value`);
    return v;
  }
  const eq = args.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

function defaultStacksDir(): string | undefined {
  const candidates: string[] = [];
  try {
    candidates.push(join(resolveAssetRoot(), "infra", "terraform", "stacks"));
  } catch {
    // An installed package without its bundle: try the config copy.
  }
  candidates.push(
    join(dirname(getConfigPath()), "templates", getCliVersion(), "infra", "terraform", "stacks"),
  );
  return candidates.find((c) => existsSync(c));
}

export async function runMapCommand(args: string[]): Promise<void> {
  const known = new Set([
    "--out",
    "--open",
    "--json",
    "--extras",
    "--stack-dir",
    "--no-ssh",
    "--no-github",
  ]);
  for (const a of args) {
    if (a.startsWith("--") && !known.has(a.split("=")[0])) {
      throw new Error(`Unknown flag ${a}.\n\n${MAP_USAGE}`);
    }
  }
  const json = args.includes("--json");
  const extrasPath = resolveExtrasPath(flag(args, "--extras"));
  const extras = loadExtras(extrasPath);
  const stackFlag = flag(args, "--stack-dir");
  const stacksDir = stackFlag ? resolve(stackFlag) : defaultStacksDir();
  const log = (line: string) => process.stderr.write(`${chalk.dim(line)}\n`);

  log(`  hatchkit map · extras: ${extrasPath ?? "none"}`);
  const facts = await collectFleetFacts({
    extras,
    ssh: !args.includes("--no-ssh"),
    github: !args.includes("--no-github"),
    stacksDir,
    log,
  });
  const map = buildFleetMap(facts, extras);

  if (json) {
    console.log(JSON.stringify(map, null, 2));
    return;
  }
  const out = resolve(
    flag(args, "--out") ?? join(dirname(getConfigPath()), "map", "hatchkit-map.html"),
  );
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, renderMapHtml(map), { mode: 0o600 });

  const t = map.tiers;
  const errors = map.sources.filter((s) => s.status === "error");
  console.log("");
  console.log(`  ${chalk.bold("hatchkit map")}  ${chalk.dim(out)}`);
  console.log(
    `  ${map.nodes.length} places · ${map.edges.length} connections · ${map.projects.length} projects · ${map.jobs.length} jobs`,
  );
  console.log(
    `  pieces: ${chalk.blue(`${t.listed} listed`)} · ${chalk.cyan(`${t.made} set up by hatchkit`)} · ${chalk.dim(`${t.outside} outside`)}${t.gaps ? ` · ${chalk.yellow(`${t.gaps} gaps`)}` : ""}`,
  );
  for (const e of errors)
    console.log(`  ${chalk.yellow("!")} not read: ${e.label} — ${e.detail ?? ""}`);
  console.log("");
  if (args.includes("--open")) {
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    await execa(opener, [out], { reject: false });
  }
}
