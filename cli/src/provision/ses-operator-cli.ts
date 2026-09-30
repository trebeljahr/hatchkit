/** Offline output only. Bootstrap remains an explicit administrator operation. */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sesOperatorPlan } from "./ses-operator-policy.js";

export async function runSesOperatorPlan(argv: string[]): Promise<void> {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--json") continue;
    if (!["--account", "--region", "--operator-user", "--output"].includes(flag))
      throw new Error(`Unknown argument: ${flag}`);
    const value = argv[++i];
    if (!value || value.startsWith("-") || values[flag])
      throw new Error(`Invalid or duplicate ${flag}`);
    values[flag] = value;
  }
  const plan = sesOperatorPlan(
    values["--account"] ?? "",
    values["--region"] ?? "",
    values["--operator-user"] ?? "",
  );
  if (values["--output"]) {
    const dir = resolve(values["--output"]);
    if (existsSync(dir)) throw new Error("Output already exists; refusing overwrite.");
    mkdirSync(dir, { mode: 0o700 });
    for (const [name, data] of Object.entries({
      "plan.json": plan,
      "bootstrap.cloudformation.json": plan.cloudFormation,
      "sender-boundary.json": plan.boundaryPolicy,
      "operator-policy.json": plan.operatorPolicy,
    }))
      writeFileSync(join(dir, name), `${JSON.stringify(data, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
  }
  console.log(JSON.stringify(plan, null, 2));
}
