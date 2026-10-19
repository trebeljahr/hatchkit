#!/usr/bin/env node
// Stand-in for `@capgo/cli bundle zip|encrypt --json`, for publish.test.mjs.
// "Encryption" reverses the bytes, so the test can recompute the upload.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
if (process.env.FAKE_CAPGO_LOG) {
  const keyFile = flag("--key");
  appendFileSync(
    process.env.FAKE_CAPGO_LOG,
    `${JSON.stringify({ args, keyMode: keyFile ? (statSync(keyFile).mode & 0o777).toString(8) : null })}\n`,
  );
}

if (args[0] === "bundle" && args[1] === "zip") {
  const dist = flag("--path");
  const name = flag("--name");
  const files = readdirSync(dist).sort();
  const content = files.map((f) => `${f}:${readFileSync(join(dist, f), "utf8")}`).join("\n");
  if (!content.includes("notifyAppReady") && !args.includes("--ignore-notify-app-ready")) {
    process.stderr.write("notifyAppReady() is missing in the build folder\n");
    process.exit(1);
  }
  writeFileSync(name, content);
  const checksum = createHash("sha256").update(content).digest("hex");
  process.stdout.write(JSON.stringify({ bundle: flag("--bundle"), filename: name, checksum }, null, 2));
} else if (args[0] === "bundle" && args[1] === "encrypt") {
  const [zip, checksum] = [args[2], args[3]];
  const keyFile = flag("--key");
  if (!keyFile || !existsSync(keyFile) || !readFileSync(keyFile, "utf8").includes("PRIVATE KEY")) {
    process.stderr.write("no key\n");
    process.exit(1);
  }
  const out = `${zip}_encrypted.zip`;
  writeFileSync(out, Buffer.from(readFileSync(zip)).reverse());
  process.stdout.write(
    `Encrypting checksum with V2\n${JSON.stringify({
      checksum: `${checksum}${"0".repeat(64)}`,
      filename: out,
      ivSessionKey: "dGVzdC1pdg:ZmFrZS1zZXNzaW9uLWtleS1mb3ItdGVzdHM",
    })}`,
  );
} else {
  process.stderr.write(`unexpected: ${args.join(" ")}\n`);
  process.exit(1);
}
