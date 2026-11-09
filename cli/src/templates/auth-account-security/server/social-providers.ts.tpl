/**
 * GitHub and Discord sign-in, through better-auth's own social providers.
 *
 * Each provider is ON only when both of its variables are set, the same rule
 * as Google:
 *
 *   GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET    callback /api/auth/callback/github
 *   DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET  callback /api/auth/callback/discord
 *
 * Which providers this project offers at all is `EXTRA_SOCIAL_PROVIDERS` in
 * `sign-in-methods.ts`. Adding one there and here is all it takes; better-auth
 * ships 30-odd providers under the same option shape.
 */

export type ExtraSocialProvider = "github" | "discord";

type Env = Readonly<Record<string, string | undefined>>;

/** The env-variable prefix of each provider's client id and secret. */
const PREFIX: Record<ExtraSocialProvider, string> = {
  github: "GITHUB",
  discord: "DISCORD",
};

function credentials(id: ExtraSocialProvider, env: Env): { clientId: string; clientSecret: string } | null {
  const clientId = env[`${PREFIX[id]}_CLIENT_ID`]?.trim();
  const clientSecret = env[`${PREFIX[id]}_CLIENT_SECRET`]?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** better-auth `socialProviders` entries for the configured providers. */
export function extraSocialProviders(
  ids: readonly ExtraSocialProvider[],
  env: Env = process.env,
): Partial<Record<ExtraSocialProvider, { clientId: string; clientSecret: string }>> {
  const out: Partial<Record<ExtraSocialProvider, { clientId: string; clientSecret: string }>> = {};
  for (const id of ids) {
    const found = credentials(id, env);
    if (found) out[id] = found;
  }
  return out;
}

/** The ids of the configured providers, for the login page. Ids only. */
export function enabledExtraSocialProviders(
  ids: readonly ExtraSocialProvider[],
  env: Env = process.env,
): ExtraSocialProvider[] {
  return ids.filter((id) => credentials(id, env) !== null);
}
