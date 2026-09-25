/*
 * cli/src/scaffold/identifiers.ts — the project's permanent identifier set.
 *
 * ============================================================
 * WHY THIS MODULE EXISTS
 * ============================================================
 *
 * A scaffolded project bakes a handful of names into places that
 * outlive the code:
 *
 *   · the bundle id lands in an Apple App ID, an App Store Connect
 *     record and a Play package name — none of which can be renamed
 *     once registered;
 *   · storage and secret-store key prefixes key data that already sits
 *     in a user's browser, Keychain or offline queue;
 *   · custom header names and device-flow client ids are what
 *     third-party integrations and shipped clients already send;
 *   · env-var prefixes are in every self-hoster's `.env`;
 *   · database names and export filenames are in backups on disk.
 *
 * The moment any of that is stored or published the name is a
 * contract. Renaming later does not fail loudly — it silently orphans
 * stored sessions, drops queued writes, 401s integrations and breaks
 * self-hosters' environments.
 *
 * So: every identifier is decided ONCE, at scaffold time, written to
 * the manifest, and read from there forever after. Nothing downstream
 * re-derives one. Before this module four separate call sites each ran
 * `config.name.replace(/[^a-z0-9]/gi, "").toLowerCase()` and hoped they
 * agreed; {@link resolveIdentifiers} is now the single decision point
 * and {@link ProjectManifest.identifiers} the single record of it.
 *
 * ============================================================
 * ONE DECISION EACH
 * ============================================================
 *
 * `resolveIdentifiers` takes a small set of DECISIONS — the project
 * name, an optional product name, short name and organisation domain —
 * and derives the rest. Every derived field can also be pinned
 * explicitly via `overrides`, because a project that has already
 * published under some other spelling must be able to say so rather
 * than be renamed by a later hatchkit run.
 *
 * Deriving is not the same as re-deriving. The derivation runs once;
 * its output is frozen into the manifest. `resolveIdentifiers` is
 * therefore pure and deterministic — same input, same output, no clock,
 * no filesystem — so a re-run against a stored manifest can be asserted
 * to reproduce it.
 */

/** Hosts that get their own device-flow client id. Each shipped client
 *  authenticates as a distinct, server-allowlisted id so a single
 *  surface can be revoked without signing out the others. Adding a host
 *  here is additive; REMOVING one breaks every already-issued token
 *  that carries it. */
export const CLIENT_HOSTS = ["desktop", "mobile", "extension", "raycast", "mcp", "cli"] as const;
export type ClientHost = (typeof CLIENT_HOSTS)[number];

/** Home-screen labels are truncated by the OS launcher, not wrapped.
 *  iOS shows roughly 12 characters under an icon before eliding; the
 *  Android launcher is similar. Longer short names do not error — they
 *  just render as `Verylongproduc…` on every device, which is why this
 *  is a warning-with-a-number rather than a silent default. */
export const SHORT_NAME_MAX = 12;

export interface ProjectIdentifiers {
  /** Kebab-case project slug. The npm package name, the GitHub repo
   *  name, the container image name. May contain hyphens. */
  slug: string;
  /** The single lowercase alphanumeric token every machine identifier
   *  is built from. Hyphen-free, because a reverse-DNS bundle-id
   *  segment, an env-var prefix and a Mongo database name each reject
   *  or mangle hyphens. This is the name the product is stuck with. */
  token: string;
  /** Human-readable product name. Shown in the UI, the web manifest
   *  `name`, the desktop installer and the store listing. Safe to
   *  change: it is displayed, never stored as a key. */
  productName: string;
  /** Home-screen / launcher label. Web manifest `short_name`, Capacitor
   *  `appName`, iOS `CFBundleDisplayName`, Android `app_name` and
   *  `title_activity_main`. These four copies MUST agree — see
   *  {@link collectIdentifierMismatches}. */
  shortName: string;
  /** Organisation domain in normal order (`example.com`). Only used to
   *  build {@link bundleId}; kept so a later run can tell a deliberate
   *  bundle id from a derived one. */
  orgDomain: string;
  /** Reverse-DNS application identifier: Electron `build.appId`,
   *  Capacitor `appId`, iOS `CFBundleIdentifier`, Android
   *  `applicationId`. PERMANENT once an App ID, an App Store Connect
   *  record or a Play package name exists. */
  bundleId: string;
  /** Namespace for browser-side storage keys (`localStorage`,
   *  `sessionStorage`, IndexedDB database names). Changing it orphans
   *  every key already written in a user's browser, including an
   *  offline queue that has not drained yet. */
  storagePrefix: string;
  /** Service name under which secrets are filed in the host secret
   *  store (macOS Keychain, Windows Credential Manager, libsecret,
   *  `chrome.storage`, Raycast's store). A Keychain item outlives the
   *  app; changing this strands the old item rather than migrating it. */
  keychainService: string;
  /** Request header each client sends to identify its surface, e.g.
   *  `x-example-client: desktop`. Lowercase — HTTP/2 rejects uppercase
   *  header names on the wire. */
  clientHeader: string;
  /** Prefix for outbound webhook headers, e.g. `X-Example-Signature`.
   *  Receivers match on the literal name, so this is an integration
   *  contract from the first delivery. */
  webhookHeaderPrefix: string;
  /** Device-flow client id per shipped surface. Server-allowlisted;
   *  a token already issued to a client carries its id. */
  clientIds: Record<ClientHost, string>;
  /** Application database name (Mongo db / Postgres database). Present
   *  in every deployed volume and every backup archive. */
  databaseName: string;
  /** Filename stem for user-facing exports and downloads, e.g.
   *  `example-export-2026-09-23.csv`. Users' scripts and folder rules
   *  match on it. */
  exportFilePrefix: string;
  /** SCREAMING_SNAKE prefix for project-owned environment variables
   *  (`EXAMPLE_VERSION`, …). It is in every self-hoster's `.env`, so a
   *  rename breaks their deployment on the next pull. */
  envPrefix: string;
  /** npm workspace scope for the generated packages (`@example/server`).
   *  Import specifiers across the whole tree depend on it. */
  npmScope: string;
  /** Origin the packaged desktop shell serves its bundle from. It is a
   *  real origin: it keys `localStorage` and it must appear verbatim in
   *  the server's trusted-origin allowlist. Never `file://`, whose
   *  origin serialises to `null` and which therefore fails same-origin
   *  and credentialed requests outright. */
  desktopOrigin: { scheme: string; host: string };
}

/** The decisions a caller makes. Everything not supplied is derived. */
export interface IdentifierInput {
  /** Project name as typed — `manifest.name` / `ProjectConfig.name`. */
  name: string;
  /** Display name. Defaults to a title-cased {@link name}. */
  productName?: string;
  /** Launcher label. Defaults to {@link productName} when it fits in
   *  {@link SHORT_NAME_MAX}, else its first word. */
  shortName?: string;
  /** Organisation domain, normal order. Defaults to `example.com`,
   *  which is deliberately obviously-a-placeholder: a bundle id under
   *  `com.example` should be changed before anything is registered,
   *  and `hatchkit doctor` says so. */
  orgDomain?: string;
  /** Machine token. Defaults to {@link name} reduced to `[a-z0-9]`. */
  token?: string;
  /** Pin any resolved field instead of deriving it. Used for projects
   *  that already published under a spelling the derivation would not
   *  produce. */
  overrides?: Partial<ProjectIdentifiers>;
}

/* ------------------------------------------------------------------ */
/* Derivation                                                          */
/* ------------------------------------------------------------------ */

/** Reduce an arbitrary project name to the `[a-z0-9]` machine token. */
export function toIdentifierToken(name: string): string {
  const token = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!token) {
    throw new Error(
      `Cannot derive an identifier token from project name ${JSON.stringify(name)}: it has no letters or digits. Pass an explicit token.`,
    );
  }
  // A leading digit is legal in most of these positions but not in a
  // reverse-DNS bundle-id segment (Apple rejects it) nor in an env-var
  // name. Prefixing here rather than at each use site keeps the single
  // token usable everywhere.
  return /^[0-9]/.test(token) ? `app${token}` : token;
}

/** Reduce an arbitrary project name to a kebab-case slug. */
export function toIdentifierSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) {
    throw new Error(
      `Cannot derive a slug from project name ${JSON.stringify(name)}: it has no letters or digits.`,
    );
  }
  return /^[0-9]/.test(slug) ? `app-${slug}` : slug;
}

/** Title-case a slug-ish name for display: `track-your-time` → `Track
 *  Your Time`. Names that already carry capitals or spaces are left
 *  alone — the user typed what they meant. */
export function toProductName(name: string): string {
  const trimmed = name.trim();
  if (/[A-Z\s]/.test(trimmed)) return trimmed;
  return trimmed
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Pascal-case the token for header names: `example` → `Example`. Multi-
 *  word product names keep their word boundaries so
 *  `X-TrackYourTime-Signature` reads the way a receiver would write it. */
function toHeaderCase(productName: string, token: string): string {
  const words = productName.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length === 0) return token.charAt(0).toUpperCase() + token.slice(1);
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
}

/** Reverse a domain for use as a bundle-id prefix: `ricos-labs.com` →
 *  `com.ricoslabs`. Hyphens are stripped, not converted: Apple rejects
 *  a hyphen in a bundle-id segment. */
export function reverseDomain(domain: string): string {
  const parts = domain
    .trim()
    .toLowerCase()
    .split(".")
    .map((p) => p.replace(/[^a-z0-9]/g, ""))
    .filter(Boolean);
  if (parts.length === 0) {
    throw new Error(`Cannot reverse organisation domain ${JSON.stringify(domain)}: it is empty.`);
  }
  return parts.reverse().join(".");
}

/** The placeholder organisation. Deliberately recognisable so
 *  {@link validateIdentifiers} can tell a project that never chose one
 *  from a project that chose `example.com` on purpose. */
export const PLACEHOLDER_ORG_DOMAIN = "example.com";

/**
 * Resolve the full identifier set. Pure and deterministic — call it
 * once at scaffold time, persist the result, and read the persisted
 * copy from then on.
 */
export function resolveIdentifiers(input: IdentifierInput): ProjectIdentifiers {
  const o = input.overrides ?? {};

  const token = o.token ?? input.token ?? toIdentifierToken(input.name);
  const slug = o.slug ?? toIdentifierSlug(input.name);
  const productName = o.productName ?? input.productName ?? toProductName(input.name);
  const shortName = o.shortName ?? input.shortName ?? deriveShortName(productName);
  const orgDomain = o.orgDomain ?? input.orgDomain ?? PLACEHOLDER_ORG_DOMAIN;
  const headerCase = toHeaderCase(productName, token);

  const clientIds = {
    ...Object.fromEntries(CLIENT_HOSTS.map((h) => [h, `${token}-${h}`])),
  } as Record<ClientHost, string>;

  return {
    slug,
    token,
    productName,
    shortName,
    orgDomain,
    bundleId: o.bundleId ?? `${reverseDomain(orgDomain)}.${token}`,
    storagePrefix: o.storagePrefix ?? token,
    keychainService: o.keychainService ?? token,
    clientHeader: o.clientHeader ?? `x-${token}-client`,
    webhookHeaderPrefix: o.webhookHeaderPrefix ?? `X-${headerCase}-`,
    clientIds: o.clientIds ?? clientIds,
    databaseName: o.databaseName ?? token,
    exportFilePrefix: o.exportFilePrefix ?? token,
    envPrefix: o.envPrefix ?? token.toUpperCase(),
    npmScope: o.npmScope ?? `@${slug}`,
    // `app://-` rather than `app://localhost`: the host is a placeholder
    // that can never collide with a real site, and a single-character
    // host keeps the serialised origin short in allowlists. The scheme
    // must be registered as a privileged standard scheme by the shell
    // before the first window loads, or fetch/storage behave as if the
    // page were opaque.
    desktopOrigin: o.desktopOrigin ?? { scheme: "app", host: "-" },
  };
}

function deriveShortName(productName: string): string {
  if (productName.length <= SHORT_NAME_MAX) return productName;
  const firstWord = productName.split(/\s+/)[0] ?? productName;
  return firstWord.slice(0, SHORT_NAME_MAX);
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export interface IdentifierProblem {
  field: string;
  /** `error` — the value will be rejected by a platform or corrupt data.
   *  `warning` — legal, but known to read badly or to be a placeholder
   *  that should be replaced before anything is published. */
  severity: "error" | "warning";
  message: string;
}

/**
 * Check a resolved set against the rules each platform actually
 * enforces. Every rule here exists because breaking it fails somewhere
 * far from the scaffold: an App Store upload rejection, a Mongo write
 * error, a header dropped by an HTTP/2 proxy.
 */
export function validateIdentifiers(ids: ProjectIdentifiers): IdentifierProblem[] {
  const problems: IdentifierProblem[] = [];
  const err = (field: string, message: string) =>
    problems.push({ field, severity: "error", message });
  const warn = (field: string, message: string) =>
    problems.push({ field, severity: "warning", message });

  if (!/^[a-z][a-z0-9]*$/.test(ids.token)) {
    err(
      "token",
      `${JSON.stringify(ids.token)} must be lowercase letters and digits only, starting with a letter. It becomes a bundle-id segment and an env-var prefix, and both reject anything else.`,
    );
  }
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(ids.slug) && !/^[a-z0-9]$/.test(ids.slug)) {
    err("slug", `${JSON.stringify(ids.slug)} is not a valid npm package / container image name.`);
  }
  // Reverse-DNS: at least two segments, each starting with a letter.
  // Apple's App ID registration and Android's applicationId both reject
  // a segment that starts with a digit, and Android additionally
  // requires at least one dot.
  if (!/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(ids.bundleId)) {
    err(
      "bundleId",
      `${JSON.stringify(ids.bundleId)} is not a valid reverse-DNS identifier. Needs two or more dot-separated segments, each starting with a letter, lowercase alphanumerics only (no hyphens or underscores).`,
    );
  }
  if (ids.bundleId.startsWith("com.example.")) {
    warn(
      "bundleId",
      `${ids.bundleId} still uses the placeholder organisation. Set a real one before registering an App ID, an App Store Connect record or a Play package name — none of those can be renamed afterwards.`,
    );
  }
  if (ids.shortName.length > SHORT_NAME_MAX) {
    warn(
      "shortName",
      `"${ids.shortName}" is ${ids.shortName.length} characters; launchers elide past about ${SHORT_NAME_MAX}.`,
    );
  }
  if (!ids.shortName.trim()) err("shortName", "Short name is empty.");
  if (!ids.productName.trim()) err("productName", "Product name is empty.");
  if (ids.clientHeader !== ids.clientHeader.toLowerCase()) {
    err(
      "clientHeader",
      `${ids.clientHeader} must be lowercase — HTTP/2 treats an uppercase header name as a malformed request.`,
    );
  }
  if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(ids.clientHeader)) {
    err(
      "clientHeader",
      `${ids.clientHeader} contains characters that are not valid in a header name.`,
    );
  }
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+-$/.test(ids.webhookHeaderPrefix)) {
    err(
      "webhookHeaderPrefix",
      `${ids.webhookHeaderPrefix} must be a valid header-name fragment ending in "-" so concrete names read as ${ids.webhookHeaderPrefix}Signature.`,
    );
  }
  // Mongo forbids / \ . " $ * < > : | ? and a space, and caps the name
  // at 63 bytes; Postgres caps identifiers at 63 bytes too. Restricting
  // to [a-z0-9_] satisfies both without a per-engine branch.
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(ids.databaseName)) {
    err(
      "databaseName",
      `${JSON.stringify(ids.databaseName)} must be lowercase letters, digits and underscores, start with a letter, and be at most 63 characters — the tightest of the Mongo and Postgres limits.`,
    );
  }
  if (!/^[A-Z][A-Z0-9_]*$/.test(ids.envPrefix)) {
    err(
      "envPrefix",
      `${JSON.stringify(ids.envPrefix)} must be SCREAMING_SNAKE_CASE starting with a letter — POSIX shells will not export anything else.`,
    );
  }
  if (!/^@[a-z0-9][a-z0-9-]*$/.test(ids.npmScope)) {
    err("npmScope", `${JSON.stringify(ids.npmScope)} is not a valid npm scope.`);
  }
  if (!/^[a-z][a-z0-9+.-]*$/.test(ids.desktopOrigin.scheme)) {
    err("desktopOrigin.scheme", `${ids.desktopOrigin.scheme} is not a valid URI scheme.`);
  }
  if (ids.desktopOrigin.scheme === "file") {
    err(
      "desktopOrigin.scheme",
      'The desktop shell must not serve from file://. That origin serialises to "null", so credentialed requests are rejected and per-origin storage is not persisted.',
    );
  }
  for (const host of CLIENT_HOSTS) {
    const id = ids.clientIds[host];
    if (!id) err(`clientIds.${host}`, `Missing client id for ${host}.`);
    else if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      err(
        `clientIds.${host}`,
        `${JSON.stringify(id)} must be lowercase alphanumerics and hyphens.`,
      );
    }
  }
  const seen = new Map<string, ClientHost>();
  for (const host of CLIENT_HOSTS) {
    const id = ids.clientIds[host];
    const prev = seen.get(id);
    if (prev) {
      err(
        `clientIds.${host}`,
        `Duplicate client id ${JSON.stringify(id)}, shared with ${prev}. Distinct ids are what make per-surface revocation possible.`,
      );
    }
    seen.set(id, host);
  }
  return problems;
}

/** Throw on any `error`-severity problem. Warnings are returned to the
 *  caller to print. */
export function assertIdentifiers(ids: ProjectIdentifiers): IdentifierProblem[] {
  const problems = validateIdentifiers(ids);
  const errors = problems.filter((p) => p.severity === "error");
  if (errors.length > 0) {
    throw new Error(
      `Invalid project identifiers:\n${errors.map((e) => `  · ${e.field}: ${e.message}`).join("\n")}`,
    );
  }
  return problems.filter((p) => p.severity === "warning");
}

/* ------------------------------------------------------------------ */
/* Template tokens                                                     */
/* ------------------------------------------------------------------ */

/**
 * `{{token}}` substitutions available in starter files.
 *
 * The starter is copied wholesale and then patched, so these are plain
 * literal replacements rather than a template language — a starter file
 * has to stay valid TypeScript/JSON/YAML in the repo, before any
 * substitution runs.
 */
export function identifierTokenMap(ids: ProjectIdentifiers): Record<string, string> {
  return {
    "{{projectName}}": ids.productName,
    "{{projectSlug}}": ids.slug,
    "{{identifierToken}}": ids.token,
    "{{productName}}": ids.productName,
    "{{shortName}}": ids.shortName,
    "{{bundleId}}": ids.bundleId,
    "{{storagePrefix}}": ids.storagePrefix,
    "{{keychainService}}": ids.keychainService,
    "{{clientHeader}}": ids.clientHeader,
    "{{webhookHeaderPrefix}}": ids.webhookHeaderPrefix,
    "{{databaseName}}": ids.databaseName,
    "{{exportFilePrefix}}": ids.exportFilePrefix,
    "{{envPrefix}}": ids.envPrefix,
    "{{npmScope}}": ids.npmScope,
    "{{desktopScheme}}": ids.desktopOrigin.scheme,
    "{{desktopHost}}": ids.desktopOrigin.host,
    "{{desktopOrigin}}": `${ids.desktopOrigin.scheme}://${ids.desktopOrigin.host}`,
    ...Object.fromEntries(
      CLIENT_HOSTS.map((h) => [`{{clientId:${h}}}`, ids.clientIds[h]] as const),
    ),
  };
}

/** Apply every identifier token to a string. Unknown `{{…}}` sequences
 *  are left alone — they may belong to another templating pass. */
export function substituteIdentifierTokens(content: string, ids: ProjectIdentifiers): string {
  let out = content;
  for (const [needle, value] of Object.entries(identifierTokenMap(ids))) {
    out = out.split(needle).join(value);
  }
  return out;
}

/** Identifier tokens still present in `content`. A non-empty result
 *  after a substitution pass means a file was rendered with an
 *  identifier set that does not know about a token the template uses —
 *  which ships a literal `{{bundleId}}` into a generated project. */
export function findUnsubstitutedIdentifierTokens(content: string): string[] {
  const known = new Set(Object.keys(identifierTokenMap(resolveIdentifiers({ name: "probe" }))));
  const found = new Set<string>();
  for (const match of content.matchAll(/\{\{[A-Za-z][A-Za-z0-9:]*\}\}/g)) {
    if (known.has(match[0])) found.add(match[0]);
  }
  return [...found].sort();
}

/* ------------------------------------------------------------------ */
/* Back-compat                                                         */
/* ------------------------------------------------------------------ */

/**
 * The identifier set a project scaffolded before this module existed
 * actually has on disk.
 *
 * Pre-identifiers hatchkit wrote exactly two things: `appId:
 * "com.example.<token>"` and `appName: "<project name verbatim>"`,
 * where `<token>` came from `name.replace(/[^a-z0-9]/gi, "").toLowerCase()`.
 * Seeding a migrated manifest from the CURRENT derivation instead would
 * silently propose a different bundle id for a project that may already
 * have a registered App ID — so the migration reproduces the old rule
 * verbatim and leaves changing it to a deliberate act.
 */
export function legacyIdentifiers(name: string): ProjectIdentifiers {
  return resolveIdentifiers({
    name,
    // The old rule stripped non-alphanumerics from the raw name; it had
    // no digit-prefix guard, but a name that started with a digit
    // produced an invalid bundle id back then too, so reusing
    // toIdentifierToken here only ever fixes such a project.
    token: toIdentifierToken(name),
    // The old `appName` was the raw project name, not a title-cased one.
    productName: name,
    orgDomain: PLACEHOLDER_ORG_DOMAIN,
  });
}
