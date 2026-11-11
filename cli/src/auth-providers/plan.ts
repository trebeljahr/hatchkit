/*
 * `hatchkit auth providers` — the pure half.
 *
 * `hatchkit update --auth-options …` writes the sign-in buttons, and each
 * one stays hidden until its provider's credentials reach the server. Only
 * a person can register those apps: Google, Apple and Discord have no API
 * for it. GitHub has one, the GitHub App manifest flow, and it gives
 * credentials better-auth's GitHub provider can use:
 *
 *  - The provider sends the user to `github.com/login/oauth/authorize`,
 *    exchanges the code at `github.com/login/oauth/access_token`, then reads
 *    `GET /user` and `GET /user/emails` with the token
 *    (`@better-auth/core` `social-providers/github.ts`, 1.6.33). A GitHub
 *    App answers the same endpoints with a user access token.
 *  - `scope` (`read:user user:email`) does not set a GitHub App's
 *    permissions. The App's own permissions do, so the manifest asks for
 *    `email_addresses: read`. Without it `/user/emails` fails, and a user
 *    with a private address signs in with no email at all.
 *  - A private GitHub App can be authorized only by its owner (or the
 *    owning organization's members). The App is public so that anyone can
 *    sign in. It holds no repository permissions, so installing it grants
 *    nothing.
 *  - The App's `redirect_uri` must match a registered callback URL exactly.
 *    better-auth sends `<BETTER_AUTH_URL>/api/auth/callback/github`, which
 *    is the one callback the manifest registers.
 *
 * Everything here is data and checks, so the tests need no terminal,
 * clipboard or network. `command.ts` runs it.
 */

import { createPrivateKey, sign } from "node:crypto";
import type { AuthSecurityOption } from "../features/auth-account-security/types.js";

export type OAuthProviderId = "google" | "apple" | "github" | "discord";

/** Catalogue order: the order the command walks them in. */
export const OAUTH_PROVIDERS: readonly OAuthProviderId[] = ["google", "apple", "github", "discord"];

/** The `authSecurity.options` id whose button each provider fills. */
export const PROVIDER_OPTION: Record<OAuthProviderId, AuthSecurityOption> = {
  google: "google-oauth",
  apple: "apple-oauth",
  github: "github-oauth",
  discord: "discord-oauth",
};

export const PROVIDER_LABEL: Record<OAuthProviderId, string> = {
  google: "Google",
  apple: "Sign in with Apple",
  github: "GitHub",
  discord: "Discord",
};

/** Where each provider's sign-in page lives. The deployed-redirect check
 *  refuses a sign-in URL on any other host. */
export const PROVIDER_AUTH_HOST: Record<OAuthProviderId, string> = {
  google: "accounts.google.com",
  apple: "appleid.apple.com",
  github: "github.com",
  discord: "discord.com",
};

/** Parse `--provider google,apple` (also repeated flags, joined by the
 *  caller). Unknown names are an error that lists the known ones. */
export function parseProviderList(
  values: readonly string[],
): { providers: OAuthProviderId[] } | { error: string } {
  const parts = [
    ...new Set(
      values
        .flatMap((v) => v.split(","))
        .map((p) => p.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (parts.length === 0) {
    return { error: `--provider needs one of: ${OAUTH_PROVIDERS.join(", ")}` };
  }
  const unknown = parts.filter((p) => !(OAUTH_PROVIDERS as readonly string[]).includes(p));
  if (unknown.length > 0) {
    return {
      error: `Unknown --provider value(s): ${unknown.join(", ")}. Known: ${OAUTH_PROVIDERS.join(", ")}`,
    };
  }
  return { providers: OAUTH_PROVIDERS.filter((p) => parts.includes(p)) };
}

/** The providers the project's `authSecurity.options` picked, in
 *  catalogue order. */
export function chosenProviders(options: readonly string[] | undefined): OAuthProviderId[] {
  const picked = new Set(options ?? []);
  return OAUTH_PROVIDERS.filter((p) => picked.has(PROVIDER_OPTION[p]));
}

// ── Values ────────────────────────────────────────────────────────────

export type FieldKey =
  | "GOOGLE_CLIENT_ID"
  | "GOOGLE_CLIENT_SECRET"
  | "APPLE_TEAM_ID"
  | "APPLE_CLIENT_ID"
  | "APPLE_KEY_ID"
  | "APPLE_PRIVATE_KEY"
  | "GITHUB_CLIENT_ID"
  | "GITHUB_CLIENT_SECRET"
  | "DISCORD_CLIENT_ID"
  | "DISCORD_CLIENT_SECRET";

export interface FieldSpec {
  key: FieldKey;
  /** What to copy, in the prompt: "the Client ID". */
  what: string;
  /** Encrypted in `.env.production` and never printed. Client IDs, Team
   *  and Key IDs are not secrets: every sign-in URL carries the client ID. */
  secret: boolean;
  /** Where the value comes from. Every value but Apple's key is copied in
   *  the provider's dashboard and read from the clipboard. */
  source: "clipboard" | "p8-file";
  /** null when the value has the provider's shape, else the problem. */
  check(value: string): string | null;
}

const GOOGLE_CLIENT_ID_RE = /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/;
const GOOGLE_SECRET_RE = /^GOCSPX-[A-Za-z0-9_-]{20,}$/;
/** Team ID and Key ID: ten characters, upper-case letters and digits —
 *  the same check `auth/apple-sign-in.ts` runs at boot. */
export const APPLE_ID_RE = /^[A-Z0-9]{10}$/;
/** A Services ID is a reverse-DNS identifier, like a bundle ID. */
const APPLE_SERVICES_ID_RE = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
/** OAuth app (`Ov23li…`), GitHub App (`Iv23li…`, older `Iv1.<hex>`) and
 *  the oldest OAuth apps' 20 hex characters. */
const GITHUB_CLIENT_ID_RE = /^(?:Iv1\.[0-9a-f]{16}|[A-Za-z0-9]{20})$/;
const GITHUB_SECRET_RE = /^[0-9a-f]{40}$/;
/** A Discord application id is a snowflake. */
const DISCORD_CLIENT_ID_RE = /^\d{17,20}$/;
const DISCORD_SECRET_RE = /^[A-Za-z0-9_-]{32}$/;

function shape(re: RegExp, problem: string): (value: string) => string | null {
  return (value) => (re.test(value) ? null : problem);
}

export const FIELDS: Record<FieldKey, FieldSpec> = {
  GOOGLE_CLIENT_ID: {
    key: "GOOGLE_CLIENT_ID",
    what: "the Client ID",
    secret: false,
    source: "clipboard",
    check: shape(GOOGLE_CLIENT_ID_RE, "expected <digits>-<id>.apps.googleusercontent.com"),
  },
  GOOGLE_CLIENT_SECRET: {
    key: "GOOGLE_CLIENT_SECRET",
    what: "the Client secret",
    secret: true,
    source: "clipboard",
    check: shape(GOOGLE_SECRET_RE, "expected a secret that starts with GOCSPX-"),
  },
  APPLE_TEAM_ID: {
    key: "APPLE_TEAM_ID",
    what: "the Team ID",
    secret: false,
    source: "clipboard",
    check: shape(APPLE_ID_RE, "expected 10 upper-case letters and digits"),
  },
  APPLE_CLIENT_ID: {
    key: "APPLE_CLIENT_ID",
    what: "the Services ID identifier",
    secret: false,
    source: "clipboard",
    check: shape(
      APPLE_SERVICES_ID_RE,
      "expected a reverse-DNS identifier like com.example.app.signin",
    ),
  },
  APPLE_KEY_ID: {
    key: "APPLE_KEY_ID",
    what: "the Key ID",
    secret: false,
    source: "clipboard",
    check: shape(APPLE_ID_RE, "expected 10 upper-case letters and digits"),
  },
  APPLE_PRIVATE_KEY: {
    key: "APPLE_PRIVATE_KEY",
    what: "the .p8 key",
    secret: true,
    source: "p8-file",
    check: checkAppleKey,
  },
  GITHUB_CLIENT_ID: {
    key: "GITHUB_CLIENT_ID",
    what: "the Client ID",
    secret: false,
    source: "clipboard",
    check: shape(GITHUB_CLIENT_ID_RE, "expected a GitHub client ID like Ov23li… or Iv23li…"),
  },
  GITHUB_CLIENT_SECRET: {
    key: "GITHUB_CLIENT_SECRET",
    what: "the client secret",
    secret: true,
    source: "clipboard",
    check: shape(GITHUB_SECRET_RE, "expected 40 hexadecimal characters"),
  },
  DISCORD_CLIENT_ID: {
    key: "DISCORD_CLIENT_ID",
    what: "the Client ID",
    secret: false,
    source: "clipboard",
    check: shape(DISCORD_CLIENT_ID_RE, "expected a numeric application id (17–20 digits)"),
  },
  DISCORD_CLIENT_SECRET: {
    key: "DISCORD_CLIENT_SECRET",
    what: "the Client Secret",
    secret: true,
    source: "clipboard",
    check: shape(DISCORD_SECRET_RE, "expected 32 letters, digits, - or _"),
  },
};

/** The variables each provider needs before its button shows. */
export const PROVIDER_FIELDS: Record<OAuthProviderId, readonly FieldKey[]> = {
  google: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  apple: ["APPLE_TEAM_ID", "APPLE_CLIENT_ID", "APPLE_KEY_ID", "APPLE_PRIVATE_KEY"],
  github: ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
  discord: ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET"],
};

/** The client ID variable the deployed sign-in URL must carry. */
export const CLIENT_ID_FIELD: Record<OAuthProviderId, FieldKey> = {
  google: "GOOGLE_CLIENT_ID",
  apple: "APPLE_CLIENT_ID",
  github: "GITHUB_CLIENT_ID",
  discord: "DISCORD_CLIENT_ID",
};

/** The `.p8` key: a PEM private key on the P-256 curve that can sign an
 *  ES256 JWT. `auth/apple-sign-in.ts` refuses anything else at boot, so
 *  catching it here saves a deploy. Accepts the stored one-line form. */
export function checkAppleKey(value: string): string | null {
  let key: ReturnType<typeof createPrivateKey>;
  try {
    key = createPrivateKey(value.replace(/\\n/g, "\n"));
  } catch {
    return "not a PEM private key";
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    return "not a P-256 key: Sign in with Apple keys are ES256";
  }
  try {
    const signature = sign("sha256", Buffer.from("hatchkit"), { key, dsaEncoding: "ieee-p1363" });
    if (signature.length !== 64) return "the key does not produce an ES256 signature";
  } catch {
    return "the key cannot sign";
  }
  return null;
}

/** The `.p8` file's contents as `APPLE_PRIVATE_KEY`: one line with
 *  literal `\n`, the form the generated `.env.example` documents. */
export function appleKeyEnvValue(pem: string): string {
  return pem
    .replace(/\r\n/g, "\n")
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\\n");
}

/** Apple names the download `AuthKey_<KEY_ID>.p8`. */
export function appleKeyFileName(keyId: string): string {
  return `AuthKey_${keyId}.p8`;
}

// ── Dashboard steps ───────────────────────────────────────────────────

export interface GuideContext {
  /** The deployed origin's host, e.g. app.example.com. */
  domain: string;
  /** The project slug from `.hatchkit.json`. */
  project: string;
  /** `--github-org`: register the GitHub app under this organization. */
  githubOrg?: string;
}

/** One block of dashboard instructions, then the values to read. */
export interface GuideStep {
  title: string;
  lines: string[];
  read: FieldKey[];
}

export function callbackUrl(provider: OAuthProviderId, domain: string): string {
  return `https://${domain}/api/auth/callback/${provider}`;
}

/** `app.example.com` → `com.example.app`: a starting point for the Apple
 *  identifiers, which the operator may change. */
export function reverseDomain(domain: string): string {
  return domain
    .toLowerCase()
    .split(".")
    .filter(Boolean)
    .reverse()
    .map((part) => part.replace(/[^a-z0-9-]/g, "-"))
    .join(".");
}

/** The registrable part Google asks for under "Authorized domains":
 *  the last two labels. Good for `app.example.com`; a domain under a
 *  public suffix with two labels (`example.co.uk`) needs all three, so
 *  the step says so. */
export function topPrivateDomainGuess(domain: string): string {
  const labels = domain.toLowerCase().split(".").filter(Boolean);
  return labels.slice(-2).join(".");
}

export function googleSteps(ctx: GuideContext): GuideStep[] {
  const origin = `https://${ctx.domain}`;
  return [
    {
      title: "Create one Google Cloud project for this app",
      lines: [
        "Open https://console.cloud.google.com/projectcreate",
        `Project name: ${ctx.project}. One project per app keeps each consent screen's name, domain and publishing status separate.`,
        "If Google refuses with a project quota message, ask for more at https://support.google.com/code/contact/project_quota_increase",
        "Select the new project in the console's project picker before the next step.",
      ],
      read: [],
    },
    {
      title: "Branding",
      lines: [
        "Open https://console.cloud.google.com/auth/branding (Get started, if the project has no consent screen yet)",
        `App name: ${ctx.project}. User support email and developer contact: your address.`,
        `App domain → Application home page: ${origin}. Add your privacy policy and terms pages if the app has them.`,
        `Authorized domains: ${topPrivateDomainGuess(ctx.domain)} (all three labels for a domain like example.co.uk).`,
        "Leave the logo empty: uploading one makes Google require brand verification before the consent screen shows it.",
      ],
      read: [],
    },
    {
      title: "Audience: external, published",
      lines: [
        "Open https://console.cloud.google.com/auth/audience",
        "User type: External.",
        "Publishing status: select Publish app, then confirm. In Testing, only listed test users can sign in.",
        "With basic scopes only (openid, email, profile), publishing needs no verification.",
      ],
      read: [],
    },
    {
      title: "Data access: basic scopes only",
      lines: [
        "Open https://console.cloud.google.com/auth/scopes",
        "Add no scopes. better-auth asks for openid, email and profile, which need no review. A sensitive scope sends the app to verification.",
      ],
      read: [],
    },
    {
      title: "Web client",
      lines: [
        "Open https://console.cloud.google.com/auth/clients/create",
        `Application type: Web application. Name: ${ctx.project} web.`,
        `Authorized JavaScript origins: ${origin}`,
        `Authorized redirect URIs: ${callbackUrl("google", ctx.domain)}`,
        "Create. Keep the dialog open: Google shows the client secret in full only now.",
        "Use the copy button next to each value.",
      ],
      read: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    },
  ];
}

export function appleSteps(ctx: GuideContext): GuideStep[] {
  const bundle = reverseDomain(ctx.domain);
  return [
    {
      title: "Team ID",
      lines: [
        "Open https://developer.apple.com/account and find Membership details.",
        "Copy the Team ID (ten characters).",
      ],
      read: ["APPLE_TEAM_ID"],
    },
    {
      title: "App ID with Sign in with Apple",
      lines: [
        "Open https://developer.apple.com/account/resources/identifiers/list",
        "Use your app's App ID if it has one (a Capacitor app: the appId in capacitor.config.ts). Otherwise:",
        "  + → App IDs → App → Continue.",
        `  Description: ${ctx.project}. Bundle ID: Explicit, for example ${bundle}.`,
        "Tick Sign in with Apple under Capabilities, then Continue → Register (or Save).",
      ],
      read: [],
    },
    {
      title: "Services ID",
      lines: [
        "Open https://developer.apple.com/account/resources/identifiers/add/serviceId (or + → Services IDs).",
        `Description: ${ctx.project} web sign-in. Identifier: for example ${bundle}.signin. Continue → Register.`,
        "Open the new Services ID, tick Sign in with Apple, then Configure:",
        "  Primary App ID: the App ID from the previous step.",
        `  Domains and Subdomains: ${ctx.domain}`,
        `  Return URLs: ${callbackUrl("apple", ctx.domain)}`,
        "Next → Done → Continue → Save.",
        "Copy the Services ID's Identifier.",
      ],
      read: ["APPLE_CLIENT_ID"],
    },
    {
      title: "Sign in with Apple key",
      lines: [
        "Open https://developer.apple.com/account/resources/authkeys/add",
        `Key name: ${ctx.project} sign-in. Tick Sign in with Apple → Configure → Primary App ID: the App ID above → Save.`,
        "Continue → Register → Download. Apple lets you download the .p8 file once; leave it in Downloads.",
        "Copy the Key ID (ten characters).",
      ],
      read: ["APPLE_KEY_ID", "APPLE_PRIVATE_KEY"],
    },
    {
      title: "Email relay",
      lines: [
        "Open https://developer.apple.com/account/resources/services/configure",
        "Sign in with Apple for Email Communication → + → add the domain (or address) the app sends mail from.",
        "A user who picks Hide My Email gets an @privaterelay.appleid.com address. Apple forwards mail to it only from registered senders whose domain passes SPF.",
      ],
      read: [],
    },
  ];
}

/** Guided GitHub OAuth app: the fallback when the manifest flow is not
 *  wanted (`--github-oauth-app`) or did not finish. */
export function githubOAuthAppSteps(ctx: GuideContext): GuideStep[] {
  const newApp = ctx.githubOrg
    ? `https://github.com/organizations/${ctx.githubOrg}/settings/applications/new`
    : "https://github.com/settings/applications/new";
  return [
    {
      title: "GitHub OAuth app",
      lines: [
        `Open ${newApp}`,
        `Application name: ${ctx.project}. Homepage URL: https://${ctx.domain}`,
        `Authorization callback URL: ${callbackUrl("github", ctx.domain)}`,
        "Register application, then copy the Client ID.",
      ],
      read: ["GITHUB_CLIENT_ID"],
    },
    {
      title: "Client secret",
      lines: ["Generate a new client secret and copy it. GitHub shows it once."],
      read: ["GITHUB_CLIENT_SECRET"],
    },
  ];
}

export function discordSteps(ctx: GuideContext): GuideStep[] {
  return [
    {
      title: "Discord application",
      lines: [
        "Open https://discord.com/developers/applications → New Application.",
        `Name: ${ctx.project}. Accept the terms → Create. No bot is needed.`,
        "Open OAuth2 in the left menu.",
        `Redirects → Add Redirect: ${callbackUrl("discord", ctx.domain)} → Save Changes.`,
        "Copy the Client ID.",
      ],
      read: ["DISCORD_CLIENT_ID"],
    },
    {
      title: "Client secret",
      lines: ["Reset Secret → confirm, then copy the new secret. Discord shows it once."],
      read: ["DISCORD_CLIENT_SECRET"],
    },
  ];
}

export function providerSteps(provider: OAuthProviderId, ctx: GuideContext): GuideStep[] {
  switch (provider) {
    case "google":
      return googleSteps(ctx);
    case "apple":
      return appleSteps(ctx);
    case "github":
      return githubOAuthAppSteps(ctx);
    case "discord":
      return discordSteps(ctx);
  }
}

// ── GitHub App manifest ───────────────────────────────────────────────

/** GitHub refuses a longer App name. */
export const GITHUB_APP_NAME_MAX = 34;

/** The App's name on GitHub's authorization screen. App names are unique
 *  across GitHub and cannot equal an existing account name, so a bare
 *  project slug is usually taken; GitHub's form lets the operator edit it
 *  before creating. */
export function defaultGithubAppName(project: string): string {
  const name = `${project} sign-in`;
  return name.length <= GITHUB_APP_NAME_MAX ? name : name.slice(0, GITHUB_APP_NAME_MAX).trimEnd();
}

export interface GithubAppManifest {
  name: string;
  url: string;
  description: string;
  hook_attributes: { url: string; active: boolean };
  redirect_url: string;
  callback_urls: string[];
  public: boolean;
  default_permissions: Record<string, "read" | "write">;
  default_events: string[];
  request_oauth_on_install: boolean;
  setup_on_update: boolean;
}

/** A sign-in-only GitHub App: one callback, email addresses read-only, no
 *  repository access, no webhook deliveries. `redirectUrl` is the local
 *  one-shot page GitHub sends the browser back to with the code. */
export function githubAppManifest(args: {
  name: string;
  domain: string;
  redirectUrl: string;
}): GithubAppManifest {
  return {
    name: args.name.slice(0, GITHUB_APP_NAME_MAX),
    url: `https://${args.domain}`,
    description: `Sign in to ${args.domain} with GitHub.`,
    // GitHub requires a URL inside hook_attributes; `active: false` means
    // GitHub never delivers to it.
    hook_attributes: { url: `https://${args.domain}/`, active: false },
    redirect_url: args.redirectUrl,
    callback_urls: [callbackUrl("github", args.domain)],
    public: true,
    default_permissions: { email_addresses: "read" },
    default_events: [],
    request_oauth_on_install: false,
    setup_on_update: false,
  };
}

/** Where the manifest form posts: the personal or organization App page. */
export function githubManifestFormAction(args: {
  webBase: string;
  org?: string;
  state: string;
}): string {
  const base = args.webBase.replace(/\/+$/, "");
  const path = args.org
    ? `/organizations/${encodeURIComponent(args.org)}/settings/apps/new`
    : "/settings/apps/new";
  return `${base}${path}?state=${encodeURIComponent(args.state)}`;
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** The local page that hands the manifest to GitHub. It submits itself;
 *  the button is there for a browser that blocks the script. */
export function githubManifestPage(args: { action: string; manifest: GithubAppManifest }): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Create the GitHub App</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem}</style>
</head>
<body>
<h1>Create the GitHub App</h1>
<p>hatchkit is sending you to GitHub with the App filled in. Check the name, then select <b>Create GitHub App</b>.</p>
<form id="manifest" method="post" action="${htmlEscape(args.action)}">
<input type="hidden" name="manifest" value="${htmlEscape(JSON.stringify(args.manifest))}">
<button type="submit">Continue to GitHub</button>
</form>
<script>document.getElementById("manifest").submit();</script>
</body>
</html>
`;
}

/** The fields hatchkit keeps from `POST /app-manifests/{code}/conversions`.
 *  The response also carries the App's private key (`pem`) and webhook
 *  secret; sign-in needs neither, so they are dropped unread. */
export interface GithubAppCredentials {
  clientId: string;
  clientSecret: string;
  slug?: string;
  htmlUrl?: string;
  owner?: string;
}

export function parseManifestConversion(body: unknown): GithubAppCredentials | { error: string } {
  if (!body || typeof body !== "object") return { error: "GitHub answered with no JSON object" };
  const b = body as Record<string, unknown>;
  if (typeof b.client_id !== "string" || typeof b.client_secret !== "string") {
    const message = typeof b.message === "string" ? b.message : "no client_id/client_secret";
    return { error: `GitHub did not return the App's credentials: ${message}` };
  }
  const owner =
    b.owner &&
    typeof b.owner === "object" &&
    typeof (b.owner as { login?: unknown }).login === "string"
      ? (b.owner as { login: string }).login
      : undefined;
  return {
    clientId: b.client_id,
    clientSecret: b.client_secret,
    ...(typeof b.slug === "string" ? { slug: b.slug } : {}),
    ...(typeof b.html_url === "string" ? { htmlUrl: b.html_url } : {}),
    ...(owner ? { owner } : {}),
  };
}

/** Where the operator manages the App later. */
export function githubAppSettingsUrl(
  creds: GithubAppCredentials,
  org?: string,
): string | undefined {
  if (!creds.slug) return creds.htmlUrl;
  return org
    ? `https://github.com/organizations/${org}/settings/apps/${creds.slug}`
    : `https://github.com/settings/apps/${creds.slug}`;
}

// ── Deployed redirect ─────────────────────────────────────────────────

export interface RedirectCheck {
  provider: OAuthProviderId;
  ok: boolean;
  /** The deployed server has no credentials for the provider yet. */
  notLive: boolean;
  clientId?: string;
  redirectUri?: string;
  problems: string[];
}

/** Read the authorization URL `POST /api/auth/sign-in/social` returned:
 *  it must point at the provider, carry the client ID just stored, and
 *  name this domain's callback as `redirect_uri`. */
export function checkSignInUrl(args: {
  provider: OAuthProviderId;
  url: string;
  domain: string;
  expectedClientId?: string;
}): RedirectCheck {
  const problems: string[] = [];
  let parsed: URL;
  try {
    parsed = new URL(args.url);
  } catch {
    return {
      provider: args.provider,
      ok: false,
      notLive: false,
      problems: ["the server returned no valid sign-in URL"],
    };
  }
  const host = PROVIDER_AUTH_HOST[args.provider];
  if (parsed.hostname !== host) {
    problems.push(`the sign-in URL goes to ${parsed.hostname}, not ${host}`);
  }
  const clientId = parsed.searchParams.get("client_id") ?? undefined;
  const redirectUri = parsed.searchParams.get("redirect_uri") ?? undefined;
  const expectedRedirect = callbackUrl(args.provider, args.domain);
  if (!clientId) problems.push("the sign-in URL has no client_id");
  else if (args.expectedClientId && clientId !== args.expectedClientId) {
    problems.push(
      `the deployed client_id is not the one in .env.production (${CLIENT_ID_FIELD[args.provider]}): sync and redeploy`,
    );
  }
  if (redirectUri !== expectedRedirect) {
    problems.push(
      `redirect_uri is ${redirectUri ?? "missing"}, expected ${expectedRedirect}: check BETTER_AUTH_URL`,
    );
  }
  return {
    provider: args.provider,
    ok: problems.length === 0,
    notLive: false,
    ...(clientId ? { clientId } : {}),
    ...(redirectUri ? { redirectUri } : {}),
    problems,
  };
}

/** The request the check sends: the same one the button sends, minus the
 *  browser. `disableRedirect` makes better-auth answer with JSON. */
export function signInRequest(
  provider: OAuthProviderId,
  domain: string,
): {
  url: string;
  init: RequestInit;
} {
  const origin = `https://${domain}`;
  return {
    url: `${origin}/api/auth/sign-in/social`,
    init: {
      method: "POST",
      headers: { "content-type": "application/json", origin, accept: "application/json" },
      body: JSON.stringify({ provider, callbackURL: "/", disableRedirect: true }),
      redirect: "manual",
    },
  };
}
