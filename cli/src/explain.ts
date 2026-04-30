/*
 * `hatchkit explain` — one-page mental model. Written so a human with
 * zero context (or an agent encountering hatchkit for the first time)
 * can read it top-to-bottom and understand what the CLI does, what it
 * owns, and the canonical workflow.
 *
 * Update the `CONCEPTS` / `COMMANDS` / `WORKFLOW` blocks in one place
 * and both the human text and the JSON payload stay in sync.
 */

import chalk from "chalk";

interface ExplainModel {
  tagline: string;
  what_it_does: string[];
  concepts: Array<{ name: string; description: string }>;
  commands: Array<{ name: string; summary: string; when: string }>;
  workflow: string[];
  provider_glossary: Array<{ name: string; role: string }>;
  state_locations: Array<{ what: string; where: string }>;
}

const MODEL: ExplainModel = {
  tagline: "Scaffold, deploy, and provision full-stack projects on your own infra.",
  what_it_does: [
    "Scaffolds opinionated full-stack projects (web + optional desktop/mobile + optional ML) from a starter template.",
    "Wires them up to your own infra: Hetzner (server), DNS (Cloudflare/INWX), Coolify (deploys), GitHub (repo).",
    "Provisions per-project clients in third-party services (GlitchTip errors, OpenPanel analytics, Resend email).",
    "Manages per-project dotenvx private keys in your OS keychain.",
  ],
  concepts: [
    {
      name: "Provider",
      description:
        "An external service (GitHub, Hetzner, Coolify, DNS, S3, GPU, GlitchTip, OpenPanel, Resend). Each is configured once; credentials go to the OS keychain, metadata to ~/<conf-dir>/config.json.",
    },
    {
      name: "Project",
      description:
        "A scaffolded repo with a .hatchkit.json manifest. Has a name (kebab-case), a domain, a feature set (desktop/mobile/s3/ml), and per-project ports.",
    },
    {
      name: "Client",
      description:
        "A per-project credential in a provider — e.g. a Resend API key scoped to one project, a GlitchTip DSN, an OpenPanel client id/secret. `hatchkit add` creates `-dev` and `-prod` pairs.",
    },
    {
      name: "Manifest",
      description:
        ".hatchkit.json at the project root. Records which features were scaffolded so `hatchkit update` knows what's already there.",
    },
    {
      name: "dotenvx key",
      description:
        "Per-project private key that decrypts .env.production at runtime. Generated at scaffold time; lives in the OS keychain under service `hatchkit`; pushed to Coolify via `hatchkit keys push`.",
    },
  ],
  commands: [
    {
      name: "hatchkit setup",
      summary: "One-time onboarding — wires up GitHub + Coolify + Hetzner + DNS + optional extras.",
      when: "First time you ever use hatchkit on a machine.",
    },
    {
      name: "hatchkit status",
      summary: "Show which providers are configured and what's the next best step.",
      when: "To get oriented, or after setup to confirm state.",
    },
    {
      name: "hatchkit doctor",
      summary:
        "Live-verify every configured provider with a read-only API call; contextual fix hints on failures.",
      when: "When something's broken, before a deploy, or as a CI sanity check.",
    },
    {
      name: "hatchkit create",
      summary: "Scaffold (and optionally deploy) a new project. Interactive.",
      when: "Starting a new project.",
    },
    {
      name: "hatchkit adopt",
      summary:
        "Bring an existing (non-hatchkit) project under management — detects layout / .env / dotenvx, writes a manifest, imports the dotenvx private key into the keychain, optionally provisions GlitchTip / OpenPanel / Resend.",
      when: "`cd <project-dir>` first; the project wasn't created by hatchkit.",
    },
    {
      name: "hatchkit update",
      summary: "Add features (desktop, mobile) to an already-scaffolded project.",
      when: "`cd <project-dir>` first; expands an existing scaffold.",
    },
    {
      name: "hatchkit add <project>",
      summary:
        "Provision GlitchTip / OpenPanel / Resend clients for an existing project (creates -dev + -prod pair each).",
      when: "After the scaffold is live and you're ready to wire up observability / email.",
    },
    {
      name: "hatchkit keys show <project>",
      summary: "Print the project's DOTENV_PRIVATE_KEY_PRODUCTION from the keychain.",
      when: "To hand the key to CI / another machine / manually paste into Coolify.",
    },
    {
      name: "hatchkit keys push <project>",
      summary: "Upsert the private key onto the project's Coolify app via API.",
      when: "After scaffold + initial Coolify deploy, so the app can decrypt env at runtime.",
    },
    {
      name: "hatchkit config add <provider>",
      summary:
        "Configure one provider (coolify / ghcr / hetzner / dns / s3 / gpu / glitchtip / openpanel / resend / stripe).",
      when: "Rotating a token, or adding an optional provider you skipped during setup.",
    },
    {
      name: "hatchkit explain",
      summary: "This screen. `--json` for a structured payload.",
      when: "Anytime a zero-context reader (human or agent) needs the mental model.",
    },
  ],
  workflow: [
    "1. `hatchkit setup` — configure credentials once (per machine).",
    "2. `hatchkit status` — confirm everything's green.",
    "3. `hatchkit create` — scaffold a new project; pick features, deploy target, ML services.",
    "4. `hatchkit add <project>` — provision per-project clients (GlitchTip, OpenPanel, Resend).",
    "5. `hatchkit keys push <project>` — ship the dotenvx key to Coolify so prod can decrypt.",
    "6. `hatchkit doctor` — sanity-check before/after anything risky.",
    "7. `hatchkit update` (from project dir) — extend an existing project with new features.",
  ],
  provider_glossary: [
    { name: "GitHub", role: "Hosts the project repo. Uses the `gh` CLI for auth." },
    { name: "Coolify", role: "Self-hosted PaaS. Deploys apps on your Hetzner box." },
    { name: "Hetzner Cloud", role: "VMs (and optional S3 object storage) for new deploy targets." },
    { name: "DNS (Cloudflare / INWX)", role: "Automates domain records during Terraform." },
    { name: "S3 (Hetzner / AWS / R2)", role: "Optional object storage — picked per-project." },
    {
      name: "GPU (Modal / RunPod / HF / Replicate)",
      role: "Optional inference backends for ML services.",
    },
    { name: "GlitchTip", role: "Self-hostable Sentry-compatible error tracking." },
    { name: "OpenPanel", role: "Privacy-friendly product analytics." },
    { name: "Resend", role: "Transactional email; keys can be scoped to a sending domain." },
  ],
  state_locations: [
    {
      what: "Provider metadata (no secrets)",
      where: "~/<conf-dir>/config.json via the `conf` package",
    },
    {
      what: "Secrets (tokens, keys)",
      where: "OS keychain under service `hatchkit` (macOS Keychain / libsecret)",
    },
    { what: "Provisioned env blocks", where: "~/<conf-dir>/provisioned/<project>.{dev,prod}.env" },
    { what: "Project manifest", where: "<project-dir>/.hatchkit.json" },
  ],
};

export function renderExplain(opts: { json: boolean }): string {
  if (opts.json) {
    return JSON.stringify(MODEL, null, 2);
  }
  const out: string[] = [];
  const b = (s: string) => chalk.bold(s);
  const dim = (s: string) => chalk.dim(s);

  out.push(b("  hatchkit — the mental model"));
  out.push(`  ${MODEL.tagline}`);
  out.push("");

  out.push(b("  What it does"));
  for (const line of MODEL.what_it_does) out.push(`    · ${line}`);
  out.push("");

  out.push(b("  Concepts"));
  for (const c of MODEL.concepts) {
    out.push(`    ${chalk.cyan(c.name)}`);
    out.push(`      ${c.description}`);
  }
  out.push("");

  out.push(b("  Commands"));
  for (const c of MODEL.commands) {
    out.push(`    ${chalk.cyan(c.name.padEnd(30))} ${c.summary}`);
    out.push(`      ${dim(`when: ${c.when}`)}`);
  }
  out.push("");

  out.push(b("  Canonical workflow"));
  for (const line of MODEL.workflow) out.push(`    ${line}`);
  out.push("");

  out.push(b("  Providers at a glance"));
  for (const p of MODEL.provider_glossary) {
    out.push(`    ${chalk.cyan(p.name.padEnd(32))} ${p.role}`);
  }
  out.push("");

  out.push(b("  Where state lives"));
  for (const s of MODEL.state_locations) {
    out.push(`    ${chalk.cyan(s.what.padEnd(32))} ${s.where}`);
  }
  out.push("");
  out.push(
    dim(
      "  Tip: `hatchkit status --json` and `hatchkit doctor --json` give agents a machine-readable view.",
    ),
  );
  out.push("");
  return out.join("\n");
}
