# Marketing assets

Images for the repository README, the GitHub social preview and posts about hatchkit. Every image is made by a script in [`scripts/marketing/`](../../scripts/marketing/), so the set can be regenerated after the CLI changes. The screenshots are real CLI output from a sandbox. The social previews are HTML layouts built from real command, provider and env-key names, and card C embeds one of the screenshots. [`manifest.json`](manifest.json) lists each file with its pixel size, bytes and SHA-256.

Brand: the docs site's palettes (dark: near-black `#0b0d12` with indigo `#818cf8`; light: `#f6f7fb` with indigo `#4f46e5`; diagonal hatch lines on both), [Inter](https://fonts.google.com/specimen/Inter) for text and [JetBrains Mono](https://fonts.google.com/specimen/JetBrains+Mono) for terminal text, and the logo mark from [`docs/public/img/logo.svg`](../public/img/logo.svg). The older 1200×630 docs card stays at [`docs/public/img/social-card.png`](../public/img/social-card.png).

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
| [`social-preview/template.html`](social-preview/template.html) | Source for the four cards (`?v=a`, `b`, `c`, `d`). | 1280×640 | hand-written | 2026-11-06 |

No candidate is uploaded to GitHub yet. Repository Settings → Social preview takes the chosen PNG.

## Regenerate

```bash
pnpm install                 # the screenshots run the CLI from cli/src through tsx
pnpm marketing               # screenshots, then social previews, then manifest.json
```

The scripts need Playwright, which is not a dependency of this repo. Install it once (`npm i -g playwright`) and point `PLAYWRIGHT_MODULE` at its `index.mjs` if Node cannot resolve it. When Playwright's own Chromium is missing, the scripts use the installed Google Chrome, headless. The cards load Inter and JetBrains Mono from Google Fonts, so rendering needs a network connection.

`HATCHKIT_CLI_ROOT` points the screenshots at another checkout's `cli/` (one with `node_modules`). `render-social-preview.mjs --review-dir <dir>` also copies the four cards there with a labelled 2×2 `review-sheet.jpg`.

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
| `create` creates the repo, Terraform DNS and Hetzner server, the Coolify app and database, and registers daily R2 backups | `cli/src/index.ts` (create steps 3–6), `cli/src/deploy/coolify-mongo.ts`, `cli/src/backups/register.ts` |
| It mints the GlitchTip DSN, Plausible site, Listmonk API user, SES DKIM and the bucket-scoped R2 token, and writes them encrypted into `.env.production` | `cli/src/provision/index.ts` (`writeProdEnv`), `glitchtip.ts`, `plausible.ts`, `listmonk-ses.ts`, `s3.ts` |
| The dotenvx key goes to the keychain, each Coolify app and the `DOTENV_PRIVATE_KEY_PRODUCTION` Actions secret | `cli/src/scaffold/dotenvx.ts`, `cli/src/deploy/keys.ts` |
| Each Coolify app gets its own 32-byte deploy secret in GitHub Actions, and no Coolify API token goes to the repo | `cli/src/deploy/coolify-deploy-hook.ts`, `cli/src/deploy/gh-actions-secrets.ts` |
| The DSN reaches Coolify `SENTRY_DSN` before the first push | `cli/src/provision/glitchtip-delivery.ts` |
| `secrets rotate` replaces GlitchTip DSNs, R2 tokens and local app secrets and pushes to Coolify and GitHub | `cli/src/secrets/registry.ts`, `docs/content/docs/secrets-rotation.mdx` |

What the cards leave out: provider tokens are entered once, at `hatchkit setup`, and a project with the Stripe feature asks for its Stripe keys during `create`. A provider that is not configured becomes a deferred step with its follow-up command.
