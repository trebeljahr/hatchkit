/*
 * cli/src/secrets/global/prompt.ts — one-off credential prompts.
 *
 * A global rotation may need more rights than hatchkit's stored
 * credential has (the SES IAM user cannot manage its own keys; the
 * ListMonk API user cannot create users). The operator can paste a
 * one-off admin credential instead. It lives in this process's memory
 * for the run and is never written to the keychain, config or disk.
 *
 * Every paste gets feedback right away: its shape (length, characters,
 * stray spaces or quotes) and then, from the caller, the identity it
 * authenticates as. A paste with the wrong shape is refused and asked
 * again; the value itself is never printed.
 */

import { confirm, input, password } from "@inquirer/prompts";
import chalk from "chalk";

interface Prompts {
  input(message: string, fallback?: string): Promise<string>;
  password(message: string): Promise<string>;
  confirm(message: string, fallback: boolean): Promise<boolean>;
}

const defaultPrompts: Prompts = {
  input: (message, fallback) => input({ message, default: fallback }),
  password: (message) => password({ message }),
  confirm: (message, fallback) => confirm({ message, default: fallback }),
};
let prompts: Prompts = defaultPrompts;

/** Test-only: answer prompts without a terminal. */
export function __setPromptsForTesting(partial: Partial<Prompts> | undefined): void {
  prompts = partial ? { ...defaultPrompts, ...partial } : defaultPrompts;
}

/** The expected form of one pasted value. */
export interface PasteShape {
  /** Names the value in feedback lines. */
  what: string;
  /** False for secrets: feedback never echoes them. */
  echo: boolean;
  length?: number;
  minLength?: number;
  /** Matches ONE allowed character. */
  chars: RegExp;
  /** `chars` in words, for the feedback line. */
  charsIn: string;
  /** A format rule beyond length and characters. Returns the problem. */
  extra?: (value: string) => string | undefined;
}

/** ListMonk v4+ mints API tokens as 32 random letters and digits
 *  (`utils.GenerateRandomString(32)`). */
export const LISTMONK_TOKEN_SHAPE: PasteShape = {
  what: "ListMonk API token",
  echo: false,
  length: 32,
  chars: /[A-Za-z0-9]/,
  charsIn: "letters and digits",
};

/** ListMonk's `reUsername`, and at least 3 characters. */
export const LISTMONK_USER_SHAPE: PasteShape = {
  what: "ListMonk user name",
  echo: true,
  minLength: 3,
  chars: /[A-Za-z0-9_.@-]/,
  charsIn: "letters, digits and _ . - @",
};

export const AWS_ACCESS_KEY_ID_SHAPE: PasteShape = {
  what: "AWS access key id",
  echo: true,
  length: 20,
  chars: /[A-Z0-9]/,
  charsIn: "capital letters and digits",
  extra: (v) =>
    v.startsWith("ASIA")
      ? "starts with ASIA: a temporary key, which needs a session token. Paste a long-lived AKIA key"
      : v.startsWith("AKIA")
        ? undefined
        : "does not start with AKIA",
};

export const AWS_SECRET_KEY_SHAPE: PasteShape = {
  what: "AWS secret access key",
  echo: false,
  length: 40,
  chars: /[A-Za-z0-9/+]/,
  charsIn: "letters, digits, / and +",
};

const QUOTES = /["'`‘’“”]/;

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** Describe a pasted value's shape without revealing it. `ok` is false
 *  on any deviation, stray whitespace and quotes included — hatchkit
 *  does not guess which part the operator meant. */
export function checkPasteShape(value: string, shape: PasteShape): { ok: boolean; line: string } {
  const problems: string[] = [];
  const lead = value.length - value.trimStart().length;
  const trail = value.length - value.trimEnd().length;
  const core = value.trim();
  if (lead > 0) problems.push(`${count(lead, "space")} at the start`);
  if (trail > 0) problems.push(`${count(trail, "space")} at the end`);
  const inner = (core.match(/\s/g) ?? []).length;
  if (inner > 0) problems.push(`${count(inner, "space")} inside`);
  const quotes = [...core].filter((c) => QUOTES.test(c)).length;
  if (quotes > 0) problems.push(`${count(quotes, "quote character")}`);
  const others = [...new Set([...core].filter((c) => !/\s/.test(c) && !QUOTES.test(c) && !shape.chars.test(c)))];
  if (others.length > 0) {
    // Characters outside the alphabet are never part of a valid value,
    // so naming them reveals nothing; a letter or digit is never named.
    problems.push(`characters outside ${shape.charsIn}: ${others.map((c) => JSON.stringify(c)).join(" ")}`);
  }
  if (shape.length !== undefined && value.length !== shape.length) {
    problems.push(`${value.length} characters, expected ${shape.length}`);
  } else if (shape.minLength !== undefined && value.length < shape.minLength) {
    problems.push(`${value.length} characters, expected at least ${shape.minLength}`);
  }
  if (problems.length === 0 && shape.extra) {
    const extra = shape.extra(value);
    if (extra) problems.push(extra);
  }

  const label = shape.echo && problems.length === 0 ? `${shape.what} ${value}` : shape.what;
  if (value.length === 0) return { ok: false, line: `${chalk.red("✘")} ${shape.what}: empty` };
  if (problems.length === 0) {
    return { ok: true, line: `${chalk.green("✔")} ${label}: ${count(value.length, "character")}, ${shape.charsIn}` };
  }
  const expected =
    shape.length !== undefined ? `${shape.length} ${shape.charsIn}` : `${shape.charsIn} only`;
  return {
    ok: false,
    line: `${chalk.red("✘")} ${label}: ${problems.join("; ")}. Expected ${expected}.`,
  };
}

/** How often a paste with the wrong shape is asked again. */
export const PASTE_ATTEMPTS = 3;

/** Ask for a one-off credential and print its shape right away. Asks
 *  again on a wrong shape; returns undefined after PASTE_ATTEMPTS, and
 *  the caller refuses to continue. A secret is never echoed. */
export async function promptPasted(label: string, shape: PasteShape): Promise<string | undefined> {
  const message = shape.echo ? `${label}:` : `${label} (used for this run only, never stored):`;
  for (let attempt = 1; attempt <= PASTE_ATTEMPTS; attempt++) {
    const value = shape.echo ? await prompts.input(message) : await prompts.password(message);
    const result = checkPasteShape(value, shape);
    console.log(`  ${result.line}`);
    if (result.ok) return value;
  }
  console.log(`  ${chalk.red("✘")} ${shape.what}: wrong shape ${PASTE_ATTEMPTS} times; stopping.`);
  return undefined;
}

/** `✔ authenticated as …` — printed after a pasted credential reached
 *  the provider and before anything else uses it. */
export function authenticatedLine(who: string, details: string[]): string {
  return `${chalk.green("✔")} authenticated as ${who} (${details.join(", ")})`;
}

/** `✘ …` — a pasted credential the provider did not accept. */
export function rejectedLine(text: string): string {
  return `${chalk.red("✘")} ${text}`;
}

export async function promptYesNo(message: string, fallback: boolean): Promise<boolean> {
  return prompts.confirm(message, fallback);
}

/** First 4 characters and an ellipsis — the most a mask may show. */
export function mask(value: string): string {
  return `${value.slice(0, 4)}…`;
}
