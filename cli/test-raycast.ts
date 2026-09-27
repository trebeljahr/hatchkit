/*
 * The `raycast` feature: what it copies, what it renames, and what a strip
 * has to take with it.
 *
 * Everything asserted here fails QUIETLY in a scaffolded project:
 *
 *  - a literal the rename table forgot ships somebody else's product name,
 *    somebody else's device-flow client id, or `https://api.starter.example`
 *    as the origin a release build talks to. All three build, install and
 *    run; the last one simply never reaches a server;
 *  - the reverse — a literal removed from the starter but left in the table —
 *    is a rename that silently stops happening, and the test that only
 *    checked the output would still pass;
 *  - a strip that leaves `packages/raycast` out of the lockfile's importers
 *    fails the user's first `pnpm install --frozen-lockfile`, which is their
 *    CI or their image build, long after the scaffold said it was done;
 *  - a strip that leaves a `pnpm --filter <package>` root script behind fails
 *    that script outright, because a filter matching nothing is an error
 *    rather than a skip;
 *  - a non-idempotent apply takes the user's edits back on the next `update`,
 *    with nothing failing to say so;
 *  - the icon copied through a UTF-8 string is an icon `ray build` refuses,
 *    and the corruption is invisible in a diff.
 *
 * Plus the four cases `docs/feature-authoring.md` asks for: idempotency, a
 * dry run, user edits surviving, and no unrendered tokens.
 *
 * Run: `tsx test-raycast.ts`.
 */
import assert from "node:assert/strict";
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
import { dirname, join, relative, sep } from "node:path";
import { starterFilesUnder } from "./src/features/client-core/index.js";
import { FeatureLedger, expandFeatureSelection } from "./src/features/contract.js";
import { lockfileImporters } from "./src/features/lockfile.js";
import {
  RAYCAST_IDENTIFIER_RENAMES,
  RAYCAST_OWNED_PATHS,
  RAYCAST_SCRIPT_NAMES,
  RAYCAST_STARTER_PACKAGE_NAME,
  applyRaycast,
  findRaycastIdentifierLiterals,
  raycastFeature,
  raycastPlannedFiles,
  raycastResidue,
  raycastRootScripts,
  stripRaycast,
} from "./src/features/raycast/index.js";
import {
  findUnsubstitutedIdentifierTokens,
  resolveIdentifiers,
} from "./src/scaffold/identifiers.js";
import type { ProjectManifest } from "./src/scaffold/manifest.js";

const failures: string[] = [];
const check = (name: string, run: () => void): void => {
  try {
    run();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(`  ✗ ${name}: ${(error as Error).message}`);
  }
};

const STARTER_ROOT = join(import.meta.dirname, "..", "starter");
const PACKAGE_DIR = join(STARTER_ROOT, "packages", "raycast");

const identifiers = resolveIdentifiers({ name: "probe-app", orgDomain: "probe.example" });

const manifest = {
  name: "probe-app",
  domain: "probe-app.com",
  topology: "split",
  surfaces: "fullstack",
  ports: { server: 5123, client: 5124 },
  features: ["client-core", "raycast"],
} as unknown as ProjectManifest;

/** The starter files the device grant patches; the launcher's apply calls it. */
const PATCHED_FILES = [
  "packages/server/src/auth/auth.ts",
  "packages/client/src/lib/auth-client.ts",
];

const makeProject = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hatchkit-raycast-"));
  for (const rel of PATCHED_FILES) {
    const to = join(dir, rel);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(STARTER_ROOT, rel), to);
  }
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "probe-app", scripts: { build: "tsc" } }, null, 2)}\n`,
  );
  return dir;
};

const applyTo = (
  dir: string,
  opts: { dryRun?: boolean } = {},
): { ledger: FeatureLedger; problems: string[] } => {
  const ledger = new FeatureLedger(dir, opts.dryRun ?? false);
  ledger.scopeTo("raycast");
  const problems = applyRaycast({
    projectDir: dir,
    manifestDir: dir,
    manifest,
    identifiers,
    mode: "create",
    ledger,
    log: () => {},
  });
  return { ledger, problems };
};

const snapshot = (dir: string): Map<string, string> => {
  const out = new Map<string, string>();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const abs = join(current, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else out.set(relative(dir, abs).split(sep).join("/"), readFileSync(abs, "base64"));
    }
  };
  walk(dir);
  return out;
};

const withProject = (run: (dir: string) => void): void => {
  const dir = makeProject();
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** Every text file the apply wrote under `packages/raycast`. */
const appliedTextFiles = (dir: string): Array<[string, string]> =>
  starterFilesUnder(dir, "packages/raycast")
    .filter((rel) => !/\.(png|jpe?g|ico|gif|webp)$/i.test(rel))
    .map((rel) => [rel, readFileSync(join(dir, rel), "utf-8")] as [string, string]);

// ---------------------------------------------------------------------------
// The package the starter ships
// ---------------------------------------------------------------------------

check("the starter ships the launcher package, with the icon its build needs", () => {
  assert.ok(existsSync(join(PACKAGE_DIR, "package.json")), "packages/raycast is missing");
  // `ray build` and `ray develop` both fail outright without this file.
  assert.ok(existsSync(join(PACKAGE_DIR, "assets", "extension-icon.png")));
  assert.ok(existsSync(join(PACKAGE_DIR, "src", "vendor", "index.ts")));
  assert.ok(existsSync(join(PACKAGE_DIR, "scripts", "vendor-core.mjs")));
  assert.ok(existsSync(join(PACKAGE_DIR, "scripts", "export-store.mjs")));
  // The one thing the export must NOT copy: publishing is manual.
  assert.ok(existsSync(join(PACKAGE_DIR, "PUBLISHING.md")));
});

check("the package imports the shared kit only through the vendored barrel", () => {
  // A `workspace:*` import cannot resolve on the store's build machine, where
  // there is no workspace — the package is built alone with a plain install.
  const manifestText = readFileSync(join(PACKAGE_DIR, "package.json"), "utf-8");
  assert.ok(!manifestText.includes("workspace:"), "the launcher declares a workspace dependency");
  for (const rel of starterFilesUnder(STARTER_ROOT, "packages/raycast")) {
    if (!/\.tsx?$/.test(rel) || rel.includes("/vendor/")) continue;
    const text = readFileSync(join(STARTER_ROOT, rel), "utf-8");
    assert.ok(
      !/from\s+"@starter\//.test(text),
      `${rel} imports the shared kit directly instead of through src/vendor`,
    );
  }
});

check("the workspace package is named after the store slug, not the npm scope", () => {
  // Raycast reads `name` as the extension id, and pnpm reads the same field.
  const pkg = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf-8"));
  assert.equal(pkg.name, RAYCAST_STARTER_PACKAGE_NAME);
  assert.ok(!pkg.name.startsWith("@"), "a scoped name is not a valid store slug");
});

// ---------------------------------------------------------------------------
// The renames, in both directions
// ---------------------------------------------------------------------------

check("the starter still carries every literal the rename table names", () => {
  // The direction that is easy to forget. A literal deleted from the starter
  // and left in the table is a rename that silently stops happening, and a
  // test that only looked at the output would still pass.
  const all = starterFilesUnder(STARTER_ROOT, "packages/raycast")
    .filter((rel) => !/\.(png|jpe?g|ico|gif|webp)$/i.test(rel))
    .map((rel) => readFileSync(join(STARTER_ROOT, rel), "utf-8"))
    .join("\n");
  for (const { from } of RAYCAST_IDENTIFIER_RENAMES) {
    assert.ok(all.includes(from), `the starter no longer contains ${JSON.stringify(from)}`);
  }
});

check("nothing the feature applied still carries a starter literal", () => {
  withProject((dir) => {
    applyTo(dir);
    for (const [rel, text] of appliedTextFiles(dir)) {
      assert.deepEqual(
        findRaycastIdentifierLiterals(text),
        [],
        `${rel} still carries a starter literal`,
      );
    }
  });
});

check("the applied names come from the identifiers, never from a rule here", () => {
  withProject((dir) => {
    applyTo(dir);
    const pkg = JSON.parse(readFileSync(join(dir, "packages/raycast/package.json"), "utf-8"));
    assert.equal(pkg.name, identifiers.slug);
    assert.equal(pkg.author, identifiers.token);
    assert.equal(pkg.title, identifiers.productName);

    const clientId = readFileSync(join(dir, "packages/raycast/src/lib/client-id.ts"), "utf-8");
    assert.ok(clientId.includes(`"${identifiers.clientIds.raycast}"`));

    const preferences = readFileSync(join(dir, "packages/raycast/src/lib/preferences.ts"), "utf-8");
    // `split` topology, so the API is on its own subdomain — the same
    // function the web client's build args come from.
    assert.ok(preferences.includes('"https://api.probe-app.com"'));
    assert.ok(preferences.includes('"https://probe-app.com"'));
    // The PINNED dev ports from the manifest, not the starter's.
    assert.ok(preferences.includes('"http://localhost:5123"'));
    assert.ok(preferences.includes('"http://localhost:5124"'));
  });
});

check("the vendored copy is renamed exactly as packages/core is", () => {
  withProject((dir) => {
    applyTo(dir);
    const vendored = readFileSync(join(dir, "packages/raycast/src/vendor/offline-ops.ts"), "utf-8");
    // The launcher runs `client-core`'s own rename over the vendored tree, so
    // the storage keys and the handshake headers come out identical to
    // `packages/core`'s. A launcher renamed by a different rule would report
    // the whole vendored tree as stale on the user's first test run.
    assert.ok(vendored.includes(`"${identifiers.storagePrefix}.offline-queue"`));
    assert.ok(!vendored.includes('"starter.offline-queue"'));

    const apiLevel = readFileSync(join(dir, "packages/raycast/src/vendor/api-level.ts"), "utf-8");
    assert.ok(apiLevel.includes(`"${identifiers.clientHeader}"`));
    assert.ok(apiLevel.includes(`"${identifiers.clientHeader}-version"`));
  });
});

check("no unrendered identifier token reaches the project", () => {
  withProject((dir) => {
    applyTo(dir);
    for (const [rel, text] of appliedTextFiles(dir)) {
      assert.deepEqual(
        findUnsubstitutedIdentifierTokens(text),
        [],
        `${rel} still carries an identifier token`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The apply
// ---------------------------------------------------------------------------

check("a fresh apply lands every planned file", () => {
  withProject((dir) => {
    const { ledger } = applyTo(dir);
    assert.deepEqual(ledger.conflicts(), []);
    const planned = raycastPlannedFiles({
      projectDir: dir,
      manifestDir: dir,
      manifest,
      identifiers,
    });
    assert.ok(planned.length > 20, `only ${planned.length} files planned`);
    for (const rel of planned) {
      assert.ok(existsSync(join(dir, rel)), `${rel} was not written`);
    }
  });
});

check("the icon arrives byte-for-byte", () => {
  withProject((dir) => {
    applyTo(dir);
    const source = readFileSync(join(PACKAGE_DIR, "assets", "extension-icon.png"));
    const landed = readFileSync(join(dir, "packages/raycast/assets/extension-icon.png"));
    // A PNG round-tripped through a UTF-8 string is a PNG the launcher's
    // build refuses, and the corruption does not show in a diff.
    assert.ok(source.equals(landed), "the icon was not copied as bytes");
  });
});

check("the root scripts name the package, because the aggregates cannot find it", () => {
  withProject((dir) => {
    applyTo(dir);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    for (const [name, value] of Object.entries(raycastRootScripts(identifiers.slug))) {
      assert.equal(pkg.scripts[name], value, `root script ${name}`);
    }
    // Add-only: the project's own script is untouched.
    assert.equal(pkg.scripts.build, "tsc");
  });
});

check("the device grant is applied, so the launcher has something to pair with", () => {
  withProject((dir) => {
    applyTo(dir);
    const auth = readFileSync(join(dir, "packages/server/src/auth/auth.ts"), "utf-8");
    assert.ok(auth.includes("deviceAuthorization({"));
    assert.ok(auth.includes("bearer(),"));
    assert.ok(auth.includes(`clientId === "${identifiers.clientIds.raycast}"`));
    assert.ok(existsSync(join(dir, "packages/client/src/app/device/page.tsx")));
  });
});

check("applying twice changes nothing", () => {
  withProject((dir) => {
    applyTo(dir);
    const before = snapshot(dir);
    const { ledger } = applyTo(dir);
    assert.deepEqual(ledger.summary().written, []);
    assert.deepEqual(ledger.conflicts(), []);
    assert.deepEqual([...snapshot(dir).entries()], [...before.entries()]);
  });
});

check("a dry run writes nothing and says what it would write", () => {
  withProject((dir) => {
    const before = snapshot(dir);
    const { ledger } = applyTo(dir, { dryRun: true });
    assert.deepEqual([...snapshot(dir).entries()], [...before.entries()]);
    assert.ok(ledger.summary()["would-write"].length > 20);
    assert.deepEqual(ledger.summary().written, []);
    assert.ok(!existsSync(join(dir, "packages/raycast")));
  });
});

check("a user's edit survives the next apply", () => {
  withProject((dir) => {
    applyTo(dir);
    const rel = "packages/raycast/src/list-items.tsx";
    const mine = `${readFileSync(join(dir, rel), "utf-8")}\n// my own change\n`;
    writeFileSync(join(dir, rel), mine);

    // And a root script the user rewrote: reported, never reverted.
    const pkgPath = join(dir, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    pkg.scripts["test:raycast"] = "echo mine";
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

    const { ledger } = applyTo(dir);
    assert.equal(readFileSync(join(dir, rel), "utf-8"), mine);
    assert.equal(JSON.parse(readFileSync(pkgPath, "utf-8")).scripts["test:raycast"], "echo mine");
    assert.ok(
      ledger.conflicts().some((entry) => entry.detail?.includes("test:raycast")),
      "the changed script was not reported as a conflict",
    );
  });
});

// ---------------------------------------------------------------------------
// The strip
// ---------------------------------------------------------------------------

const LOCKFILE = [
  "lockfileVersion: '9.0'",
  "",
  "importers:",
  "",
  "  .:",
  "    dependencies:",
  "      react:",
  "        specifier: 19.0.0",
  "        version: 19.0.0",
  "",
  "  packages/raycast:",
  "    dependencies:",
  "      zod:",
  "        specifier: ^4.4.3",
  "        version: 4.4.3",
  "",
  "  packages/server:",
  "    dependencies:",
  "      express:",
  "        specifier: ^5.0.0",
  "        version: 5.0.0",
  "",
  "packages:",
  "",
  "  zod@4.4.3: {}",
  "",
].join("\n");

check("the strip leaves no file, no root script and no lockfile importer", () => {
  withProject((dir) => {
    applyTo(dir);
    writeFileSync(join(dir, "pnpm-lock.yaml"), LOCKFILE);
    mkdirSync(join(dir, "packages", "server"), { recursive: true });
    writeFileSync(
      join(dir, "packages", "server", "package.json"),
      `${JSON.stringify({ name: "server", dependencies: { express: "^5.0.0" } }, null, 2)}\n`,
    );
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify(
        {
          name: "probe-app",
          dependencies: { react: "19.0.0" },
          scripts: { build: "tsc", ...raycastRootScripts(identifiers.slug) },
        },
        null,
        2,
      )}\n`,
    );

    const notes = stripRaycast(dir);
    assert.ok(notes.some((line) => line.startsWith("removed: raycast")));

    for (const rel of RAYCAST_OWNED_PATHS) {
      assert.ok(!existsSync(join(dir, rel)), `${rel} survived the strip`);
    }
    // A `pnpm --filter <package>` script against a workspace with no such
    // package is an ERROR, not a skip.
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    for (const name of RAYCAST_SCRIPT_NAMES) {
      assert.equal(pkg.scripts[name], undefined, `root script ${name} survived`);
    }
    assert.equal(pkg.scripts.build, "tsc");

    // A stale importer fails the user's first `pnpm install --frozen-lockfile`,
    // which is their CI or their image build — long after the scaffold said
    // it was done.
    const importers = lockfileImporters(readFileSync(join(dir, "pnpm-lock.yaml"), "utf-8"));
    assert.deepEqual(importers, [".", "packages/server"]);

    // Nothing anywhere still refers to the launcher. Checked on "raycast"
    // rather than on the slug, which is the PROJECT's name and legitimately
    // stays in the manifest.
    for (const rel of ["package.json", "pnpm-lock.yaml"]) {
      const text = readFileSync(join(dir, rel), "utf-8");
      assert.ok(!text.includes("raycast"), `${rel} still refers to the launcher`);
    }
  });
});

check("the strip is a no-op on a tree that never had the launcher", () => {
  withProject((dir) => {
    const before = snapshot(dir);
    assert.deepEqual(stripRaycast(dir), []);
    assert.deepEqual([...snapshot(dir).entries()], [...before.entries()]);
    // `hatchkit adopt` runs strips over repos of unknown provenance, so a
    // second run has to be free.
    assert.deepEqual(stripRaycast(dir), []);
  });
});

// ---------------------------------------------------------------------------
// The registration
// ---------------------------------------------------------------------------

check("selecting the launcher alone pulls the client kit in, first", () => {
  const selection = expandFeatureSelection([raycastFeature.id]);
  assert.deepEqual(selection.errors, []);
  assert.ok(selection.implied.includes("client-core"), "client-core was not implied");
  assert.ok(
    selection.ordered.indexOf("client-core") < selection.ordered.indexOf(raycastFeature.id),
    "client-core must apply first — the vendor generator reads packages/core",
  );
});

check("the feature refuses the surfaces it cannot serve, with the reason", () => {
  assert.deepEqual(raycastFeature.surfaces, ["fullstack", "split"]);
  assert.equal(raycastFeature.addableAfterScaffold, true);
});

check("the residue names the two permanent decisions", () => {
  const residue = raycastResidue(identifiers.slug);
  assert.ok(residue.some((line) => line.includes("PERMANENT")));
  assert.ok(residue.some((line) => line.includes(identifiers.slug)));
  assert.ok(residue.some((line) => line.includes("test:unit")));
});

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const failure of failures) console.error(failure);
  process.exit(1);
}
console.log("\nraycast ok");
