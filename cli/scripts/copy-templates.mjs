#!/usr/bin/env node
import { execFileSync } from "node:child_process";
/**
 * Copy non-TS assets (Handlebars templates) from src/ into dist/ so
 * the compiled CLI can resolve them at runtime via
 * `dist/utils/../templates/...`. Run automatically from `pnpm build`.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const from = join(root, "src", "templates");
const to = join(root, "dist", "templates");

if (!existsSync(from)) {
  console.error(`copy-templates: source missing at ${from}`);
  process.exit(1);
}
cpSync(from, to, { recursive: true });

// Only tracked files belong in the published templates. Never package local
// credentials, dependencies, build caches or a developer's infrastructure state.
const repo = join(root, "..");
const bundle = join(root, "dist", "bundle");
rmSync(bundle, { recursive: true, force: true });
const files = execFileSync("git", ["ls-files", "-z", "--", "starter", "infra", "services"], {
  cwd: repo, encoding: "utf8",
}).split("\0").filter(Boolean);
for (const required of ["starter/package.json", "infra/terraform/stacks/node-realtime/main.tf"]) {
  if (!files.includes(required)) throw new Error(`Template source missing: ${required}`);
}
for (const file of files) {
  if (/(?:^|\/)(?:node_modules|\.git)(?:\/|$)|\.tfstate(?:\.|$)|(?:^|\/)\.env\.keys$/.test(file)) {
    throw new Error(`Refusing to bundle private or generated state: ${file}`);
  }
  const destination = join(bundle, file);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(join(repo, file), destination, { dereference: true });
}
cpSync(join(repo, "README.md"), join(root, "README.md"));
cpSync(join(repo, "LICENSE"), join(root, "LICENSE"));

chmodSync(join(root, "dist", "index.js"), 0o755);
