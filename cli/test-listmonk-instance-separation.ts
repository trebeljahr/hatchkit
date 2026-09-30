/** Opt-in real Listmonk/Postgres test. No AWS, SMTP, public routes or real subscribers. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { cpus, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { prepareTransfer } from "./src/templates/listmonk-isolated/prepare-transfer.mjs";

if (process.env.HATCHKIT_RUN_LISTMONK_DOCKER !== "1") {
  throw new Error(
    "Not run: set HATCHKIT_RUN_LISTMONK_DOCKER=1 through scripts/test.mjs after checking machine resources. This is not a pass.",
  );
}
// Never follow a remote Docker context or read ambient provider credentials.
const env: NodeJS.ProcessEnv = { ...process.env, HATCHKIT_KEYCHAIN_ACCESS: "deny" };
delete env.DOCKER_HOST;
delete env.DOCKER_CONTEXT;
const command = (cmd: string, args: string[], input?: string) => {
  const result = spawnSync(cmd, args, {
    env,
    input,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${cmd} ${args.slice(0, 2).join(" ")} failed (output withheld; fixture data may be present)`,
    );
  return result.stdout.trim();
};
if (loadavg()[0] > cpus().length * 0.7) throw new Error("Deferred: machine load too high.");
if (process.platform !== "darwin")
  throw new Error("Review a resource gate for this platform before running.");
const swap = command("sysctl", ["vm.swapusage"]);
const used = Number(swap.match(/used = ([\d.]+)M/)?.[1] ?? Number.NaN);
if (!Number.isFinite(used) || used > 2048)
  throw new Error("Deferred: swap is unknown or above 2 GiB.");
const pressure = command("memory_pressure", []);
const free = Number(pressure.match(/memory free percentage: (\d+)%/)?.[1] ?? Number.NaN);
if (!Number.isFinite(free) || free < 30)
  throw new Error("Deferred: memory pressure is unsafe or unknown.");
const context = command("docker", ["context", "show"]);
const endpoint = command("docker", [
  "context",
  "inspect",
  context,
  "--format",
  "{{.Endpoints.docker.Host}}",
]);
if (!endpoint.startsWith("unix://"))
  throw new Error("Only a local Unix-socket Docker context is allowed.");
// Pin the reviewed local context, even if another shell changes its default.
const docker = (args: string[], input?: string) =>
  command("docker", ["--context", context, ...args], input);
for (const image of ["postgres:17-alpine", "listmonk/listmonk:v6.2.0"])
  docker(["image", "inspect", image]);
const lock = "/tmp/hatchkit-recovery-validation.lock";
if (existsSync(lock))
  throw new Error("Validation lock exists; inspect owner. Never remove a foreign lock.");
mkdirSync(lock);
const owner = JSON.stringify({
  pid: process.pid,
  purpose: "Listmonk two-instance fixtures",
  started: new Date().toISOString(),
});
writeFileSync(join(lock, "owner.json"), owner);
const scratch = mkdtempSync(join(tmpdir(), "hatchkit-listmonk-separation-"));
const stacks: Array<{
  name: string;
  path: string;
  port: number;
  auth: string;
  email: string;
  id: number;
}> = [];
const compose = (stack: { name: string; path: string }, args: string[], input?: string) =>
  docker(
    ["compose", "--project-name", stack.name, "--file", join(stack.path, "compose.yml"), ...args],
    input,
  );
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let cleaned = true;
async function freePort() {
  for (let n = 0; n < 3; n++) {
    const port = 49152 + (randomBytes(2).readUInt16BE() % 16000);
    const server = createServer();
    const ok = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (ok) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      return port;
    }
  }
  throw new Error("No free high loopback port after three attempts.");
}
try {
  for (const [i, project] of ["alpha", "bravo"].entries()) {
    const name = `hk-separation-${project}-${randomBytes(6).toString("hex")}`;
    const path = join(scratch, project);
    mkdirSync(path, { mode: 0o700 });
    mkdirSync(join(path, "secrets"), { mode: 0o700 });
    for (const key of ["db_password", "admin_password"])
      writeFileSync(join(path, "secrets", key), randomBytes(24).toString("hex"), { mode: 0o600 });
    const token = randomBytes(32).toString("hex");
    const stack = {
      name,
      path,
      port: await freePort(),
      auth: `token project-api:${token}`,
      email: `${project}@example.com`,
      id: 100 + i,
    };
    const definition = parse(
      readFileSync(
        new URL("./src/templates/listmonk-isolated/compose.yml", import.meta.url),
        "utf8",
      ),
    );
    definition.name = name;
    // Exercise the shipped Listmonk/DB network and secret wiring. Omit the live SES relay.
    delete definition.services.relay;
    delete definition.networks.sending;
    for (const key of ["relay_password", "ses_access_key", "ses_secret_key"])
      delete definition.secrets[key];
    definition.services.listmonk.ports = [`127.0.0.1:${stack.port}:9000`];
    for (const service of Object.values(definition.services) as Array<{
      restart: string;
      mem_limit: string;
      cpus: number;
    }>) {
      service.restart = "no";
      service.mem_limit = "256m";
      service.cpus = 0.5;
    }
    writeFileSync(join(path, "compose.yml"), stringify(definition));
    stacks.push(stack); // Track before starting; failures still clean only this random project.
    compose(stack, ["up", "-d", "--pull", "never", "--wait", "--wait-timeout", "45", "db"]);
    compose(stack, [
      "run",
      "--rm",
      "--pull",
      "never",
      "--no-deps",
      "listmonk",
      "./listmonk",
      "--install",
      "--idempotent",
      "--yes",
      "--config",
      "",
    ]);
    compose(
      stack,
      ["exec", "-T", "db", "psql", "-U", "listmonk", "-d", "listmonk", "-v", "ON_ERROR_STOP=1"],
      `
      INSERT INTO lists(id,uuid,name,type,optin) VALUES (100,gen_random_uuid(),'fixture','private','double');
      INSERT INTO subscribers(id,uuid,email,name,status) VALUES (${stack.id},gen_random_uuid(),'${stack.email}','fixture','enabled');
      INSERT INTO subscriber_lists(subscriber_id,list_id,status) VALUES (${stack.id},100,'confirmed');
      INSERT INTO roles(id,type,name,permissions) VALUES (100,'user','fixture',ARRAY['subscribers:get','subscribers:get_all','subscribers:manage','campaigns:get','campaigns:manage','tx:send']);
      INSERT INTO roles(id,type,name) VALUES (101,'list','fixture');
      INSERT INTO roles(id,type,parent_id,list_id,permissions) VALUES (102,'list',101,100,ARRAY['list:get','list:manage']);
      INSERT INTO users(username,password,email,name,type,user_role_id,list_role_id,status) VALUES ('project-api','${token}','fixture@api','fixture','api',100,101,'enabled');
      INSERT INTO campaigns(id,uuid,name,subject,from_email,body,content_type,messenger) VALUES (${stack.id},gen_random_uuid(),'fixture','fixture','noreply@mail.${project}.example.com','fixture','plain','email');
      INSERT INTO campaign_lists(campaign_id,list_id,list_name) VALUES (${stack.id},100,'fixture');
      UPDATE settings SET value='[]'::jsonb WHERE key='smtp';
      UPDATE settings SET value='false'::jsonb WHERE key IN ('app.check_updates','app.send_optin_confirmation');
    `,
    );
    compose(stack, ["up", "-d", "--pull", "never", "listmonk"]);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const r = await fetch(`http://127.0.0.1:${stack.port}/api/subscribers/${stack.id}`, {
          headers: { authorization: stack.auth },
          signal: AbortSignal.timeout(1000),
        });
        if (r.ok) {
          ready = true;
          break;
        }
      } catch {}
      await pause(500);
    }
    assert(ready, "Fixture Listmonk did not become ready with its own token");
  }
  const call = async (
    destination: (typeof stacks)[number],
    auth: string,
    path: string,
    method = "GET",
    body?: unknown,
  ) => {
    const r = await fetch(`http://127.0.0.1:${destination.port}${path}`, {
      method,
      headers: { authorization: auth, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return { status: r.status, text: await r.text() };
  };
  for (const [i, own] of stacks.entries()) {
    const other = stacks[1 - i];
    for (const path of [
      `/api/subscribers/${other.id}`,
      "/api/subscribers",
      "/api/lists",
      `/api/campaigns/${other.id}`,
    ]) {
      const before = await call(other, other.auth, path);
      assert.equal(before.status, 200);
      assert([401, 403].includes((await call(other, own.auth, path)).status));
    }
    for (const [path, method, body] of [
      [
        `/api/subscribers/${other.id}`,
        "PUT",
        { email: "attacker@example.com", name: "attacker", status: "enabled" },
      ],
      [`/api/subscribers/${other.id}`, "DELETE", undefined],
      [`/api/campaigns/${other.id}/status`, "PUT", { status: "running" }],
      [
        "/api/tx",
        "POST",
        {
          subscriber_email: other.email,
          template_id: 1,
          from_email: `noreply@mail.bravo.example.com`,
        },
      ],
    ] as const)
      assert([401, 403].includes((await call(other, own.auth, path, method, body)).status));
    assert(
      [401, 403].includes((await call(own, own.auth, "/api/settings", "PUT", { smtp: [] })).status),
    );
    const ownRows = await call(own, own.auth, "/api/subscribers?per_page=all");
    assert.equal(ownRows.status, 200);
    assert(ownRows.text.includes(own.email));
    assert(!ownRows.text.includes(other.email));
    const foreignRow = await call(own, own.auth, `/api/subscribers/${other.id}`);
    assert([400, 404].includes(foreignRow.status));
    const protectedRow = await call(other, other.auth, `/api/subscribers/${other.id}`);
    assert.equal(JSON.parse(protectedRow.text).data.email, other.email);
    const protectedCampaign = await call(other, other.auth, `/api/campaigns/${other.id}`);
    assert.equal(JSON.parse(protectedCampaign.text).data.status, "draft");
    const ownNetwork = JSON.parse(docker(["network", "inspect", `${own.name}_private`]))[0];
    assert.equal(ownNetwork.Internal, true);
    const foreignContainers = Object.keys(
      JSON.parse(docker(["network", "inspect", `${other.name}_private`]))[0].Containers,
    );
    assert(!Object.keys(ownNetwork.Containers).some((id) => foreignContainers.includes(id)));
  }
  // Reuse only these owned synthetic stacks for the import rehearsal. No third DB.
  for (const stack of stacks) compose(stack, ["stop", "listmonk"]);
  const sql = (stack: (typeof stacks)[number], statement: string) =>
    compose(
      stack,
      [
        "exec",
        "-T",
        "db",
        "psql",
        "-X",
        "-q",
        "-A",
        "-t",
        "-U",
        "listmonk",
        "-d",
        "listmonk",
        "-v",
        "ON_ERROR_STOP=1",
      ],
      statement,
    );
  const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const source = stacks[0];
  const target = stacks[1];
  // These databases were created above, contain fixtures only, and are destroyed below.
  for (const stack of stacks)
    sql(stack, "DELETE FROM campaigns; DELETE FROM subscribers; DELETE FROM lists;");
  sql(
    source,
    `
    INSERT INTO lists(id,uuid,name,type,optin) VALUES
      (3,'${uid(3)}','fixture live','private','double'),
      (4,'${uid(4)}','fixture test','private','double'),
      (9,'${uid(9)}','excluded fixture project','private','double');
    INSERT INTO subscribers(id,uuid,email,name,status,created_at,updated_at) VALUES
      (21,'${uid(21)}','reader21@example.com','fixture','enabled','2026-09-29 01:02:03.123456+00','2026-09-29 01:02:03.123456+00'),
      (22,'${uid(22)}','reader22@example.com','fixture','disabled',NULL,NULL),
      (23,'${uid(23)}','reader23@example.com','fixture','blocklisted',NOW(),NOW()),
      (24,'${uid(24)}','reader24@example.com','fixture','enabled',NOW(),NOW()),
      (25,'${uid(25)}','excluded-orphan@example.com','fixture','enabled',NOW(),NOW()),
      (26,'${uid(26)}','excluded-project@example.com','fixture','enabled',NOW(),NOW());
    INSERT INTO subscriber_lists(subscriber_id,list_id,status,updated_at) VALUES
      (21,3,'confirmed','2026-09-29 01:02:03.123456+00'),
      (21,4,'unsubscribed','2026-09-29 01:02:03.123456+00'),
      (22,3,'unconfirmed',NULL),(23,3,'confirmed',NOW()),(24,3,'unconfirmed',NOW()),(26,9,'confirmed',NOW());
  `,
  );
  const exportTemplate = readFileSync(
    new URL("./src/templates/listmonk-isolated/export-memberships.sql", import.meta.url),
    "utf8",
  );
  const exported = sql(
    source,
    exportTemplate
      .replaceAll(":'live_uuid'", `'${uid(3)}'`)
      .replaceAll(":'test_uuid'", `'${uid(4)}'`),
  );
  assert(!exported.includes("excluded-"));
  assert.throws(() =>
    sql(
      source,
      exportTemplate
        .replaceAll(":'live_uuid'", `'${uid(3)}'`)
        .replaceAll(":'test_uuid'", `'${uid(3)}'`),
    ),
  );
  const plan = {
    project: "alpha",
    publicUrl: "https://newsletter.alpha.example.com",
    scope: { from: ["noreply@mail.alpha.example.com"] },
  };
  const review = {
    version: 1,
    reviewed: true,
    project: "alpha",
    sourceOrigin: "https://newsletter.shared.example.com",
    targetOrigin: plan.publicUrl,
    lists: [
      { role: "live", sourceId: 3, sourceUuid: uid(3), targetUuid: uid(13) },
      { role: "test", sourceId: 4, sourceUuid: uid(4), targetUuid: uid(14) },
    ],
    expectedSubscribers: 4,
    expectedMemberships: 5,
  };
  const prepared = prepareTransfer(plan, review, exported);
  sql(
    target,
    `
    INSERT INTO lists(id,uuid,name,type,optin) VALUES
      (13,'${uid(13)}','fixture live','private','double'),(14,'${uid(14)}','fixture test','private','double');
    UPDATE settings SET value='"noreply@mail.alpha.example.com"'::jsonb WHERE key='app.from_email';
  `,
  );
  assert.throws(() => sql(target, prepared.sql));
  assert.equal(sql(target, "SELECT count(*) FROM subscribers;"), "0");
  sql(
    target,
    `UPDATE settings SET value='"https://newsletter.alpha.example.com"'::jsonb WHERE key='app.root_url';`,
  );
  // A failure after inserts must roll back both imported rows and migration mapping.
  assert.throws(() => sql(target, prepared.sql.replace("COMMIT;", "SELECT 1/0; COMMIT;")));
  assert.equal(sql(target, "SELECT count(*) FROM subscribers;"), "0");
  assert.equal(
    sql(target, "SELECT count(*) FROM pg_namespace WHERE nspname='hatchkit_newsletter_transfer';"),
    "0",
  );
  sql(target, prepared.sql);
  assert.equal(sql(target, "SELECT count(*) FROM subscribers;"), "4");
  assert.equal(sql(target, "SELECT count(*) FROM subscriber_lists;"), "5");
  assert.equal(
    sql(target, "SELECT status FROM subscribers WHERE email='reader22@example.com';"),
    "disabled",
  );
  assert.equal(
    sql(target, "SELECT status FROM subscribers WHERE email='reader23@example.com';"),
    "blocklisted",
  );
  assert.equal(
    sql(
      target,
      "SELECT sl.status FROM subscriber_lists sl JOIN subscribers s ON sl.subscriber_id=s.id WHERE s.email='reader21@example.com' AND sl.list_id=14;",
    ),
    "unsubscribed",
  );
  assert.equal(
    sql(target, "SELECT created_at IS NULL FROM subscribers WHERE email='reader22@example.com';"),
    "t",
  );
  // Replaying an initial import cannot erase a newer suppression.
  sql(target, "UPDATE subscribers SET status='blocklisted' WHERE email='reader21@example.com';");
  assert.throws(() => sql(target, prepared.sql));
  assert.equal(
    sql(target, "SELECT status FROM subscribers WHERE email='reader21@example.com';"),
    "blocklisted",
  );
} finally {
  for (const stack of stacks.reverse()) {
    try {
      compose(stack, ["down", "--volumes", "--timeout", "5"]);
    } catch {
      cleaned = false;
      console.error(
        `Cleanup needed for owned fixture only: ${stack.name}, compose file ${join(stack.path, "compose.yml")}`,
      );
    }
  }
  if (cleaned) rmSync(scratch, { recursive: true });
  if (readFileSync(join(lock, "owner.json"), "utf8") === owner) rmSync(lock, { recursive: true });
}

if (!cleaned) throw new Error("Fixture cleanup incomplete; not a verification pass.");
console.log(
  "PASS: two disposable Listmonk/Postgres instances deny foreign API tokens, isolate subscriber/campaign data and have separate internal networks. Selective export/import preserves consent states, excludes other-project/orphan rows, rolls back on failure and refuses destructive replay. No mail sent. Run relay separation separately; AWS enforcement is not tested here.",
);
