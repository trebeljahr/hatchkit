/**
 * One more OAuth 2.0 / OpenID Connect provider, for anything better-auth has
 * no built-in provider for: a company Keycloak, Authentik, Okta, a self-hosted
 * Gitea. Through better-auth's `genericOAuth` plugin.
 *
 * Environment — ON only when the id, the client and an endpoint source are set:
 *
 *   OAUTH_PROVIDER_ID      A lowercase slug, e.g. `keycloak`. The callback is
 *                          /api/auth/oauth2/callback/<id>.
 *   OAUTH_PROVIDER_NAME    The button label, e.g. `Company SSO`.
 *   OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET
 *   OAUTH_DISCOVERY_URL    The OIDC `.well-known/openid-configuration` URL. Or,
 *                          for plain OAuth 2.0, all three of:
 *   OAUTH_AUTHORIZATION_URL, OAUTH_TOKEN_URL, OAUTH_USERINFO_URL
 *   OAUTH_SCOPES           Optional, space-separated. Default `openid email profile`.
 *
 * A second provider is a second entry in the array `genericOAuthPlugin`
 * passes — the plugin takes any number.
 */

import { genericOAuth } from "better-auth/plugins/generic-oauth";

type Env = Readonly<Record<string, string | undefined>>;

export type GenericOAuthProvider = {
  providerId: string;
  name: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  discoveryUrl?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  userInfoUrl?: string;
};

const SLUG_RE = /^[a-z][a-z0-9-]{1,31}$/;

/** The configured provider, or null. A malformed set is logged by name. */
export function genericOAuthProvider(
  env: Env = process.env,
  log: (message: string) => void = (message) => console.error(message),
): GenericOAuthProvider | null {
  const value = (key: string): string => env[key]?.trim() ?? "";
  const providerId = value("OAUTH_PROVIDER_ID");
  if (!providerId) return null;
  if (!SLUG_RE.test(providerId)) {
    log("[auth] OAUTH_PROVIDER_ID must be a lowercase slug such as `keycloak`; generic OAuth is off.");
    return null;
  }
  const clientId = value("OAUTH_CLIENT_ID");
  const clientSecret = value("OAUTH_CLIENT_SECRET");
  const discoveryUrl = value("OAUTH_DISCOVERY_URL");
  const endpoints = {
    authorizationUrl: value("OAUTH_AUTHORIZATION_URL"),
    tokenUrl: value("OAUTH_TOKEN_URL"),
    userInfoUrl: value("OAUTH_USERINFO_URL"),
  };
  const hasEndpoints = Object.values(endpoints).every(Boolean);
  const missing = [
    ...(clientId ? [] : ["OAUTH_CLIENT_ID"]),
    ...(clientSecret ? [] : ["OAUTH_CLIENT_SECRET"]),
    ...(discoveryUrl || hasEndpoints ? [] : ["OAUTH_DISCOVERY_URL"]),
  ];
  if (missing.length > 0) {
    log(`[auth] Generic OAuth is off: ${missing.join(", ")} not set.`);
    return null;
  }
  return {
    providerId,
    name: value("OAUTH_PROVIDER_NAME") || providerId,
    clientId,
    clientSecret,
    scopes: (value("OAUTH_SCOPES") || "openid email profile").split(/\s+/),
    ...(discoveryUrl ? { discoveryUrl } : endpoints),
  };
}

let cached: { provider: GenericOAuthProvider | null } | undefined;

/** The process's provider, read once (so a bad set is logged once). */
export function genericOAuthConfig(): GenericOAuthProvider | null {
  cached ??= { provider: genericOAuthProvider() };
  return cached.provider;
}

/** What the login page may know: the id it calls and the label it shows. */
export function genericOAuthButton(): { id: string; name: string } | null {
  const provider = genericOAuthConfig();
  return provider ? { id: provider.providerId, name: provider.name } : null;
}

/** better-auth's plugin, with no provider registered when none is configured. */
export function genericOAuthPlugin(): ReturnType<typeof genericOAuth> {
  const provider = genericOAuthConfig();
  if (!provider) return genericOAuth({ config: [] });
  const { name: _label, ...config } = provider;
  return genericOAuth({ config: [config] });
}
