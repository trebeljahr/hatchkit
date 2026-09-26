/*
 * cli/src/features/token-client-auth/rewriter.ts — the edits this feature
 * makes to files the starter already owns.
 *
 * Two rules govern every one of them:
 *
 *   1. **Transactional per file.** A file's edits are computed against an
 *      in-memory copy and written only once every anchor has matched. A
 *      half-patched `auth.ts` does not compile, and "it built before I ran
 *      hatchkit" is the one thing an additive command must never earn.
 *   2. **Idempotent, and honest about it.** Each rewrite recognises its own
 *      output and reports `already-applied` rather than appending a second
 *      copy. `update` re-applies every selected feature on every run.
 *
 * ============================================================
 * COMPOSING WITH THE OTHER FEATURES THAT EDIT auth.ts
 * ============================================================
 *
 * `betterAuth({ … })` is shared ground. `workspaces` adds the organization
 * plugin and a `user` database hook; the extension feature adds `bearer()` and
 * the device-authorization plugin; account security adds its sign-in plugins.
 * Each of those inserts a `plugins:` key — and a second `plugins:` key in one
 * object literal is a duplicate property, which TypeScript reports and which
 * silently discards whichever came first at runtime.
 *
 * So this feature never inserts a key that might already be there. It MERGES:
 * `session:` gains properties if it exists, `databaseHooks:` gains a `session`
 * sub-object beside whatever `user` hooks are already declared, and both are
 * created only when absent. That is also why the merge is anchored on the
 * shape of each key rather than on its full text — the other features' output
 * is not something this one can predict.
 *
 * Nothing here touches the disk. Every function is `string -> RewriteResult`,
 * which is what makes them testable without a project on disk, and the apply
 * in `index.ts` hands the result to `FeatureLedger` — the one place that knows
 * about `--dry-run`.
 */

/** What a rewrite concluded. `manual` means the file was left untouched. */
export type RewriteOutcome = "rewritten" | "already-applied" | "manual";

export interface RewriteResult {
  outcome: RewriteOutcome;
  reason?: string;
  /** The patched text. Undefined when nothing would be written. */
  next?: string;
}

const manual = (reason: string): RewriteResult => ({ outcome: "manual", reason });
const done = (): RewriteResult => ({ outcome: "already-applied" });
const wrote = (next: string): RewriteResult => ({ outcome: "rewritten", next });

/**
 * Find the body of a top-level key inside `betterAuth({ … })`.
 *
 * Returns the index just after the key's opening brace and the index of its
 * matching close, by counting braces rather than by matching a regex — the
 * bodies in question contain nested objects, template literals and comments,
 * none of which a regex survives.
 */
function objectBody(source: string, key: string): { open: number; close: number } | null {
  const marker = `\n    ${key}: {`;
  const at = source.indexOf(marker);
  if (at === -1) return null;
  const open = at + marker.length;
  let depth = 1;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return { open, close: i };
    }
  }
  return null;
}

/** Insert `addition` at the start of the body of an existing top-level key. */
function intoObject(source: string, key: string, addition: string): string | null {
  const body = objectBody(source, key);
  if (!body) return null;
  return `${source.slice(0, body.open)}\n${addition}${source.slice(body.open)}`;
}

/** Add import lines that are not present yet, after the last existing import. */
function addImports(source: string, lines: readonly string[]): string {
  const missing = lines.filter((line) => !source.includes(line));
  if (missing.length === 0) return source;
  const lastImport = source.lastIndexOf("\nimport ");
  const endOfLine = source.indexOf("\n", lastImport + 1);
  const at = lastImport === -1 || endOfLine === -1 ? 0 : endOfLine + 1;
  return `${source.slice(0, at)}${missing.join("\n")}\n${source.slice(at)}`;
}

// ── packages/server/src/auth/auth.ts ─────────────────────────────────

const SESSION_PROPERTIES = `      /**
       * The **ceiling**, not the answer: the window a stored-token client
       * (a native shell, an extension, a launcher, the CLI) gets. Browser
       * cookie sessions are cut back by the \`session\` hooks below, which
       * rewrite \`expiresAt\` on create AND on every refresh.
       *
       * Why the global has to be the long one rather than the short one —
       * the refresh trigger is computed against it — is argued in
       * \`auth/session-lifetime.ts\`. Read that before changing either number.
       */
      expiresIn: TOKEN_CLIENT_SESSION_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
      /**
       * \`client\` is what turns a list of opaque session rows into a readable
       * Devices screen, and it is what the refresh hook reads to keep a
       * session on its own window. \`input: false\` keeps it out of the
       * request body: a field the body can write is a field a caller can
       * forge to whatever the devices list will show — and, since the window
       * is chosen from it, to whatever lifetime it prefers.
       */
      additionalFields: {
        client: {
          type: "string",
          required: false,
          defaultValue: "unknown",
          input: false,
        },
      },
`;

const SESSION_KEY = `    session: {
${SESSION_PROPERTIES}      cookieCache: {
        enabled: true,
        maxAge: 5 * 60, // 5 minutes
      },
    },
`;

const SESSION_HOOKS = `      session: {
        create: {
          /**
           * Stamp each new session with the client that created it, and give
           * it that client's window.
           *
           * The stamp is cosmetic — it names a row in Settings → Devices, and
           * it is self-reported. The window is not: \`expiresAt\` here is what
           * makes a browser session short and a stored-token client's long,
           * since better-auth's \`session.expiresIn\` is one global number.
           */
          before: async (
            session: Record<string, unknown>,
            context: Parameters<typeof clientKindForNewSession>[0],
          ) => ({
            data: {
              ...session,
              client: clientKindForNewSession(context),
              expiresAt: expiryForNewSession(context),
            },
          }),
        },
        update: {
          /**
           * Keep a refreshed session on its own window.
           *
           * Without this the split above would last exactly one refresh:
           * better-auth re-expires a session to the *global* \`expiresIn\`, so
           * a shortened browser row would come back at the long value the
           * first time the browser was used — scoped in appearance, global in
           * behaviour.
           *
           * The client is read off the session ROW, not off the request that
           * triggered the refresh; \`auth/session-hooks.ts\` says why. An
           * update that is not already moving \`expiresAt\` is left untouched,
           * so another plugin writing a field to a session does not silently
           * extend it.
           */
          before: async (
            update: Record<string, unknown>,
            context: Parameters<typeof expiryForSessionRefresh>[1],
          ) => {
            const expiresAt = expiryForSessionRefresh(update, context);
            return expiresAt ? { data: { ...update, expiresAt } } : undefined;
          },
        },
      },
`;

const AUTH_IMPORTS = [
  `import { clientKindForNewSession, expiryForNewSession, expiryForSessionRefresh } from "./session-hooks.js";`,
  `import { SESSION_UPDATE_AGE_SECONDS, TOKEN_CLIENT_SESSION_SECONDS } from "./session-lifetime.js";`,
];

/**
 * Wire the per-client session window and the client stamp into `auth.ts`.
 *
 * Merges rather than inserts wherever another feature may have got there
 * first — see the header. The only hard requirement is the end of the
 * `betterAuth({ … })` call, which every variant of this file has.
 */
export function rewriteAuthConfig(source: string): RewriteResult {
  if (source.includes("session-lifetime.js")) return done();
  if (!source.includes("betterAuth({")) {
    return manual(
      "auth.ts does not call betterAuth({ … }) where expected. Add `expiresIn`, `updateAge`, the `client` additionalField and both session databaseHooks by hand — docs/token-client-auth.md has the block.",
    );
  }

  let out = addImports(source, AUTH_IMPORTS);

  // ── session: merge into it, or create it ──
  if (objectBody(out, "session")) {
    const merged = intoObject(out, "session", SESSION_PROPERTIES);
    if (!merged) {
      return manual("could not read the body of the `session:` key in auth.ts.");
    }
    out = merged;
  } else {
    const tail = out.lastIndexOf("\n  });");
    if (tail === -1) {
      return manual("could not find the end of the betterAuth({ … }) call in auth.ts.");
    }
    out = `${out.slice(0, tail)}\n\n${SESSION_KEY}${out.slice(tail)}`;
  }

  // ── databaseHooks: add a `session` sub-object beside any `user` hooks ──
  if (objectBody(out, "databaseHooks")) {
    const merged = intoObject(out, "databaseHooks", SESSION_HOOKS);
    if (!merged) {
      return manual("could not read the body of the `databaseHooks:` key in auth.ts.");
    }
    out = merged;
  } else {
    const tail = out.lastIndexOf("\n  });");
    if (tail === -1) {
      return manual("could not find the end of the betterAuth({ … }) call in auth.ts.");
    }
    out = `${out.slice(0, tail)}\n\n    databaseHooks: {\n${SESSION_HOOKS}    },\n${out.slice(tail)}`;
  }

  return wrote(out);
}

// ── packages/server/src/app.ts ───────────────────────────────────────

const EXPOSED_HEADERS = `      /**
       * \`set-auth-token\` is how better-auth's bearer plugin hands a session
       * token back, and a cross-origin browser client cannot READ a response
       * header unless it is exposed. Without this an extension popup signs in
       * successfully and then finds no token to store — a failure that looks
       * like a server misconfiguration from the client side and appears in no
       * log.
       */
      exposedHeaders: ["set-auth-token"],
`;

/**
 * Expose the session-token response header through CORS.
 *
 * Anchored on the `cors({` call rather than on its full body, because what is
 * inside it depends on which other features are on.
 */
export function rewriteCors(source: string): RewriteResult {
  if (source.includes('exposedHeaders: ["set-auth-token"]')) return done();
  const marker = "\n    cors({";
  const at = source.indexOf(marker);
  if (at === -1) {
    return manual(
      'app.ts does not call cors({ … }) where expected. Add `exposedHeaders: ["set-auth-token"]` to the CORS options by hand, or no cross-origin client can read its own session token.',
    );
  }
  const open = at + marker.length;
  return wrote(`${source.slice(0, open)}\n${EXPOSED_HEADERS}${source.slice(open)}`);
}

// ── barrels ──────────────────────────────────────────────────────────

/** Re-export a feature module from a package barrel. Append-only. */
export function rewriteBarrel(source: string, modules: readonly string[]): RewriteResult {
  const lines = modules
    .map((name) => `export * from "./${name}.js";`)
    .filter((line) => !source.includes(line));
  if (lines.length === 0) return done();
  return wrote(`${source.trimEnd()}\n${lines.join("\n")}\n`);
}
