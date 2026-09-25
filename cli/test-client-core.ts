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
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const {
  CLIENT_CORE_MARKED_FILES,
  CLIENT_CORE_OWNED_PATHS,
  CLIENT_CORE_ROOT_SCRIPTS,
  CORE_PACKAGE_NAME,
  UnbalancedMarkerError,
  addClientCore,
  anchoredBlocks,
  hasMarkedBlocks,
  insertAfter,
  readMarkedBlocks,
  stripClientCore,
  stripMarkedBlocks,
  unchainSegment,
  writeClientCoreChecklist,
} = await import("./src/features/client-core/index.js");
const { KNOWN_FEATURES } = await import("./src/utils/flags.js");

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
    // `packages/server/contract` is generated by `pnpm run contract:emit`, so
    // it is on the strip list without being in the template.
    const generated = new Set(["packages/server/contract"]);
    return CLIENT_CORE_OWNED_PATHS.filter((rel) => !generated.has(rel)).map(
      (rel) => [`${rel} present`, existsSync(join(STARTER, rel))] as [string, boolean],
    );
  });

  group("strip leaves no trace", () => {
    const dir = tempDir("client-core-strip-");
    const out = join(dir, "project");
    cpSync(STARTER, out, { recursive: true, filter: notNodeModules });
    stripClientCore(out);

    const rootPkg = JSON.parse(readFileSync(join(out, "package.json"), "utf-8")) as {
      scripts?: Record<string, string>;
    };
    // CLAUDE.md is not the strip's business: its client-core section sits in a
    // `<!-- hatchkit:if client-core -->` block that `applyClaudeMd` prunes later
    // in the same scaffold run. Asserted separately, just below.
    const referencing = grepFiles(out, CORE_PACKAGE_NAME).filter((rel) => rel !== "CLAUDE.md");
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
              depth += open[1] === "client-core" ? 1000 : 1;
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

  group("add restores the feature", () => {
    const dir = tempDir("client-core-add-");
    const out = join(dir, "project");
    cpSync(STARTER, out, { recursive: true, filter: notNodeModules });
    stripClientCore(out);
    const result = addClientCore(out, STARTER);

    const serverPkg = JSON.parse(
      readFileSync(join(out, "packages/server/package.json"), "utf-8"),
    ) as { dependencies?: Record<string, string> };
    const clientPkg = JSON.parse(
      readFileSync(join(out, "packages/client/package.json"), "utf-8"),
    ) as { dependencies?: Record<string, string> };
    const rootPkg = JSON.parse(readFileSync(join(out, "package.json"), "utf-8")) as {
      scripts?: Record<string, string>;
    };

    const restored = CLIENT_CORE_MARKED_FILES.filter((rel) => existsSync(join(STARTER, rel))).map(
      (rel) =>
        [
          `${rel} matches the starter again`,
          sameCode(
            readFileSync(join(out, rel), "utf-8"),
            readFileSync(join(STARTER, rel), "utf-8"),
          ),
        ] as [string, boolean],
    );

    return [
      ["packages/core is back", existsSync(join(out, "packages/core/src/offline-queue.ts"))],
      ["nothing needed a human", result.manual.length === 0 || failWith("manual", result.manual.map((m) => m.file))],
      ...restored,
      ["the server depends on @starter/core", serverPkg.dependencies?.[CORE_PACKAGE_NAME] === "workspace:*"],
      ["the client depends on @starter/core", clientPkg.dependencies?.[CORE_PACKAGE_NAME] === "workspace:*"],
      ["contract:emit is back", (rootPkg.scripts?.["contract:emit"] ?? "").length > 0],
      [
        "the server's test script builds @starter/core again",
        (
          (
            JSON.parse(readFileSync(join(out, "packages/server/package.json"), "utf-8")) as {
              scripts?: Record<string, string>;
            }
          ).scripts?.test ?? ""
        ).includes(CORE_PACKAGE_NAME),
      ],
      [
        "build and typecheck build @starter/core again",
        (rootPkg.scripts?.build ?? "").includes(CORE_PACKAGE_NAME) &&
          (rootPkg.scripts?.typecheck ?? "").includes(CORE_PACKAGE_NAME),
      ],
      ["adding twice is a no-op", (() => {
        const before = CLIENT_CORE_MARKED_FILES.map((rel) =>
          existsSync(join(out, rel)) ? readFileSync(join(out, rel), "utf-8") : "",
        );
        addClientCore(out, STARTER);
        const after = CLIENT_CORE_MARKED_FILES.map((rel) =>
          existsSync(join(out, rel)) ? readFileSync(join(out, rel), "utf-8") : "",
        );
        return before.every((content, index) => content === after[index]);
      })()],
    ];
  });

  group("add never overwrites a user's edits", () => {
    const dir = tempDir("client-core-edits-");
    const out = join(dir, "project");
    cpSync(STARTER, out, { recursive: true, filter: notNodeModules });
    stripClientCore(out);

    // Pick a marked file and edit it the way a user would: add a line that has
    // nothing to do with the feature. The anchors must still be found.
    const rel = CLIENT_CORE_MARKED_FILES.find((candidate) =>
      existsSync(join(out, candidate)),
    ) as string;
    const path = join(out, rel);
    const edited = `${readFileSync(path, "utf-8")}\n// a line the user added\n`;
    writeFileSync(path, edited, "utf-8");

    const result = addClientCore(out, STARTER);
    const after = readFileSync(path, "utf-8");

    // Now the hostile case: an anchor the user deleted. The block must land in
    // the checklist rather than be guessed at.
    const dir2 = tempDir("client-core-noanchor-");
    const out2 = join(dir2, "project");
    cpSync(STARTER, out2, { recursive: true, filter: notNodeModules });
    stripClientCore(out2);
    const rel2 = rel;
    const path2 = join(out2, rel2);
    const anchorLines = new Set(
      anchoredBlocks(readFileSync(join(STARTER, rel2), "utf-8")).flatMap(({ anchor }) =>
        anchor.map((line) => line.trim()),
      ),
    );
    const gutted = readFileSync(path2, "utf-8")
      .split("\n")
      .filter((line) => !anchorLines.has(line.trim()))
      .join("\n");
    writeFileSync(path2, gutted, "utf-8");
    const result2 = addClientCore(out2, STARTER);
    const checklist = writeClientCoreChecklist(out2, result2.manual);

    return [
      [`${rel}: the user's line survived`, after.includes("// a line the user added")],
      [`${rel}: the blocks were still wired in`, hasMarkedBlocks(after)],
      [`${rel}: no manual step was needed`, result.manual.length === 0],
      [`${rel2}: a missing anchor produced a manual step`, result2.manual.length > 0],
      [
        `${rel2}: nothing was guessed into the file`,
        !hasMarkedBlocks(readFileSync(path2, "utf-8")),
      ],
      [
        "the checklist is written to .hatchkit/post-client-core.md",
        checklist !== null && existsSync(checklist),
      ],
      [
        "the checklist names the file and shows the block",
        checklist !== null &&
          readFileSync(checklist, "utf-8").includes(rel2) &&
          readFileSync(checklist, "utf-8").includes("── client-core ──"),
      ],
      ["no checklist when nothing is left to do", writeClientCoreChecklist(out, []) === null],
    ];
  });
}

// ── plumbing ─────────────────────────────────────────────────────────

group("feature plumbing", () => {
  return [
    ["client-core is a known --features value", KNOWN_FEATURES.includes("client-core")],
    [
      "the owned paths and the marked files do not overlap",
      !CLIENT_CORE_OWNED_PATHS.some((owned) => CLIENT_CORE_MARKED_FILES.includes(owned)),
    ],
  ];
});

// ── helpers ──────────────────────────────────────────────────────────

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
