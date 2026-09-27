#!/usr/bin/env node
/*
 * The process. Reads the environment, opens stdio, and never writes a byte to
 * stdout itself.
 *
 * STDOUT IS THE PROTOCOL. One stray `console.log` anywhere in this process —
 * in this file, in a dependency, in a debug line somebody left in — lands in
 * the middle of a JSON-RPC frame and the host reports a crash it cannot
 * explain. The redirect below makes that mistake harmless instead of fatal;
 * it is not a substitute for the rule, it is the guard that keeps the rule
 * from being broken silently.
 *
 * Everything the server IS lives in `server.ts`, so the tests drive the same
 * factory this file does.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, readConfig } from "./config.js";
import { SERVER_NAME, SERVER_VERSION } from "./identity.js";
import { buildServer, startupLine } from "./server.js";

// Human output goes to stderr, which hosts show in their server log.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

async function main(): Promise<void> {
  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    // stderr, like everything else: stdout belongs to the transport even for
    // a run that never opens it, because a wrapper script may be capturing it.
    process.stderr.write(`${SERVER_NAME} ${SERVER_VERSION}\n`);
    return;
  }

  let config: ReturnType<typeof readConfig>;
  try {
    config = readConfig(process.env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    // One sentence, naming the variable and what to put in it. The host shows
    // the user only that the process exited, so this line in the server log
    // is the entire diagnosis they will get.
    process.stderr.write(`${SERVER_NAME}: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  const { server, probe, toolNames } = await buildServer(config);
  process.stderr.write(`${startupLine(config, probe, toolNames)}\n`);
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${SERVER_NAME}: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
