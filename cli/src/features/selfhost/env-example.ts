/*
 * `.env.selfhost.example` — the smallest set of values that gets the
 * self-host stack to boot, and nothing else.
 *
 * Why a separate example rather than the project's own `.env.example`:
 * the project's one is written for a developer with the whole monorepo
 * checked out and for the owner's deploy, and it carries dozens of keys
 * for services a self-hoster does not run. A stranger reading it cannot
 * tell which five values they actually have to fill in, guesses, and
 * ends up with a stack that starts and then refuses every sign-in.
 *
 * So this file lists exactly what the compose file reads: the domain,
 * the session secret, the image version, the datastore URLs, the trust
 * switches and the optional mail settings. Required values are marked as
 * such, and the compose file backs them with `${VAR:?message}` so a
 * missing one stops `up` with a sentence instead of booting a server
 * that will fail later in a way nobody can trace back here.
 */

import type { OperationalProject } from "../operational-context.js";
import { hasServerHalf } from "../operational-context.js";
import { type SelfHostOptions, ownedFileHeader, selfHostPlan } from "./compose.js";
import { trustSwitches } from "./trust.js";

export const SELFHOST_ENV_EXAMPLE_REL = ".env.selfhost.example";

/** Which part of the stack a value belongs to. */
export type SelfHostEnvGroup = "domain" | "secret" | "image" | "datastore" | "trust" | "mail";

export interface SelfHostEnvKey {
  key: string;
  group: SelfHostEnvGroup;
  /** True when `up` fails without it. Mirrors the `${VAR:?}` forms in
   *  the compose file — the two must agree, or a value documented as
   *  optional stops the stack. */
  required: boolean;
  /** Value written into the example file. Empty for a secret: a
   *  plausible-looking placeholder is worse than a blank, because it
   *  boots. */
  example: string;
  /** Comment lines above it, without the leading `#`. */
  comment: readonly string[];
}

/**
 * Every value the self-host stack reads, in file order.
 *
 * Derived from the project: the datastore URLs follow the datastores the
 * project actually uses, the version key follows the project name, and
 * the trust switches follow its features.
 */
export function selfHostEnvKeys(
  project: OperationalProject,
  opts: SelfHostOptions = {},
): SelfHostEnvKey[] {
  if (!hasServerHalf(project.surfaces)) return [];
  const plan = selfHostPlan(project, opts);
  const keys: SelfHostEnvKey[] = [
    {
      key: "APP_DOMAIN",
      group: "domain",
      required: true,
      example: project.domain,
      comment: [
        "The hostname people type in the browser. Bare host, no scheme and",
        "no path. It is also the certificate the proxy requests, so the",
        "A/AAAA record for it has to point at this machine before the first",
        "request.",
      ],
    },
    {
      key: "APP_URL",
      group: "domain",
      required: false,
      example: "",
      comment: [
        "The full origin, when it is not simply https://$APP_DOMAIN. It must",
        "be spelled EXACTLY as it appears in the address bar: the origin",
        "check is a literal string comparison, so https://example.com and",
        "https://www.example.com are two different deployments as far as the",
        "session cookie is concerned, and so are http://localhost and",
        "http://127.0.0.1.",
      ],
    },
    {
      key: "BETTER_AUTH_SECRET",
      group: "secret",
      required: true,
      example: "",
      comment: [
        "Signs every session. Generate one and keep it:",
        "",
        "  openssl rand -base64 32",
        "",
        "Changing it signs everybody out. Leave it blank here and the stack",
        "refuses to start rather than booting with a guessable default.",
      ],
    },
    {
      key: plan.versionKey,
      group: "image",
      required: false,
      example: plan.version,
      comment: [
        "Which published release to run. A release tag, not a moving one —",
        `"which version am I running" has to have an answer. Changing it and`,
        "running `up -d` again pulls the new images and restarts.",
      ],
    },
  ];

  if (plan.datastores.includes("mongo")) {
    keys.push({
      key: "MONGODB_URI",
      group: "datastore",
      required: false,
      example: "",
      comment: [
        `Leave empty to use the mongo container in the stack`,
        `(mongodb://mongo:27017/${project.name}). Set it to point at a managed`,
        "database instead, credentials included — the local service then goes",
        "unused and can be removed from the compose file.",
      ],
    });
  }
  if (plan.datastores.includes("redis")) {
    keys.push({
      key: "REDIS_URL",
      group: "datastore",
      required: false,
      example: "",
      comment: [
        "Leave empty to use the redis container in the stack",
        "(redis://redis:6379). Set it to point at a managed instance instead.",
      ],
    });
  }

  for (const sw of trustSwitches(project, opts)) {
    keys.push({
      key: sw.key,
      group: "trust",
      required: false,
      example: sw.default,
      comment: sw.comment,
    });
  }

  keys.push(
    {
      key: "LISTMONK_URL",
      group: "mail",
      required: false,
      example: "",
      comment: [
        "Optional. With the mail settings empty nothing is sent and every",
        "message is written to the server log instead — `docker compose -f",
        "docker-compose.selfhost.yml logs server` is then how you get a",
        "password-reset link. The app works without mail.",
      ],
    },
    { key: "LISTMONK_API_USER", group: "mail", required: false, example: "", comment: [] },
    { key: "LISTMONK_API_TOKEN", group: "mail", required: false, example: "", comment: [] },
    { key: "LISTMONK_TX_TEMPLATE_ID", group: "mail", required: false, example: "", comment: [] },
    {
      key: "LISTMONK_FROM_EMAIL",
      group: "mail",
      required: false,
      example: "",
      comment: ["The address mail is sent from. Required by the others, unused without them."],
    },
  );

  return keys;
}

const GROUP_HEADINGS: Record<SelfHostEnvGroup, string> = {
  domain: "Your domain — REQUIRED",
  secret: "The session secret — REQUIRED",
  image: "Which version to run",
  datastore: "Datastores — override only to use something outside this stack",
  trust: "Which clients may sign in",
  mail: "Mail — optional",
};

/** Render the example file. Copied to `.env` by the install steps, which
 *  is the file compose reads by default. */
export function renderSelfHostEnvExample(
  project: OperationalProject,
  opts: SelfHostOptions = {},
): string {
  const keys = selfHostEnvKeys(project, opts);
  const lines: string[] = [
    ...ownedFileHeader(),
    `# Environment for the ${project.name} self-host stack.`,
    "#",
    "#   cp .env.selfhost.example .env",
    "#   $EDITOR .env",
    "#   docker compose -f docker-compose.selfhost.yml up -d",
    "#",
    "# Compose reads `.env` from this directory, so the copy is what counts.",
    "# Two values have to be filled in; everything else has a working",
    "# default and can stay as it is.",
  ];
  let group: SelfHostEnvGroup | null = null;
  for (const key of keys) {
    if (key.group !== group) {
      group = key.group;
      lines.push(
        "",
        `# ── ${GROUP_HEADINGS[group]} ${"─".repeat(Math.max(1, 58 - GROUP_HEADINGS[group].length))}`,
      );
    }
    lines.push("");
    for (const line of key.comment) lines.push(line ? `# ${line}` : "#");
    if (key.required) lines.push("# REQUIRED — the stack refuses to start without it.");
    lines.push(`${key.key}=${key.example}`);
  }
  return `${lines.join("\n")}\n`;
}
