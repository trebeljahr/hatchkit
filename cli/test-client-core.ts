/**
 * `client-core` feature tests.
 *
 * The feature is the only one that adds a workspace PACKAGE to the starter, and
 * the only one whose code has to sit inside files the starter always ships (the
 * tRPC init, `/api/health`, the server entrypoint). Both facts make it easy to
 * break in ways nothing notices until a scaffolded project runs `pnpm install`
 * or `pnpm run build` for the first time, so the assertions here are mostly
 * about the two directions agreeing:
 *
 *   · strip → nothing in the output names `@starter/core` and no marker is left;
 *   · add   → a stripped tree comes back byte-identical to the starter.
 *
 * The round-trip over the REAL starter is the one that earns its keep: it fails
 * the moment somebody adds a marked block whose anchor line `add.ts` cannot find
 * again, which is exactly the case that would otherwise reach a user as a
 * half-installed handshake.
 *
 * Run: pnpm test
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Same isolation contract as test-scaffold.ts and test-feature-matrix.ts: the
// pruned-project group below runs a REAL scaffold, which mints a dotenvx key
// and reads the user's config. Set before the first dynamic import, because
// config.ts resolves these at module load.
process.env.HATCHKIT_CONF_DIR ??= mkdtempSync(join(tmpdir(), "client-core-conf-"));
process.env.HATCHKIT_KEYTAR_SERVICE ??= `hatchkit-client-core-${process.pid}`;
process.env.HATCHKIT_DEV_CONFIG_DIR ??= mkdtempSync(join(tmpdir(), "client-core-devdir-"));

const {
  CLIENT_CORE_CHECKLIST_PATH,
  CLIENT_CORE_GENERATED_PATHS,
  CLIENT_CORE_MARKED_FILES,
  CLIENT_CORE_OWNED_PATHS,
  CLIENT_CORE_ROOT_SCRIPTS,
  CONTRACT_SNAPSHOT_PATH,
  CORE_PACKAGE_NAME,
  IDENTIFIER_RENAMES,
  UnbalancedMarkerError,
  anchoredBlocks,
  applyClientCore,
  chainCoreBuild,
  clientCoreFeature,
  hasMarkedBlocks,
  insertAfter,
  readMarkedBlocks,
  stripClientCore,
  stripMarkedBlocks,
  unchainSegment,
  findStarterIdentifierLiterals,
  renameClientCoreIdentifiers,
  renderClientCoreChecklist,
} = await import("./src/features/client-core/index.js");
const { FeatureLedger, expandFeatureSelection } = await import("./src/features/contract.js");
/** Conditions whose sections may name the kit: the feature itself, and the
 *  two host surfaces that require it. */
const CORE_GATED_CONDITIONS = new Set(["client-core", "raycast", "mcp"]);

const { stripRaycast } = await import("./src/features/raycast/index.js");
const { stripMcp } = await import("./src/features/mcp/index.js");
const { findUnsubstitutedIdentifierTokens, resolveIdentifiers } = await import(
  "./src/scaffold/identifiers.js"
);
const { KNOWN_FEATURES } = await import("./src/utils/flags.js");
const { scaffoldApp } = await import("./src/scaffold/app.js");

type Ledger = InstanceType<typeof FeatureLedger>;

/**
 * Apply the feature to `projectDir` through a real ledger, as `update` does.
 *
 * The context is the minimum `applyClientCore` reads. It is deliberately not a
 * full manifest: the feature must not reach for anything but `identifiers`, and
 * a narrow fake is what makes that a test rather than a convention.
 */
function apply(
  projectDir: string,
  opts: { dryRun?: boolean; name?: string } = {},
): { ledger: Ledger; manual: number; logs: string[] } {
  const ledger = new FeatureLedger(projectDir, opts.dryRun ?? false);
  const logs: string[] = [];
  const identifiers = resolveIdentifiers({ name: opts.name ?? "acme-tracker" });
  const { manual } = applyClientCore(
    {
      projectDir,
      manifestDir: projectDir,
      manifest: { name: opts.name ?? "acme-tracker", identifiers } as never,
      identifiers,
      mode: "update",
      ledger,
      log: (m: string) => logs.push(m),
    },
    STARTER,
  );
  return { ledger, manual: manual.length, logs };
}

/** Every file under `dir` with its contents, for a byte-for-byte comparison. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      if (entry === "node_modules" || entry === ".git") continue;
      const path = join(current, entry);
      if (statSync(path).isDirectory()) walk(path);
      else out.set(path.slice(dir.length + 1), readFileSync(path, "utf-8"));
    }
  };
  walk(dir);
  return out;
}

function sameSnapshot(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [path, content] of a) if (b.get(path) !== content) return false;
  return true;
}

/** A stripped copy of the real starter, i.e. a project scaffolded without the feature. */
function strippedProject(prefix: string): string {
  const out = join(tempDir(prefix), "project");
  cpSync(STARTER, out, { recursive: true, filter: notNodeModules });
  // The two host packages go first, because both REQUIRE client-core and both
  // legitimately name `@starter/core` — in a dependency, in an import, and,
  // for the launcher, in a byte-for-byte vendored copy of the kit's own prose.
  // A tree with `packages/core` deleted and either host still present is one
  // the selection closure can never produce, so asserting "nothing names the
  // package" against it would be asserting a property of a project that
  // cannot exist. Stripping them here makes the assertion about a real tree.
  stripRaycast(out);
  stripMcp(out);
  stripClientCore(out);
  return out;
}

const STARTER = resolve(join(import.meta.dirname, "..", "starter"));
const results: Record<string, boolean> = {};
const temps: string[] = [];

function group(name: string, run: () => Array<[string, boolean]>): void {
  console.log(`\n=== ${name} ===`);
  let ok = true;
  let checks: Array<[string, boolean]>;
  try {
    checks = run();
  } catch (error) {
    console.log(`  ✗ threw: ${error instanceof Error ? error.message : String(error)}`);
    results[name] = false;
    return;
  }
  for (const [label, passed] of checks) {
    console.log(`  ${passed ? "✓" : "✗"} ${label}`);
    if (!passed) ok = false;
  }
  results[name] = ok;
}

function throws(fn: () => unknown, is: (error: unknown) => boolean): boolean {
  try {
    fn();
    return false;
  } catch (error) {
    return is(error);
  }
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** Whitespace-insensitive comparison — a formatter is not a semantic change. */
function sameCode(a: string, b: string): boolean {
  const normalize = (value: string): string =>
    value
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line !== "")
      .join("\n");
  return normalize(a) === normalize(b);
}


/**
 * Identifiers a marked block brings into scope: imports, and declarations.
 *
 * Deliberately crude — a regex, not a parser. It only has to catch the one
 * failure that matters: a name that exists only inside a block and is still
 * referenced after the block is gone. That is a TS2304 in a scaffolded project
 * and the reason the marked-block convention needs a test at all, since the
 * strip itself cannot tell the difference between removing a definition and
 * removing its last use.
 */
function blockScopedNames(block: string): string[] {
  const names = new Set<string>();
  for (const line of block.split("\n")) {
    const imported = /^\s*import\s+(?:type\s+)?\{([^}]*)\}/.exec(line);
    if (imported) {
      for (const part of (imported[1] ?? "").split(",")) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (name) names.add(name);
      }
      continue;
    }
    const defaultImport = /^\s*import\s+(?:type\s+)?(\w+)\s+from/.exec(line);
    if (defaultImport?.[1]) {
      names.add(defaultImport[1]);
      continue;
    }
    const declared =
      /^\s*(?:export\s+)?(?:const|let|var|class|function|type|interface|enum)\s+(\w+)/.exec(line);
    if (declared?.[1]) names.add(declared[1]);
  }
  return [...names];
}

// ── markers ──────────────────────────────────────────────────────────

group("markers", () => {
  const file = [
    "const before = 1;",
    "// ── client-core ──────────────────────────────────────────────────",
    "const inside = 2;",
    "// ── end client-core ──────────────────────────────────────────────",
    "const after = 3;",
    "",
  ].join("\n");

  const indented = [
    "function f() {",
    "  const a = 1;",
    "  // ── client-core ──",
    "  const b = 2;",
    "  // ── end client-core ──",
    "}",
  ].join("\n");

  return [
    ["hasMarkedBlocks true for a marked file", hasMarkedBlocks(file)],
    ["hasMarkedBlocks false for a plain file", !hasMarkedBlocks("const a = 1;\n")],
    [
      "strip removes the block and both markers",
      stripMarkedBlocks(file) === "const before = 1;\nconst after = 3;\n",
    ],
    ["strip is a no-op on an unmarked file", stripMarkedBlocks("const a = 1;\n") === "const a = 1;\n"],
    ["strip handles short marker rules and indentation", stripMarkedBlocks(indented) === "function f() {\n  const a = 1;\n}"],
    ["readMarkedBlocks returns the block body", readMarkedBlocks(file)[0] === "const inside = 2;"],
    ["readMarkedBlocks on an unmarked file is empty", readMarkedBlocks("x\n").length === 0],
    [
      "an unclosed marker throws rather than truncating",
      throws(
        () => stripMarkedBlocks("a\n// ── client-core ──\nb\n"),
        (e) => e instanceof UnbalancedMarkerError,
      ),
    ],
    [
      "a stray close marker throws",
      throws(
        () => stripMarkedBlocks("a\n// ── end client-core ──\n"),
        (e) => e instanceof UnbalancedMarkerError,
      ),
    ],
    [
      "a nested marker throws",
      throws(
        () => stripMarkedBlocks("// ── client-core ──\n// ── client-core ──\nx\n"),
        (e) => e instanceof UnbalancedMarkerError,
      ),
    ],
    [
      "blank runs left by a strip are collapsed",
      stripMarkedBlocks(
        ["a", "", "// ── client-core ──", "x", "// ── end client-core ──", "", "b"].join("\n"),
      ) === "a\n\nb",
    ],
  ];
});

// ── script chains ────────────────────────────────────────────────────

group("unchainSegment", () => {
  const seg = "pnpm --filter @starter/core run build";
  return [
    ["trailing position", unchainSegment(`pnpm run x && ${seg}`, seg) === "pnpm run x"],
    ["leading position", unchainSegment(`${seg} && pnpm run x`, seg) === "pnpm run x"],
    ["middle position", unchainSegment(`a && ${seg} && b`, seg) === "a && b"],
    ["whole script becomes empty so the caller can delete it", unchainSegment(seg, seg) === ""],
    ["a script without the segment is untouched", unchainSegment("a && b", seg) === "a && b"],
    [
      "the segment's @ and / are not treated as regex",
      unchainSegment("pnpm --filter @starter/shared run build && x", seg) ===
        "pnpm --filter @starter/shared run build && x",
    ],
  ];
});

group("chainCoreBuild", () => {
  const seg = "pnpm --filter @starter/core run build";
  const shared = "pnpm --filter @starter/shared run build";
  // The starter's real shapes: one script where the core build is in the middle
  // of the chain, one where it leads.
  const starter = {
    typecheck: `${shared} && ${seg} && pnpm -r run typecheck && pnpm typecheck:electron`,
    test: `${seg} && node --test`,
  };
  const chain = (scripts: Record<string, string>, names: string[] = ["typecheck", "test"]): Record<string, string> =>
    (
      JSON.parse(chainCoreBuild(JSON.stringify({ scripts }, null, 2), starter, names)) as {
        scripts: Record<string, string>;
      }
    ).scripts;

  // Exactly the starter's minus the core segment — the whole starter script
  // comes back, so any other change it carries comes with it.
  const exact = chain({ typecheck: `${shared} && pnpm -r run typecheck && pnpm typecheck:electron` });
  // The shape a real scaffold produces: minus the core segment AND minus the
  // Electron one, because `desktop` was not selected either.
  const twoStripped = chain({ typecheck: `${shared} && pnpm -r run typecheck` });
  // Already chained — a second apply must change nothing.
  const already = chain({ typecheck: starter.typecheck });
  // Leading position, where there is no preceding segment to place after.
  const leading = chain({ test: "node --test" });
  // Somebody's own command: the segment the core build follows is gone, so
  // there is no position this can claim to know.
  const rewritten = chain({ typecheck: "tsc -b" });
  // …and one where it appears twice, which is equally unplaceable.
  const ambiguous = chain({ typecheck: `${shared} && pnpm -r run typecheck && ${shared}` });

  return [
    ["the starter's script minus the segment is restored whole", exact.typecheck === starter.typecheck],
    [
      "a script missing a SECOND segment still gets the core build",
      twoStripped.typecheck === `${shared} && ${seg} && pnpm -r run typecheck`,
    ],
    [
      "and does not gain back the segment it had pruned",
      !(twoStripped.typecheck ?? "").includes("typecheck:electron"),
    ],
    ["an already-chained script is untouched", already.typecheck === starter.typecheck],
    ["a leading segment is prepended", leading.test === `${seg} && node --test`],
    ["a rewritten script is left alone", rewritten.typecheck === "tsc -b"],
    [
      "an ambiguous position is refused rather than guessed",
      ambiguous.typecheck === `${shared} && pnpm -r run typecheck && ${shared}`,
    ],
    [
      "a script the starter does not have is left alone",
      chain({ build: "x" }, ["build"]).build === "x",
    ],
    ["invalid JSON is returned unchanged", chainCoreBuild("{oops", starter, ["typecheck"]) === "{oops"],
  ];
});

// ── anchored insertion ───────────────────────────────────────────────

group("anchored insertion", () => {
  const source = [
    "import a from 'a';",
    "",
    "// ── client-core ──",
    "import b from 'b';",
    "// ── end client-core ──",
    "",
    "run();",
  ].join("\n");
  const blocks = anchoredBlocks(source);
  const stripped = stripMarkedBlocks(source);
  const reinserted = blocks.reduce<string | null>(
    (acc, { anchor, block }) => (acc === null ? null : insertAfter(acc, anchor, block)),
    stripped,
  );

  // A short anchor that repeats must GROW until it is unique, not pick one.
  const ambiguous = [
    "function a() {",
    "  work();",
    "}",
    "function b() {",
    "  work();",
    "}",
    "// ── client-core ──",
    "after();",
    "// ── end client-core ──",
  ].join("\n");
  const ambiguousAnchor = anchoredBlocks(ambiguous)[0]?.anchor ?? [];

  return [
    ["one block found", blocks.length === 1],
    ["the anchor is the nearest non-blank line above", blocks[0]?.anchor.length === 1],
    ["the anchor is that line", blocks[0]?.anchor[0]?.trim() === "import a from 'a';"],
    ["round-trips back to the original", reinserted !== null && sameCode(reinserted, source)],
    ["a missing anchor is null, not a guess", insertAfter("x\n", ["nope"], "block") === null],
    ["an empty anchor never matches", insertAfter("\nx\n", [], "block") === null],
    [
      "matching ignores indentation",
      insertAfter("  const a = 1;\n", ["const a = 1;"], "B") === "  const a = 1;\nB\n",
    ],
    [
      "an ambiguous anchor is refused rather than guessed",
      insertAfter("dup\nother\ndup\n", ["dup"], "B") === null,
    ],
    [
      "a repeated line grows the anchor until it is unique",
      ambiguousAnchor.length > 1 && ambiguousAnchor[ambiguousAnchor.length - 1]?.trim() === "}",
    ],
    [
      "the grown anchor matches exactly once",
      insertAfter(stripMarkedBlocks(ambiguous), ambiguousAnchor, "B") !== null,
    ],
    [
      "matching allows blank lines between the anchor's lines",
      insertAfter("a();\n\nb();\n", ["a();", "b();"], "B") === "a();\n\nb();\nB\n",
    ],
  ];
});

// ── the real starter ─────────────────────────────────────────────────

if (!existsSync(join(STARTER, "package.json"))) {
  console.log(`\nSkipping starter-backed groups: starter not populated at ${STARTER}`);
} else {
  group("starter marker blocks round-trip", () => {
    const checks: Array<[string, boolean]> = [];
    for (const rel of CLIENT_CORE_MARKED_FILES) {
      const path = join(STARTER, rel);
      if (!existsSync(path)) {
        checks.push([`${rel} exists in the starter`, false]);
        continue;
      }
      const original = readFileSync(path, "utf-8");
      checks.push([`${rel} carries at least one marked block`, hasMarkedBlocks(original)]);
      const stripped = stripMarkedBlocks(original);
      checks.push([`${rel} strips to something without markers`, !hasMarkedBlocks(stripped)]);

      // Every block's anchor must be findable in the stripped file, or
      // `hatchkit update` cannot put the block back for a real project.
      let rebuilt: string | null = stripped;
      for (const { anchor, block } of anchoredBlocks(original)) {
        rebuilt = rebuilt === null ? null : insertAfter(rebuilt, anchor, block);
      }
      checks.push([`${rel} every block's anchor survives the strip`, rebuilt !== null]);

      // The failure this whole convention exists to prevent: the strip removes a
      // definition and leaves a use of it behind, so a scaffold without the
      // feature does not compile.
      // A name the stripped file DECLARES for itself is not dangling: a local
      // like `item` exists in several procedures, and one of them happens to be
      // inside a block. Only a name that survives as a use with no definition
      // left is a problem.
      const declaredAfter = new Set(blockScopedNames(stripped));
      const dangling: string[] = [];
      for (const block of readMarkedBlocks(original)) {
        for (const name of blockScopedNames(block)) {
          if (declaredAfter.has(name)) continue;
          if (new RegExp(`\\b${name}\\b`).test(stripped)) dangling.push(name);
        }
      }
      checks.push([
        `${rel} the strip leaves no reference to a block-only name`,
        dangling.length === 0 || failWith("dangling", dangling),
      ]);
      checks.push([
        `${rel} re-inserting the blocks reproduces the starter`,
        rebuilt !== null && sameCode(rebuilt, original),
      ]);
    }
    return checks;
  });

  group("starter ships every owned path", () => {
    // The contract snapshot too: without it the starter's own server suite
    // fails. It sits where `emitContractSnapshot` expects the emitter to write.
    return [
      ...CLIENT_CORE_OWNED_PATHS.map(
        (rel) => [`${rel} present`, existsSync(join(STARTER, rel))] as [string, boolean],
      ),
      [
        `${CONTRACT_SNAPSHOT_PATH} present`,
        existsSync(join(STARTER, CONTRACT_SNAPSHOT_PATH)),
      ],
      [
        "the snapshot is under a generated path",
        CLIENT_CORE_GENERATED_PATHS.some((rel) => CONTRACT_SNAPSHOT_PATH.startsWith(`${rel}/`)),
      ],
      [
        "every generated path is an owned path, so the strip removes it",
        CLIENT_CORE_GENERATED_PATHS.every((rel) => CLIENT_CORE_OWNED_PATHS.includes(rel)),
      ],
    ];
  });

  group("strip leaves no trace", () => {
    const dir = tempDir("client-core-strip-");
    const out = join(dir, "project");
    cpSync(STARTER, out, { recursive: true, filter: notNodeModules });
    // The two host packages go first. Both REQUIRE client-core and both
    // legitimately name `@starter/core` — in a dependency, in an import, and,
    // for the launcher, inside a byte-for-byte vendored copy of the kit's own
    // prose that it must not edit. A tree with `packages/core` deleted and
    // either host still standing is one the selection closure cannot produce,
    // so asserting "nothing names the package" against it would be asserting a
    // property of a project that does not exist.
    stripRaycast(out);
    stripMcp(out);
    stripClientCore(out);

    const rootPkg = JSON.parse(readFileSync(join(out, "package.json"), "utf-8")) as {
      scripts?: Record<string, string>;
    };
    // CLAUDE.md is not the strip's business: its client-core section sits in a
    // `<!-- hatchkit:if client-core -->` block that `applyClaudeMd` prunes later
    // in the same scaffold run. Asserted separately, just below.
    //
    // The lockfile is not either. It is a resolution artifact, regenerated by
    // the first `pnpm install` in the new project, and NO feature strip
    // rewrites it — dropping desktop or mobile leaves their dependencies in it
    // just the same. Scanning it here would make this assertion a test of how
    // recently somebody refreshed `starter/pnpm-lock.yaml` rather than of what
    // the strip removes.
    const ignored = new Set(["CLAUDE.md", "pnpm-lock.yaml"]);
    const referencing = grepFiles(out, CORE_PACKAGE_NAME).filter((rel) => !ignored.has(rel));
    const markerLeft = grepFiles(out, "── client-core ──");

    return [
      ["packages/core is gone", !existsSync(join(out, "packages/core"))],
      [
        "every owned path is gone",
        CLIENT_CORE_OWNED_PATHS.every((rel) => !existsSync(join(out, rel))),
      ],
      [
        "no file names @starter/core",
        referencing.length === 0 || failWith("still referenced by", referencing),
      ],
      ["no marker is left behind", markerLeft.length === 0 || failWith("marker left in", markerLeft)],
      [
        "the feature's root scripts are gone",
        CLIENT_CORE_ROOT_SCRIPTS.every((name) => rootPkg.scripts?.[name] === undefined),
      ],
      [
        "build and typecheck no longer filter a package that does not exist",
        !(rootPkg.scripts?.build ?? "").includes(CORE_PACKAGE_NAME) &&
          !(rootPkg.scripts?.typecheck ?? "").includes(CORE_PACKAGE_NAME),
      ],
      ["build is still a non-empty script", (rootPkg.scripts?.build ?? "").length > 0],
      ["typecheck is still a non-empty script", (rootPkg.scripts?.typecheck ?? "").length > 0],
      [
        "CLAUDE.md's client-core prose is inside a hatchkit:if block",
        (() => {
          const md = readFileSync(join(out, "CLAUDE.md"), "utf-8");
          let depth = 0;
          let outside = 0;
          for (const line of md.split("\n")) {
            const open = /<!--\s*hatchkit:if\s+([\w-]+)\s*-->/.exec(line);
            if (open) {
              // A section gated on a feature that REQUIRES client-core is as
              // safe as one gated on client-core itself — the selection
              // closure never emits the first without the second — so the
              // launcher's and the MCP server's own prose may name the kit.
              depth += CORE_GATED_CONDITIONS.has(open[1] ?? "") ? 1000 : 1;
              continue;
            }
            if (/<!--\s*hatchkit:endif\s*-->/.test(line)) {
              depth -= depth >= 1000 ? 1000 : 1;
              continue;
            }
            if (line.includes(CORE_PACKAGE_NAME) && depth < 1000) outside += 1;
          }
          return outside === 0;
        })(),
      ],
      [
        "the server's test script no longer builds a package that is gone",
        !(
          (
            JSON.parse(readFileSync(join(out, "packages/server/package.json"), "utf-8")) as {
              scripts?: Record<string, string>;
            }
          ).scripts?.test ?? ""
        ).includes(CORE_PACKAGE_NAME),
      ],
      ["stripping twice is a no-op", (() => {
        const before = readFileSync(join(out, "package.json"), "utf-8");
        stripClientCore(out);
        return readFileSync(join(out, "package.json"), "utf-8") === before;
      })()],
    ];
  });

  group("apply restores the feature", () => {
    const out = strippedProject("client-core-apply-");
    const { ledger, manual } = apply(out);

    const serverPkg = readJsonAt(out, "packages/server/package.json");
    const clientPkg = readJsonAt(out, "packages/client/package.json");
    const rootPkg = readJsonAt(out, "package.json");

    const restored = CLIENT_CORE_MARKED_FILES.filter((rel) => existsSync(join(STARTER, rel))).map(
      (rel) =>
        [
          `${rel} carries the handshake again`,
          hasMarkedBlocks(readFileSync(join(out, rel), "utf-8")),
        ] as [string, boolean],
    );

    return [
      ["packages/core is back", existsSync(join(out, "packages/core/src/offline-queue.ts"))],
      ["nothing needed a human", manual === 0],
      ...restored,
      [
        "the server depends on @starter/core",
        serverPkg.dependencies?.[CORE_PACKAGE_NAME] === "workspace:*",
      ],
      [
        "the client depends on @starter/core",
        clientPkg.dependencies?.[CORE_PACKAGE_NAME] === "workspace:*",
      ],
      ["contract:emit is back", (rootPkg.scripts?.["contract:emit"] ?? "").length > 0],
      [
        "build and typecheck build @starter/core again",
        (rootPkg.scripts?.build ?? "").includes(CORE_PACKAGE_NAME) &&
          (rootPkg.scripts?.typecheck ?? "").includes(CORE_PACKAGE_NAME),
      ],
      [
        "the server's test script builds @starter/core again",
        (readJsonAt(out, "packages/server/package.json").scripts?.test ?? "").includes(
          CORE_PACKAGE_NAME,
        ),
      ],
      ["the ledger reports written files", ledger.summary().written.length > 0],
      ["the ledger reports no conflict", ledger.conflicts().length === 0],
      // The starter's snapshot records the starter's router. Copied here, the
      // project's first `pnpm test` would report the project's own router as
      // a breaking change against it.
      [
        "the starter's contract snapshot is not copied",
        CLIENT_CORE_GENERATED_PATHS.every((rel) => !existsSync(join(out, rel))),
      ],
    ];
  });

  // ── the four checks docs/feature-authoring.md requires ─────────────

  group("idempotency", () => {
    const out = strippedProject("client-core-idem-");
    apply(out);
    const after = snapshot(out);
    const second = apply(out);

    return [
      [
        "a second apply writes nothing",
        second.ledger.summary().written.length === 0 ||
          failWith("written again", second.ledger.summary().written),
      ],
      ["a second apply reports nothing as touched", !second.ledger.touched],
      ["the tree is byte-identical after the second apply", sameSnapshot(after, snapshot(out))],
      ["a second apply needs no human", second.manual === 0],
    ];
  });

  group("dry run", () => {
    const out = strippedProject("client-core-dry-");
    const before = snapshot(out);
    const { ledger } = apply(out, { dryRun: true });
    const summary = ledger.summary();

    return [
      [
        "the disk is byte-identical afterwards",
        sameSnapshot(before, snapshot(out)) || failWith("changed", [...snapshot(out).keys()]),
      ],
      ["the ledger reports would-write", summary["would-write"].length > 0],
      ["and reports nothing as written", summary.written.length === 0],
      ["the run still reports itself as touching the project", ledger.touched],
      [
        "no checklist file is written in a dry run",
        !existsSync(join(out, ".hatchkit", "post-client-core.md")),
      ],
    ];
  });

  group("user edits survive", () => {
    const out = strippedProject("client-core-edits-");

    // A line the user added to a file the feature inserts blocks into.
    const marked = CLIENT_CORE_MARKED_FILES.find((rel) => existsSync(join(out, rel))) as string;
    const markedPath = join(out, marked);
    writeFileSync(
      markedPath,
      `${readFileSync(markedPath, "utf-8")}\n// a line the user added\n`,
      "utf-8",
    );

    // A script the user rewrote. mergePackageJson must report, not revert.
    const rootPath = join(out, "package.json");
    const rootPkg = JSON.parse(readFileSync(rootPath, "utf-8")) as {
      scripts: Record<string, string>;
    };
    rootPkg.scripts["contract:emit"] = "echo mine";
    writeFileSync(rootPath, `${JSON.stringify(rootPkg, null, 2)}\n`, "utf-8");

    // A kit file the user already has. Copy-if-absent must leave it alone.
    const ownedPath = join(out, "packages/core/src/offline-queue.ts");
    mkdirSync(dirname(ownedPath), { recursive: true });
    writeFileSync(ownedPath, "// mine, not the starter's\n", "utf-8");

    const { ledger } = apply(out);
    const conflicts = ledger.conflicts();

    return [
      [`${marked}: the user's line survived`, readFileSync(markedPath, "utf-8").includes("// a line the user added")],
      [`${marked}: the blocks were still wired in`, hasMarkedBlocks(readFileSync(markedPath, "utf-8"))],
      [
        "a rewritten script is kept, not reverted",
        readJsonAt(out, "package.json").scripts?.["contract:emit"] === "echo mine",
      ],
      [
        "and the conflict is reported rather than silent",
        conflicts.some((c) => c.file === "package.json" && (c.detail ?? "").includes("contract:emit")),
      ],
      [
        "an existing kit file is not overwritten",
        readFileSync(ownedPath, "utf-8") === "// mine, not the starter's\n",
      ],
    ];
  });

  group("names come from the manifest", () => {
    const out = strippedProject("client-core-names-");
    apply(out, { name: "acme-tracker" });

    // Both directions. The starter must still carry each literal — otherwise the
    // rename table has drifted away from the files it renames and nothing else
    // would notice — and nothing the feature applied may still carry one.
    const starterCarries: string[] = [];
    const applied: string[] = [];
    for (const rel of [...CLIENT_CORE_OWNED_PATHS, ...CLIENT_CORE_MARKED_FILES]) {
      const starterAbs = join(STARTER, rel);
      if (existsSync(starterAbs)) {
        for (const [, content] of filesUnder(starterAbs, STARTER)) {
          starterCarries.push(...findStarterIdentifierLiterals(content));
        }
      }
      const abs = join(out, rel);
      if (!existsSync(abs)) continue;
      for (const [file, content] of filesUnder(abs, out)) {
        const left = findStarterIdentifierLiterals(content);
        if (left.length > 0) applied.push(`${file}: ${left.join(", ")}`);
      }
    }

    // Every `{{…}}` token must be gone too — a literal `{{bundleId}}` in a
    // user's repo is a template that outgrew its token list.
    const leftoverTokens: string[] = [];
    for (const rel of [...CLIENT_CORE_OWNED_PATHS, ...CLIENT_CORE_MARKED_FILES]) {
      const abs = join(out, rel);
      if (!existsSync(abs)) continue;
      for (const [file, content] of filesUnder(abs, out)) {
        const tokens = findUnsubstitutedIdentifierTokens(content);
        if (tokens.length > 0) leftoverTokens.push(`${file}: ${tokens.join(", ")}`);
      }
    }

    const ops = readFileSync(join(out, "packages/core/src/offline-ops.ts"), "utf-8");
    const apiLevel = readFileSync(join(out, "packages/shared/src/api-level.ts"), "utf-8");

    return [
      [
        "every rename in the table is exercised by the starter",
        new Set(starterCarries).size === IDENTIFIER_RENAMES.length ||
          failWith(
            "starter is missing",
            IDENTIFIER_RENAMES.map((r) => r.from).filter((f) => !starterCarries.includes(f)),
          ),
      ],
      [
        "no starter literal survives the apply",
        applied.length === 0 || failWith("left", applied),
      ],
      [
        "no identifier token survives the apply",
        leftoverTokens.length === 0 || failWith("left", leftoverTokens),
      ],
      [
        "the storage prefix comes from the identifiers",
        ops.includes('"acmetracker.offline-queue"'),
      ],
      [
        "so do the handshake headers",
        apiLevel.includes('"x-acmetracker-client-version"') &&
          apiLevel.includes('"x-acmetracker-api-level"') &&
          apiLevel.includes('"x-acmetracker-client"'),
      ],
      [
        "a header name is still a legal header name",
        (() => {
          try {
            new Headers({ "x-acmetracker-api-level": "2" });
            return true;
          } catch {
            return false;
          }
        })(),
      ],
    ];
  });

  group("create renames in place", () => {
    // `create` copies the whole starter and mutates the copy, so the rename runs
    // as one pass over what is on disk rather than per rendered file. Distinct
    // code path from `apply`, and the only one a scaffolded project ever sees.
    const out = join(tempDir("client-core-create-"), "project");
    cpSync(STARTER, out, { recursive: true, filter: notNodeModules });
    const ids = resolveIdentifiers({ name: "acme-tracker" });
    const first = renameClientCoreIdentifiers(out, ids);
    const after = snapshot(out);
    const second = renameClientCoreIdentifiers(out, ids);

    const leftovers: string[] = [];
    for (const rel of [...CLIENT_CORE_OWNED_PATHS, ...CLIENT_CORE_MARKED_FILES]) {
      const abs = join(out, rel);
      if (!existsSync(abs)) continue;
      for (const [file, content] of filesUnder(abs, out)) {
        const left = findStarterIdentifierLiterals(content);
        if (left.length > 0) leftovers.push(`${file}: ${left.join(", ")}`);
      }
    }

    return [
      ["it reports what it renamed", first.length === 1 && first[0]?.includes("file(s)")],
      ["no starter literal is left", leftovers.length === 0 || failWith("left", leftovers)],
      [
        "the storage prefix is the project's",
        readFileSync(join(out, "packages/core/src/offline-ops.ts"), "utf-8").includes(
          '"acmetracker.offline-queue"',
        ),
      ],
      ["a second pass renames nothing", second.length === 0],
      ["and changes no bytes", sameSnapshot(after, snapshot(out))],
    ];
  });

  group("manual wiring when an anchor is gone", () => {
    const out = strippedProject("client-core-noanchor-");
    const rel = CLIENT_CORE_MARKED_FILES.find((c) => existsSync(join(out, c))) as string;
    const path = join(out, rel);

    // Delete every line the starter's anchors rely on. The blocks then have no
    // unambiguous home, and must be handed over rather than guessed at.
    const anchorLines = new Set(
      anchoredBlocks(readFileSync(join(STARTER, rel), "utf-8")).flatMap(({ anchor }) =>
        anchor.map((line) => line.trim()),
      ),
    );
    writeFileSync(
      path,
      readFileSync(path, "utf-8")
        .split("\n")
        .filter((line) => !anchorLines.has(line.trim()))
        .join("\n"),
      "utf-8",
    );

    const { manual, logs } = apply(out);
    const checklist = join(out, ".hatchkit", "post-client-core.md");

    return [
      [`${rel}: a missing anchor produced a manual step`, manual > 0],
      [`${rel}: nothing was guessed into the file`, !hasMarkedBlocks(readFileSync(path, "utf-8"))],
      ["the checklist is written", existsSync(checklist)],
      [
        "the checklist names the file and shows the block",
        existsSync(checklist) &&
          readFileSync(checklist, "utf-8").includes(rel) &&
          readFileSync(checklist, "utf-8").includes("── client-core ──"),
      ],
      ["the run says so out loud", logs.some((line) => line.includes("need you"))],
      ["no checklist when nothing is left to do", renderClientCoreChecklist([]) === null],
    ];
  });

  // ── the kit does not reach into another feature's files ────────────

  group("the kit owns its own upgrade authentication", () => {
    // `sync/handler.ts` imported `authenticateUpgrade` from `../ws/auth.js`
    // until the sync feed grew its own `sessionFromCookie`. `ws/` belongs to
    // the `websocket` feature and `sync/` to this one, and the two are selected
    // independently — so that import was a TS2307 in every project that picked
    // the sync feed without the room socket. The create path papered over it by
    // keeping `ws/auth.ts` behind when client-core was on; `update` had no such
    // special case and shipped the broken import.
    //
    // Generalised, because the next such import would be just as invisible: no
    // file this feature owns may import from a directory another feature owns.
    const foreign: string[] = [];
    for (const rel of CLIENT_CORE_OWNED_PATHS) {
      const abs = join(STARTER, rel);
      if (!existsSync(abs)) continue;
      for (const [file, content] of filesUnder(abs, STARTER)) {
        for (const match of content.matchAll(/from\s+"([^"]+)"/g)) {
          const target = match[1] ?? "";
          if (/(^|\/)ws\//.test(target)) foreign.push(`${file} -> ${target}`);
        }
      }
    }

    const syncHandler = readFileSync(join(STARTER, "packages/server/src/sync/handler.ts"), "utf-8");

    return [
      [
        "no owned file imports out of packages/server/src/ws",
        foreign.length === 0 || failWith("imports", foreign),
      ],
      ["the sync feed resolves the session cookie itself", syncHandler.includes("sessionFromCookie")],
      ["and the bearer subprotocol path is still there", syncHandler.includes("sessionFromBearerSubprotocol")],
    ];
  });

  // ── update onto a project hatchkit itself scaffolded ───────────────

  // The scaffold itself, awaited out here: `group` takes a synchronous body,
  // and this is the one group that needs a real `scaffoldApp` run first.
  const scaffolded = join(tempDir("client-core-scaffolded-"), "project");
  const scaffoldName = "acme-tracker";
  console.log("\n(scaffolding a pruned project for the update group…)");
  await scaffoldApp(
    {
      name: scaffoldName,
      domain: `${scaffoldName}.example.com`,
      baseDomain: "example.com",
      subdomain: scaffoldName,
      surfaces: "fullstack",
      deploymentMode: "coolify",
      deployTarget: "existing",
      serverId: 1,
      serverIp: "1.2.3.4",
      features: [],
      provisionServices: [],
      s3Provider: "none",
      mongodbProvider: "external",
      mlServices: [],
      forceRedeployMl: [],
      scaffoldRepo: true,
      createGithubRepo: false,
      installDeps: false,
      runDeployment: false,
      dryRun: false,
    } as never,
    scaffolded,
  );

  group("update onto a scaffolded project", () => {
    // The groups above start from `strippedProject`, which is the starter with
    // only THIS feature stripped. A real project has been through every other
    // strip as well, and two of those rewrite files this feature has blocks in:
    // the `websocket` strip rewrites `packages/server/src/index.ts`, and the ML
    // prune removes `export * from "./ml-types.js";` from
    // `packages/shared/src/index.ts`. Both used to take an anchor with them, so
    // `update` handed four of its own blocks to the manual checklist — for a
    // project hatchkit had generated, which is the exact case the checklist was
    // meant to be the exception for. A silently unwired `setupSyncFeed` is a
    // sync feed that never listens.
    //
    // The project above is therefore the most-pruned one that can still take
    // the feature: fullstack, because the kit needs both halves, and then
    // nothing selected and no ML service, so every conditional strip takes its
    // "remove" arm.
    // Read before applying: these two assert what the SCAFFOLD did, and the
    // apply is about to add a block whose own comment names `./ml-types.js`.
    const prunedWs = !existsSync(join(scaffolded, "packages/server/src/ws"));
    const prunedMlExport = !/^export \* from "\.\/ml-types\.js";$/m.test(
      readFileSync(join(scaffolded, "packages/shared/src/index.ts"), "utf-8"),
    );

    const { manual, ledger } = apply(scaffolded, { name: scaffoldName });
    const rootPkg = readJsonAt(scaffolded, "package.json");
    const present = CLIENT_CORE_MARKED_FILES.filter((rel) => existsSync(join(scaffolded, rel)));
    const unwired = present.filter(
      (rel) => !hasMarkedBlocks(readFileSync(join(scaffolded, rel), "utf-8")),
    );
    const read = (rel: string): string => readFileSync(join(scaffolded, rel), "utf-8");

    return [
      // The scaffold really is the pruned shape this group is about. If a later
      // change stops pruning either one, the assertions below quietly stop
      // testing what they claim to.
      ["the scaffold pruned ws/", prunedWs],
      ["the scaffold pruned the ml-types re-export", prunedMlExport],
      ["nothing was handed to the checklist", manual === 0 || failWith("manual steps", [String(manual)])],
      ["no checklist file was written", !existsSync(join(scaffolded, CLIENT_CORE_CHECKLIST_PATH))],
      [
        "every marked file the project has was wired",
        unwired.length === 0 || failWith("not wired", unwired),
      ],
      [
        "the sync feed is actually registered on the server",
        read("packages/server/src/index.ts").includes("setupSyncFeed(server)"),
      ],
      [
        "the shared barrel re-exports the handshake",
        read("packages/shared/src/index.ts").includes('./api-level.js"'),
      ],
      [
        "the kit does not import the room socket's authenticator",
        !read("packages/server/src/sync/handler.ts").includes("../ws/auth.js"),
      ],
      // The project's `typecheck` is the starter's minus TWO segments here (this
      // feature's and the Electron one), which a whole-script equality test
      // could never recognise. Left unchained, `pnpm run typecheck` fails on
      // `Cannot find module '@starter/core'` — it resolves through `dist/` and
      // nothing built it.
      [
        "typecheck builds @starter/core",
        (rootPkg.scripts?.typecheck ?? "").includes(CORE_PACKAGE_NAME),
      ],
      [
        "and did not gain back a script the project had pruned",
        !(rootPkg.scripts?.typecheck ?? "").includes("typecheck:electron"),
      ],
      ["build builds @starter/core", (rootPkg.scripts?.build ?? "").includes(CORE_PACKAGE_NAME)],
      ["the ledger reports no conflict", ledger.conflicts().length === 0],
    ];
  });
}

// ── plumbing ─────────────────────────────────────────────────────────

group("feature plumbing", () => {
  return [
    ["client-core is a known --features value", KNOWN_FEATURES.includes("client-core")],
    ["it is registered in the feature registry", clientCoreFeature.id === "client-core"],
    ["it is addable after scaffold", clientCoreFeature.addableAfterScaffold],
    [
      "it declares the surfaces that have both halves",
      (clientCoreFeature.surfaces ?? []).join(",") === "fullstack,split",
    ],
    [
      "selecting it alone is a valid selection",
      expandFeatureSelection(["client-core"]).errors.length === 0,
    ],
    [
      "and pulls in no prerequisite it does not declare",
      expandFeatureSelection(["client-core"]).implied.length === 0,
    ],
    [
      "the owned paths and the marked files do not overlap",
      !CLIENT_CORE_OWNED_PATHS.some((owned) => CLIENT_CORE_MARKED_FILES.includes(owned)),
    ],
  ];
});

// ── helpers ──────────────────────────────────────────────────────────

function readJsonAt(
  dir: string,
  rel: string,
): { scripts?: Record<string, string>; dependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(join(dir, rel), "utf-8"));
}

/** `abs` and everything under it, as [projectRelativePath, contents]. */
function filesUnder(abs: string, projectDir: string): Array<[string, string]> {
  if (!statSync(abs).isDirectory()) {
    return [[abs.slice(projectDir.length + 1), readFileSync(abs, "utf-8")]];
  }
  const out: Array<[string, string]> = [];
  for (const entry of readdirSync(abs)) {
    if (entry === "node_modules" || entry === "dist") continue;
    out.push(...filesUnder(join(abs, entry), projectDir));
  }
  return out;
}

function notNodeModules(source: string): boolean {
  return !source.includes("/node_modules") && !source.includes("/.git");
}

/** Every text file under `dir` containing `needle`, as project-relative paths. */
function grepFiles(dir: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
      const path = join(current, entry);
      const stats = statSync(path);
      if (stats.isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(ts|tsx|js|mjs|cjs|json|md|yml|yaml)$/.test(entry)) continue;
      if (readFileSync(path, "utf-8").includes(needle)) {
        hits.push(path.slice(dir.length + 1));
      }
    }
  };
  walk(dir);
  return hits;
}

/** Print the offending paths, then fail the check. */
function failWith(label: string, paths: readonly string[]): false {
  console.log(`      ${label}: ${paths.join(", ")}`);
  return false;
}

for (const dir of temps) rmSync(dir, { recursive: true, force: true });

console.log("\n=== SUMMARY ===");
let allOk = true;
for (const [name, ok] of Object.entries(results)) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) allOk = false;
}
console.log();
process.exit(allOk ? 0 : 1);
