import Handlebars from "handlebars";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, "..", "templates");
/** Register Handlebars helpers. */
Handlebars.registerHelper("ifIn", function (value, list, options) {
    if (list && list.includes(value)) {
        return options.fn(this);
    }
    return options.inverse(this);
});
Handlebars.registerHelper("join", function (arr, separator) {
    return arr.join(separator);
});
Handlebars.registerHelper("json", function (obj) {
    return JSON.stringify(obj, null, 2);
});
/** Render a Handlebars template file with the given context. */
export function renderTemplate(templatePath, context) {
    const fullPath = join(TEMPLATES_DIR, templatePath);
    if (!existsSync(fullPath)) {
        throw new Error(`Template not found: ${fullPath}`);
    }
    const source = readFileSync(fullPath, "utf-8");
    const template = Handlebars.compile(source, { noEscape: true });
    return template(context);
}
/** Render a template string (not from file) with the given context. */
export function renderString(source, context) {
    const template = Handlebars.compile(source, { noEscape: true });
    return template(context);
}
/** Get the templates directory path. */
export function getTemplatesDir() {
    return TEMPLATES_DIR;
}
//# sourceMappingURL=template.js.map