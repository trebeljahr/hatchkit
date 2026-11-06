# Marketing assets

Images for the repository README, the GitHub social preview and posts about hatchkit. Every image is made by a script in [`scripts/marketing/`](../../scripts/marketing/) from real CLI output, so the set can be regenerated after the CLI changes. [`manifest.json`](manifest.json) lists each file with its pixel size, bytes and SHA-256.

Brand: the docs site's palette (near-black `#0b0d12`, indigo `#818cf8`, diagonal hatch lines), [Inter](https://fonts.google.com/specimen/Inter) for text and [JetBrains Mono](https://fonts.google.com/specimen/JetBrains+Mono) for terminal text, and the logo mark from [`docs/public/img/logo.svg`](../public/img/logo.svg). The older 1200×630 docs card stays at [`docs/public/img/social-card.png`](../public/img/social-card.png).

## Files

| File | Purpose | Pixels | Made by | Date |
| --- | --- | --- | --- | --- |
| [`screenshots/create-dry-run.png`](screenshots/create-dry-run.png) | README hero. `hatchkit create --dry-run` plan for an example project, `nimbus`. | 2080×2084 | `pnpm marketing:screenshots` | 2026-11-06 |
| [`screenshots/status.png`](screenshots/status.png) | README quickstart. `hatchkit status` on a machine where only GitHub is configured. | 2080×1154 | `pnpm marketing:screenshots` | 2026-11-06 |
| [`screenshots/help.png`](screenshots/help.png) | Command overview: the Getting started and Projects groups of `hatchkit --help`. | 2240×1712 | `pnpm marketing:screenshots` | 2026-11-06 |
| `screenshots/*.txt` | Plain-text copy of what each screenshot shows, for alt text and diffs. | – | `pnpm marketing:screenshots` | 2026-11-06 |
| [`social-preview/social-preview-a.png`](social-preview/social-preview-a.png) | Social preview candidate A: headline beside the `create --dry-run` screenshot. | 1280×640 | `pnpm marketing:social` | 2026-11-06 |
| [`social-preview/social-preview-b.png`](social-preview/social-preview-b.png) | Social preview candidate B: typographic, docs-site brand. | 1280×640 | `pnpm marketing:social` | 2026-11-06 |
| [`social-preview/social-preview-c.png`](social-preview/social-preview-c.png) | Social preview candidate C: light, the setup → create → sync → backup strip. | 1280×640 | `pnpm marketing:social` | 2026-11-06 |
| [`social-preview/template.html`](social-preview/template.html) | Source for the three cards (`?v=a`, `b`, `c`). | 1280×640 | hand-written | 2026-11-06 |

No candidate is uploaded to GitHub yet. Repository Settings → Social preview takes the chosen PNG.

## Regenerate

```bash
pnpm install                 # the screenshots run the CLI from cli/src through tsx
pnpm marketing               # screenshots, then social previews, then manifest.json
```

The scripts need Playwright, which is not a dependency of this repo. Install it once (`npm i -g playwright`) and point `PLAYWRIGHT_MODULE` at its `index.mjs` if Node cannot resolve it. When Playwright's own Chromium is missing, the scripts use the installed Google Chrome, headless. The cards load Inter and JetBrains Mono from Google Fonts, so rendering needs a network connection.

`HATCHKIT_CLI_ROOT` points the screenshots at another checkout's `cli/` (one with `node_modules`). `render-social-preview.mjs --review-dir <dir>` also copies the three cards there with a labelled `review-sheet.jpg`.

## How the screenshots are made

`capture-screenshots.mjs` runs each command in a throwaway sandbox: `HATCHKIT_CONF_DIR` is a fresh temp dir, `HATCHKIT_KEYCHAIN_ACCESS=deny` and `HATCHKIT_LOCAL_DEV=0`. No stored credentials or projects are read, and nothing is written outside the temp dir. `create` runs with `--dry-run`. The one machine-dependent line is the GitHub check, which reads the local `gh` login.

The coloured output is drawn into a terminal frame in the docs-site palette. These display edits are made, and no others:

- the sandbox folder is shown as `~/projects`, the repo as `~/hatchkit` and the sandbox config dir as `~/.config/hatchkit`,
- runs of blank lines are collapsed to one,
- the create shot omits the generated `terraform.tfvars` and Coolify `.env` previews, marked with a dim `⋮`, and the help shot stops after `sync`, also marked `⋮`,
- the create command is wrapped over three lines with `\` continuations.
