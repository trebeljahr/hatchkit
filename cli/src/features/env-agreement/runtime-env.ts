/*
 * cli/src/features/env-agreement/runtime-env.ts — where production
 * environment actually lives, and whether it reaches the container.
 *
 * ---------------------------------------------------------------------
 * The two silent failures
 * ---------------------------------------------------------------------
 *
 * 1. **The encrypted file that reaches nothing.** The template inherits
 *    a dotenvx-encrypted `.env.production`: ciphertext in the repository,
 *    opened at boot by a private key. That mechanism only works if the
 *    ciphertext is IN the image. A project whose env file is untracked
 *    or gitignored, or whose runtime stage copies only `dist`,
 *    `package.json` and `node_modules`, ships an image with nothing to
 *    decrypt — and the private key on the platform then opens nothing.
 *
 *    Setting a value in that file afterwards is the worst shape of bug
 *    this repository has seen: the edit looks right, the commit looks
 *    right, the deploy goes green, and the server keeps running on the
 *    old values. There is nothing in the diff to point at. (tracktime,
 *    2026-09 — see the deploy notes that led to this module.)
 *
 * 2. **The platform variable nobody reads.** The platform's environment
 *    fields are INTERPOLATION VARIABLES FOR THE COMPOSE FILE, not
 *    container environment. A variable set on the platform against a
 *    compose file that never writes `${VAR}` reaches no container at
 *    all. It sits in the dashboard looking set. The same trap runs the
 *    other way: a `${VAR}` with no default that nobody ever sets
 *    interpolates to an empty string, and the container starts anyway.
 *
 *    Measured shape of that one: `TRUST_PROXY_HOPS` set on the platform
 *    while the compose file never named it. The rate limiter kept
 *    resolving every caller to the proxy's address and nothing anywhere
 *    raised.
 *
 * Both failures are invisible in every artefact a person would look at,
 * which is why they are checks rather than documentation.
 */

/** Stable finding codes. They are matched on by tests, by doctor output
 *  and (eventually) by anything that wants to suppress one, so treat a
 *  rename as breaking. */
export type RuntimeEnvFindingCode =
  | "encrypted-env-never-reaches-image"
  | "private-key-decrypts-nothing"
  | "platform-var-not-referenced-by-compose"
  | "compose-var-never-set";

export interface RuntimeEnvFinding {
  code: RuntimeEnvFindingCode;
  /** The file the finding is about, relative to the project root, when
   *  it is about one file. */
  path?: string;
  /** The variable the finding is about, when it is about one variable. */
  key?: string;
  /** One line, stating the consequence rather than the rule. */
  message: string;
}

/** One compose document, as read from disk. */
export interface ComposeFileInput {
  /** Path relative to the project root, for the finding's `path`. */
  path: string;
  content: string;
}

/** What the caller found out about the at-rest production env file.
 *
 *  Passed in rather than discovered here so the check stays pure: the
 *  `apply*` wrapper and `hatchkit doctor` do the stat-ing, the rules
 *  live in one testable function. */
export interface EnvFileFacts {
  /** Path relative to the project root. */
  path: string;
  /** Present on disk. */
  exists: boolean;
  /** Its values are dotenvx ciphertext. A plaintext local-convenience
   *  file is a different thing and not a finding — it was never meant
   *  to reach production. */
  encrypted: boolean;
}

export interface RuntimeEnvSourceInput {
  /** The server image's Dockerfile. Null or absent when the project has
   *  none — a static project, or one deployed some other way. */
  dockerfile?: string | null;
  /** The project's `.gitignore`. */
  gitignore?: string | null;
  /** Every compose document the deployment uses. */
  composeFiles: readonly ComposeFileInput[];
  /** The variables this project expects to set on the platform. Each one
   *  must be named by a compose file or it reaches nothing. */
  expectedKeys: readonly string[];
  /** Git-tracked paths, when the caller knows them. Absent means "I did
   *  not ask git", and the untracked test is then skipped rather than
   *  assumed either way. */
  trackedFiles?: readonly string[];
  /** The at-rest production env file, when the caller looked for one. */
  envFile?: EnvFileFacts;
  /** Whether a dotenvx private key is configured for production (on the
   *  platform, or as a CI secret). A key with nothing to decrypt is a
   *  finding of its own — it is the thing that makes a person believe
   *  the encrypted file is live. */
  privateKeyPresent?: boolean;
}

export interface RuntimeEnvSourceResult {
  ok: boolean;
  findings: RuntimeEnvFinding[];
}

/** Names that belong to the encryption mechanism rather than the app.
 *  Kept in step with `deploy/env-resolve.ts`, which strips the same
 *  shape before pushing values to the platform. */
const DOTENV_KEY = /^DOTENV_(PUBLIC|PRIVATE)_KEY/;

/** Check that production environment reaches the running container.
 *
 *  Pure: everything it needs is in the input, so the test drives it with
 *  strings and `hatchkit doctor` drives it with what it read off disk.
 *  Writes nothing, ever. */
export function checkRuntimeEnvSource(input: RuntimeEnvSourceInput): RuntimeEnvSourceResult {
  const findings: RuntimeEnvFinding[] = [];
  const envFile = input.envFile;

  // ── 1. the encrypted file that never reaches the image ──────────────
  const reasons: string[] = [];
  if (envFile?.exists && envFile.encrypted) {
    if (isGitIgnored(input.gitignore ?? "", envFile.path)) {
      reasons.push("a .gitignore rule excludes it, so it is not in the build context");
    } else if (input.trackedFiles && !input.trackedFiles.includes(envFile.path)) {
      reasons.push("git does not track it, so it is not in the build context");
    }
    if (input.dockerfile && !runtimeStageCopies(input.dockerfile, envFile.path)) {
      reasons.push("the runtime stage of the Dockerfile never COPYs it");
    }
  }
  // "Reaches the image" is a positive claim, so it needs a file that is
  // there, encrypted, and carries no reason against it. A caller that
  // passed no Dockerfile simply did not contribute a reason — the check
  // reports what it could establish and never invents a failure out of
  // an input it was not given.
  const encryptedFileReachesImage =
    envFile?.exists === true && envFile.encrypted && !reasons.length;
  if (reasons.length > 0 && envFile) {
    findings.push({
      code: "encrypted-env-never-reaches-image",
      path: envFile.path,
      message:
        `${envFile.path} is encrypted production env that never reaches the running image ` +
        `(${reasons.join("; ")}). Editing it changes nothing: the deploy goes green and the ` +
        "server keeps its old values. Production environment belongs in the platform's " +
        "environment fields.",
    });
  }

  // ── 2. a private key with nothing to open ───────────────────────────
  const keyDeclared =
    input.privateKeyPresent === true ||
    input.expectedKeys.some((k) => DOTENV_KEY.test(k)) ||
    composeVariableNames(input.composeFiles).some((k) => DOTENV_KEY.test(k));
  if (keyDeclared && !encryptedFileReachesImage) {
    findings.push({
      code: "private-key-decrypts-nothing",
      key: "DOTENV_PRIVATE_KEY_PRODUCTION",
      message:
        "a dotenvx production private key is configured, but no encrypted env file reaches the " +
        "image for it to open. It decrypts nothing, and its presence is what makes people " +
        "believe the committed file is live. Set the values as environment fields instead.",
    });
  }

  // ── 3. platform variables no compose file names ─────────────────────
  const composeVars = collectComposeVariables(input.composeFiles);
  for (const key of input.expectedKeys) {
    // Covered by finding 2 already; two lines about the same key would
    // send a reader looking for two problems.
    if (DOTENV_KEY.test(key) && keyDeclared && !encryptedFileReachesImage) continue;
    if (composeVars.has(key)) continue;
    findings.push({
      code: "platform-var-not-referenced-by-compose",
      key,
      message:
        `${key} is expected on the platform, but no compose file writes \${${key}}. The ` +
        "platform's environment fields are interpolation variables for the compose file, so " +
        "this value reaches no container however carefully it is set.",
    });
  }

  // ── 4. compose substitutions nobody sets ────────────────────────────
  const expected = new Set(input.expectedKeys);
  for (const [name, use] of composeVars) {
    if (use.hasDefault || expected.has(name)) continue;
    findings.push({
      code: "compose-var-never-set",
      key: name,
      path: use.path,
      message:
        `${use.path} substitutes \${${name}}, which nothing sets and which has no default. ` +
        "Compose interpolates it to an empty string and the container starts anyway, so the " +
        "value is missing at runtime and nothing reports it.",
    });
  }

  return { ok: findings.length === 0, findings };
}

// ---------------------------------------------------------------------------
// Compose parsing
// ---------------------------------------------------------------------------

interface ComposeVarUse {
  /** The compose file the first use was seen in. */
  path: string;
  /** True when at least one use supplies a fallback (`${VAR:-x}`). A
   *  variable with a fallback still works when nobody sets it, so it is
   *  not a finding — that is exactly how the proxy-hop count ships a
   *  safe generic default and lets a deployment override it. */
  hasDefault: boolean;
}

/** Every `${VAR}` substitution in a set of compose documents.
 *
 *  Comment lines are stripped first. The generated compose files
 *  explain the interpolation rule in a header comment that itself
 *  contains `${VAR_NAME}`, and a check that reported that as a missing
 *  variable would be wrong on the very file it ships with. */
export function collectComposeVariables(
  files: readonly ComposeFileInput[],
): Map<string, ComposeVarUse> {
  const out = new Map<string, ComposeVarUse>();
  for (const file of files) {
    const body = file.content
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    for (const match of body.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)([^}]*)\}/g)) {
      const name = match[1];
      const hasDefault = /^:?[-?]/.test(match[2] ?? "");
      const existing = out.get(name);
      if (existing) existing.hasDefault = existing.hasDefault || hasDefault;
      else out.set(name, { path: file.path, hasDefault });
    }
  }
  return out;
}

function composeVariableNames(files: readonly ComposeFileInput[]): string[] {
  return [...collectComposeVariables(files).keys()];
}

// ---------------------------------------------------------------------------
// Dockerfile and gitignore
// ---------------------------------------------------------------------------

/** Does the FINAL build stage copy this file into the image?
 *
 *  Only the final stage counts. A builder stage that copies the whole
 *  repository is normal and proves nothing — what ships is what the
 *  runtime stage carries, and the runtime stages here deliberately copy
 *  three things by name. Matching is on the file's own name so a
 *  `COPY --from=build /app/packages/server/.env.production ./` counts. */
export function runtimeStageCopies(dockerfile: string, relPath: string): boolean {
  const lines = dockerfile.split("\n");
  let lastFrom = -1;
  lines.forEach((line, i) => {
    if (/^\s*FROM\s/i.test(line)) lastFrom = i;
  });
  const basename = relPath.split("/").pop() ?? relPath;
  return lines
    .slice(lastFrom + 1)
    .some((line) => /^\s*COPY\s/i.test(line) && line.includes(basename));
}

/** Does a `.gitignore` exclude this path?
 *
 *  A deliberately small subset: exact paths, bare names matched at any
 *  depth, and `*` globs — the shapes that actually exclude an env file.
 *  Negations (`!rule`) are honoured because a project that re-includes
 *  its env file on purpose must not be reported. Anything more exotic
 *  than that is left to git itself: the caller can pass `trackedFiles`,
 *  which is the authoritative answer. */
export function isGitIgnored(gitignore: string, relPath: string): boolean {
  const basename = relPath.split("/").pop() ?? relPath;
  let ignored = false;
  for (const raw of gitignore.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    const pattern = (negated ? line.slice(1) : line).replace(/^\/+|\/+$/g, "");
    if (pattern === "") continue;
    const rx = new RegExp(`^${pattern.split("*").map(escapeRegExp).join("[^/]*")}$`);
    if (rx.test(relPath) || rx.test(basename)) ignored = !negated;
  }
  return ignored;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** Render the findings as lines for doctor-style output. One line per
 *  finding, already phrased as a consequence — the code is printed too
 *  so a reader can search for it. */
export function renderRuntimeEnvSource(result: RuntimeEnvSourceResult): string[] {
  if (result.ok) {
    return ["Production environment: every expected value has a path to the container"];
  }
  return [
    "Production environment does not reach the container:",
    ...result.findings.map((f) => `  FAIL  [${f.code}] ${f.message}`),
  ];
}
