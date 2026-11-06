/*
 * `hatchkit add <project> paid-unlock` — sell a page, a download or an
 * email through Stripe Checkout.
 *
 * Two runtimes run the same core (`cli/src/paid-unlock/core.ts`, copied
 * into the project verbatim):
 *
 *   · worker — `workers/unlock/`, a Cloudflare Worker on the site's own
 *     origin (Workers routes /api/unlock/* and /paid/*). For static sites
 *     and for apps whose domain is proxied through Cloudflare.
 *   · server — `<server>/src/services/unlock/`, mounted in the starter's
 *     Express app before express.json().
 *
 * Every run (re)writes the runtime files: hatchkit-owned files are
 * refreshed and reported as a conflict, never overwritten, when the copy
 * was edited; files meant to be edited (wrangler.jsonc, unlocks.json, the
 * private folder) are written only when absent. With `--key` it also
 * adds, changes or removes one product in unlocks.json, validated with
 * the runtime's own rules.
 *
 * Local files only. Stripe is `hatchkit stripe sync`. Rollback is
 * `git checkout` / deleting the written folder.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import {
  UNLOCK_KINDS,
  type UnlockConfig,
  type UnlockKind,
  type UnlockProduct,
  unlockConfigProblems,
  unlockProductProblems,
} from "../../paid-unlock/core.js";
import { zoneOf } from "../../provision/stripe-sync.js";
import { readEnvKeys } from "../../provision/write-env.js";
import { readManifest } from "../../scaffold/manifest.js";
import {
  appendClaudeMdSection,
  appendEnvBlock,
  patchSourceFile,
  resolveServerDir,
  writeManaged,
} from "../server-platform/kit.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(__dirname, "..", "..", "templates", "paid-unlock");
/** The runtime core's source: src/paid-unlock/core.ts, or the copy
 *  scripts/copy-templates.mjs puts next to dist/paid-unlock/core.js. */
const CORE_SOURCE = join(__dirname, "..", "..", "paid-unlock", "core.ts");

export type UnlockRuntime = "worker" | "server";

export interface PaidUnlockOptions {
  projectDir: string;
  runtime?: UnlockRuntime;
  key?: string;
  name?: string;
  description?: string;
  kind?: string;
  /** Major units: "9" or "4.50". */
  price?: string;
  /** Pay what you want: minimum and suggested amount, major units. */
  min?: string;
  suggested?: string;
  interval?: string;
  /** Comma-separated `object[:filename]`. */
  files?: string;
  email?: string;
  subject?: string;
  taxCode?: string;
  active?: boolean;
  remove?: boolean;
  dryRun?: boolean;
}

export interface PaidUnlockResult {
  ok: boolean;
  runtime?: UnlockRuntime;
  /** unlocks.json, relative to the project. */
  file?: string;
  written: string[];
  unchanged: string[];
  conflicted: string[];
  action?: "listed" | "added" | "updated" | "removed" | "unchanged";
  products: Record<string, UnlockProduct>;
  errors: string[];
  warnings: string[];
  nextSteps: string[];
}

interface Layout {
  runtime: UnlockRuntime;
  /** Directory holding core.ts and unlocks.json. */
  srcDir: string;
  /** The private folder: paid/<key>/…, emails/…, files/… (server). */
  privateDir: string;
  configPath: string;
  serverDir?: string;
}

function layoutFor(projectDir: string, runtime: UnlockRuntime): Layout | null {
  if (runtime === "worker") {
    const root = join(projectDir, "workers", "unlock");
    return {
      runtime,
      srcDir: join(root, "src"),
      privateDir: join(root, "private"),
      configPath: join(root, "src", "unlocks.json"),
    };
  }
  const serverDir = resolveServerDir(projectDir);
  if (!serverDir) return null;
  return {
    runtime,
    serverDir,
    srcDir: join(serverDir, "src", "services", "unlock"),
    privateDir: join(serverDir, "unlock-private"),
    configPath: join(serverDir, "src", "services", "unlock", "unlocks.json"),
  };
}

/** The runtime already in the project, if any. */
export function findUnlockLayout(projectDir: string): Layout | null {
  for (const runtime of ["worker", "server"] as const) {
    const layout = layoutFor(projectDir, runtime);
    if (layout && existsSync(layout.configPath)) return layout;
  }
  return null;
}

function template(rel: string): string {
  return readFileSync(join(TEMPLATE_DIR, rel), "utf-8");
}

function render(text: string, tokens: Record<string, string>): string {
  let out = text;
  for (const [name, value] of Object.entries(tokens)) out = out.split(`__${name}__`).join(value);
  return out;
}

/** Major units ("9", "4.50") → smallest unit (900, 450). */
export function parseMajorAmount(text: string): number | null {
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(text.trim())) return null;
  const [whole, frac = ""] = text.trim().split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

function rel(projectDir: string, path: string): string {
  return relative(projectDir, path).split("\\").join("/");
}

/** Write the runtime files. Records outcomes on `result`. */
function scaffold(
  result: PaidUnlockResult,
  projectDir: string,
  layout: Layout,
  tokens: Record<string, string>,
  dryRun: boolean,
): void {
  const track = (abs: string, outcome: "written" | "unchanged" | "conflicted") => {
    result[outcome].push(rel(projectDir, abs));
  };
  // Files hatchkit owns: refreshed, or a conflict when edited.
  const managed = (abs: string, content: string) =>
    track(abs, writeManaged(abs, content, { dryRun }));
  // Files the project owns: written once.
  const once = (abs: string, content: string) =>
    existsSync(abs)
      ? result.unchanged.push(rel(projectDir, abs))
      : track(abs, writeManaged(abs, content, { dryRun }));

  managed(join(layout.srcDir, "core.ts"), readFileSync(CORE_SOURCE, "utf-8"));
  once(join(layout.privateDir, "paid", "README.txt"), template("worker/private/paid/README.txt"));
  once(
    join(layout.privateDir, "emails", "README.txt"),
    template("worker/private/emails/README.txt"),
  );
  once(layout.configPath, render(template("worker/src/unlocks.json"), tokens));

  if (layout.runtime === "worker") {
    const root = dirname(layout.srcDir);
    managed(join(layout.srcDir, "index.ts"), template("worker/src/index.ts"));
    managed(join(root, "README.md"), template("worker/README.md"));
    once(join(root, "wrangler.jsonc"), render(template("worker/wrangler.jsonc"), tokens));
    once(join(root, "package.json"), template("worker/package.json"));
    once(join(root, "tsconfig.json"), template("worker/tsconfig.json"));
    once(join(root, ".gitignore"), template("worker/gitignore"));
    claudeMd(result, projectDir, layout, dryRun);
    return;
  }

  const serverDir = layout.serverDir as string;
  managed(join(layout.srcDir, "index.ts"), template("server/index.ts"));
  once(join(layout.privateDir, "files", "README.txt"), template("server/files-README.txt"));

  const app = join(serverDir, "src", "app.ts");
  const appPatch = patchSourceFile(
    app,
    [
      {
        guard: 'from "./services/unlock/index.js"',
        anchor: 'import { env, getTrustedOrigins } from "./config/env.js";',
        insert: '\nimport { createUnlockHandler } from "./services/unlock/index.js";',
      },
      {
        guard: "createUnlockHandler()",
        anchor: "app.use(helmet());",
        insert:
          "\n\n  // ── Paid unlock (Stripe Checkout → page, download, email) ──────────\n" +
          "  // Before express.json(): the webhook needs the raw body and the core\n" +
          "  // parses its own forms. It answers only /api/unlock/* and the page\n" +
          "  // prefix (unlocks.json pagePrefix, default /paid) and passes the rest on.\n" +
          "  app.use(createUnlockHandler());",
      },
    ],
    { dryRun },
  );
  if (appPatch.changed) result.written.push(rel(projectDir, app));
  if (appPatch.missingAnchors.length)
    result.warnings.push(
      `${rel(projectDir, app)}: could not find ${appPatch.missingAnchors.join(" / ")}. Add \`app.use(createUnlockHandler())\` (from "./services/unlock/index.js") by hand, before express.json().`,
    );

  const dockerfile = join(serverDir, "Dockerfile");
  if (existsSync(dockerfile)) {
    const dockerPatch = patchSourceFile(
      dockerfile,
      [
        {
          guard: "unlock-private",
          anchor: "COPY --from=build /prod/node_modules ./node_modules",
          insert:
            "\n# Paid unlock: pages, email bodies and local files, read at runtime.\n" +
            `COPY --from=build /app/${rel(projectDir, serverDir)}/unlock-private ./unlock-private`,
        },
      ],
      { dryRun },
    );
    if (dockerPatch.changed) result.written.push(rel(projectDir, dockerfile));
    if (dockerPatch.missingAnchors.length)
      result.warnings.push(
        `${rel(projectDir, dockerfile)}: copy ${rel(projectDir, layout.privateDir)} into the runtime image next to dist/ by hand.`,
      );
  }

  const envFiles = appendEnvBlock(
    serverDir,
    "Paid unlock (hatchkit add … paid-unlock)",
    [
      "# STRIPE_SECRET_KEY above is the project's own Stripe key for this mode.",
      "# UNLOCK_WEBHOOK_SECRET is written by `hatchkit stripe sync`.",
      "# UNLOCK_TOKEN_SECRET: any long random string; changing it logs every buyer out.",
      "# UNLOCK_SITE_URL: public origin buyers use (default BETTER_AUTH_URL).",
      "UNLOCK_WEBHOOK_SECRET=",
      "UNLOCK_TOKEN_SECRET=",
      "UNLOCK_SITE_URL=",
    ],
    { dryRun, files: [".env.example"] },
  );
  for (const file of envFiles) result.written.push(rel(projectDir, join(serverDir, file)));

  claudeMd(result, projectDir, layout, dryRun);
}

/** A short section in the project's CLAUDE.md, once. */
function claudeMd(
  result: PaidUnlockResult,
  projectDir: string,
  layout: Layout,
  dryRun: boolean,
): void {
  const where =
    layout.runtime === "worker"
      ? "- Cloudflare Worker `workers/unlock/` on routes `/api/unlock/*` and `/paid/*` of the site's origin. Deploy it on its own (`wrangler deploy`)."
      : "- Mounted in `src/app.ts` before `express.json()`; it needs the raw body for the webhook.";
  const added = appendClaudeMdSection(
    projectDir,
    "## Paid unlock",
    [
      "Stripe Checkout → a page, a download or an email, with no buyer database: the paid Checkout Session is the record, an HMAC cookie or email link is the proof.",
      `- Code: \`${rel(projectDir, layout.srcDir)}/\` (\`core.ts\` is hatchkit's; \`hatchkit add <project> paid-unlock\` refreshes it). Products: \`unlocks.json\` there; Stripe objects: \`hatchkit stripe sync\`.`,
      `- Paid pages, email bodies${layout.runtime === "server" ? ", local files" : ""}: \`${rel(projectDir, layout.privateDir)}/\`. Never put paid content in the public site build.`,
      where,
      "- Access ends on a full refund, an open dispute or an ended subscription (email links at once, cookies within 24 h).",
    ].join("\n"),
    { dryRun },
  );
  if (added) result.written.push("CLAUDE.md");
}

function normalizeFiles(text: string): Array<{ object: string; filename?: string }> {
  return text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const at = part.indexOf(":");
      return at === -1
        ? { object: part }
        : { object: part.slice(0, at), filename: part.slice(at + 1) };
    });
}

/** Build the new entry from flags on top of the previous one. */
function mergeProduct(
  opts: PaidUnlockOptions,
  previous: UnlockProduct | undefined,
): { entry?: unknown; error?: string } {
  const entry: Record<string, unknown> = previous ? { ...previous } : {};
  if (opts.name !== undefined) entry.name = opts.name;
  if (opts.description !== undefined) entry.description = opts.description || undefined;
  if (opts.kind !== undefined) {
    if (!UNLOCK_KINDS.includes(opts.kind as UnlockKind))
      return { error: `--kind must be one of ${UNLOCK_KINDS.join(", ")}` };
    entry.kind = opts.kind;
  }
  if (opts.price !== undefined && (opts.min !== undefined || opts.suggested !== undefined))
    return { error: "give either --price, or --min (and --suggested) for pay what you want" };
  if (opts.price !== undefined) {
    const amount = parseMajorAmount(opts.price);
    if (amount === null) return { error: "--price must be an amount such as 9 or 4.50" };
    entry.price = amount;
  }
  if (opts.min !== undefined || opts.suggested !== undefined) {
    const min = parseMajorAmount(opts.min ?? "0");
    const preset = opts.suggested !== undefined ? parseMajorAmount(opts.suggested) : undefined;
    if (min === null || preset === null)
      return { error: "--min and --suggested must be amounts such as 3 or 4.50" };
    entry.price = preset === undefined ? { min } : { min, preset };
  }
  if (opts.interval !== undefined)
    entry.interval = opts.interval === "none" ? undefined : opts.interval;
  if (opts.files !== undefined) entry.files = normalizeFiles(opts.files);
  if (opts.email !== undefined) entry.email = opts.email;
  if (opts.subject !== undefined) entry.subject = opts.subject;
  if (opts.taxCode !== undefined) entry.taxCode = opts.taxCode || undefined;
  if (opts.active !== undefined) entry.active = opts.active ? undefined : false;
  // A kind change drops fields that belonged to the old kind.
  if (entry.kind !== "download") delete entry.files;
  if (entry.kind !== "email") {
    delete entry.email;
    delete entry.subject;
  }
  for (const [k, v] of Object.entries(entry)) if (v === undefined) delete entry[k];
  return { entry };
}

/** Read-only checks of what selling `config`'s products still needs. */
function warningsFor(projectDir: string, layout: Layout, config: UnlockConfig): string[] {
  const warnings: string[] = [];
  if (!config.refundPolicy)
    warnings.push(
      `${rel(projectDir, layout.configPath)} has no "refundPolicy". Add one line buyers see at checkout and in the purchase email, e.g. "Not happy? Write to hello@example.com within 30 days for a full refund."`,
    );
  for (const [key, product] of Object.entries(config.products)) {
    if (product.kind === "page" && !existsSync(join(layout.privateDir, "paid", key, "index.html")))
      warnings.push(
        `${key}: no ${rel(projectDir, join(layout.privateDir, "paid", key, "index.html"))} yet.`,
      );
    if (
      product.kind === "email" &&
      product.email &&
      !existsSync(join(layout.privateDir, "emails", product.email))
    )
      warnings.push(
        `${key}: no ${rel(projectDir, join(layout.privateDir, "emails", product.email))} yet.`,
      );
  }
  const downloads = Object.values(config.products).some((p) => p.kind === "download");
  const emails = Object.values(config.products).some((p) => p.kind === "email");
  if (layout.runtime === "worker") {
    const wrangler = join(dirname(layout.srcDir), "wrangler.jsonc");
    const text = existsSync(wrangler) ? readFileSync(wrangler, "utf-8") : "";
    const live = text.split("\n").filter((line) => !line.trim().startsWith("//"));
    const where = rel(projectDir, wrangler);
    if (downloads && !live.some((line) => /"binding"\s*:\s*"FILES"/.test(line)))
      warnings.push(
        `${where} binds no R2 bucket as FILES, so downloads cannot be read. Uncomment "r2_buckets" and name a private bucket.`,
      );
    const prefix = config.pagePrefix ?? "/paid";
    if (!live.some((line) => line.includes(`${prefix}/*"`)))
      warnings.push(
        `${where} has no route for ${prefix}/*, so page products never reach the Worker.`,
      );
    if (live.some((line) => /"LISTMONK_TX_TEMPLATE_ID"\s*:\s*"0"/.test(line)))
      warnings.push(
        `${where}: LISTMONK_TX_TEMPLATE_ID is "0", so no purchase email is sent${emails ? " and email products cannot be delivered" : ""}. Set the project's tx template id.`,
      );
  }
  if (layout.runtime === "server" && layout.serverDir) {
    const prod = join(layout.serverDir, ".env.production");
    if (existsSync(prod)) {
      const keys = readEnvKeys(prod);
      const missing = ["STRIPE_SECRET_KEY", "UNLOCK_WEBHOOK_SECRET", "UNLOCK_TOKEN_SECRET"].filter(
        (k) => !keys.has(k),
      );
      if (!keys.has("LISTMONK_TX_TEMPLATE_ID"))
        warnings.push(
          `${rel(projectDir, prod)} has no LISTMONK_TX_TEMPLATE_ID, so no purchase email is sent${emails ? " and email products cannot be delivered" : ""}.`,
        );
      if (missing.length)
        warnings.push(
          `${rel(projectDir, prod)} has no ${missing.join(", ")}; unlock routes answer 503 until they are set.`,
        );
    }
  }
  return warnings;
}

function nextStepsFor(projectDir: string, layout: Layout, project: string, key?: string): string[] {
  const steps: string[] = [];
  steps.push(
    `\`hatchkit stripe sync ${project} --mode test\` creates the products, prices and webhook in the project's Stripe sandbox.`,
  );
  if (layout.runtime === "worker") {
    steps.push(
      "Set the Worker secrets STRIPE_SECRET_KEY, UNLOCK_TOKEN_SECRET and LISTMONK_API_TOKEN (`pnpm --dir workers/unlock exec wrangler secret put <NAME>`), then `wrangler deploy`. See workers/unlock/README.md.",
    );
  } else {
    steps.push(
      `Set UNLOCK_TOKEN_SECRET and UNLOCK_SITE_URL in ${rel(projectDir, join(layout.serverDir as string, ".env.production"))} (\`dotenvx set … --encrypt\`). A client on Cloudflare must route the page prefix to the server: add "/paid" to originPaths in .hatchkit.json.`,
    );
  }
  steps.push(
    `Buy button: <form method="post" action="/api/unlock/checkout"><input type="hidden" name="product" value="${key ?? "<key>"}"><button>Buy</button></form>`,
  );
  return steps;
}

export function applyPaidUnlock(opts: PaidUnlockOptions): PaidUnlockResult {
  const result: PaidUnlockResult = {
    ok: false,
    written: [],
    unchanged: [],
    conflicted: [],
    products: {},
    errors: [],
    warnings: [],
    nextSteps: [],
  };
  const dryRun = Boolean(opts.dryRun);
  const manifest = readManifest(opts.projectDir);
  const existing = findUnlockLayout(opts.projectDir);
  if (existing && opts.runtime && existing.runtime !== opts.runtime) {
    result.errors.push(
      `This project already has the ${existing.runtime} runtime (${rel(opts.projectDir, existing.configPath)}). Remove it first to switch.`,
    );
    return result;
  }
  const runtime: UnlockRuntime =
    existing?.runtime ??
    opts.runtime ??
    (manifest?.surfaces !== "static" && resolveServerDir(opts.projectDir) ? "server" : "worker");
  const layout = existing ?? layoutFor(opts.projectDir, runtime);
  if (!layout) {
    result.errors.push(
      "No server package here (packages/server with src/index.ts). Use --runtime worker.",
    );
    return result;
  }
  result.runtime = runtime;
  result.file = rel(opts.projectDir, layout.configPath);

  const project = manifest?.name ?? "";
  const domain = manifest?.domain ?? "";
  if (!existing && (!project || !domain)) {
    result.errors.push(
      "No .hatchkit.json with a project name and domain here. Run `hatchkit adopt` first, or pass the project directory.",
    );
    return result;
  }
  scaffold(
    result,
    opts.projectDir,
    layout,
    { PROJECT: project, DOMAIN: domain, ZONE: zoneOf(domain) },
    dryRun,
  );

  // Current unlocks.json: on disk, or the template a dry run did not write.
  let raw: unknown;
  try {
    raw = existsSync(layout.configPath)
      ? JSON.parse(readFileSync(layout.configPath, "utf-8"))
      : JSON.parse(render(template("worker/src/unlocks.json"), { PROJECT: project }));
  } catch (err) {
    result.errors.push(`${result.file} is not valid JSON: ${(err as Error).message}`);
    return result;
  }
  const problems = unlockConfigProblems(raw);
  if (problems.length && !opts.key) {
    result.errors.push(`${result.file}: ${problems.join("; ")}`);
    return result;
  }
  const config = raw as UnlockConfig;

  if (!opts.key) {
    result.ok = true;
    result.action = "listed";
    result.products = config.products ?? {};
    result.warnings.push(...warningsFor(opts.projectDir, layout, config));
    result.nextSteps.push(...nextStepsFor(opts.projectDir, layout, config.project));
    return result;
  }

  const key = opts.key;
  const before = JSON.stringify(config);
  if (opts.remove) {
    if (!config.products?.[key]) {
      result.errors.push(`No product "${key}" in ${result.file}.`);
      return result;
    }
    delete config.products[key];
    result.action = "removed";
    result.nextSteps.push(
      "Everyone who bought it loses access once this is deployed. To stop sales but keep buyers' access, use --inactive instead.",
      `\`hatchkit stripe sync ${config.project} --mode live --archive-removed\` archives the Stripe product.`,
    );
  } else {
    const previous = config.products?.[key];
    const merged = mergeProduct(opts, previous);
    if (merged.error) {
      result.errors.push(merged.error);
      return result;
    }
    const entryProblems = unlockProductProblems(key, merged.entry);
    if (entryProblems.length) {
      result.errors.push(...entryProblems);
      return result;
    }
    config.products = { ...(config.products ?? {}), [key]: merged.entry as UnlockProduct };
    result.action = previous ? "updated" : "added";
    if (
      previous &&
      JSON.stringify(previous.price) !== JSON.stringify((merged.entry as UnlockProduct).price)
    )
      result.nextSteps.push(
        "A new price takes effect for new buyers after `hatchkit stripe sync`; existing subscriptions keep their old price.",
      );
  }
  const remaining = unlockConfigProblems(config);
  if (remaining.length) {
    result.errors.push(`${result.file}: ${remaining.join("; ")}`);
    return result;
  }
  if (JSON.stringify(config) === before) result.action = "unchanged";
  else if (!dryRun) {
    mkdirSync(dirname(layout.configPath), { recursive: true });
    writeFileSync(layout.configPath, `${JSON.stringify(config, null, 2)}\n`);
  }
  result.products = config.products;
  result.ok = true;
  result.warnings.push(...warningsFor(opts.projectDir, layout, config));
  result.nextSteps.push(...nextStepsFor(opts.projectDir, layout, config.project, key));
  return result;
}

export function printPaidUnlockResult(result: PaidUnlockResult, dryRun: boolean): void {
  if (!result.ok) {
    for (const error of result.errors) console.log(chalk.red(`  ${error}`));
    for (const file of result.conflicted)
      console.log(chalk.yellow(`  ! ${file} was edited; left as is`));
    return;
  }
  const verb = dryRun ? "would write" : "wrote";
  console.log(
    chalk.bold(
      `\n  Paid unlock (${result.runtime})${dryRun ? chalk.dim(" — --dry-run, nothing written") : ""}`,
    ),
  );
  for (const file of result.written) console.log(chalk.green(`  ✓ ${verb} ${file}`));
  for (const file of result.conflicted)
    console.log(chalk.yellow(`  ! ${file} differs from hatchkit's copy (edited?) — left as is`));
  if (result.action === "listed") {
    const keys = Object.keys(result.products);
    console.log(chalk.bold(`\n  Products in ${result.file}:`));
    if (keys.length === 0) console.log(chalk.dim("    none"));
    for (const key of keys) {
      const p = result.products[key];
      const price =
        typeof p.price === "number"
          ? `${(p.price / 100).toFixed(2)}`
          : `from ${(p.price.min / 100).toFixed(2)}`;
      console.log(
        `    ${chalk.cyan(key)}  ${p.name}  ${chalk.dim(`${p.kind}, ${price}${p.interval ? ` / ${p.interval}` : ""}${p.active === false ? ", not for sale" : ""}`)}`,
      );
    }
  } else {
    const what =
      dryRun && result.action !== "unchanged" ? `would be ${result.action}` : result.action;
    console.log(chalk.green(`\n  ✓ ${result.file}: product ${what}`));
  }
  for (const warning of result.warnings) console.log(chalk.yellow(`  ! ${warning}`));
  if (result.nextSteps.length) {
    console.log(chalk.bold("\n  Next:"));
    for (const step of result.nextSteps) console.log(`    · ${step}`);
  }
  console.log("");
}
