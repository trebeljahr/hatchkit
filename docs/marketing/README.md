# Marketing assets

Images for the repository README, the GitHub social preview and posts about hatchkit. Every image is made by a script in [`scripts/marketing/`](../../scripts/marketing/), so the set can be regenerated after the CLI changes. The screenshots are real CLI output from a sandbox. The social previews are HTML layouts built from real command, provider and env-key names, and round 2's card C embeds one of the screenshots. [`manifest.json`](manifest.json) lists each file with its pixel size, bytes and SHA-256.

Brand: the docs site's palettes (dark: near-black `#0b0d12` with indigo `#818cf8`; light: `#f6f7fb` with indigo `#4f46e5`; diagonal hatch lines on both), [Inter](https://fonts.google.com/specimen/Inter) for text and [JetBrains Mono](https://fonts.google.com/specimen/JetBrains+Mono) for terminal text, and the egg mark (a white cracked egg on an indigo tile, chosen 13 May 2026) from [`docs/public/img/logo.svg`](../public/img/logo.svg), the same drawing as the favicon. The 1200×630 docs card at [`docs/public/img/social-card.png`](../public/img/social-card.png) carries the egg too.

## Files

| File | Purpose | Pixels | Made by | Date |
| --- | --- | --- | --- | --- |
| [`screenshots/create-dry-run.png`](screenshots/create-dry-run.png) | README hero. `hatchkit create --dry-run` plan for an example project, `nimbus`. | 2080×2084 | `pnpm marketing:screenshots` | 2026-11-06 |
| [`screenshots/status.png`](screenshots/status.png) | README quickstart. `hatchkit status` on a machine where only GitHub is configured. | 2080×1154 | `pnpm marketing:screenshots` | 2026-11-06 |
| [`screenshots/help.png`](screenshots/help.png) | Command overview: the Getting started and Projects groups of `hatchkit --help`. | 2240×1712 | `pnpm marketing:screenshots` | 2026-11-06 |
| `screenshots/*.txt` | Plain-text copy of what each screenshot shows, for alt text and diffs. | – | `pnpm marketing:screenshots` | 2026-11-06 |
| [`screenshots/create-secrets.png`](screenshots/create-secrets.png) | Social preview C. A sandboxed `hatchkit create` encrypts `.env.production`, then `hatchkit secrets rotate --dry-run` names its deploy targets. | 1312×916 | `pnpm marketing:screenshots` | 2026-11-06 |
| [`social-preview/social-preview-a.png`](social-preview/social-preview-a.png) | Social preview candidate A, dark. `hatchkit create` fans out to the nine things it sets up, from the GitHub repo to the dotenvx key in the keychain. | 1280×640 | `pnpm marketing:social` | 2026-11-06 |
| [`social-preview/social-preview-b.png`](social-preview/social-preview-b.png) | Social preview candidate B, light. The per-project setup list (repo, DNS, server, app, database, backups, DSN, DKIM, API user, bucket token, auth secret, encryption, deploy secrets), every item ticked by `hatchkit create`. | 1280×640 | `pnpm marketing:social` | 2026-11-06 |
| [`social-preview/social-preview-c.png`](social-preview/social-preview-c.png) | Social preview candidate C, dark. "Your secrets, committed as ciphertext." beside `screenshots/create-secrets.png`. | 1280×640 | `pnpm marketing:social` | 2026-11-06 |
| [`social-preview/social-preview-d.png`](social-preview/social-preview-d.png) | Social preview candidate D, light. Six secrets, what makes each one and where hatchkit delivers it. | 1280×640 | `pnpm marketing:social` | 2026-11-06 |
| [`social-preview/social-preview-a3-1.png`](social-preview/social-preview-a3-1.png) | Round 3 candidate A3-1, dark. Card A with the text cut to labels: the wordmark, the `hatchkit create` pill and nine nodes, each a thing and its provider (Repo/GitHub, DNS/Cloudflare, Server/Hetzner, App/Coolify, Error tracking/GlitchTip, Analytics/Plausible, Email/Listmonk + SES, Backups/R2, Secrets/dotenvx). | 1280×640 | `pnpm marketing:social` | 2026-11-07 |
| [`social-preview/social-preview-a3-2.png`](social-preview/social-preview-a3-2.png) | Round 3 candidate A3-2, dark. A3-1 plus one line under the wordmark: "Automates the drudgery of starting a new project". | 1280×640 | `pnpm marketing:social` | 2026-11-07 |
| [`social-preview/social-preview-a3-3.png`](social-preview/social-preview-a3-3.png) | Round 3 candidate A3-3, light. A3-2 in the light palette. | 1280×640 | `pnpm marketing:social` | 2026-11-07 |
| [`social-preview/template.html`](social-preview/template.html) | Source for every card: round 2 `?v=a`, `b`, `c`, `d`; round 3 `?v=a3-1`, `a3-2`, `a3-3`. | 1280×640 | hand-written | 2026-11-07 |
| [`social-preview/og-wordmark.png`](social-preview/og-wordmark.png) | og:image. Card A3-2 laid out at 1.91:1 with a larger egg mark and wordmark and a larger line, broken after "starting". The pill sits lower and the wires fan out later, so they clear the text. | 1200×630 | `pnpm marketing:social --og` | 2026-11-12 |
| [`social-preview/og-clean.png`](social-preview/og-clean.png) | og:image without text. A3-2's `hatchkit create` pill and nine nodes, no wordmark or line, the glow behind the pill. | 1200×630 | `pnpm marketing:social --og` | 2026-11-11 |
| [`social-preview/og-clean.html`](social-preview/og-clean.html) | Source for `og-clean.png`. | 1280×672 | hand-written | 2026-11-11 |

Round 3 follows the pick of card A, with its headline, paragraph, URL and node descriptions removed. No candidate is uploaded to GitHub yet. Repository Settings → Social preview takes the chosen PNG.

## Regenerate

```bash
pnpm install                 # the screenshots run the CLI from cli/src through tsx
pnpm marketing               # screenshots, then social previews, then manifest.json
```

The scripts need Playwright, which is not a dependency of this repo. Install it once (`npm i -g playwright`) and point `PLAYWRIGHT_MODULE` at its `index.mjs` if Node cannot resolve it. When Playwright's own Chromium is missing, the scripts use the installed Google Chrome, headless. The cards load Inter and JetBrains Mono from Google Fonts, so rendering needs a network connection.

`HATCHKIT_CLI_ROOT` points the screenshots at another checkout's `cli/` (one with `node_modules`). `render-social-preview.mjs --og` renders only the two og:image cards; a run without `--round` renders them too. They are laid out at 1280×672 CSS px, shot at 2× and downscaled to exactly 1200×630 with ImageMagick, so `magick` must be installed (`brew install imagemagick`). `render-social-preview.mjs --round 3` renders only one round's cards. `--round <n> --review-dir <dir>` also copies that round's cards there as `social-preview-a.png`, `-b.png` and so on, with a labelled `review-sheet.jpg`.

The docs site's link preview, `docs/app/opengraph-image.jpg` (and the identical `twitter-image.jpg`, each with an `.alt.txt`), is `og-wordmark.png` as JPEG:

```bash
magick docs/marketing/social-preview/og-wordmark.png -strip -interlace Plane -sampling-factor 4:4:4 -quality 88 docs/app/opengraph-image.jpg && cp docs/app/opengraph-image.jpg docs/app/twitter-image.jpg
```

## How the screenshots are made

`capture-screenshots.mjs` runs each command in a throwaway sandbox: `HATCHKIT_CONF_DIR` is a fresh temp dir, `HATCHKIT_KEYCHAIN_ACCESS=deny` and `HATCHKIT_LOCAL_DEV=0`. No stored credentials or projects are read, and nothing is written outside the temp dir. `create` runs with `--dry-run`. The one machine-dependent line is the GitHub check, which reads the local `gh` login.

The secrets shot (`create-secrets.png`) scaffolds a real project, so it needs a keychain. It loads the CLI test suite's fixture keychain (`cli/test-support/setup.mjs`), which keeps every key in files inside the sandbox. The OS keychain is never read or written, so the CLI's "stored in macOS Keychain" line refers to that fixture store. The run uses `--deployment-mode scaffold-only --no-github --no-install`, so no provider is called. A source checkout's `create` writes `infra/stacks/nimbus.env` and a `nimbus.tfvars`. The script refuses to start if either exists and deletes both afterwards. The encrypted values on the card are random sandbox values whose key is deleted with the sandbox.

The coloured output is drawn into a terminal frame in the docs-site palette. These display edits are made, and no others:

- the sandbox folder is shown as `~/projects`, the repo as `~/hatchkit` and the sandbox config dir as `~/.config/hatchkit`,
- runs of blank lines are collapsed to one,
- the create shot omits the generated `terraform.tfvars` and Coolify `.env` previews, marked with a dim `⋮`, and the help shot stops after `sync`, also marked `⋮`,
- the secrets shot keeps two lines of the `create` output (the encryption count and the keychain line) and the first four lines of the `secrets rotate` plan, marked `⋮`,
- long commands are wrapped with `\` continuations.

## Where the card claims come from

Every name on the cards is a command, provider or env key in this repo. The places to check them:

| Claim | Source |
| --- | --- |
| `create` creates the repo, Terraform DNS and Hetzner server, the Coolify app and database, and registers daily R2 backups (round 3: Repo, DNS, Server, App, Backups) | `cli/src/index.ts` (create steps 3–6), `cli/src/deploy/coolify-mongo.ts`, `cli/src/backups/register.ts` |
| It mints the GlitchTip DSN, Plausible site, Listmonk API user, SES DKIM and the bucket-scoped R2 token, and writes them encrypted into `.env.production` (round 3: Error tracking, Analytics, Email, Secrets) | `cli/src/provision/index.ts` (`writeProdEnv`), `glitchtip.ts`, `plausible.ts`, `listmonk-ses.ts`, `s3.ts` |
| The dotenvx key goes to the keychain, each Coolify app and the `DOTENV_PRIVATE_KEY_PRODUCTION` Actions secret | `cli/src/scaffold/dotenvx.ts`, `cli/src/deploy/keys.ts` |
| Each Coolify app gets its own 32-byte deploy secret in GitHub Actions, and no Coolify API token goes to the repo | `cli/src/deploy/coolify-deploy-hook.ts`, `cli/src/deploy/gh-actions-secrets.ts` |
| The DSN reaches Coolify `SENTRY_DSN` before the first push | `cli/src/provision/glitchtip-delivery.ts` |
| `secrets rotate` replaces GlitchTip DSNs, R2 tokens and local app secrets and pushes to Coolify and GitHub | `cli/src/secrets/registry.ts`, `docs/content/docs/secrets-rotation.mdx` |
| The live card's line "Automates the drudgery of starting a new project" (chosen 2026-11-07): `create` runs the repo, DNS, server, app, email, analytics, error-tracking, backup and secrets setup and scaffolds the TypeScript monorepo in `starter/` and deploys it to Coolify on a server you own | `starter/`, `cli/src/index.ts` (create steps 1 and 6) |

What the cards leave out: provider tokens are entered once, at `hatchkit setup`, and a project with the Stripe feature asks for its Stripe keys during `create`. A provider that is not configured becomes a deferred step with its follow-up command.

The live GitHub social preview is `social-preview-a3-2.png` (uploaded 2026-11-07). The cards here were re-rendered on 2026-11-12 with the egg mark in place of the earlier hatched-square logo; the uploaded copy still shows the old logo until it is uploaded again.
