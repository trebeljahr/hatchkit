/*
 * cli/src/secrets/global/prompt.ts — one-off credential prompts.
 *
 * A global rotation may need more rights than hatchkit's stored
 * credential has (the SES IAM user cannot manage its own keys; the
 * ListMonk API user cannot create users). The operator can paste a
 * one-off admin credential instead. It lives in this process's memory
 * for the run and is never written to the keychain, config or disk.
 */

import { confirm, input, password } from "@inquirer/prompts";

/** Ask for a secret without echoing it. Shows only its length back. */
export async function promptOneOffSecret(label: string): Promise<string> {
  for (;;) {
    const value = (await password({ message: `${label} (used for this run only, never stored):` }))
      .replace(/\s+/g, "")
      .trim();
    if (value) return value;
  }
}

export async function promptOneOffInput(label: string, fallback?: string): Promise<string> {
  return (await input({ message: `${label}:`, default: fallback })).trim();
}

export async function promptYesNo(message: string, fallback: boolean): Promise<boolean> {
  return confirm({ message, default: fallback });
}

/** First 4 characters and an ellipsis — the most a mask may show. */
export function mask(value: string): string {
  return `${value.slice(0, 4)}…`;
}
