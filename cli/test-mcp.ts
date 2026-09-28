/*
 * The `mcp` feature: what it writes, what it renames, and the one thing it
 * cannot express in the type system.
 *
 * Everything asserted here fails QUIETLY if it regresses:
 *
 *  - the MCP package mirrors `public-api`'s route table, because that table
 *    lives in a server package the starter does not ship (the REST surface is
 *    an opt-in feature) and therefore cannot be imported. A route added,
 *    renamed or re-scoped on one side and not the other means a model calls a
 *    tool for a route that does not exist and reports the 404 as the user's
 *    mistake. THIS FILE IS WHAT CLOSES THAT GAP, and it is the reason the
 *    mirror is allowed to exist at all;
 *  - an env-var name or a binary name left as the starter's literal is a name
 *    in every user's host configuration file that does not match the project;
 *  - a default origin still pointing at the starter's development port is an
 *    integration that silently talks to nothing;
 *  - a strip that leaves `pnpm --filter @starter/mcp` in a root script fails a
 *    scaffold's own test command with ERR_PNPM_NO_MATCHING_PACKAGE.
 *
 * Plus the four cases `docs/feature-authoring.md` asks every feature to
 * cover: idempotency, dry run, user edits surviving, and no unrendered
 * tokens.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */

import assert from "node:assert/strict";
import {
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
import { join, relative, sep } from "node:path";
import { expandFeatureSelection } from "./src/features/all.js";
import { FeatureLedger } from "./src/features/contract.js";
import {
  MCP_IDENTIFIER_RENAMES,
  MCP_OWNED_PATHS,
  MCP_PACKAGE_NAME,
  MCP_ROOT_SCRIPTS,
  MCP_STARTER_DEV_ORIGIN,
  MCP_TEST_AGGREGATE,
  MCP_TEST_SEGMENT,
  PUBLIC_API_ROUTE_TABLE,
  findMcpIdentifierLiterals,
  mcpFeature,
  mcpPlannedFiles,
  mcpPrerequisiteProblem,
  stripMcp,
} from "./src/features/mcp/index.js";
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

const REPO_ROOT = join(import.meta.dirname, "..");
const STARTER_ROOT = join(REPO_ROOT, "starter");
const MCP_SRC = join(STARTER_ROOT, "packages", "mcp");
const PUBLIC_API_TEMPLATES = join(
  REPO_ROOT,
  "cli",
  "src",
  "templates",
  "features",
  "public-api",
);

const identifiers = resolveIdentifiers({ name: "example-app", orgDomain: "example.com" });

const manifest = {
  name: "example-app",
  domain: "example.com",
  topology: "split",
  surfaces: "fullstack",
  ports: { server: 5123, client: 5124 },
  features: ["client-core", "public-api", "mcp"],
} as unknown as ProjectManifest;

/* ================================================================== */
/* The pin: the mirrored route table against the real one             */
/* ================================================================== */

type TemplateRoute = {
  method: string;
  path: string;
  scope: string | null;
  summary: string;
  /** `schema` is a string in the mirror and a stub function in the template. */
  input: { source: string; schema: unknown } | null;
  isPublic?: true;
};

/** The schema's declared name, whichever side of the comparison it came from. */
const schemaName = (schema: unknown): string =>
  typeof schema === "function" ? (schema as { name: string }).name : String(schema);

/**
 * Evaluate the `API_ROUTES` array out of the public-api template.
 *
 * The template is TypeScript that imports zod, the shared package and two
 * server modules, none of which resolve from this package — so it cannot be
 * imported. The array itself is pure data apart from the `schema:` values,
 * which are identifiers; a `with` block over a Proxy that answers every
 * identifier with its own NAME turns those into the strings the mirror
 * records, which is exactly what we want to compare.
 *
 * A structural read rather than a regex per field: the summaries contain
 * commas, backticks and quotes, and a regex that got one of them wrong would
 * silently compare fewer routes than there are.
 */
function templateRoutes(): TemplateRoute[] {
  const source = readFileSync(join(PUBLIC_API_TEMPLATES, "api/v1/routes-table.ts.tpl"), "utf-8");
  const declaration = source.indexOf("export const API_ROUTES");
  assert.notEqual(declaration, -1, "the template no longer declares API_ROUTES");
  const literal = source.slice(source.indexOf("[", declaration), source.lastIndexOf("];") + 1);
  // Every identifier resolves to a named, self-returning function, so both
  // `schema: itemListSchema` and `output: dataOf(identitySchema)` evaluate —
  // the first to something whose `.name` is the schema the mirror records,
  // the second to a value nothing compares.
  const scope = new Proxy(
    {},
    {
      has: () => true,
      get: (_target, key) => {
        if (typeof key !== "string") return undefined;
        const stub = (): unknown => stub;
        Object.defineProperty(stub, "name", { value: key });
        return stub;
      },
    },
  );
  // eslint-disable-next-line no-new-func — the input is a file in this repo.
  const read = new Function("scope", `with (scope) { return ${literal}; }`) as (
    scope: unknown,
  ) => TemplateRoute[];
  return read(scope);
}

/** The mirror, loaded from the starter package. It imports nothing, on purpose. */
const mirror = (await import(join(MCP_SRC, "src", "routes.ts"))) as {
  API_ROUTES: TemplateRoute[];
  API_TOKEN_SCOPES: string[];
  WEBHOOK_EVENTS: string[];
};

/**
 * The tool table, read out of `tools.ts` rather than imported.
 *
 * Unlike `routes.ts`, `tools.ts` imports `zod` and `@starter/shared`, and
 * those resolve only after a `pnpm install` inside `starter/`. A developer's
 * checkout may have one; CI never does, so an import here passed locally and
 * crashed the suite on the runner. The two facts this file checks are plain
 * data in the source anyway: each tool's own `route: route("<method>",
 * "<path>")` line, and the `UNTOOLED_ROUTES` literal.
 */
function toolTable(): {
  tooled: { method: string; path: string }[];
  untooled: { method: string; path: string; reason: string }[];
} {
  const source = readFileSync(join(MCP_SRC, "src", "tools.ts"), "utf-8");
  const definitions = source.indexOf("export const TOOL_DEFINITIONS");
  const exclusions = source.indexOf("export const UNTOOLED_ROUTES");
  assert.notEqual(definitions, -1, "tools.ts no longer declares TOOL_DEFINITIONS");
  assert.notEqual(exclusions, -1, "tools.ts no longer declares UNTOOLED_ROUTES");
  // One chunk per `defineTool({ … })` call. The definition's own `route:` is
  // the one at property indentation; the deeper ones are arguments to the
  // requests its `run` makes.
  const tooled = source
    .slice(definitions, exclusions)
    .split("defineTool({")
    .slice(1)
    .map((chunk) => {
      const match = /^ {4}route: route\("(\w+)", "([^"]+)"\),$/m.exec(chunk);
      assert.ok(match, `a tool with no route of its own: ${chunk.slice(0, 80).trim()}`);
      return { method: match[1] as string, path: match[2] as string };
    });
  // Pure data, so evaluate the literal rather than pattern-match each field:
  // the reasons are prose, and a regex that tripped on one would silently
  // compare fewer rows than there are.
  const open = source.indexOf("= [", exclusions) + 2;
  const close = source.indexOf("\n];", open) + 2;
  const untooled = new Function(`return ${source.slice(open, close)};`)() as {
    method: string;
    path: string;
    reason: string;
  }[];
  return { tooled, untooled };
}

const tools = toolTable();

check("the mirrored route table is the public API's route table", () => {
  const real = templateRoutes();
  assert.ok(real.length > 0, "read no routes out of the template");
  const shape = (route: TemplateRoute): string =>
    JSON.stringify({
      method: route.method,
      path: route.path,
      scope: route.scope ?? null,
      summary: route.summary,
      input:
        route.input === null || route.input === undefined
          ? null
          : { source: route.input.source, schema: schemaName(route.input.schema) },
      isPublic: route.isPublic === true,
    });
  assert.deepEqual(
    mirror.API_ROUTES.map(shape),
    real.map(shape),
    "packages/mcp/src/routes.ts has drifted from the public-api route table",
  );
});

check("the mirrored scope vocabulary is the server's", () => {
  const source = readFileSync(join(PUBLIC_API_TEMPLATES, "auth/api-permissions.ts.tpl"), "utf-8");
  const block = /export const API_TOKEN_SCOPES = \[([^\]]*)\] as const;/.exec(source);
  assert.ok(block, "the template no longer declares API_TOKEN_SCOPES");
  const declared = [...(block[1] as string).matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(mirror.API_TOKEN_SCOPES, declared);
});

check("the mirrored webhook event names are the server's", () => {
  const source = readFileSync(
    join(PUBLIC_API_TEMPLATES, "services/webhooks/types.ts.tpl"),
    "utf-8",
  );
  const block = /export const WEBHOOK_EVENTS = \[([^\]]*)\] as const;/.exec(source);
  assert.ok(block, "the template no longer declares WEBHOOK_EVENTS");
  const declared = [...(block[1] as string).matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(mirror.WEBHOOK_EVENTS, declared);
});

check("every real route is either a tool or a stated exclusion", () => {
  // The drift that matters most: a route ADDED to the public surface gets no
  // tool and nothing says so. Here it stops the build until somebody decides.
  assert.ok(tools.tooled.length > 0, "read no tools out of tools.ts");
  // What `route()` would throw on at the MCP server's startup: a tool naming
  // a row the mirrored table does not have.
  for (const tool of tools.tooled) {
    assert.ok(
      mirror.API_ROUTES.some((row) => row.method === tool.method && row.path === tool.path),
      `a tool calls ${tool.method.toUpperCase()} ${tool.path}, which the mirrored table lacks`,
    );
  }
  for (const route of templateRoutes()) {
    const tooled = tools.tooled.filter(
      (tool) => tool.method === route.method && tool.path === route.path,
    ).length;
    const excluded = tools.untooled.filter(
      (row) => row.method === route.method && row.path === route.path,
    ).length;
    assert.equal(
      tooled + excluded,
      1,
      `${route.method} ${route.path} is covered ${tooled + excluded} times by packages/mcp`,
    );
  }
});

/* ================================================================== */
/* The feature                                                        */
/* ================================================================== */

/** A project shaped like a scaffold that has NOT had the package copied in. */
const project = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hatchkit-mcp-"));
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: "example-app",
        private: true,
        scripts: {
          build: "pnpm --filter @starter/shared run build",
          [MCP_TEST_AGGREGATE]: "pnpm --filter @starter/server run test",
        },
      },
      null,
      2,
    )}\n`,
  );
  mkdirSync(join(dir, "packages", "server", "src", "api", "v1"), { recursive: true });
  writeFileSync(join(dir, PUBLIC_API_ROUTE_TABLE), "export const API_ROUTES = [];\n");
  return dir;
};

const applyTo = (dir: string, opts: { dryRun?: boolean } = {}): FeatureLedger => {
  const ledger = new FeatureLedger(dir, opts.dryRun ?? false);
  ledger.scopeTo("mcp");
  const result = mcpFeature.apply({
    projectDir: dir,
    manifestDir: dir,
    manifest,
    identifiers,
    mode: "update",
    ledger,
    log: () => {},
  });
  assert.equal(result, undefined, "apply is synchronous");
  return ledger;
};

/** Every file under `dir`, with its contents — for the dry-run test. */
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
  const dir = project();
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

check("a fresh apply lands the package and names it in the aggregate", () => {
  withProject((dir) => {
    const ledger = applyTo(dir);
    assert.deepEqual(ledger.conflicts(), []);
    for (const rel of [
      "packages/mcp/package.json",
      "packages/mcp/tsconfig.json",
      "packages/mcp/tsconfig.test.json",
      "packages/mcp/README.md",
      "packages/mcp/src/index.ts",
      "packages/mcp/src/server.ts",
      "packages/mcp/src/tools.ts",
      "packages/mcp/src/routes.ts",
      "packages/mcp/src/tests/server.test.ts",
      "packages/mcp/src/tests/integration/binary.test.ts",
    ]) {
      assert.ok(existsSync(join(dir, rel)), `${rel} was not written`);
    }

    const root = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as {
      scripts: Record<string, string>;
    };
    for (const [name, value] of Object.entries(MCP_ROOT_SCRIPTS)) {
      assert.equal(root.scripts[name], value, `root script ${name}`);
    }
    assert.ok(
      root.scripts[MCP_TEST_AGGREGATE]?.includes(MCP_TEST_SEGMENT),
      "the package's tests are not named in the aggregate, so CI would never run them",
    );
  });
});

check("neither `dist` nor `node_modules` is copied out of the starter", () => {
  // Both exist in this checkout after a build. Copying either would make the
  // scaffold ship a binary compiled against this repository's dependencies.
  for (const rel of mcpPlannedFiles()) {
    assert.ok(!rel.includes("/dist/"), `${rel} is build output`);
    assert.ok(!rel.includes("/node_modules/"), `${rel} is an installed dependency`);
  }
});

check("plannedFiles is what apply actually writes", () => {
  withProject((dir) => {
    const ledger = applyTo(dir);
    const written = ledger
      .summary()
      .written.filter((file) => file.startsWith("packages/mcp/"))
      .sort();
    assert.deepEqual(written, [...mcpPlannedFiles()].sort());
  });
});

check("a second apply writes nothing", () => {
  withProject((dir) => {
    applyTo(dir);
    const again = applyTo(dir);
    assert.deepEqual(again.summary().written, [], "the second apply is not idempotent");
    assert.equal(again.touched, false);
  });
});

check("a dry run reports the plan and touches nothing", () => {
  withProject((dir) => {
    const before = snapshot(dir);
    const ledger = applyTo(dir, { dryRun: true });
    assert.ok(ledger.summary()["would-write"].length > 5, "the dry run planned nothing");
    assert.deepEqual(ledger.summary().written, []);
    assert.deepEqual([...snapshot(dir).entries()], [...before.entries()], "the dry run wrote");
  });
});

check("a user's edit to the package survives the next apply", () => {
  withProject((dir) => {
    applyTo(dir);
    const rel = "packages/mcp/src/tools.ts";
    const edited = `${readFileSync(join(dir, rel), "utf-8")}\n// mine\n`;
    writeFileSync(join(dir, rel), edited);
    applyTo(dir);
    assert.equal(readFileSync(join(dir, rel), "utf-8"), edited, "the edit was overwritten");
  });
});

check("a customised root script is reported, not reverted", () => {
  withProject((dir) => {
    const path = join(dir, "package.json");
    const pkg = JSON.parse(readFileSync(path, "utf-8")) as { scripts: Record<string, string> };
    pkg.scripts["build:mcp"] = "echo mine";
    writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);

    const ledger = applyTo(dir);
    const after = JSON.parse(readFileSync(path, "utf-8")) as { scripts: Record<string, string> };
    assert.equal(after.scripts["build:mcp"], "echo mine");
    assert.ok(
      ledger.conflicts().some((entry) => (entry.detail ?? "").includes("build:mcp")),
      "the kept script was not reported",
    );
  });
});

check("nothing written carries an unsubstituted identifier token", () => {
  withProject((dir) => {
    applyTo(dir);
    for (const [rel, content] of snapshot(dir)) {
      if (!rel.startsWith("packages/mcp/")) continue;
      assert.deepEqual(findUnsubstitutedIdentifierTokens(content), [], `${rel} has a live token`);
    }
  });
});

/* ================================================================== */
/* Identifier renames, both directions                                */
/* ================================================================== */

/** Every file of the package in the starter, as text. */
const starterFiles = (): Map<string, string> => {
  const out = new Map<string, string>();
  for (const rel of mcpPlannedFiles()) {
    out.set(rel, readFileSync(join(STARTER_ROOT, rel), "utf-8"));
  }
  return out;
};

check("the starter still carries every literal the rename table names", () => {
  const all = [...starterFiles().values()].join("\n");
  for (const { from } of MCP_IDENTIFIER_RENAMES) {
    assert.ok(all.includes(from), `${from} is no longer in the starter — the rename is dead code`);
  }
  assert.ok(all.includes(MCP_STARTER_DEV_ORIGIN), "the starter no longer names its dev origin");
});

check("nothing the feature applied still carries one", () => {
  withProject((dir) => {
    applyTo(dir);
    for (const [rel, content] of snapshot(dir)) {
      if (!rel.startsWith("packages/mcp/")) continue;
      assert.deepEqual(
        findMcpIdentifierLiterals(content),
        [],
        `${rel} still names the starter's identifiers`,
      );
      assert.ok(!content.includes(MCP_STARTER_DEV_ORIGIN), `${rel} still points at the dev origin`);
    }
  });
});

check("the project's own names reach the package", () => {
  withProject((dir) => {
    applyTo(dir);
    const config = readFileSync(join(dir, "packages/mcp/src/config.ts"), "utf-8");
    assert.ok(config.includes(`"${identifiers.envPrefix}_API_TOKEN"`));
    assert.ok(config.includes(`"${identifiers.envPrefix}_API_URL"`));
    // `split` topology, so the API is on its own subdomain — read from the
    // same function the client's build args come from, never composed here.
    assert.ok(
      config.includes('"https://api.example.com"'),
      "the default origin is not this project's API",
    );

    const identity = readFileSync(join(dir, "packages/mcp/src/identity.ts"), "utf-8");
    assert.ok(identity.includes(`"${identifiers.clientIds.mcp}"`), "the server name is not frozen");
    assert.ok(
      identity.includes(`"${identifiers.productName}"`),
      "the product name the model is told is not this project's",
    );

    const pkg = JSON.parse(
      readFileSync(join(dir, "packages/mcp/package.json"), "utf-8"),
    ) as { bin: Record<string, string> };
    assert.deepEqual(Object.keys(pkg.bin), [identifiers.clientIds.mcp]);
  });
});

check("an origin the project changed is not put back", () => {
  withProject((dir) => {
    applyTo(dir);
    const rel = "packages/mcp/src/config.ts";
    const staged = readFileSync(join(dir, rel), "utf-8").replace(
      '"https://api.example.com"',
      '"https://staging.example.com"',
    );
    writeFileSync(join(dir, rel), staged);
    applyTo(dir);
    assert.ok(
      readFileSync(join(dir, rel), "utf-8").includes("staging.example.com"),
      "an update reverted a deliberate origin",
    );
  });
});

/* ================================================================== */
/* Prerequisites and the strip                                        */
/* ================================================================== */

check("selecting mcp alone pulls client-core in and applies it first", () => {
  const selection = expandFeatureSelection(["mcp" as never]);
  assert.ok(selection.implied.includes("client-core"), "client-core was not implied");
  assert.ok(
    selection.ordered.indexOf("client-core" as never) <
      selection.ordered.indexOf("mcp" as never),
    "client-core does not apply first",
  );
});

check("public-api is pulled in as a prerequisite it is not this registry's job to apply", () => {
  // `public-api` is a real, offerable feature applied through
  // `applyServerFeatures`, with no entry in the CONTRACT registry. The
  // expansion validates against the `Feature` union rather than the registry
  // precisely so this reads as the true statement it is — before that, `mcp`'s
  // honest `requires` came back as `Unknown feature "public-api"`, and
  // selecting it explicitly did not help, so the prerequisite was unsatisfiable.
  const selection = expandFeatureSelection(["mcp" as never]);
  assert.deepEqual(selection.errors, []);
  assert.ok(selection.implied.includes("public-api" as never), "public-api was not implied");
  // …and it stays out of `ordered`, which is only what this registry applies.
  assert.ok(
    !selection.ordered.includes("public-api" as never),
    "public-api must not be in the apply order — a different writer owns it",
  );
});

check("a genuine typo in a prerequisite is still an error", () => {
  // The widening above must not turn every unknown id into a silent pass:
  // validating against the union still catches anything that is not a feature.
  const selection = expandFeatureSelection(["not-a-feature" as never]);
  assert.equal(selection.errors.length, 1, selection.errors.join("; "));
  assert.match(selection.errors[0] as string, /Unknown feature "not-a-feature"/);
});

check("a project with no /api/v1 is told so rather than left with tools that 404", () => {
  withProject((dir) => {
    rmSync(join(dir, PUBLIC_API_ROUTE_TABLE));
    const lines: string[] = [];
    const ledger = new FeatureLedger(dir, false);
    mcpFeature.apply({
      projectDir: dir,
      manifestDir: dir,
      manifest,
      identifiers,
      mode: "update",
      ledger,
      log: (message) => lines.push(message),
    });
    assert.ok(
      lines.some((line) => line.includes("public-api")),
      "nothing said the REST surface is missing",
    );
  });
});

check("the surfaces that cannot carry it say why", () => {
  assert.equal(mcpPrerequisiteProblem("fullstack"), null);
  assert.equal(mcpPrerequisiteProblem("split"), null);
  assert.match(mcpPrerequisiteProblem("static") ?? "", /server runtime/);
  assert.match(mcpPrerequisiteProblem("backend") ?? "", /web app/);
});

check("the strip removes the package and every reference to it", () => {
  withProject((dir) => {
    applyTo(dir);
    const notes = stripMcp(dir);
    assert.ok(notes.length > 0, "the strip reported nothing");
    for (const rel of MCP_OWNED_PATHS) {
      assert.ok(!existsSync(join(dir, rel)), `${rel} survived the strip`);
    }
    const root = readFileSync(join(dir, "package.json"), "utf-8");
    assert.ok(
      !root.includes(MCP_PACKAGE_NAME),
      "a root script still filters a package that is gone — ERR_PNPM_NO_MATCHING_PACKAGE",
    );
    assert.ok(!root.includes(MCP_TEST_SEGMENT), "the aggregate still chains the removed tests");
    const scripts = (
      JSON.parse(root) as { scripts: Record<string, string> }
    ).scripts;
    assert.equal(
      scripts[MCP_TEST_AGGREGATE],
      "pnpm --filter @starter/server run test",
      "unchaining did not restore the original aggregate",
    );
  });
});

check("the strip is a no-op on a tree that never had the package", () => {
  withProject((dir) => {
    const before = snapshot(dir);
    assert.deepEqual(stripMcp(dir), []);
    assert.deepEqual([...snapshot(dir).entries()], [...before.entries()]);
  });
});

/* ================================================================== */

if (failures.length > 0) {
  console.error(`\n${failures.join("\n")}`);
  console.error(`\nmcp: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log("\nmcp ok");
