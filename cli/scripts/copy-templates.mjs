#!/usr/bin/env node
/**
 * Copy non-TS assets (Handlebars templates) from src/ into dist/ so
 * the compiled CLI can resolve them at runtime via
 * `dist/utils/../templates/...`. Run automatically from `pnpm build`.
 */
import { cpSync, existsSync } from "node:fs";
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
