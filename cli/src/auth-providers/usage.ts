/*
 * Help text for `hatchkit auth`. Its own module so `index.ts` can print it
 * without loading the command (and its HTTP server, dotenvx and prompts).
 */

export const AUTH_USAGE = `Usage:
  hatchkit auth providers [dir] [--provider google,apple,github,discord] [--dry-run] [--json]
  hatchkit auth providers [dir] --verify [--provider …] [--json]

Takes the OAuth sign-in buttons that \`hatchkit update --auth-options …\` wrote from
hidden to live. Each button stays hidden until its provider's credentials reach the
server; this command registers or walks through each provider's app and stores the
values in the project's .env.production.

  GitHub    A GitHub App through GitHub's manifest flow: confirm once on github.com,
            and the client ID and secret come back over the API. Sign-in only: one
            callback, read access to email addresses, no repository access, no
            webhook. Public, because a private App can only be authorized by its
            owner. --github-oauth-app walks through a classic OAuth app instead.
  Google    No API. One Cloud project per app, branding without a logo (a logo
  Apple     forces brand verification), published to production, basic scopes only,
  Discord   one web client. Apple: Team ID, App ID, Services ID with its return URL,
            the .p8 key and the email relay. The command prints each dashboard URL
            and the values to paste there.

Each value is read from the clipboard when you press Enter (pbpaste; never echoed),
checked for the provider's shape, and the clipboard is emptied. Client IDs are
stored plain, secrets encrypted with dotenvx. Apple's AuthKey_<KEY_ID>.p8 is read
from ~/Downloads and moved to the Trash once stored. Nothing is written for a
provider until all its values are in.

Then it offers \`hatchkit sync --deploy\` and checks the deployed sign-in: one
POST /api/auth/sign-in/social per provider, comparing the returned URL's client_id
and redirect_uri (https://<domain>/api/auth/callback/<provider>).

Options:
  [dir]                   Project directory (default: the current directory).
  --provider <list>       Only these providers. Default: every OAuth provider in the
                          manifest's authSecurity.options.
  --dry-run               Print the steps, the GitHub App manifest and the variables
                          each provider would write. Writes nothing, opens nothing.
  --verify                Only check the deployed sign-in (better-auth stores a
                          short-lived OAuth state row per request; nothing else).
  --replace               Ask again for providers whose variables are already set.
  --github-oauth-app      GitHub: guided OAuth app steps instead of the manifest flow.
  --github-org <org>      GitHub: register under this organization.
  --github-app-name <n>   GitHub: the App's name (default "<project> sign-in", at most
                          34 characters; GitHub's form lets you change it).
  --no-sync               Do not offer \`hatchkit sync --deploy\` at the end.
  --json                  With --dry-run or --verify: print JSON.
`;
