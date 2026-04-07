import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { renderTemplate } from "../utils/template.js";
/** Scaffold a new Node.js app repo based on project config. */
export function scaffoldApp(config, outputDir) {
    const files = [];
    const context = buildTemplateContext(config);
    // Base files (always generated)
    files.push({ path: "package.json", content: renderTemplate("base/package.json.hbs", context) });
    files.push({ path: "tsconfig.json", content: renderTemplate("base/tsconfig.json.hbs", context) });
    files.push({ path: "Dockerfile", content: renderTemplate("base/Dockerfile.hbs", context) });
    files.push({ path: ".dockerignore", content: renderTemplate("base/.dockerignore.hbs", context) });
    files.push({ path: ".env.example", content: renderTemplate("base/env.example.hbs", context) });
    files.push({ path: ".gitignore", content: renderTemplate("base/gitignore.hbs", context) });
    files.push({
        path: ".github/workflows/deploy.yml",
        content: renderTemplate("base/github-actions.yml.hbs", context),
    });
    // Source files
    files.push({ path: "src/index.ts", content: renderTemplate("base/src/index.ts.hbs", context) });
    files.push({ path: "src/db.ts", content: renderTemplate("base/src/db.ts.hbs", context) });
    files.push({ path: "src/config.ts", content: renderTemplate("base/src/config.ts.hbs", context) });
    files.push({ path: "src/routes/health.ts", content: renderTemplate("base/src/routes/health.ts.hbs", context) });
    // better-auth (always included)
    files.push({ path: "src/auth/auth.ts", content: renderTemplate("base/src/auth/auth.ts.hbs", context) });
    files.push({ path: "src/auth/routes.ts", content: renderTemplate("base/src/auth/routes.ts.hbs", context) });
    // Addon: WebSocket + Redis
    if (config.features.includes("websocket")) {
        files.push({ path: "src/ws.ts", content: renderTemplate("addons/websocket/ws.ts.hbs", context) });
        files.push({ path: "src/redis.ts", content: renderTemplate("addons/websocket/redis.ts.hbs", context) });
    }
    // Addon: Stripe
    if (config.features.includes("stripe")) {
        files.push({ path: "src/stripe/client.ts", content: renderTemplate("addons/stripe/client.ts.hbs", context) });
        files.push({ path: "src/stripe/webhook.ts", content: renderTemplate("addons/stripe/webhook.ts.hbs", context) });
        files.push({ path: "src/stripe/checkout.ts", content: renderTemplate("addons/stripe/checkout.ts.hbs", context) });
    }
    // Addon: Analytics + Error tracking
    if (config.features.includes("analytics")) {
        files.push({ path: "src/analytics/sentry.ts", content: renderTemplate("addons/analytics/sentry.ts.hbs", context) });
        files.push({
            path: "src/analytics/middleware.ts",
            content: renderTemplate("addons/analytics/middleware.ts.hbs", context),
        });
    }
    // Addon: S3 storage
    if (config.features.includes("s3")) {
        files.push({ path: "src/storage/s3.ts", content: renderTemplate("addons/storage/s3.ts.hbs", context) });
        files.push({ path: "src/storage/upload.ts", content: renderTemplate("addons/storage/upload.ts.hbs", context) });
    }
    // ML clients
    for (const service of config.mlServices) {
        if (service === "custom-hf")
            continue; // handled separately
        files.push({
            path: `src/ml/${service}.ts`,
            content: renderTemplate(`ml-clients/${service}.ts.hbs`, context),
        });
    }
    if (config.mlServices.includes("custom-hf") && config.customHfModelId) {
        files.push({
            path: "src/ml/custom-model.ts",
            content: renderTemplate("ml-clients/custom-hf.ts.hbs", context),
        });
    }
    if (config.dryRun) {
        console.log(chalk.bold("\n  [dry-run] Would create the following files:\n"));
        for (const file of files) {
            console.log(chalk.dim(`    ${outputDir}/${file.path}`));
        }
        return files;
    }
    // Write files to disk
    for (const file of files) {
        const fullPath = join(outputDir, file.path);
        const dir = join(fullPath, "..");
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        writeFileSync(fullPath, file.content, "utf-8");
    }
    console.log(chalk.green(`  ✓ Scaffolded ${files.length} files in ${outputDir}`));
    return files;
}
function buildTemplateContext(config) {
    return {
        name: config.name,
        domain: config.domain,
        baseDomain: config.baseDomain,
        subdomain: config.subdomain,
        websocket: config.features.includes("websocket"),
        stripe: config.features.includes("stripe"),
        analytics: config.features.includes("analytics"),
        s3: config.features.includes("s3"),
        s3Provider: config.s3Provider,
        mlServices: config.mlServices,
        has3d: config.mlServices.includes("3d-extraction"),
        hasSubtitles: config.mlServices.includes("subtitles"),
        hasImageRecognition: config.mlServices.includes("image-recognition"),
        hasBgRemoval: config.mlServices.includes("background-removal"),
        hasCustomHf: config.mlServices.includes("custom-hf"),
        customHfModelId: config.customHfModelId,
        gpuPlatform: config.gpuPlatform,
    };
}
//# sourceMappingURL=app.js.map