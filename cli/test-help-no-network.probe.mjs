/*
 * Loaded via `--import` into a `hatchkit ... --help` subprocess so a
 * help run can be shown to talk to nobody.
 *
 * Every provider path in the CLI — Cloudflare/R2, AWS SDK, Coolify,
 * Hetzner, GitHub — ends at a socket, so poisoning socket creation
 * catches all of them regardless of which HTTP client they use. A
 * blocked call prints a marker the test greps for and kills the
 * process, so a regression is loud instead of a silent bucket.
 */
import net from "node:net";
import tls from "node:tls";

const MARKER = "PROVIDER_CALL_ATTEMPTED";

function block(what, target) {
  console.error(`${MARKER}: ${what} ${target}`);
  process.exit(97);
}

const describe = (args) => {
  const first = args[0];
  if (typeof first === "object" && first !== null)
    return `${first.host ?? first.path}:${first.port ?? ""}`;
  return String(first);
};

net.Socket.prototype.connect = function blocked(...args) {
  block("net.connect", describe(args));
};
net.connect = (...args) => block("net.connect", describe(args));
net.createConnection = (...args) => block("net.createConnection", describe(args));
tls.connect = (...args) => block("tls.connect", describe(args));

globalThis.fetch = (input) => block("fetch", String(input));
