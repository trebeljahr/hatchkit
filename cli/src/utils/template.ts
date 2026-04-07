import Handlebars from "handlebars";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, "..", "templates");

/** Register Handlebars helpers. */
Handlebars.registerHelper("ifIn", function (this: unknown, value: string, list: string[], options: Handlebars.HelperOptions) {
  if (list && list.includes(value)) {
    return options.fn(this);
  }
  return options.inverse(this);
});

Handlebars.registerHelper("join", function (arr: string[], separator: string) {
  return arr.join(separator);
});

Handlebars.registerHelper("json", function (obj: unknown) {
  return JSON.stringify(obj, null, 2);
});

/** Render a Handlebars template file with the given context. */
export function renderTemplate(
  templatePath: string,
  context: Record<string, unknown>,
): string {
  const fullPath = join(TEMPLATES_DIR, templatePath);
  if (!existsSync(fullPath)) {
    throw new Error(`Template not found: ${fullPath}`);
  }
  const source = readFileSync(fullPath, "utf-8");
  const template = Handlebars.compile(source, { noEscape: true });
  return template(context);
}

/** Render a template string (not from file) with the given context. */
export function renderString(
  source: string,
  context: Record<string, unknown>,
): string {
  const template = Handlebars.compile(source, { noEscape: true });
  return template(context);
}

/** Get the templates directory path. */
export function getTemplatesDir(): string {
  return TEMPLATES_DIR;
}
