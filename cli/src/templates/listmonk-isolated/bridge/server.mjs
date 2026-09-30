import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import pg from "pg";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { relayConfig, createRelayHandler } from "../relay/message.mjs";
import { NewsletterBridge } from "./store.mjs";
import { bridgeHandler } from "./http.mjs";
const secret = (name) => {
  const path = process.env[`${name}_FILE`];
  if (!path) throw Error(`Missing ${name}_FILE`);
  return readFileSync(path, "utf8").trim();
};
const config = relayConfig(process.env);
const scope = JSON.parse(readFileSync(process.env.BRIDGE_SCOPE_FILE, "utf8"));
const source = new pg.Pool({
  connectionString: secret("BRIDGE_SOURCE_DATABASE_URL"),
  max: 3,
  connectionTimeoutMillis: 5000,
});
const target = new pg.Pool({
  connectionString: secret("BRIDGE_TARGET_DATABASE_URL"),
  max: 4,
  connectionTimeoutMillis: 5000,
});
const bridge = new NewsletterBridge(source, target, scope, secret("NEWSLETTER_TOKEN_SECRET"));
await bridge.verify();
const client = new SESv2Client({
  region: config.region,
  credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  maxAttempts: 1,
});
const appPassword = secret("BRIDGE_APP_PASSWORD");
if (appPassword.length < 32) throw Error("Bridge app password too short");
const topic = process.env.BRIDGE_SNS_TOPIC_ARN;
const account = config.identity.split(":")[4];
if (!topic?.startsWith(`arn:aws:sns:${config.region}:${account}:`))
  throw Error("Pinned SNS topic required");
const relay = createRelayHandler(config, (message, payload) =>
  bridge.deliver(message, payload, (m) =>
    client.send(new SendEmailCommand(m), { abortSignal: AbortSignal.timeout(15000) }),
  ),
);
const server = createServer(
  bridgeHandler({ ...config, appUser: "project-app", appPassword, topic, account }, bridge, relay),
);
server.requestTimeout = 20000;
server.headersTimeout = 10000;
server.timeout = 20000;
server.listen(8787, "0.0.0.0");
let stopped = false;
async function poll() {
  while (!stopped) {
    try {
      await bridge.reconcile();
    } catch {
      console.error("Legacy reconciliation failed; send-time checks remain required.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}
const polling = poll();
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    stopped = true;
    server.close(async () => {
      await polling;
      await Promise.all([source.end(), target.end()]);
      client.destroy();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 25000).unref();
  });
