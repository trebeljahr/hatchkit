#!/usr/bin/env node
// Starts client, server, and (optionally) docs for development.
//
// Usage:
//   node scripts/dev.mjs                Random ports (client 3100-3999, docs 4100-4999, server 5100-5999)
//   node scripts/dev.mjs --fixed        Fixed ports (client 3000, docs 4000, server 5000)
//   node scripts/dev.mjs --docs         Include docs site
//   node scripts/dev.mjs --fixed --docs Fixed ports with docs
//   pnpm run dev                        Random ports (client + server)
//   pnpm run dev:fixed                  Fixed ports (client + server)
//   pnpm run dev:docs                   Random ports (client + server + docs)
//   pnpm run dev:docs:fixed             Fixed ports (client + server + docs)

import { createServer } from "net";
import { execSync } from "child_process";

const fixedMode = process.argv.includes("--fixed");
const includeDocs = process.argv.includes("--docs");

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findRandomFreePort(min, max, maxAttempts = 20) {
  for (let i = 0; i < maxAttempts; i++) {
    const port = randomInt(min, max);
    if (await isPortFree(port)) {
      return port;
    }
  }
  throw new Error(
    `Could not find a free port in range ${min}-${max} after ${maxAttempts} attempts`,
  );
}

let clientPort;
let docsPort;
let apiPort;

if (process.env.PORT) {
  clientPort = parseInt(process.env.PORT, 10);
} else if (fixedMode) {
  clientPort = 3000;
} else {
  clientPort = await findRandomFreePort(3100, 3999);
}

if (process.env.DOCS_PORT) {
  docsPort = parseInt(process.env.DOCS_PORT, 10);
} else if (fixedMode) {
  docsPort = 4000;
} else {
  docsPort = await findRandomFreePort(4100, 4999);
}

if (process.env.API_PORT) {
  apiPort = parseInt(process.env.API_PORT, 10);
} else if (fixedMode) {
  apiPort = 5000;
} else {
  apiPort = await findRandomFreePort(5100, 5999);
}

console.log(`\n  Mode:   ${fixedMode ? "fixed" : "random"}`);
console.log(`  Client: http://127.0.0.1:${clientPort}`);
if (includeDocs) {
  console.log(`  Docs:   http://127.0.0.1:${docsPort}`);
}
console.log(`  Server: http://127.0.0.1:${apiPort}\n`);

const processes = [
  `"node scripts/wait-for-port.mjs ${apiPort} && PORT=${clientPort} NEXT_PUBLIC_API_URL=http://127.0.0.1:${apiPort} NEXT_PUBLIC_WS_URL=ws://127.0.0.1:${apiPort} pnpm --filter @starter/client run dev"`,
  `"PORT=${apiPort} FRONTEND_URL=http://127.0.0.1:${clientPort} pnpm --filter @starter/server run dev"`,
];
const names = ["client", "server"];
const colors = ["yellow", "cyan"];

if (includeDocs) {
  processes.push(
    `"pnpm --filter docs-site run start -- --port ${docsPort}"`,
  );
  names.push("docs");
  colors.push("magenta");
}

try {
  execSync(
    `npx concurrently -k -n ${names.join(",")} -c ${colors.join(",")}` +
      ` ${processes.join(" ")}`,
    { stdio: "inherit" },
  );
} catch {
  process.exit(1);
}
