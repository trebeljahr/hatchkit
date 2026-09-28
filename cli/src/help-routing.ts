/*
 * Where `--help` is decided.
 *
 * This lives outside `index.ts` on purpose: that module calls `main()`
 * at import time, so nothing in it can be unit-tested. The rule below
 * is the one thing in the router that must be provably right, so it
 * gets its own importable module.
 *
 * The rule exists because `hatchkit provision s3 --help` did not print
 * help. It ran the provisioner: created an R2 bucket, attached a custom
 * domain, applied CORS, minted a scoped R2 account API token and wrote
 * six entries into a project's .env.production. The `provision` case
 * dispatched on `args[1] === "s3"` and never looked at the rest of the
 * argv, and every other per-case `--help` check had the same blind spot
 * for its own subcommands (`keys rotate <p> --help` rotated a keypair,
 * `assets push --help` mirrored to the prod bucket, `ses unverify
 * <addr> --help` deleted an SES identity).
 *
 * So the check happens once, ahead of the dispatch, and therefore also
 * covers commands added later.
 */

/** Every help topic `printHelp` renders. Lives here so the
 *  command→topic table can be typed against it. */
export type HelpTopic =
  | "create"
  | "init"
  | "setup"
  | "config"
  | "update"
  | "server"
  | "keys"
  | "secrets"
  | "add"
  | "adopt"
  | "assets"
  | "remove"
  | "destroy"
  | "rename-domain"
  | "migrate-domain"
  | "rename-project"
  | "set-description"
  | "sync"
  | "regen-infra"
  | "doctor"
  | "dev-setup"
  | "inventory"
  | "overview"
  | "status"
  | "explain"
  | "completion"
  | "gh-pages"
  | "cloudflare"
  | "dns"
  | "plausible"
  | "email";

/** A `--help` or `-h` anywhere in the argv is a request for
 *  documentation, never an instruction to act — it wins over whatever
 *  subcommand it sits next to. No hatchkit flag takes a value, so there
 *  is no `--flag --help` case where the word is an argument rather than
 *  a request. */
export function isHelpRequest(argv: readonly string[]): boolean {
  return argv.some((arg) => arg === "--help" || arg === "-h");
}

/* Commands whose help is a `printHelp` topic. `provision`, `signing`,
 * `release` and `ses` are absent deliberately: they print their own usage blocks,
 * which `index.ts` routes to. Anything unmapped falls back to the root
 * help, which is the right answer for a typo'd command. */
const HELP_TOPIC_BY_COMMAND: Readonly<Record<string, HelpTopic>> = {
  init: "init",
  setup: "setup",
  config: "config",
  status: "status",
  explain: "explain",
  completion: "completion",
  create: "create",
  update: "update",
  server: "server",
  keys: "keys",
  secrets: "secrets",
  add: "add",
  remove: "remove",
  adopt: "adopt",
  destroy: "destroy",
  "rename-domain": "rename-domain",
  "migrate-domain": "migrate-domain",
  "set-description": "set-description",
  "rename-project": "rename-project",
  sync: "sync",
  "regen-infra": "regen-infra",
  doctor: "doctor",
  "dev-setup": "dev-setup",
  overview: "overview",
  inventory: "inventory",
  assets: "assets",
  dns: "dns",
  plausible: "plausible",
  email: "email",
  "gh-pages": "gh-pages",
  cloudflare: "cloudflare",
  // `pages` is the pre-rename alias and shares the topic.
  pages: "gh-pages",
};

export function helpTopicForCommand(command: string | undefined): HelpTopic | undefined {
  return command === undefined ? undefined : HELP_TOPIC_BY_COMMAND[command];
}
