# Authoring a feature

A **feature** is a unit of scaffolding a user can choose: `hatchkit create`
offers it, and `hatchkit update` can add it to an already-scaffolded project
later. This document is the contract a feature has to meet, and the shared
mechanism that meets most of it for you.

The mechanism lives in `cli/src/features/contract.ts` and
`cli/src/features/templates.ts`. The worked example is `cli/src/features/signing/`.

---

## The two invariants

Everything else in this document follows from these.

### Additive

A feature adds; it never removes. By the time `update` runs, the project is
somebody's working repository, and hatchkit cannot tell the difference between
scaffolding it wrote and code the user built on top of that scaffolding.
`hatchkit update` therefore refuses feature *removal* outright
(`cli/src/scaffold/update.ts`) and says so rather than doing something clever.

### Idempotent

Applying a feature to a project that already has it changes nothing and reports
nothing as written.

This is not tidiness. `update` re-applies every selected feature on **every**
run, so a feature that is not idempotent corrupts the project a little more each
time — a second copy of an import, a script reverted to the starter's version, a
config block appended twice. The failure is cumulative and silent.

Every primitive in `FeatureLedger` compares before it writes. A feature that
reaches around them for a bare `writeFileSync` breaks the guarantee *and* the
dry run, and nothing will catch it.

---

## The shape of the codebase you are adding to

Three facts about hatchkit surprise most people writing their first feature.

### 1. `create` renders no templates. It copies the starter and subtracts.

`hatchkit create` copies `starter/` wholesale into the output directory and then
mutates the copy (`cli/src/scaffold/app.ts`). The starter ships **every**
feature; selecting a feature means its files are *not deleted*.

That inversion has a sharp edge: **a deletion almost always needs a paired
call-site stripper.** Removing `packages/server/src/ws/` leaves
`packages/server/src/index.ts` importing `./ws/handler.js`, which is a hard
TS2307 on the user's first `pnpm build`. The existing strippers —
`stripWebSocketFromServerIndex`, `stripStripeFromServer`,
`stripNewsletterFromServerApp`, `stripMobileBridgeFromLayout` — all exist for
that reason. If your feature ships source that something else imports
unconditionally, you owe a stripper too.

### 2. `starter/` and `cli/src/templates/` serve different commands.

|  | `starter/` | `cli/src/templates/` |
| --- | --- | --- |
| Consumed by | `create` (and `update`, which copies out of it) | `adopt`, `signing`, anything operating on a repo hatchkit did not create |
| Form | a real, buildable, type-checked monorepo | template files with placeholders |
| Why | a human can open and run it before any scaffold happens | there is no starter copy to take from — the content must be synthesized per project |

Put files in `starter/` when they must exist as working source. Put them in
`cli/src/templates/<feature>/` when your feature also has to run against a repo
that was never scaffolded from the starter — which is exactly why `signing`,
whose three GitHub Actions workflows could have lived in
`starter/.github/workflows/`, keeps them under `cli/src/templates/signing/`
instead.

Two gotchas:

- **`cli/package.json`'s `files` list ships `dist`, not `starter/`.** A template
  file parked outside `cli/src/templates/` is missing from the published
  package, and the failure only appears on a user's machine.
  `cli/scripts/copy-templates.mjs` copies the whole `src/templates` tree into
  `dist/` recursively, so a new directory under it needs no registration — but
  it must be under it.
- **`cli/src/templates/{base,addons,ml-clients}/` are dead.** Nothing references
  them. Do not copy their Handlebars conventions; they are not how anything
  currently works.

### 3. Two placeholder syntaxes, for two different reasons.

| Syntax | Where | Why |
| --- | --- | --- |
| `{{name}}` | `starter/` files | The starter is plain TypeScript/JSON and `{{…}}` collides with nothing there. Substituted by literal `replaceAll` — see `substituteIdentifierTokens` in `cli/src/scaffold/identifiers.ts`. |
| `__HATCHKIT_NAME__` | `cli/src/templates/` files | Workflows are full of `${{ secrets.FOO }}` and Apple plists carry `__APPLE_TEAM_ID__` placeholders that CI substitutes with `sed` *later*. A mustache pass would mangle the first; a naive pass would eat the second. See `renderTemplateString` in `cli/src/features/templates.ts`. |

Both leave an unknown token **in place** rather than substituting an empty
string, so a partial render is detectable by grepping for the marker instead of
shipping a plausible-looking file with a hole in it.

---

## Never derive a name

A feature does not compute a bundle id, a storage prefix, a header name, a
client id, a database name or an env-var prefix. It reads them from
`ctx.identifiers`, which comes from the manifest.

Those names are contracts the moment anything is stored or published — see the
header of `cli/src/scaffold/identifiers.ts`. This rule exists because hatchkit
used to break it: four call sites each ran
`config.name.replace(/[^a-z0-9]/gi, "").toLowerCase()` and the signing feature
ran a fifth, different rule, so a project could be offered a bundle id that
disagreed with the one already in its own files.

If your feature needs a name that does not exist yet, add it to
`ProjectIdentifiers` with a validator and a migration. Do not derive it locally.

---

## Writing the feature

### Layout

```
cli/src/features/<name>/
  index.ts          the feature definition + its apply()
  <name>.ts         whatever the feature actually does
  types.ts          its own config types, if it persists any
cli/src/templates/<name>/
  ...               template assets, if any
cli/test-<name>.ts  its tests
```

### The definition

```ts
import { type FeatureContext, registerFeature } from "../contract.js";

export const myFeature = registerFeature({
  id: "my-feature",
  title: "My feature",
  summary: "One line, shown under the label in the picker.",
  requires: ["desktop"],
  surfaces: ["fullstack", "split"],
  addableAfterScaffold: true,
  apply(ctx: FeatureContext) {
    ctx.ledger.writeIfChanged(".github/workflows/my-feature.yml", rendered);
  },
});
```

`apply` receives everything it needs and writes only through `ctx.ledger`:

| field | what it is |
| --- | --- |
| `projectDir` | the deployable directory, already resolved through `projectSubdir` |
| `manifestDir` | where `.hatchkit.json` lives (the same directory for a root-deployed project) |
| `manifest` | the project manifest |
| `identifiers` | the frozen identifier set — see above |
| `mode` | `"create"` or `"update"` |
| `ledger` | every mutation goes through this |
| `log` | progress output, in both real and dry runs |

### Declaring a prerequisite

`requires: ["desktop"]` is enforced, not documentation.
`expandFeatureSelection` pulls prerequisites into the selection automatically and
orders the apply so a prerequisite runs first, which means `apply` may assume
everything it requires has already applied **in the same run**.

Prefer that over a runtime check. "If the desktop feature happens to be on, also
do X" puts one feature's knowledge inside another feature's code, and it goes
stale the next time either one changes.

`conflictsWith` is for features that produce the same artefact in incompatible
ways. It is reported as a selection error rather than resolved by a precedence
rule: hatchkit does not get to decide which of two things the user asked for
they actually meant.

Ordering is a topological sort with registration order as the tie-break, so the
same selection always applies in the same sequence. Two features that both edit
one file produce a different result depending on who goes first, and a run whose
order varies produces a diff that varies for no reason.

### `addableAfterScaffold`

Set it to `false` when your feature's scaffold-time effect is a coarse strip of
files across the tree that cannot be cleanly reversed. `update` then says so and
skips, instead of half-applying. `websocket`, `stripe`, `analytics` and `s3` are
in this position today.

---

## Editing a file the user also edits

This is where features break projects. Pick the weakest primitive that does the
job.

| Primitive | Use when | Re-run safe | Safe over user edits |
| --- | --- | --- | --- |
| `writeIfChanged(rel, content)` | the feature **owns** the file outright | yes | **no** — it overwrites |
| `ensureManagedBlock(rel, id, body)` | the file is shared; the feature owns a region of it | yes | yes, outside the markers |
| `ensureLine(rel, line)` | one line in an ignore-file-shaped file | yes | yes |
| `mergePackageJson(rel, patch)` | adding scripts or dependencies | yes | yes — a differing value is a reported conflict, not an overwrite |
| `edit(rel, fn)` | anything else | only if `fn` is a fixed point | depends on `fn` |

### Owned files

`writeIfChanged` overwrites. That is correct for a file the feature generates
and regenerates — a workflow, a generated config — and wrong for anything a user
might reasonably edit, because their change disappears on the next `update`. An
owned file should say it is owned, in a header comment.

### Managed blocks

```
# hatchkit:begin desktop-scripts
# Managed by hatchkit — edits between these markers are overwritten.
…
# hatchkit:end desktop-scripts
```

Outside the markers belongs to the user and is never touched. Inside belongs to
hatchkit and is replaced wholesale on each apply — which is the point: it lets a
later CLI version *change* what the feature contributed without duplicating it
or guessing which surrounding lines were once its own. A user who needs to
change a line inside the block moves it out.

One surviving marker is reported as a `conflict` rather than repaired. Guessing
where the missing partner belonged would delete user lines.

### Fixed-point edits

`edit(rel, fn)` requires `fn(fn(x)) === fn(x)`. In practice: anchor on what the
edit **produces**, not on where it goes. Check for the result before inserting,
not merely for the insertion point — otherwise the second run inserts a second
copy.

### package.json

`mergePackageJson` is add-only. Absent entries are added; identical ones are
left alone; **differing ones are reported and not overwritten**, because a
changed script is the single most common thing a user customises, and silently
reverting it on every `update` is the worst form of this bug: it undoes their
work without ever failing. Pass `force` only when the value is genuinely
hatchkit's to set.

Check `ctx.ledger.conflicts()` and surface what you did not apply.

---

## `--dry-run`

`--dry-run` is checked in `FeatureLedger` and nowhere else. A feature never asks
whether this is a dry run: it calls the same methods either way, and the ledger
decides whether to touch the disk, recording `would-write` / `would-remove`
instead of `written` / `removed`.

That is deliberate. When every writer checked its own flag, adding a writer meant
remembering to check, and the ones that forgot were discovered by a dry run that
changed the user's files.

Print from `ctx.ledger.summary()`; the `would-*` entries carry the same
information as their real counterparts, so one code path renders both modes.

> The pre-existing `scaffoldDryRun` in `cli/src/scaffold/app.ts` predates this and
> is a hand-maintained parallel list of prose that re-derives every decision from
> `config` a second time. It has no structural connection to the real scaffold
> and drifts from it. Do not add to it; use the ledger.

---

## Registering the feature

The registry in `contract.ts` is the goal, not yet the whole story. A feature
that must appear in the `--features` flag and both interactive pickers still has
to be listed in a few places that predate the registry:

1. `cli/src/prompts.ts` — the `Feature` union.
2. `cli/src/utils/flags.ts` — `KNOWN_FEATURES`, which drives both `--features`
   parsing and the help text.
3. `cli/src/prompts.ts` — the `Features` multiselect in `collectProjectConfig`.
4. `cli/src/prompts.ts` — the **second** multiselect, in the review/edit-section
   flow. Two independent lists that have to stay in sync.
5. `cli/src/scaffold/app.ts` — the scaffold-time strip, plus its paired
   call-site stripper if the feature ships imported source.
6. `cli/src/scaffold/claude-md.ts` — `activeConditions`, so the generated
   `CLAUDE.md` can gate a section on `<!-- hatchkit:if <name> -->`.
7. `cli/src/scaffold/surfaces.ts` — `CLIENT_SIDE_TOP_LEVEL` and `NATIVE_SCRIPTS`
   if the feature ships top-level files or root scripts. This duplicates the
   strip in `app.ts` on purpose ("backend + desktop is a contradiction we don't
   bother validating; the strip just wins"), so a feature missing here survives
   a `backend` / `static` prune.
8. `cli/src/scaffold/update.ts` — `SUPPORTED_ADDITIONS`, `allOptions`, and the
   dispatch to your `apply`.
9. `cli/src/adopt.ts` — dependency sniffing and adopt's own multiselect.
10. `cli/src/scaffold/native-origins.ts` — only if the feature introduces a new
    document origin.
11. Help and docs: `cli/src/index.ts`, `cli/src/explain.ts`,
    `docs/content/docs/commands.mdx`, `SKILL.md` **and its two copies** under
    `.claude/skills/hatchkit/` and `.agents/skills/hatchkit/`.

Four separate hardcoded feature lists and three copies of the skill file is the
reason `FeatureDefinition` exists. Register your feature in the registry, add it
to the lists above, and when the registry can drive one of those lists, delete
the list.

### Manifest fields

`cli/src/scaffold/manifest.ts` has one rule, stated at the top of the file: the
manifest is committed to the user's repo, so **every field is eventually
public**, and `toManifest` is the single choke point that picks the safe subset.
The default for a new field is to *not* include it. Credentials, server
coordinates, and infrastructure cost signals never go in.

A new field needs a `MANIFEST_VERSION` bump and a migration in
`readManifestWithMigrationInfo` that seeds it for older manifests. Seed what the
old CLI *actually produced*, not what the current rule would produce — see the
v4 → v5 identifier migration for why: proposing a different bundle id for a
project with a registered App ID is exactly the failure being prevented.

### Alternative: a bolt-on subsystem

`signing` is deliberately **not** a `Feature`. It has its own verb
(`hatchkit signing …`), its own manifest block, and it runs against repos
hatchkit never scaffolded. That costs six registration points instead of eleven.

Choose it when the thing is not a scaffold-time choice at all — when it applies
to any repo, is re-run rather than "added", and has its own lifecycle.

---

## Testing

Tests are plain `tsx` scripts with a hand-rolled `assert`, not a framework.

```ts
let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (!cond) { failed++; console.error(`  ✗ ${msg}`); }
}

const root = mkdtempSync(join(tmpdir(), "my-feature-"));
try {
  // … build a fake project on disk, run the feature, assert …
  process.exit(failed === 0 ? 0 : 1);
} finally {
  rmSync(root, { recursive: true, force: true });
}
```

Register the file by appending `&& tsx test-<name>.ts` to the `test` script in
`cli/package.json`, and add a `test:<name>` entry so it can be run alone. There
is no discovery — an unregistered test file never runs.

Cover at least these four. They are the ones that catch the failures this
document is about:

1. **Idempotency.** Apply twice; the second run must report zero written.
   `cli/test-signing-workflow-writer.ts` is the model.
2. **Dry run.** Apply with `dryRun: true` against a project snapshot; assert the
   disk is byte-identical afterwards and the ledger reports `would-write`.
3. **User edits survive.** Apply, edit a file the feature touches *outside* its
   managed block, apply again, assert the edit is still there. For
   `mergePackageJson`, change a script and assert the feature reports a conflict
   rather than reverting it.
4. **No unrendered tokens.** `findUnrenderedTokens` over every template your
   feature ships, and `findUnsubstitutedIdentifierTokens` over every starter
   file it substitutes. A literal `__HATCHKIT_FOO__` in a user's repo is a
   template that outgrew its token list.

If your feature declares `requires`, also assert that selecting it alone pulls
the prerequisite in and orders it first — `expandFeatureSelection` returns both
`ordered` and `implied`.

Then:

```bash
pnpm --filter hatchkit run check
```

which is typecheck + lint + the whole test chain.
