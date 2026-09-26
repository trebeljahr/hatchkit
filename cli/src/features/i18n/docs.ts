/*
 * cli/src/features/i18n/docs.ts — Write `docs/i18n.md` into the project.
 *
 * The generated code carries its own WHY in file headers; this file
 * carries the decisions no single file owns, and that a reader six
 * months later will otherwise re-litigate:
 *
 *   · which surfaces deliberately stay in one language, and the reason
 *     for each — the list is the feature's boundary, and without the
 *     reasoning somebody "finishes the job" and breaks an integration;
 *   · how a NEW surface gets a catalog without inventing a second
 *     resolution rule;
 *   · why the root has no `[locale]` segment;
 *   · the first-paint sequence and what breaks in each direction;
 *   · the byte-identical shared-helper contract.
 *
 * It is derived from the config, not a static asset, because a project
 * without public pages or without server catalogs must not be told to
 * maintain them. `starter/CLAUDE.md`'s i18n block is the short form for
 * an agent; this is the long form for a person.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { localeMeta } from "./locales.js";
import { PSEUDO_EXPANSION_RATIO } from "./plan.js";
import type { I18nConfig } from "./types.js";

export interface WriteI18nDocsInput {
  projectDir: string;
  config: I18nConfig;
  pkgScope: string;
  appName: string;
}

export interface WriteI18nDocsResult {
  /** Project-relative, for the audit. */
  relPath: string;
  /** Absolute, for a terminal line the user can click. */
  path: string;
  status: "written" | "unchanged";
}

const DOCS_REL = "docs/i18n.md";

export function writeI18nProjectDocs(input: WriteI18nDocsInput): WriteI18nDocsResult {
  const body = renderI18nDocs(input);
  const path = join(input.projectDir, DOCS_REL);
  const status = writeIfChanged(path, body);
  return { relPath: DOCS_REL, path, status };
}

/** Exposed separately so a test can assert on the text without a
 *  temporary directory. */
export function renderI18nDocs(input: WriteI18nDocsInput): string {
  const { config, pkgScope, appName } = input;
  const src = config.sourceLocale;
  const targets = config.targetLocales;
  const primary = targets[0] ?? src;
  const all = [src, ...targets];
  const label = (code: string) => `${localeMeta(code).englishName} (\`${code}\`)`;
  const L: string[] = [];

  L.push(
    `# Internationalisation`,
    ``,
    `${appName} ships in ${all.map(label).join(" and ")}. The source language is`,
    `${label(src)}: every key exists there first, every prerendered HTML file`,
    `contains it, and every fallback ends there.`,
    ``,
    `Everything client-side lives in \`packages/client/src/i18n/\`. The resolver and`,
    `the byte-stable formatters live in \`packages/shared/src/\` because more than`,
    `one surface needs them.`,
    ``,
    `\`\`\`ts`,
    `const t = useT("app");                  // inside a client component`,
    `t("dashboard.summary", { count });      // key AND ICU arguments are typed`,
    `translate("common")("errors.generic");  // outside React, resolved at call time`,
    `const f = useFormat();                  // f.date / f.money / f.duration / …`,
    `\`\`\``,
    ``,
    `## The library, and the one we did not use`,
    ``,
    `\`useT\` is \`createTranslator\` from \`use-intl/core\` bound to a vanilla store in`,
    `\`i18n/store.ts\`. Nothing from use-intl's React half is imported, so there is no`,
    `provider to mount: every component test that existed before this feature still`,
    `renders unchanged, in ${label(src)}.`,
    ``,
    `A routing-based library (\`next-intl\` and friends) was not an option. Its locale`,
    `negotiation is \`middleware.ts\`, and this project builds with \`output: "export"\``,
    `for the native shells — a static export has no middleware to run.`,
    ``,
    `## Catalogs`,
    ``,
    `One file per namespace per locale. Namespaces: ${config.namespaces.map((n) => `\`${n}\``).join(", ")}.`,
    ``,
    `- \`messages/${src}/<ns>.ts\` is the source: a \`const\` object \`as const\`, whose`,
    `  literal types are what type-check both keys and ICU arguments.`,
    ...targets.map(
      (t) =>
        `- \`messages/${t}/<ns>.ts\` is annotated \`Translation<typeof source>\`, so a` +
        ` missing, misspelled or extra key is a \`tsc\` error.`,
    ),
    `- \`messages/index.ts\` is the only file that lists the namespaces. Nothing else`,
    `  may enumerate them.`,
    `- \`${config.namespaces[0] ?? "common"}\` is shared vocabulary. Edit it deliberately, never in passing:`,
    `  one word there is on every screen.`,
    ``,
    `\`catalog-parity.test.ts\` covers the three failures the types cannot see:`,
    ``,
    `1. **A renamed ICU argument.** \`{count}\` translated as \`{anzahl}\` type-checks`,
    `   and renders the brace literally on the page.`,
    `2. **Broken ICU** in either locale — an unbalanced brace throws at render time,`,
    `   in one language only, on whichever screen nobody opened.`,
    `3. **A whole source sentence left in place.** Byte-identical to the source and`,
    `   sentence-shaped. Brand names and single words like "OK" are exempt through`,
    `   the allow-list the test documents; extend that list rather than the rule.`,
    ``,
    ...targets.map(
      (t) => `Terms and voice for \`${t}\`: \`i18n/GLOSSARY.${t}.md\`. Decide a word there once.`,
    ),
    ``,
    `## The preference is synced, the language is resolved per device`,
    ``,
    `\`preferences.locale\` is \`${["system", ...all].map((v) => `"${v}"`).join(" | ")}\`, stored beside \`theme\` on the`,
    `profile and carried both ways by \`<LocaleSync>\`.`,
    ``,
    `**The server never resolves \`"system"\`.** It has no device to ask, so it stores`,
    `the word and nothing more. One account therefore reads ${label(primary)} on a`,
    `${localeMeta(primary).englishName} phone and ${label(src)} on a`,
    `${localeMeta(src).englishName} laptop, which is the behaviour a person expects`,
    `from a device setting.`,
    ``,
    `\`matchLocaleList\` in \`${pkgScope}/shared\` is THE resolver: primary subtag,`,
    `first supported entry of the caller's ordered list, source locale otherwise.`,
    `Every other surface calls it. A second resolution rule anywhere is a bug —`,
    `two rules disagree, and the disagreement shows up as a first paint in the`,
    `wrong language.`,
    ``,
    `The local mirror is \`localStorage\` (like the theme), read synchronously. An`,
    `async read cannot work: the answer is needed before the first paint, and`,
    `anything awaited has already painted. A phone evicting the mirror costs one`,
    `gated frame, not data — the synced value comes back with the profile.`,
    ``,
    `## The first paint, and what breaks in each direction`,
    ``,
    `This is the part that fails silently, so it is pinned by three tests rather`,
    `than by review. Every HTML file outside a language prefix is prerendered in`,
    `${label(src)}, and hydration has to match it.`,
    ``,
    `The sequence on a cold load for a reader whose language is ${label(primary)}:`,
    ``,
    `1. \`LOCALE_SCRIPT\` (\`app/pre-paint.ts\`, inlined first in \`<head>\`) resolves`,
    `   the language, sets \`<html lang>\` and \`data-locale\`, and — because the`,
    `   answer is not ${label(src)} — sets \`data-locale-pending\` on \`<html>\`.`,
    `2. \`globals.css\` hides \`[data-locale-gate]\`, the wrapper inside \`<body>\`.`,
    `   The page has layout and no visible text.`,
    `3. React hydrates. \`useLocale()\` answers ${label(src)} by construction —`,
    `   \`useSyncExternalStore\`'s server snapshot — so the tree matches the served`,
    `   markup exactly.`,
    `4. \`<LocaleRoot>\`'s \`useLayoutEffect\` activates the store and removes the`,
    `   pending attribute, in that order, in one flush. An update scheduled from a`,
    `   layout effect is flushed before the browser paints, so the first frame the`,
    `   reader ever sees is already translated.`,
    ``,
    `What breaks in each direction, and which test catches it:`,
    ``,
    `- **Rendering the reader's language during hydration** is a text mismatch.`,
    `  React reports it once and then "fixes" it by discarding the served DOM — the`,
    `  whole page is rebuilt client-side over one date separator.`,
    `  \`locale-root.test.tsx\` hydrates real prerendered markup and fails on any`,
    `  \`console.error\`. Never read the locale during render from anywhere but the`,
    `  store.`,
    `- **The script and the store disagreeing.** Then the gate lifts on the wrong`,
    `  language, or waits for a switch that never comes and the reader stares at an`,
    `  invisible page. \`pre-paint.test.ts\` runs both over the same matrix of`,
    `  stored preference × \`navigator.languages\` × path and asserts they agree row`,
    `  by row. Change one, change the other in the same commit.`,
    `- **The gate on \`<body>\` or \`<html>\`.** Two problems at once: a script that`,
    `  mutates \`<body>\` before hydration makes its attributes disagree with the`,
    `  served HTML, and hiding those elements hides the prerendered per-language`,
    `  pages, which had nothing to wait for. The gate is always an element inside`,
    `  \`<body>\`.`,
    `- **A chunk that never loads.** The failsafe in the script removes the`,
    `  attribute after ${config.gateFailsafeMs} ms regardless. A page in the source`,
    `  language beats an invisible one.`,
    ``,
    `Native shells need nothing extra: they load the same export and the same`,
    `script, and \`navigator.languages\` is the device language.`,
    ``,
    `## Formatting: one module, and the byte-identical contract`,
    ``,
    `Every \`Intl.*\` construction in the client goes through \`i18n/format.ts\`.`,
    `\`format.test.ts\` greps the client source for bare \`toLocale*\` calls and fails`,
    `on a new one, because \`toLocaleString(undefined)\` follows the BROWSER's`,
    `language rather than the reader's choice — it looks right on the machine of`,
    `whoever wrote it and is wrong for everyone whose device does not match their`,
    `preference.`,
    ``,
    `Formatting uses the rendered language with the DEVICE's region, which is why`,
    `an en-GB device keeps "21 Aug" and a de-AT device keeps „Jänner“. The region`,
    `is withheld until the store is activated, for the same reason the language is:`,
    `the prerendered markup was formatted with no device to ask.`,
    ``,
    `**\`formatDuration\`, \`formatDurationShort\` and \`formatDecimal\` in**`,
    `**\`${pkgScope}/shared\` are byte-identical to their pre-i18n output when**`,
    `**called with no locale.** That is a contract, not an accident:`,
    ``,
    `- exported data and any CLI that parses it read the no-locale form;`,
    `- the server has no reader to format for, so it uses the no-locale form;`,
    `- a test with a hardcoded expected string somewhere else in the repo would`,
    `  otherwise fail the day a language is added.`,
    ``,
    `\`format-duration.test.ts\` asserts the no-locale output against a hardcoded`,
    `table and asserts that the localised call differs. Pass a locale only where a`,
    `person reads the result. \`parseDecimalInput\` accepts comma and dot alike, so`,
    `an imported file written on a German machine parses.`,
    ``,
    `## What deliberately stays in one language`,
    ``,
    `Two registers, with two different reasons. Neither list is an oversight, and`,
    `both are worth re-reading before "finishing" the localisation.`,
    ``,
    `### Anything a machine reads`,
    ``,
    `A machine has no language. Translating one of these does not make a sentence`,
    `read better, it breaks a caller — and the break lands in the integration, days`,
    `later, not in the commit:`,
    ``,
    `- **Exported data**: column headers and exported values. A consumer's parser`,
    `  keys on the header string, and a spreadsheet already localises its own`,
    `  display of a number.`,
    `- **Importers.** Whatever the export writes, the import must read. The one`,
    `  concession is numeric input: comma and dot are both accepted, because a`,
    `  person typed it.`,
    `- **Error codes and \`problem+json\` \`type\` values.** The code is the API, the`,
    `  message beside it is the copy. A client switching on a translated code is a`,
    `  client that works in one language.`,
    `- **Webhook payloads**, and the field names of every API response. Same rule:`,
    `  a payload is read by software.`,
    `- **The WebSocket protocol** in \`${pkgScope}/shared/protocol.ts\`. Message`,
    `  types are identifiers, not copy.`,
    `- **API documentation**, environment variable names, log lines, and`,
    `  \`data-testid\` attributes (the E2E selectors — a translated selector is a`,
    `  test suite that fails in the other language).`,
    `- **The locale codes themselves.** \`${all.join("`, `")}\`.`,
    ``,
    `### Surfaces whose platform will not take a second language`,
    ``,
    `The test is not "could it be translated" but "is there an API that follows the`,
    `account preference, and will the store accept the result":`,
    ``,
    `- **Store listings and the installed app's display name.** The native bundle`,
    `  identifier and product name are one string each in`,
    `  \`src-tauri/tauri.conf.json\` / \`android/…/strings.xml\` / the Xcode project.`,
    `  A second language there means per-language store assets and a review round`,
    `  per locale, which is a release decision, not a code change.`,
    `- **Any surface whose host has no locale API.** A platform that picks the`,
    `  language from its own UI setting cannot honour an account preference, and a`,
    `  store that accepts one language cannot publish a second. Such a surface`,
    `  stays in ${label(src)} deliberately, and **never passes a locale to the`,
    `  shared duration or decimal helpers** — that is what the byte-identical`,
    `  contract above is for.`,
    `- **Third-party dashboards** (analytics, error reporting). Their language is`,
    `  their own setting, and nothing in this repo can set it.`,
    ``,
    `When you add a surface, write its verdict into this section with the reason.`,
    `A list without reasons gets "corrected" by the next person.`,
    ``,
    `## Adding a surface that needs its own catalog`,
    ``,
    `An extension, a separate widget, a second app — any surface outside`,
    `\`packages/client\` that shows the reader sentences. Four steps, and the order`,
    `matters:`,
    ``,
    `1. **Give it its own catalog directory**, one file per namespace per locale,`,
    `   with the target annotated \`Translation<typeof source>\` from`,
    `   \`${pkgScope}/shared\`. Do not import the client's catalogs: a surface with`,
    `   different screens needs different messages, and sharing them means every`,
    `   string ships to both.`,
    `2. **Resolve from the synced preference**, through \`resolveLocale\` from`,
    `   \`${pkgScope}/shared\`. Not the platform's own UI language: a browser`,
    `   extension API such as \`chrome.i18n\` follows the BROWSER's interface`,
    `   language, which cannot be told about the account preference — the reader`,
    `   who set ${label(primary)} in ${appName} would get ${label(src)} in the`,
    `   extension and have no way to fix it.`,
    `3. **Mirror the preference locally and synchronously** (\`localStorage\`, or`,
    `   whatever the platform's synchronous store is), exactly like the client`,
    `   does. The surface has to render in the right language on its FIRST frame;`,
    `   an async read of the synced value has already painted. The mirror is a`,
    `   cache, the synced value is the truth, and the sync runs after the paint.`,
    `4. **Extend the parity test** to the new catalogs. The algorithm is in the`,
    `   existing test; point it at the new directory.`,
    ``,
    `A platform manifest that needs a translated name (an extension's name and`,
    `description, say) is a separate mechanism from this one: it is read by the`,
    `store at install time, not by your code at render time. Keep it to the`,
    `manifest and leave the resolution rule alone.`,
    ``,
  );

  if (config.publicPages) {
    L.push(
      `## Public pages: one build per language`,
      ``,
      `${label(src)} at \`/\`, ${targets.map((t) => `${label(t)} under \`/${t}/\``).join(", ")}.`,
      `Each \`app/<locale>/**/page.tsx\` is a one-line re-export of a shared page`,
      `component in \`components/marketing/pages/\` with the locale passed in, so the`,
      `HTML a crawler fetches is already translated. \`marketingT(locale)\` translates`,
      `at build time; \`marketingMetadata\` adds the canonical link, the \`hreflang\``,
      `alternates and \`og:locale\`; \`localizedPath\` keeps internal links inside the`,
      `language; \`<MarketingShell>\` wraps the page in \`<FixedLocale>\`, which pins`,
      `the language and exempts the page from the gate — it never follows the`,
      `preference, because the file's text cannot change.`,
      ``,
      `**Why not a \`[locale]\` dynamic segment at the root.** Two reasons, both`,
      `structural:`,
      ``,
      `- It competes with the application's own routes. \`/settings\` would match`,
      `  \`[locale]\` as well as the real route, and which one wins is a resolution`,
      `  order nobody should have to remember.`,
      `- It turns every unknown path into a page. \`/definitely-not-a-page\` matches`,
      `  \`[locale]\`, so the reader gets a marketing page in a language that does not`,
      `  exist instead of a not-found — and a crawler indexes it.`,
      ``,
      `An explicit prefix per language has neither problem: the routes exist or they`,
      `do not.`,
      ``,
      `Two limits of a static export to keep in mind on these pages:`,
      ``,
      `- The served \`<html lang>\` is the source locale even under a language`,
      `  prefix, because one root layout serves every route. The content wrapper`,
      `  carries the right \`lang\`, and the pre-paint script fixes the root`,
      `  attribute before paint. Moving \`<html lang>\` per language means a second`,
      `  root layout, which means moving every route into a group.`,
      `- **Never put a date or a time into an ICU argument on a prerendered page.**`,
      `  It is formatted on the build machine, in the build machine's time zone,`,
      `  and that value is then baked into the file every reader downloads.`,
      ``,
      `Auth and application routes are NOT prefixed: \`/${primary}/login/\` does not`,
      `exist. Mailed links point at the unprefixed paths, and those screens follow`,
      `the preference at runtime anyway. \`localizedPath\` is for public pages only.`,
      ``,
    );
  }

  if (config.serverCatalogs) {
    L.push(
      `## Email and documents are localised per document`,
      ``,
      `\`packages/server/src/i18n/\` holds the server catalogs and \`serverT(locale,`,
      `ns)\`: the same \`createTranslator\` core, no React.`,
      ``,
      `**A document's language is snapshotted at issue time and never recomputed.**`,
      `Store the resolved locale on the row beside every other figure on it. A`,
      `re-render must never change the language of a document somebody already`,
      `holds — a PDF re-issued in another language reads as a different document,`,
      `and the person who has the first copy cannot tell which one is authoritative.`,
      ``,
      `Resolution order, in \`server/i18n/resolve.ts\`:`,
      ``,
      `- **Email**: the recipient's explicit preference, then the sender's (for an`,
      `  address with no account yet), then ${label(src)}.`,
      `- **Documents**: an explicit override, then the subject's preference, then`,
      `  the issuer's, then ${label(src)}.`,
      ``,
      `\`"system"\` is not an answer on the server — see above. The model field for a`,
      `snapshotted document locale deliberately has no default: a row that predates`,
      `the feature was issued in ${label(src)} and stays that way.`,
      ``,
      `Parity over the server catalogs plus both precedence tables:`,
      `\`packages/server/src/tests/i18n-catalog.test.ts\`.`,
      ``,
    );
  }

  if (config.pseudoLocale) {
    L.push(
      `## Pseudo-locale`,
      ``,
      `\`?locale=pseudo\` turns it on and persists it; \`?locale=off\` clears it. It is`,
      `derived from the source catalog at runtime: accented, bracketed, and about`,
      `${Math.round(PSEUDO_EXPANSION_RATIO * 100)}% longer.`,
      ``,
      `- **Derived, not a catalog.** Text that was never extracted stays`,
      `  unaccented, which is the point: the untranslated string is visible on the`,
      `  screen instead of waiting for a translator to notice it.`,
      `- **Longer on purpose.** A label that clips under the pseudo-locale clips in`,
      `  a real translation. Fix the layout, do not shorten the translation.`,
      `- **Absent from a production build.** The branch is behind a condition on`,
      `  \`process.env.NODE_ENV\` in a position the bundler folds, so a production`,
      `  \`LOCALE_SCRIPT\` contains no trace of it.`,
      `- It needs one line in a development build to register itself:`,
      `  \`import "@/i18n/pseudo";\` anywhere in the client graph. With nothing`,
      `  registered the switch renders the source language, which is the right`,
      `  failure for a development-only tool.`,
      ``,
    );
  }

  L.push(
    `## Adding a language`,
    ``,
    `1. Add the code to \`SUPPORTED_LOCALES\` in \`packages/shared/src/locale.ts\`,`,
    `   with its endonym and its default Intl region. The picker shows the`,
    `   endonym — a reader who cannot read the current interface language still`,
    `   recognises their own.`,
    `2. Copy \`messages/${src}/\` to \`messages/<code>/\`, annotate each file`,
    `   \`Translation<typeof source>\`, and translate. \`tsc\` names every key you`,
    `   miss.`,
    `3. Wire the catalogs into \`messages/index.ts\` at the \`hatchkit:locale-imports\``,
    `   marker. The record is total, so a language in \`SUPPORTED_LOCALES\` with no`,
    `   catalog is a compile error that names the language — not a language that`,
    `   silently renders in ${label(src)}.`,
    `4. Add the value to \`updateProfileSchema.preferences.locale\` and to the`,
    `   mongoose enum on the profile. The API rejects an unknown language, which`,
    `   is what you want, and which is also why this step is easy to forget.`,
    `5. Copy a \`GLOSSARY.<code>.md\` and fill it in before the first translation,`,
    `   not after.`,
    ...(config.publicPages
      ? [
          `6. Add \`app/<code>/**/page.tsx\` re-exports for every public page, and check`,
          `   the \`hreflang\` set includes the new language.`,
        ]
      : []),
    ...(config.serverCatalogs
      ? [
          `7. Copy the server catalogs and register them in`,
          `   \`packages/server/src/i18n/index.ts\` at the`,
          `   \`hatchkit:i18n-server-catalogs\` marker. An unregistered language falls`,
          `   back to ${label(src)} and logs a warning once.`,
        ]
      : []),
    ``,
    `## The tests, and what each one is for`,
    ``,
    `| test | what it prevents |`,
    `| --- | --- |`,
    `| \`i18n/catalog-parity.test.ts\` | renamed ICU arguments, broken ICU, forgotten source sentences |`,
    `| \`app/pre-paint.test.ts\` | the script and the store resolving differently |`,
    `| \`i18n/locale-root.test.tsx\` | a hydration mismatch, and a gate that never lifts |`,
    `| \`i18n/format.test.ts\` | a bare \`toLocale*\` call reaching the source |`,
    `| \`shared/locale.test.ts\` | a second resolution rule |`,
    `| \`shared/format-duration.test.ts\` | the byte-identical no-locale contract |`,
    ...(config.serverCatalogs
      ? [
          `| \`server/tests/i18n-catalog.test.ts\` | server catalog parity + both precedence tables |`,
        ]
      : []),
    ``,
    `None of them are optional. Each one exists because the failure it covers is`,
    `invisible in review: the page renders, the types pass, and one language is`,
    `wrong on one screen.`,
    ``,
  );

  return `${L.join("\n").replace(/\n{3,}/g, "\n\n")}`;
}

function writeIfChanged(absPath: string, content: string): "written" | "unchanged" {
  if (existsSync(absPath)) {
    const cur = readFileSync(absPath, "utf-8");
    if (cur === content) return "unchanged";
  }
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content, "utf-8");
  return "written";
}
