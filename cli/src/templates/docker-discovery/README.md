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
