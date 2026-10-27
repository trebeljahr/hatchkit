# Restricted Traefik discovery

`discovery.py` supplies the requests used by Traefik's **non-Swarm Docker
provider**. It is a small, private discovery service, not a general Docker API.
The broker still holds daemon trust; a read-only socket mount does not remove
that trust. Keep management components and the broker in the incident scope.

Allow only ping, version, container IDs, redacted container inspection and
start/die/health events. Deny creation, exec, archive, logs, images, volumes and
other paths. Inspection omits environment, commands, mounts, health output and
unrelated labels. Routing labels, ports and network addresses remain visible
because Traefik needs them; routing labels can contain credentials themselves.

Require a unique 43-character base64url `DISCOVERY_TOKEN` and Traefik's Docker
provider Basic authentication (`discovery` as username). Generate it inside the
existing private deployment/configuration system. Never print it, commit it,
put it in a test receipt or export rendered configuration between hosts. Only
loopback ping bypasses authentication for the container health check.

Deploy with these controls:

- Dedicated internal Docker network containing only Traefik and this broker;
  no published port, host networking, app networks or extra mounts.
- UID/GID `65532:65532`, supplemental host socket GID, all capabilities dropped,
  no-new-privileges and read-only root. The sole bind is the Docker socket.
- 128 MiB memory, 256 MiB combined memory/swap, 0.5 CPU and 64 PIDs. Confirm
  headroom before adopting this profile on a larger fleet.
- Loopback `/_ping` health check and a healthy dependency before Traefik starts.
- Exact tested image, `pull_policy: never` for a local image, and rooted image
  provenance. Keep package scans and a tested rebuild path for the broker too.

`compose.yaml.example` contains the reusable broker module and required client
integration notes. Merge it into the native private proxy configuration; preserve
existing Traefik flags and add its internal network/healthy dependency. The module
alone does not remove a client's socket. Never print rendered configuration to
inspect it: its environment/provider arguments contain the service-local token.

The Dockerfile expects an inspected official Python Alpine base digest. Build
and scan on the application host. Use the real installed Traefik image in the
canary; provider behavior can change between releases. Fixture guards:

```sh
python3 cli/test-docker-discovery.py
python3 cli/test-container-policy.py
python3 cli/test-health-publisher.py
```

Before production, run a canary on the real host. It should verify real routing,
start/die events, idle event renewal, broker restart/cold-start recovery,
authentication, redaction and denial from an existing application network, then
remove its containers/network and verify the original running container IDs are
unchanged. Hatchkit does not ship that canary: it names one host's containers,
so it belongs in the operator's own runbook. Choose an existing application for
the negative network probe, and probe with Node when that application has Node
rather than Python. Keep production credentials out of the fixtures.
Cold-start coverage explicitly starts Traefik while its broker is unavailable:
Docker daemon restart does not enforce Compose's dependency startup ordering.

`native-proxy-discovery.py` prepares the change inside the controller and uses
the existing `SaveProxyConfiguration`/`StartProxy` actions. Preserve the current
Traefik image bytes, ports, TLS/data mounts and unrelated settings. Keep private
original configuration and an original-host image anchor. Check activity status
and use `proxy-discovery-host.py` to verify real application routes/TLS and all
other running containers. Never repeat an ambiguous deployment request blindly.
Pin the actual inspected Traefik repository manifest digest and verify it
resolves to the running image ID. A manifest digest and image configuration ID
can differ. Do not construct a repository digest by prefixing an image ID.
Dedicated game health checks must use their real public RPC prefixes; an
unrouted container-only health path is not evidence of a proxy failure.
Rollback restores the private original configuration with a verified runtime
image pin through the same native actions; inspect concurrent changes first.

Pin recovery to the **observed original runtime image**, even when an older
saved Compose tag lagged behind that runtime. Preserve the original canonical
bytes separately; prepare a recovery variant that changes only the image pin
and sets `pull_policy: never`. Verify the manifest resolves on the target host,
parse the private recovery Compose on the controller host and prove an explicit
pull skips it. Never copy that private YAML to an operator machine or another
application host. Recovery preparation must not restart services. Validate
companion images separately when a proxy definition contains multiple services.
Legacy receipts without a controller image require an explicit review of the
current exact image before recovery preparation. Record that review separately;
do not invent historical identity or override a recorded controller mismatch.
Keep hash-verified, mode-0600 transaction copies outside the controller container
on its original host. Container-local storage alone can disappear during a
controller replacement. Retain the original and candidate hashes, immutable image
identities and private recovery configuration; never export these through the
operator machine. Reconstruct a missing record only from hash-matched original
backup bytes and unchanged canonical/runtime identities, and label reconstruction
explicitly. A reconstruction must not change live configuration or start services.

Normal saved-configuration restarts retain this setup. **Force-regenerating the
proxy defaults can drop the broker/network and restore direct socket access.**
Review regeneration and controller/provider upgrades against the canary before
applying them. Sentinel and other management agents need their own trust review.

# Reviewed control drift

`container-policy.py` checks explicit reviewed settings; it never learns a
baseline or changes containers. Policies contain selectors and expected controls,
not environment values. Prefix selectors cover every running rolling replica.
The timer runs every five minutes. Install the policy, produce a successful
status, then enable `HATCHKIT_CONTAINER_POLICY_REQUIRED=1` in a separate publisher
service drop-in. Keep publisher credential files unchanged.

The publisher combines process/control status using the **older** timestamp.
Missing or failed control reports stay incomplete, so an independent monitor can
detect disappearance. Only booleans/counts/timestamps leave the host. Policy
findings stay visible locally without exporting resource names or secrets.
New controls must be tested and explicitly added to the policy. This check does
not prove isolation for containers that have no reviewed policy yet.

`app-resources-policy.example.json` is a partial CPU/memory drift profile. Replace
the selector and use only limits justified by measured headroom and a tested undo
path. Persist the same settings through the native deployment configuration and
check each running replica. This profile makes no PID, filesystem, capability,
user or no-new-privileges claim; those need separate tested controls. Never copy
a limit across the fleet after testing only one application.

`node-app-permission-policy.example.json` is a stronger **per-app tested** example.
It requires a checker with strict field/Tmpfs support; set the enclosing config
to schema 2 so older schema-1-only checkers fail incomplete instead of ignoring
new fields. Replace the selector, preserve the existing policy set and adapt the
UID, writable data mounts and temporary space to the actual application. Check
kernel UID, capabilities, no-new-privileges, cgroup limits and a denied root write.
Prove authenticated application traffic, data writes, realtime and restart
recovery on synthetic data before production. Do not add a permission claim to
drift policy until both native generation/deployment and live controls pass.

Preserve an image app's canonical tracking tag while selecting the exact observed
repository manifest for its one maintenance deployment. Inspect the installed
native entry point and normal admission rules; do not bypass concurrency limits.
Persist the tested options and queue admission atomically, dispatch one job after
commit, and prove the transaction rolls back before a live request. Record its
planned UUID first and inspect ambiguous outcomes before any retry. Keep a fresh
database snapshot and image/runtime recovery evidence on the original host.
Reject unknown image/data identities before recovery; never automatically restore
old database contents as part of reverting container configuration.

Game probes need per-app fixtures: a game on SQLite and Redis, or one on a fresh
PostgreSQL/Redis stack with its installed WebSocket codecs. Keep current
protocol/forfeit semantics, exercise persisted results after restart, bound
client handshakes and retain private diagnostics on timeout. Remove only labelled
fixtures and verify original production identities on every path. An isolated
canary or generation probe is not proof of live enforcement. Activate an app's
stronger drift profile only after a native deployment with the original
image/data and kernel controls. Apply that same canary, native deployment and
live verification boundary to each app.

Upgrade checker and policy together only after live controls pass. Preserve all
other reviewed profiles, use schema 2, test the complete current policy against
the strict checker, then review the exact authored files against the trusted AIDE
baseline. Upgrade and review scripts written for one host are scoped examples, not an
automatic baseline-learning service. Existing monitor credentials stay unchanged.

# Provider metadata guard

`metadata-guard.py` owns only `HATCHKIT-METADATA` and its tagged
first jump in `DOCKER-USER`. It drops Docker bridge forwarding to the exact
provider metadata IPv4 and IPv6 addresses. Host OUTPUT, Tailscale interfaces and
other forwarding rules are untouched. Unsupported bridge names/backend, changed
hook order, modified owned rules or unexpected references require review. Apply
and rollback use `iptables-restore --noflush`; rollback removes only exact owned
rules and reports protection absent even when the rollback itself succeeded.

Before installation, test current host/app TCP reachability without fetching
metadata. Prove apply/rollback/reapply on one host, retained host metadata access,
app DNS and certificate-validated outbound TLS, unchanged public routes and
public-origin IPv4/IPv6 filtering. Check both rule families. If containers have
no IPv6 path, state that limit rather than claiming an IPv6 connection test.

The apply unit follows Docker startup/restart; the separate timer checks every
five minutes without silently accepting or repairing changed rules. Enable the
publisher's `HATCHKIT_METADATA_GUARD_REQUIRED=1` drop-in only after successful
installation and a fresh complete report. The external process check then uses
the oldest process, container-policy and metadata-guard timestamp. Missing or
failed guard reporting remains visible. Preserve publisher credentials and
manually review exact AIDE changes. Copying these templates does not activate the guard.

Provider addresses: [Hetzner metadata](https://docs.hetzner.cloud/reference/cloud)
and [hcnet IPv6 metadata](https://docs.hetzner.com/cloud/technical-details/hcnet/).
Rule ordering: [Docker iptables](https://docs.docker.com/engine/network/firewall-iptables/).

Provider request sources: [Docker provider](https://github.com/traefik/traefik/blob/v3.7.16/pkg/provider/docker/pdocker.go)
and [shared discovery](https://github.com/traefik/traefik/blob/v3.7.16/pkg/provider/docker/shared.go).

# Proxy to database guard

`database-guard.py` is a narrow additional boundary for explicitly named database
containers on a host where the native controller reattaches its shared service
network. It places DROP rules on the reverse proxy's actual host veth ingress
interfaces, covering direct IP traffic to those databases before bridging or
routing. It changes only its own `netdev hatchkit_db_guard` nftables table;
existing origin, Docker and metadata rules remain untouched. Namespace-local
interface names or packet source addresses are not trusted identities.

Do not assume iptables forwarding rules cover same-bridge traffic: the reviewed
host did not have bridge netfilter enabled. No bridge sysctl/module was changed.
With nft 1.0.9, JSON omits the ingress device; verify the exact device independently
in bounded native output. A rule that looks right without a proven hook is not
verified enforcement.

A five-second poll resolves current containers/interfaces. Changes converge after
that poll and command latency, with a 30-second service restart backoff after a
failed cycle; this is not zero-gap isolation. Missing containers
or unexplained firewall changes fail incomplete. Linux removes ingress chains
when their veth disappears. Accept only that exact subtraction when the observed
Docker identity/topology changed and the old host devices are independently
absent; keep every other reviewed rule exact. Never learn an unexplained policy.

The synthetic internal-network canary proves before/apply/undo/reapply behavior,
application-path preservation and replacement-proxy reconciliation without
production records, credentials or mounts. Real deployment additionally needs
TCP-only proxy-denial/application-connection checks for every named database,
real TLS routes, original-container checks, independent report coupling and a
separate exact AIDE review. Template files alone activate nothing. Adapt `database-guard.example.json` to
explicit existing names before installation.

This boundary does not split the actual Layer 2 networks, remove the proxy's raw
socket capability, prevent ARP spoofing, restrict general outbound traffic or
isolate app-to-host management access. Keep those risks visible and continue
capability/network hardening. A real Docker/host restart needs its own verification;
the replacement-fixture test does not establish it. The optional publisher flag
`HATCHKIT_DATABASE_GUARD_REQUIRED=1` makes missing/failed guard reporting incomplete
without transmitting database names, addresses or application records.

# Proxy permission profile

`proxy-permissions.example.yml` is a fragment for an existing proxy service, not
a standalone Compose deployment. Measure current demand and test its exact image
before merging these keys. A real-host canary should exercise the restricted
Traefik on real ports 80 and 443, using a fresh synthetic certificate and verified
TLS, routing/start/die events, idle discovery and cold-start recovery. It should check
kernel effective/bounding capabilities and no-new-privileges, remove its synthetic
key/fixtures and preserve production container/image/start/restart identity.

The native controller helper compares the complete parsed configuration outside
these fields, preserves discovery credentials, images, routes and mounts, and
retains original configuration privately. It pins the controller image and native
action hash, records submission intent before dispatch, and refuses duplicate
application or recovery while its native activity is unfinished. Validate Compose,
keep a current original-host snapshot/image anchor and verify actual runtime,
health, TLS identities, companion controls and all existing drift policies after
the native deployment. A canary or prepared candidate is not proof of live controls.

Read-only root does not make existing writable binds read-only. The original
proxy data/configuration bind remains a separate permissions review; preserve
certificate state and test renewal before narrowing its writable locations.
Do not restore old data when reverting configuration. Do not regenerate proxy
defaults, change the controller/updater or replace discovery credentials as part
of applying this fragment.

# Node app permission profile

`node-app-permissions.example.yml` is a fragment for an existing service. It
does not activate a deployment. Test the exact image with fresh synthetic data,
its existing non-root user, no external network/credentials and only explicit
writable data mounts. Exercise real functions, SQLite write/integrity and restart
persistence where used, plus the kernel capability bounding set, no-new-privileges
and denied root writes. Next.js caches and release-asset bootstraps require their
own writable-path review; one Node app's canary does not qualify another app.

Fresh app defaults and the matching policy example use 512 PIDs. Preserve an
existing separately measured 256-PID profile rather than changing it implicitly.
Preserve the existing recorded tracking tag and select the exact immutable image
for a permissions-only native deployment. Keep an online original-host recovery
snapshot and source-bound generator/admission proofs before replacing anything.
Verify original volume/device/inode and database identity, credentials and other
workloads, then add only the qualified drift expectations and review their exact
integrity diff. Recovery restores configuration; it must not restore older data.

`next-app-permissions.example.yml` includes a separate capped cache for the
reviewed UID-1000 Next standalone layout. An exact-image canary for such an app also
tests original startup/asset publishing, retained asset bytes and range requests,
mixed-release RSC rejection and cold restart. It seeds only synthetic prior
metadata and public exports carried in the image. Its dotenvx command reads a
synthetic environment file; no production key or store is used. Cache permission
does not qualify arbitrary ISR or upload paths, and the external newsletter
delivery flow is not claimed by the disconnected canary.

A Mongo/Redis app needs isolated backing services in its permission canary, not
production URLs or copied credentials. A game's exact-image test should include synthetic
authenticated game/WebSocket behavior, native preview rendering and persistence
across restart with the 512-PID profile. Verify original backend identities/mounts
and real readiness after deployment. Preserve unknown native submission intent
until queue, runtime and settings inspection resolves it; never blindly retry.

For Mongo-only tRPC apps, exercise authenticated profile writes and their actual
business records across restart. Each canary covers the records its app stores and
profile persistence, not external provider flows. Mask an encrypted environment file with
a fresh synthetic file when the production loader can override process values.
Any email-verification opt-out belongs only to the disconnected fixture; preserve
the full production environment and authentication policy during deployment.
Capture only registered Mongo sources on the original host. A gzip integrity
check proves a capture is readable, not a restore drill or an authorized upload.

An app using Mongo transactions needs a fresh synthetic replica-set primary in
the fixture. One reviewed case exercises authenticated projects,
timer start/stop, WebSocket access and state/session persistence after restart.
That coverage does not imply invoice, avatar or external-provider flow testing.
Preserve its actual 512-PID profile and registered production database identity;
never reuse real Mongo credentials or initialization files to make a fixture pass.

For a PostgreSQL accounts API, test its real startup migrations and verification
requirement with fresh synthetic data and a disconnected TLS mail fixture. One reviewed
case includes rejected unverified sign-in, fake-link verification,
verified login, credits/session persistence after restart and the disabled paid
provider boundary. Trust only the fixture CA inside the fixture; retain normal
TLS verification. Explicitly chmod a non-root bind directory after a private
umask-masked mkdir while keeping its host parent 0700. Preserve existing native
capability/PID options and qualify only source-proven restart bookkeeping resets.

`redis-resources.example.yml` and its matching policy JSON are an opt-in resource
profile, separate from database permissions. Measure current/lifetime memory and
PID use and require headroom. The reviewed Redis 7.2.16 image passed authenticated
pipeline writes, AOF restart and a separate cold RDB reload with 256 MiB memory,
512 MiB combined memory/swap, half a CPU and 128 PIDs. These observations do not
qualify arbitrary Redis datasets or engine upgrades. The native standalone
database generator can be exercised through an injected non-executing command
executor, with its database/environment changes rolled back. Compare the complete
generated configuration outside the four intended resource fields.

Record canonical-image differences separately when a running locally patched
image differs from its upstream tag. Qualify image selection before a native
restart/redeploy. Resource-only cgroup changes preserve current image/data bytes;
configuration recovery must preserve current volumes and writes, including when
the limited container is stopped or OOM-killed. Never overwrite a newer image,
credential, mount, network or privilege change during recovery.
