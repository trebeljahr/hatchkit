/** Offline only. Create reviewable SQL and configuration in a new private directory. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installationSql } from "./bridge/install.mjs";
try {
  const [reviewPath, output, ...extra] = process.argv.slice(2);
  if (!reviewPath || !output || extra.length) throw Error("usage");
  const scope = JSON.parse(readFileSync(reviewPath, "utf8"));
  const plan = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "plan.json"), "utf8"),
  );
  if (scope.project !== plan.project || scope.targetOrigin !== plan.publicUrl) throw Error("scope");
  const prepared = installationSql(scope);
  mkdirSync(output, { mode: 0o700 });
  for (const [name, content] of Object.entries({
    "source.sql": prepared.source,
    "target.sql": prepared.target,
    "bridge.json": JSON.stringify(prepared.config, null, 2),
  }))
    writeFileSync(join(output, name), content, { mode: 0o600, flag: "wx" });
  console.log(
    "Prepared only: review source.sql, target.sql and bridge.json before any database installation.",
  );
} catch {
  console.error(
    "Bridge preparation failed. Supply a reviewed scope JSON and a new output directory. No database changed.",
  );
  process.exitCode = 1;
}
