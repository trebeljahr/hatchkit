import { resolve } from "node:path";
import type { SimulateCustomPolicyCommandOutput } from "@aws-sdk/client-iam";
import { execa } from "execa";
import { readManifest } from "../scaffold/manifest.js";
import {
  SIMULATION_PERMISSION,
  senderPolicyProbes,
  verifySenderPolicy,
} from "./ses-policy-verification.js";
import { senderSpec } from "./ses-project-policy.js";

export async function runSesPolicyVerification(argv: string[]): Promise<void> {
  let projectDir = "";
  let account = "";
  let region = "";
  let profile = "";
  let dryRun = false;
  let from: string[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") continue;
    if (a === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (["--account", "--region", "--profile", "--from"].includes(a)) {
      const value = argv[++i];
      if (!value || value.startsWith("-")) throw new Error(`${a} requires a value.`);
      if (a === "--account") account = value;
      if (a === "--region") region = value;
      if (a === "--profile") profile = value;
      if (a === "--from") from = value.split(",");
    } else if (a.startsWith("-") || projectDir) throw new Error(`Unknown argument: ${a}`);
    else projectDir = resolve(a);
  }
  const manifest = readManifest(projectDir || process.cwd());
  if (!manifest?.name || !manifest.domain)
    throw new Error("A Hatchkit project manifest is required.");
  const spec = senderSpec(manifest.name, manifest.domain, account, region, from);
  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          scope: spec,
          permission: SIMULATION_PERMISSION,
          requests: senderPolicyProbes(spec),
          liveSenderVerified: false,
          writes: false,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (!profile || !/^[A-Za-z0-9_.@-]+$/.test(profile))
    throw new Error(
      "Pass an explicitly approved AWS CLI --profile. This command never reads Hatchkit's keychain or selects ambient credentials.",
    );
  const env = { ...process.env };
  // --profile must be the only chosen credential source. Ignore endpoint overrides.
  for (const key of Object.keys(env)) if (key.startsWith("AWS_")) delete env[key];
  Object.assign(env, {
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: "true",
    AWS_CLI_AUTO_PROMPT: "off",
    AWS_PAGER: "",
    HATCHKIT_KEYCHAIN_ACCESS: "deny",
  });
  const report = await verifySenderPolicy(spec, async (input) => {
    const refusal =
      "AWS policy simulation refused. The approved profile needs iam:SimulateCustomPolicy on *. No credentials, policies or resources were changed; provider error output is withheld.";
    const result = await execa(
      "aws",
      [
        "--profile",
        profile,
        "--region",
        region,
        "--no-cli-pager",
        "iam",
        "simulate-custom-policy",
        "--cli-input-json",
        JSON.stringify(input),
        "--output",
        "json",
      ],
      { env, extendEnv: false, reject: false, timeout: 30_000 },
    ).catch(() => {
      throw new Error(refusal);
    });
    if (result.exitCode !== 0) throw new Error(refusal);
    return JSON.parse(result.stdout) as SimulateCustomPolicyCommandOutput;
  });
  console.log(JSON.stringify(report, null, 2));
}
