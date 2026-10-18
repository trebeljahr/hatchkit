// Update watch: the matcher and host script (Python), the one doctor row
// built from real script output, and what goes over Tailscale SSH.
//
// 2026-10-18: Plausible CE v3.0.1 on the shared Coolify host ran four months
// past a critical RCE fix and was taken over. The fixture host below is that
// host before the upgrades (every service must be flagged), and the one after
// them on two hosts (nothing may be).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackupHost } from "./src/backups/provider.js";
import { getStore } from "./src/config.js";
import {
  type HostScan,
  type LastCheck,
  type UpdateReport,
  advisoriesUrl,
  checkUpdateWatch,
  compareHetznerFirewalls,
  installUpdateWatch,
  latestUrl,
  liveCloudflare,
  pinnedCloudflare,
  runUpdatesCommand,
  uninstallUpdateWatch,
  updateRow,
  watchedServices,
} from "./src/host/updates.js";
import { SECRET_KEYS, setSecret } from "./src/utils/secrets.js";

const python = spawnSync("python3", ["test-update-watch.py"], { stdio: "inherit" });
assert.equal(python.status, 0, "Python update-watch tests failed");

// The host script's own reports for the fixture hosts (test-update-watch.py).
const generated = spawnSync(
  "python3",
  [
    "-c",
    `import json,sys
sys.path.insert(0,'.')
t=__import__('test-update-watch')
uw=t.uw
import tempfile,pathlib
src=pathlib.Path(tempfile.mkdtemp())
for day in range(9,19):
    (src/('upgrade-2026-10-%02d-00-00-12.log'%day)).write_text(t.failed_log(day))
old=uw.scan(t.FakeDocker(t.OLD_HOST,t.OLD_EXECS),t.SERVICES,uw.Feeds(t.FEEDS,get=t.offline),str(src),t.NOW,t.CLOUDFLARE,t.DEDICATED_CHAIN.get)
(src/'upgrade-2026-10-19-00-00-12.log').write_text(t.OK_LOG)
new=uw.scan(t.FakeDocker(t.NEW_HOST[:2]),t.SERVICES,uw.Feeds(t.FEEDS,get=t.offline),str(src),t.NOW,t.CLOUDFLARE,t.DEDICATED_CHAIN.get)
shared=uw.scan(t.FakeDocker(t.NEW_HOST[1:]),t.SERVICES,uw.Feeds(t.FEEDS,get=t.offline),str(src/'none'),t.NOW,t.CLOUDFLARE,t.no_chain)
moved=dict(t.FEEDS)
moved[uw.CLOUDFLARE_IPS]=t.cloudflare_answer('5e1a8d1e0c3f4b2a9d7c6e5f4a3b2c1d',add=('198.51.100.0/22',),drop=('131.0.72.0/22',))
changed=uw.scan(t.FakeDocker(t.NEW_HOST[:2]),t.SERVICES,uw.Feeds(moved,get=t.offline),str(src),t.NOW,t.CLOUDFLARE,t.DEDICATED_CHAIN.get)
changed_shared=uw.scan(t.FakeDocker(t.NEW_HOST[1:]),t.SERVICES,uw.Feeds(moved,get=t.offline),str(src/'none'),t.NOW,t.CLOUDFLARE,t.no_chain)
print(json.dumps({'old':old,'new':new,'shared':shared,'changed':changed,'changedShared':changed_shared,'urls':[[s['github'],uw.advisories_url(s['github']),uw.latest_url(s['github'])] for s in t.SERVICES if s.get('github')]}))`,
  ],
  { encoding: "utf8" },
);
assert.equal(generated.status, 0, generated.stderr);
const fixtures = JSON.parse(generated.stdout) as {
  old: Omit<UpdateReport, "timer">;
  new: Omit<UpdateReport, "timer">;
  shared: Omit<UpdateReport, "timer">;
  changed: Omit<UpdateReport, "timer">;
  changedShared: Omit<UpdateReport, "timer">;
  urls: [string, string, string][];
};

// A prefetched feed is used only under the key the host script asks for.
for (const [repo, advisories, latest] of fixtures.urls) {
  assert.equal(advisoriesUrl(repo), advisories);
  assert.equal(latestUrl(repo), latest);
}
assert.deepEqual(
  watchedServices().map((s) => s.key),
  ["coolify", "traefik", "plausible", "listmonk", "uptime-kuma", "glitchtip", "clickhouse"],
);

const now = new Date("2026-10-19T08:00:00Z");
const DEDICATED: BackupHost = {
  name: "dedicated-vps",
  transport: "tailscale",
  target: "root@dedicated-vps",
  serverUuid: "qjtg",
};
const SHARED: BackupHost = {
  name: "shared-vps",
  transport: "tailscale",
  target: "root@shared-vps",
  serverUuid: "s2",
};
const ran = (checkedAt: string, extra: Partial<LastCheck> = {}): LastCheck => ({
  checkedAt,
  ok: true,
  error: null,
  services: [],
  findings: [],
  skipped: [],
  mailed: null,
  ...extra,
});
const installed = (last: LastCheck | null = ran("2026-10-19T06:12:00+00:00")) => ({
  installed: true,
  active: true,
  serviceResult: "success",
  nextRun: "Mon 2026-10-26 06:00:00 UTC",
  lastCheck: last,
});
const scan = (
  host: BackupHost,
  report: Omit<UpdateReport, "timer">,
  timer: UpdateReport["timer"] = installed(),
): HostScan => ({ host, report: { ...report, timer } });

// --- the versions found on 2026-10-18 ----------------------------------------
{
  const row = updateRow([scan(DEDICATED, fixtures.old)], now);
  assert.equal(row.name, "Shared service updates");
  assert.equal(row.status, "fail");
  for (const part of [
    "Plausible CE 3.0.1: 1 advisory (critical)",
    "Coolify 4.0.0-beta.469: 16 advisories (critical)",
    "Traefik 3.6.12:",
    "Listmonk 6.0.0:",
    "Uptime Kuma 2.2.1: 1 advisory (high)",
    "Coolify auto-update failing",
  ])
    assert.ok(row.detail?.includes(part), `${part} in ${row.detail}`);
  const hints = row.hint!.join("\n");
  assert.match(
    hints,
    /Plausible CE 3\.0\.1 \(plausible-c8378br07og1w4ta45uxh57l\): GHSA-mhcv-h7gf-57cf critical fixed in 3\.2\.1\. Upgrade to 3\.2\.1 or the latest 3\.2\.1\./,
  );
  assert.match(hints, /GHSA-wf2j-5mc7-5c4w high fixed in 2\.5\.4/);
  assert.match(hints, /GHSA-w4v4-9rw7-5326 high fixed in 3\.7\.13/);
  assert.match(hints, /GHSA-h5j9-cvrw-v5qh high fixed in 6\.1\.0/);
  assert.match(hints, /GHSA-9pp4-wcmj-rq73 high fixed in 4\.0\.0-beta\.470/);
  assert.match(hints, /GHSA-w8wm-r924-f65v/);
  assert.match(hints, /failed 10 run\(s\) in a row since 2026-10-09 00:00:12/);
  assert.match(hints, /REGISTRY_URL=docker\.io/);
  assert.match(hints, /tailscale ssh root@dedicated-vps 'tail -5/);
  assert.ok(row.hint!.at(-1)!.startsWith("Re-check: hatchkit host updates --json"));
  assert.doesNotMatch(row.detail!, /ClickHouse|GlitchTip/, "current ones are not failures");
}

// --- after the upgrades, two hosts --------------------------------------------
{
  const row = updateRow([scan(DEDICATED, fixtures.new), scan(SHARED, fixtures.shared)], now);
  assert.equal(row.status, "ok", JSON.stringify(row));
  assert.equal(row.hint, undefined);
  assert.match(
    row.detail!,
    /^no high\/critical advisory covers dedicated-vps: Coolify 4\.4\.6, Traefik 3\.7\.15; shared-vps: /,
  );
  assert.match(row.detail!, /Plausible CE 3\.2\.1/);
  assert.match(
    row.detail!,
    /behind the latest release: ClickHouse 24\.12\.6\.70-alpine on shared-vps \(latest 26\.7\.34\.3-stable\)/,
  );
  assert.match(
    row.detail!,
    /weekly check last ran dedicated-vps 2026-10-19, shared-vps 2026-10-19/,
  );
  assert.match(
    row.detail!,
    /Cloudflare ranges unchanged \(etag 38f79d05\), matched by HATCHKIT-CF on dedicated-vps;/,
  );
  const withFirewall = updateRow(
    [scan(DEDICATED, fixtures.new), scan(SHARED, fixtures.shared)],
    now,
    { checked: ["shared-vps-fw"], mismatches: [] },
  );
  assert.match(
    withFirewall.detail!,
    /matched by HATCHKIT-CF on dedicated-vps, Hetzner firewall shared-vps-fw/,
  );
}

// --- Cloudflare changes its ranges: both origins would drop the new edges -------
{
  const scans = [scan(DEDICATED, fixtures.changed), scan(SHARED, fixtures.changedShared)];
  const live = liveCloudflare(scans)!;
  assert.ok(live.includes("198.51.100.0/22") && !live.includes("131.0.72.0/22"));
  assert.equal(live.length, 22);
  const row = updateRow(scans, now, {
    checked: ["shared-vps-fw"],
    mismatches: [
      {
        name: "shared-vps-fw",
        port: "443",
        missing: ["198.51.100.0/22"],
        extra: ["131.0.72.0/22"],
      },
    ],
  });
  assert.equal(row.status, "fail");
  assert.equal(
    row.detail!.match(/Cloudflare IP ranges changed \(etag 5e1a8d1e0c3f4b2a9d7c6e5f4a3b2c1d\)/g)
      ?.length,
    1,
    "one Cloudflare change, not one per host",
  );
  assert.match(
    row.detail!,
    /chain HATCHKIT-CF on dedicated-vps does not match Cloudflare's ranges/,
  );
  assert.match(row.detail!, /Hetzner firewall shared-vps-fw \(port 443\) does not match/);
  const hints = row.hint!.join("\n");
  assert.match(hints, /added 198\.51\.100\.0\/22; removed 131\.0\.72\.0\/22/);
  assert.match(hints, /update-watch-cloudflare\.json/);
  assert.match(hints, /tailscale ssh root@dedicated-vps iptables -S HATCHKIT-CF/);
  assert.match(
    hints,
    /shared-vps-fw, port 443: missing 198\.51\.100\.0\/22 \(dropped\); not Cloudflare's 131\.0\.72\.0\/22/,
  );
  const unread = updateRow([scan(DEDICATED, fixtures.new)], now, {
    checked: [],
    mismatches: [],
    error:
      "couldn't read the Hetzner token: OS keychain access is disabled for this unattended command.",
  });
  assert.equal(unread.status, "warn");
  assert.ok(unread.hint!.some((h) => h.includes("HATCHKIT_KEYCHAIN_ACCESS=allow")));
}

// --- Hetzner firewalls that restrict 80/443 (the token from the test keychain) ---
{
  const live = [...pinnedCloudflare().ipv4, ...pinnedCloudflare().ipv6];
  assert.equal(await compareHetznerFirewalls(live), null, "Hetzner not configured");
  getStore().set("providers.hetzner", { status: "configured" });
  await setSecret(SECRET_KEYS.hetznerToken, "fixture-hetzner-token");
  const realFetch = globalThis.fetch;
  const seen: string[] = [];
  let rules: unknown[] = [];
  globalThis.fetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
    seen.push(`${url} ${init?.headers?.Authorization}`);
    return new Response(
      JSON.stringify({
        firewalls: [
          { name: "shared-vps-fw", rules },
          {
            name: "open-fw",
            rules: [
              { direction: "in", protocol: "tcp", port: "443", source_ips: ["0.0.0.0/0", "::/0"] },
            ],
          },
        ],
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  try {
    rules = [
      { direction: "in", protocol: "tcp", port: "22", source_ips: ["10.0.0.0/8"] },
      { direction: "in", protocol: "tcp", port: "80", source_ips: live },
      { direction: "in", protocol: "tcp", port: "443", source_ips: live },
      { direction: "in", protocol: "udp", port: "41641", source_ips: ["0.0.0.0/0"] },
    ];
    assert.deepEqual(await compareHetznerFirewalls(live), {
      checked: ["shared-vps-fw"],
      mismatches: [],
    });
    assert.deepEqual(seen, [
      "https://api.hetzner.cloud/v1/firewalls?per_page=50 Bearer fixture-hetzner-token",
    ]);
    rules = [{ direction: "in", protocol: "tcp", port: "80-443", source_ips: live.slice(1) }];
    assert.deepEqual(await compareHetznerFirewalls([...live, "198.51.100.0/22"]), {
      checked: ["shared-vps-fw"],
      mismatches: [
        {
          name: "shared-vps-fw",
          port: "80-443",
          missing: ["173.245.48.0/20", "198.51.100.0/22"],
          extra: [],
        },
      ],
    });
    assert.match(
      (await compareHetznerFirewalls(null))!.error!,
      /Cloudflare's ranges could not be read/,
    );
  } finally {
    globalThis.fetch = realFetch;
    getStore().delete("providers.hetzner");
  }
}

// --- the weekly timer, per host -----------------------------------------------
{
  const missing = updateRow(
    [
      scan(DEDICATED, fixtures.new, { installed: false, lastCheck: null }),
      scan(SHARED, fixtures.shared, { installed: false, lastCheck: null }),
    ],
    now,
  );
  assert.equal(missing.status, "warn");
  assert.match(missing.detail!, /^no high\/critical advisory covers dedicated-vps: /);
  assert.match(missing.detail!, /weekly check not installed on dedicated-vps/);
  assert.match(missing.detail!, /weekly check not installed on shared-vps/);
  assert.ok(
    missing.hint!.includes(
      "Preview (reads only): hatchkit host updates install --host shared-vps --dry-run",
    ),
  );

  const stale = updateRow(
    [scan(DEDICATED, fixtures.new, installed(ran("2026-10-05T06:00:00Z")))],
    now,
  );
  assert.equal(stale.status, "fail");
  assert.match(stale.detail!, /last run 2026-10-05T06:00:00Z, 14 days ago/);

  const unmailed = updateRow(
    [
      scan(
        DEDICATED,
        fixtures.new,
        installed(ran("2026-10-19T06:00:00Z", { mailError: "OSError" })),
      ),
    ],
    now,
  );
  assert.equal(unmailed.status, "fail");
  assert.ok(
    unmailed.hint!.includes("Test the mail path: hatchkit host updates test --host dedicated-vps"),
  );

  const inactive = updateRow(
    [scan(DEDICATED, fixtures.new, { ...installed(), active: false })],
    now,
  );
  assert.equal(inactive.status, "fail");
  assert.match(inactive.hint![0], /systemctl enable --now hatchkit-update-watch\.timer/);

  const killed = updateRow(
    [scan(DEDICATED, fixtures.new, { ...installed(), serviceResult: "timeout" })],
    now,
  );
  assert.match(killed.detail!, /systemd result "timeout"/);
}

// --- what could not be checked is never "clean" --------------------------------
{
  const skipped = updateRow(
    [
      scan(DEDICATED, {
        ...fixtures.new,
        skipped: [
          "Traefik: GitHub API rate limit reached for this address; it resets at 07:00 UTC",
        ],
      }),
      { host: SHARED, error: "Backup host shared-vps command failed (exit 255)." },
    ],
    now,
  );
  assert.equal(skipped.status, "warn");
  assert.match(skipped.detail!, /1 check not made on dedicated-vps/);
  assert.match(skipped.detail!, /couldn't scan shared-vps: Backup host shared-vps command failed/);
  assert.ok(
    skipped.hint!.some((h) =>
      h.startsWith("Not checked on dedicated-vps: Traefik: GitHub API rate limit"),
    ),
  );
  assert.ok(
    skipped.hint!.includes("Retry one host: hatchkit host updates --host shared-vps --json"),
  );
}

// --- over Tailscale SSH (a fake tailscale and gh on PATH) -----------------------
const dir = mkdtempSync(join(tmpdir(), "hatchkit-update-watch-"));
try {
  assert.deepEqual(await checkUpdateWatch(), [], "without a backup host doctor stays quiet");
  getStore().set("providers.backups", {
    status: "configured",
    repositoryBase: "s3:https://account.eu.r2.cloudflarestorage.com/backups",
    hosts: {
      "dedicated-vps": { transport: "tailscale", target: "root@dedicated-vps", serverUuid: "qjtg" },
      "shared-vps": { transport: "tailscale", target: "root@shared-vps", serverUuid: "s2" },
    },
    autoRegister: false,
  });
  const bin = join(dir, "bin");
  mkdirSync(bin);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const script = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // tailscale: argv and stdin per target, then that target's answer.
  const tailscale = (body: string) =>
    script(
      "tailscale",
      `t=$(echo "$2" | cut -d@ -f2)\nprintf '%s\\n' "$@" > "${dir}/argv-$t"\ncat > "${dir}/stdin-$t"\n${body}`,
    );
  const argv = (host: string) =>
    readFileSync(join(dir, `argv-${host}`), "utf8")
      .trim()
      .split("\n");
  const stdin = (host: string) => JSON.parse(readFileSync(join(dir, `stdin-${host}`), "utf8"));
  writeFileSync(
    join(dir, "dedicated-vps.json"),
    `${JSON.stringify({ ...fixtures.old, timer: { installed: false, lastCheck: null } })}\n`,
  );
  writeFileSync(
    join(dir, "shared-vps.json"),
    `${JSON.stringify({ ...fixtures.shared, timer: { installed: false, lastCheck: null } })}\n`,
  );
  tailscale(`cat "${dir}/$t.json"`);

  // gh: fails → no prefetched feeds; the host reads GitHub itself.
  script("gh", "exit 1");
  const [row] = await checkUpdateWatch();
  assert.equal(row.status, "fail");
  assert.match(row.detail!, /Plausible CE 3\.0\.1 on dedicated-vps: 1 advisory \(critical\)/);
  assert.match(row.detail!, /weekly check not installed on shared-vps/);
  const sent = stdin("dedicated-vps");
  assert.equal(sent.script, readFileSync("src/templates/update-watch/update-watch.py", "utf8"));
  assert.deepEqual(sent.services, watchedServices());
  assert.deepEqual(sent.cloudflare, pinnedCloudflare());
  assert.equal(sent.cloudflare.etag, "38f79d050aa027e3be3865e495dcc9bc");
  assert.deepEqual(sent.feeds, {});
  assert.deepEqual(argv("shared-vps").slice(0, 2), ["ssh", "root@shared-vps"]);
  const command = argv("dedicated-vps")[2];
  assert.match(command, /^python3 -c '[^']+' scan$/);

  // The command runs the script from stdin under a real shell, with PAYLOAD.
  const boot = spawnSync("sh", ["-c", command], {
    input: JSON.stringify({
      script: "import json,sys\nprint(json.dumps({'argv': sys.argv, 'feeds': PAYLOAD['feeds']}))",
      feeds: { x: 1 },
    }),
    encoding: "utf8",
  });
  assert.equal(boot.status, 0, boot.stderr);
  assert.deepEqual(JSON.parse(boot.stdout), { argv: ["update-watch.py", "scan"], feeds: { x: 1 } });

  // gh answers: advisories trimmed to what the matcher reads, latest release.
  script(
    "gh",
    `case "$*" in
  *security-advisories*) echo '[[{"ghsa_id":"GHSA-x","severity":"high","summary":"s","description":"LONG TEXT","credits":[1],"html_url":"u","published_at":"p","withdrawn_at":null,"vulnerabilities":[{"package":{"ecosystem":"go","name":"n"},"vulnerable_version_range":"< 1","patched_versions":"1","vulnerable_functions":[]}]}],[{"ghsa_id":"GHSA-y","severity":"low","summary":"t","html_url":"u2","published_at":"p","withdrawn_at":null,"vulnerabilities":null}]]' ;;
  *releases/latest*) echo '{"tag_name":"v9.9.9","published_at":"2026-10-01T00:00:00Z","body":"notes"}' ;;
  *) exit 1 ;;
esac`,
  );
  await checkUpdateWatch();
  const feeds = stdin("shared-vps").feeds;
  assert.deepEqual(
    Object.keys(feeds).sort(),
    watchedServices()
      .filter((s) => s.github)
      .flatMap((s) => [advisoriesUrl(s.github!), latestUrl(s.github!)])
      .sort(),
    "GlitchTip (GitLab) is read by the host",
  );
  const traefik = feeds[advisoriesUrl("traefik/traefik")];
  assert.equal(traefik.length, 2, "both pages");
  assert.equal(traefik[0].description, undefined);
  assert.deepEqual(traefik[0].vulnerabilities, [
    {
      package: { ecosystem: "go", name: "n" },
      vulnerable_version_range: "< 1",
      patched_versions: "1",
    },
  ]);
  assert.deepEqual(traefik[1].vulnerabilities, []);
  assert.deepEqual(feeds[latestUrl("traefik/traefik")], {
    tag_name: "v9.9.9",
    published_at: "2026-10-01T00:00:00Z",
  });

  // One host down: its own warning, the other still reported.
  tailscale(`[ "$t" = shared-vps ] && exit 255\ncat "${dir}/$t.json"`);
  const [partial] = await checkUpdateWatch();
  assert.equal(partial.status, "fail");
  assert.match(partial.detail!, /couldn't scan shared-vps: Backup host shared-vps command failed/);

  // install --dry-run: six files and the boot line; the installer stops after
  // its read-only first scan and checks every prerequisite before writing.
  tailscale(`printf '{"host": "shared-vps", "applied": false, "findingsNow": []}\\n'`);
  const preview = await installUpdateWatch(SHARED, true);
  assert.equal(preview.applied, false);
  assert.equal(preview.backupHost, "shared-vps");
  assert.equal(
    preview.rollback,
    "hatchkit host updates uninstall --host shared-vps (keeps the last status)",
  );
  const payload = stdin("shared-vps");
  assert.equal(payload.dryRun, true);
  assert.deepEqual(Object.keys(payload).sort(), ["boot", "dryRun", "feeds", "files"]);
  assert.deepEqual(Object.keys(payload.files).sort(), [
    "hatchkit-update-watch-failed.service",
    "hatchkit-update-watch.service",
    "hatchkit-update-watch.timer",
    "update-watch-cloudflare.json",
    "update-watch-services.json",
    "update-watch.py",
  ]);
  assert.match(
    payload.files["hatchkit-update-watch.timer"],
    /OnCalendar=Mon \*-\*-\* 06:00:00 UTC/,
  );
  assert.match(
    payload.files["hatchkit-update-watch.service"],
    /OnFailure=hatchkit-update-watch-failed\.service/,
  );
  assert.match(payload.files["hatchkit-update-watch.service"], /update-watch\.py check/);
  assert.match(payload.files["hatchkit-update-watch-failed.service"], /update-watch\.py failed/);
  assert.equal(command.includes(payload.boot), true, "install probes with the same boot line");
  const installer = Buffer.from(
    argv("shared-vps")[2].match(/b64decode\("([^"]+)"\)/)![1],
    "base64",
  ).toString();
  const dryExit = installer.indexOf("if payload['dryRun']:");
  assert.ok(dryExit > installer.indexOf("probe=subprocess.run"), "dry-run reports the first scan");
  assert.ok(dryExit < installer.indexOf("temp.write_text"), "dry-run exits before any write");
  for (const check of [
    "fail('unexpected installer files')",
    "fail('the backup runner is not installed",
    "fail('backup alert mail is not configured",
    "fail('the first scan failed",
  ])
    assert.ok(installer.indexOf(check) < installer.indexOf("temp.write_text"), check);

  tailscale(`printf '{"applied": false, "removed": [], "kept": []}\\n'`);
  assert.deepEqual(await uninstallUpdateWatch(DEDICATED, true), {
    applied: false,
    removed: [],
    kept: [],
  });
  assert.match(argv("dedicated-vps")[2], /sys\.argv=\["hatchkit","dry"\]/);

  // Arguments: a write names its host when there are several.
  await assert.rejects(runUpdatesCommand(["install", "--dry-run"]), /Several backup hosts/);
  await assert.rejects(runUpdatesCommand(["--dry-run"]), /applies to host updates install/);
  await assert.rejects(runUpdatesCommand(["--host"]), /Unknown or incomplete/);
  await assert.rejects(runUpdatesCommand(["--host", "nope"]), /No backup host named nope/);
  await assert.rejects(runUpdatesCommand(["nope"]), /Usage:/);
  const help = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/index.ts", "host", "updates", "install", "--help"],
    { encoding: "utf8" },
  );
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /hatchkit host updates install --host <name> \[--dry-run\]/);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log("Update watch matcher, doctor row and host payloads passed.");
