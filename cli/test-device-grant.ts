/*
 * The shared device-grant unit: what it writes, what it wires, and the
 * one question every caller has to ask it rather than answer itself.
 *
 * Everything asserted here fails QUIETLY in a scaffolded project:
 *
 *  - an allowlist that names one client when two are selected refuses
 *    the other with `invalid_client`, which reads to a person like the
 *    server being down;
 *  - a second application in the same run — which is what a project with
 *    two pairing clients does — writing a second `plugins:` key gives a
 *    duplicate object property, and the failure is on the user's first
 *    build, not here;
 *  - a strip that runs while a dependent is still selected deletes the
 *    page that client pairs through, and the client's code just never
 *    turns green;
 *  - a moved anchor in `auth.ts` scaffolds a client that shows a pairing
 *    code against a server with no device endpoint.
 *
 * Plus the four cases `docs/feature-authoring.md` asks for: idempotency,
 * dry run, user edits surviving, and no unrendered tokens.
 *
 * Run: `tsx test-device-grant.ts`.
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
import { FeatureLedger } from "./src/features/contract.js";
import {
  DEVICE_GRANT_DEPENDENTS,
  DEVICE_GRANT_OWNED_PATHS,
  applyDeviceGrant,
  deviceGrantClientIds,
  deviceGrantPlannedFiles,
  deviceGrantWanted,
  shouldStripDeviceGrant,
  stripDeviceGrant,
  validateClientExpression,
} from "./src/features/device-grant/index.js";
import {
  findUnrenderedTokens,
  listFeatureTemplates,
  renderFeatureTemplate,
} from "./src/features/templates.js";
import { resolveIdentifiers } from "./src/scaffold/identifiers.js";
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
const identifiers = resolveIdentifiers({ name: "example-app", orgDomain: "example.com" });

const manifestWith = (features: string[]): ProjectManifest =>
  ({
    name: "example-app",
    domain: "example.com",
    topology: "split",
    surfaces: "fullstack",
    ports: { server: 5123, client: 5124 },
    features,
  }) as unknown as ProjectManifest;

// ---------------------------------------------------------------------------
// The predicate
// ---------------------------------------------------------------------------

check("the dependent list is named once, and both directions read it", () => {
  assert.ok(DEVICE_GRANT_DEPENDENTS.includes("extension"));
  assert.ok(DEVICE_GRANT_DEPENDENTS.includes("raycast"));
  // `mcp` authenticates with an API token from `public-api`, not by
  // pairing. Listing it here would scaffold an approval page nothing
  // ever opens.
  assert.ok(!DEVICE_GRANT_DEPENDENTS.includes("mcp"));

  assert.equal(deviceGrantWanted(["extension"]), true);
  assert.equal(deviceGrantWanted(["raycast"]), true);
  assert.equal(deviceGrantWanted(["extension", "raycast"]), true);
  assert.equal(deviceGrantWanted(["client-core", "mcp", "public-api"]), false);
  assert.equal(deviceGrantWanted([]), false);

  // The strip asks the same question from the other end. They can never
  // disagree, which is the whole reason the predicate exists.
  for (const selection of [["extension"], ["raycast"], ["mcp"], []]) {
    assert.equal(shouldStripDeviceGrant(selection), !deviceGrantWanted(selection));
  }
});

check("the allowlist is one id per selected dependent, read from the identifiers", () => {
  assert.deepEqual(deviceGrantClientIds({ manifest: manifestWith(["extension"]), identifiers }), [
    identifiers.clientIds.extension,
  ]);
  assert.deepEqual(
    deviceGrantClientIds({ manifest: manifestWith(["raycast", "extension"]), identifiers }),
    // Dependent order, not selection order: an order that followed the
    // user's picks would rewrite auth.ts on every update.
    [identifiers.clientIds.extension, identifiers.clientIds.raycast],
  );
  assert.deepEqual(deviceGrantClientIds({ manifest: manifestWith(["mcp"]), identifiers }), []);
});

check("one client renders as the comparison projects already have", () => {
  assert.equal(validateClientExpression(["a-ext"]), 'clientId === "a-ext"');
  assert.equal(
    validateClientExpression(["a-ext", "a-ray"]),
    '["a-ext", "a-ray"].includes(clientId)',
  );
  // No dependent means refuse, never accept: an open pairing endpoint is
  // the one wrong answer here.
  assert.equal(validateClientExpression([]), "false");
});

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

check("every template renders with no placeholder left behind", () => {
  const templates = listFeatureTemplates("device-grant");
  assert.deepEqual(templates.sort(), ["client/device-approve.ts", "client/device-page.tsx"]);
  for (const rel of templates) {
    const leftover = findUnrenderedTokens(renderFeatureTemplate("device-grant", rel, {}));
    assert.deepEqual(leftover, [], `${rel} still has ${leftover.join(", ")}`);
  }
});

check("the planned file list is the list the apply writes", () => {
  assert.deepEqual(deviceGrantPlannedFiles().sort(), [
    "packages/client/src/app/device/page.tsx",
    "packages/client/src/lib/device-approve.ts",
  ]);
});

// ---------------------------------------------------------------------------
// Applying to a project
// ---------------------------------------------------------------------------

/** The starter files the unit edits, copied as they really are, so a
 *  moved anchor in the starter fails here rather than in a project. */
const PATCHED_FILES = [
  "packages/server/src/auth/auth.ts",
  "packages/client/src/lib/auth-client.ts",
];

const makeProject = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hatchkit-device-grant-"));
  for (const rel of PATCHED_FILES) {
    const to = join(dir, rel);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(STARTER_ROOT, rel), to);
  }
  return dir;
};

const applyTo = (
  dir: string,
  features: string[],
  opts: { dryRun?: boolean } = {},
): { ledger: FeatureLedger; problems: string[] } => {
  const ledger = new FeatureLedger(dir, opts.dryRun ?? false);
  ledger.scopeTo("device-grant");
  const problems = applyDeviceGrant({
    projectDir: dir,
    manifestDir: dir,
    manifest: manifestWith(features),
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
      else out.set(relative(dir, abs).split(sep).join("/"), readFileSync(abs, "utf-8"));
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

check("a fresh apply lands the page and wires both starter files", () => {
  withProject((dir) => {
    const { ledger, problems } = applyTo(dir, ["extension"]);
    assert.deepEqual(problems, []);
    assert.deepEqual(ledger.conflicts(), []);
    for (const rel of deviceGrantPlannedFiles()) {
      assert.ok(existsSync(join(dir, rel)), `${rel} was not written`);
    }

    const auth = readFileSync(join(dir, "packages/server/src/auth/auth.ts"), "utf-8");
    assert.ok(auth.includes('import { bearer } from "better-auth/plugins";'));
    assert.ok(auth.includes('from "better-auth/plugins/device-authorization";'));
    assert.ok(auth.includes("bearer(),"));
    assert.ok(auth.includes("deviceAuthorization({"));
    assert.ok(auth.includes(`clientId === "${identifiers.clientIds.extension}"`));
    // The verification URI has to point at the WEB app, not the API.
    assert.ok(auth.includes('${env.FRONTEND_URL.replace(/\\/$/, "")}/device'));
    // Exactly one plugin array, and it is inside the betterAuth call.
    assert.equal(auth.match(/^ {4}plugins: \[$/gm)?.length, 1);

    const client = readFileSync(join(dir, "packages/client/src/lib/auth-client.ts"), "utf-8");
    assert.ok(client.includes("deviceAuthorizationClient()"));
    assert.ok(client.includes('from "better-auth/client/plugins"'));
  });
});

check("applying twice — two dependents in one run — changes nothing", () => {
  withProject((dir) => {
    applyTo(dir, ["extension", "raycast"]);
    const before = snapshot(dir);
    const { ledger } = applyTo(dir, ["extension", "raycast"]);
    assert.deepEqual(ledger.summary().written, [], "a second apply wrote files");
    assert.equal(ledger.touched, false);
    const after = snapshot(dir);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
    for (const [file, content] of after) {
      assert.equal(content, before.get(file), `${file} changed on the second apply`);
    }
  });
});

check("adding a dependent later widens the allowlist instead of refusing it", () => {
  withProject((dir) => {
    applyTo(dir, ["extension"]);
    const authPath = join(dir, "packages/server/src/auth/auth.ts");
    assert.ok(
      readFileSync(authPath, "utf-8").includes(`clientId === "${identifiers.clientIds.extension}"`),
    );

    // `hatchkit update` adds the launcher months later.
    const { ledger } = applyTo(dir, ["extension", "raycast"]);
    const auth = readFileSync(authPath, "utf-8");
    assert.ok(
      auth.includes(
        `["${identifiers.clientIds.extension}", "${identifiers.clientIds.raycast}"].includes(clientId)`,
      ),
      "the second client was not added to the allowlist",
    );
    assert.ok(ledger.summary().written.includes("packages/server/src/auth/auth.ts"));
    // Still one plugin array; the block was refreshed, not re-inserted.
    assert.equal(auth.match(/^ {4}plugins: \[$/gm)?.length, 1);

    // And that widened state is itself a fixed point.
    const { ledger: third } = applyTo(dir, ["extension", "raycast"]);
    assert.deepEqual(third.summary().written, []);
  });
});

check("a dry run touches nothing and says what it would do", () => {
  withProject((dir) => {
    const before = snapshot(dir);
    const { ledger } = applyTo(dir, ["extension"], { dryRun: true });
    const after = snapshot(dir);
    assert.deepEqual(
      [...after.keys()].sort(),
      [...before.keys()].sort(),
      "a dry run created files",
    );
    for (const [file, content] of after) {
      assert.equal(content, before.get(file), `${file} changed during a dry run`);
    }
    const summary = ledger.summary();
    assert.deepEqual(summary.written, []);
    assert.ok(summary["would-write"].includes("packages/client/src/app/device/page.tsx"));
    assert.ok(summary["would-write"].includes("packages/server/src/auth/auth.ts"));
    assert.equal(ledger.touched, true);
  });
});

check("the approval page is the project's once written", () => {
  withProject((dir) => {
    applyTo(dir, ["extension"]);
    const page = join(dir, "packages/client/src/app/device/page.tsx");
    writeFileSync(page, "// mine\n", "utf-8");
    applyTo(dir, ["extension"]);
    assert.equal(readFileSync(page, "utf-8"), "// mine\n", "the approval page was overwritten");
  });
});

check("a moved anchor is reported, never silently skipped", () => {
  withProject((dir) => {
    // Somebody reordered the betterAuth options by hand.
    const authPath = join(dir, "packages/server/src/auth/auth.ts");
    writeFileSync(
      authPath,
      readFileSync(authPath, "utf-8").replace(
        "\n\n    emailAndPassword: {",
        "\n    emailAndPassword: {",
      ),
      "utf-8",
    );
    const { problems } = applyTo(dir, ["extension"]);
    assert.ok(
      problems.some((line) => line.includes("deviceAuthorization")),
      `messages were: ${problems.join(" | ")}`,
    );
  });
});

check("a hand-written validateClient is reported, not overwritten", () => {
  withProject((dir) => {
    applyTo(dir, ["extension"]);
    const authPath = join(dir, "packages/server/src/auth/auth.ts");
    const mine = readFileSync(authPath, "utf-8").replace(
      /validateClient: \(clientId: string\) => .*,/,
      "validateClient: (clientId: string) => myOwnRule(clientId),",
    );
    writeFileSync(authPath, mine, "utf-8");
    const { problems } = applyTo(dir, ["extension", "raycast"]);
    assert.equal(readFileSync(authPath, "utf-8"), mine, "a hand-written rule was overwritten");
    assert.ok(
      problems.some((line) => line.includes(identifiers.clientIds.raycast)),
      `messages were: ${problems.join(" | ")}`,
    );
  });
});

check("a caller with no pairing client is told, not given an open endpoint", () => {
  withProject((dir) => {
    const { problems } = applyTo(dir, ["mcp"]);
    assert.ok(
      problems.some((line) => line.includes("no client id")),
      problems.join(" | "),
    );
    assert.ok(
      readFileSync(join(dir, "packages/server/src/auth/auth.ts"), "utf-8").includes(
        "validateClient: (clientId: string) => false,",
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Stripping
// ---------------------------------------------------------------------------

check("the strip removes what the apply wrote, and is a no-op twice", () => {
  withProject((dir) => {
    applyTo(dir, ["extension"]);
    const first = stripDeviceGrant(dir);
    assert.ok(first.length > 0, "the strip reported nothing");
    for (const rel of DEVICE_GRANT_OWNED_PATHS) {
      assert.equal(existsSync(join(dir, rel)), false, `${rel} survived the strip`);
    }
    // The auth wiring is named as a manual step rather than un-edited:
    // an automated un-edit of somebody's auth config can lock a running
    // deployment out.
    assert.ok(first.some((line) => line.includes("auth.ts")));
    assert.ok(
      readFileSync(join(dir, "packages/server/src/auth/auth.ts"), "utf-8").includes("bearer(),"),
    );

    assert.deepEqual(stripDeviceGrant(dir), [], "a second strip reported work");
  });
});

check("stripping a project that never had it reports nothing", () => {
  withProject((dir) => {
    assert.deepEqual(stripDeviceGrant(dir), []);
  });
});

if (failures.length > 0) {
  console.error("\ndevice grant failures:");
  for (const line of failures) console.error(line);
  process.exit(1);
}
console.log("device grant ok");
