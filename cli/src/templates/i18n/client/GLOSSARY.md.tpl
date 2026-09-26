# __HATCHKIT_TARGET_LABEL__ (`__HATCHKIT_TARGET_LOCALE__`) — glossary for __HATCHKIT_APP_NAME__

Terms and voice for whoever writes the `__HATCHKIT_TARGET_LOCALE__` catalogs in
`./messages/__HATCHKIT_TARGET_LOCALE__/` (beside this file). Decide a word here once, then
use that word everywhere. Two words for one thing on screen reads as two
different things.

Source language: `__HATCHKIT_SOURCE_LOCALE__`
(__HATCHKIT_SOURCE_LABEL__). Every key exists in
`./messages/__HATCHKIT_SOURCE_LOCALE__/` first.

## Voice

**Register: __HATCHKIT_VOICE__.** Address the reader that way on every screen,
including error messages, which is where a polite register usually slips back
in. Keep the same register in email and in anything a person keeps, such as a
PDF: those are snapshotted in the language they were issued in and nobody
re-reads them for consistency later.

Further decisions, so they are made once rather than per message:

- **Buttons** are the action, not a sentence: the word for "Save", not "Do you
  want to save?".
- **Progress** ("Saving…") and **result** ("Saved") are different messages.
  Do not fold them into one.
- **Placeholders** in a form field name the content, not the instruction.
- **Errors** say what happened and what the reader can do. No apology, no
  blame, no exclamation mark.

## Terms

Fill the middle column before you touch the catalogs. The word you write here
is the only word allowed for that term anywhere in
`__HATCHKIT_TARGET_LOCALE__`.

The catalogs hatchkit shipped already carry a worked German example. If
__HATCHKIT_TARGET_LABEL__ is German, copy the words those catalogs use into
this table rather than choosing again; if it is not, every message in them is
still German and this table is where the real translation starts.

| `__HATCHKIT_SOURCE_LOCALE__` term | `__HATCHKIT_TARGET_LOCALE__` term | What it means on screen |
| --- | --- | --- |
| Account |  | The reader's own account, not a billing plan. |
| Item |  | One row in the dashboard list. The app's central noun — rename it here and every screen follows. |
| Dashboard |  | The first screen after logging in. |
| Profile |  | Name, avatar and bio. Not the account settings. |
| Settings |  | Preferences: appearance, notifications, language. |
| Bio |  | Free text the reader writes about themselves. |
| Sign up |  | Create an account. Distinct from "Log in". |
| Log in |  | Start a session with an existing account. |
| Sign out |  | End the session. Same verb every time, never a second synonym. |
| Password |  | Also used for "New password" and "Confirm password" — one stem for all three. |
| Email |  | The address. Not the message. |
| Notification |  | An email the app sends, not an in-app badge. |
| Language |  | The reading language, chosen in Settings. Not the region or the country. |
| Delete |  | Irreversible removal. Keep it distinct from a word meaning "remove from view". |

Add a row for every noun your product invents. A term that appears twice in
the app and only once in this table is a term two translators will disagree
about.

## False friends

A word that looks like the source word and means something else is the failure
this section exists to prevent, because it type-checks, reads fluently, and is
wrong. The classic: a time tracker whose English "tag" becomes German „Tag“ —
which means *day*, on every screen of a product about days.

**Record every one you find here, with the word you must not use.**

| `__HATCHKIT_SOURCE_LOCALE__` term | Do NOT use | Because it means | Use instead |
| --- | --- | --- | --- |
|  |  |  |  |

Two habits that find them:

- Read the translated screen out loud in context. A false friend survives a
  side-by-side diff and dies immediately when spoken as part of the sentence
  the reader sees.
- Check any term whose cognate is shorter than the correct word. The cognate
  is the one that fits the button, which is why it gets chosen.

## Never translated

These are not oversights — they are read by machines, and translating one
breaks an integration rather than a sentence:

- CSV export headers and exported values.
- Error codes, `problem+json` types and API field names.
- Webhook payloads and anything in the API documentation.
- The locale codes themselves (`__HATCHKIT_SOURCE_LOCALE__`,
  `__HATCHKIT_TARGET_LOCALE__`).

Language names in the picker stay in their own language
(__HATCHKIT_TARGET_LABEL__, not the __HATCHKIT_SOURCE_LOCALE__ word for it): a
reader who cannot read the current interface language still recognises their
own.

## Before you open a pull request

- `pnpm --filter __HATCHKIT_PKG_SCOPE__/client test` — `catalog-parity.test.ts`
  checks what the compiler cannot: that every `{argument}` and every `<tag>`
  is spelled exactly as the source spells it, that both messages are valid
  ICU, and that no source sentence was left in place.
- `pnpm --filter __HATCHKIT_PKG_SCOPE__/client typecheck` — a missing,
  misspelled or extra key is a compile error, not a runtime surprise.
- Look at the longest string on each screen. __HATCHKIT_TARGET_LABEL__ text
  that is 35% longer than the source is normal; a button that clips is a
  layout bug to report, not a reason to abbreviate the translation.
