# Newsletter request budget

Subscription requests use the socket peer by default. Forwarding headers do not
select client identity unless `NEWSLETTER_TRUSTED_PROXY_IPS` explicitly lists the
proxy addresses. This policy is independent of the application's Express
`trust proxy` setting and affects only newsletter subscription requests.

The optional variable is a comma-separated list of exact IPv4 or IPv6 literals
(up to 64), not CIDRs or hop counts. Invalid configuration stops route setup.
Only configure addresses after verifying which proxies can connect to the app
and that each trusted proxy appends the actual peer or replaces untrusted
forwarding headers. The resolver walks X-Forwarded-For from right to left and
stops at the first untrusted address. X-Real-IP is ignored. Missing, malformed,
or oversized trusted-chain input falls back to the socket peer. IPv6 spellings
and IPv4-mapped IPv6 are normalized. Unconfigured deployments behind a proxy
share that proxy's budget; no production topology is assumed by this default.

Each process permits five attempts per identity per fixed 60-second window.
The map retains at most 10,000 identities. Expired entries are swept on traffic
at most once per second, and the requested identity expires at its deadline.
At capacity, new identities receive the existing 429 response until space is
available; active entries are never evicted to admit new identities. Idle
processes retain at most the same bounded map, without a timer.

Limits reset on process restart and are independent across workers. This is
not a fleet-wide email quota. Shared-store accounting and edge policy validation
require a separate deployment decision. Existing honeypot and double opt-in
behavior remain in place.

## Deployment configuration

The production Compose server service passes `NEWSLETTER_TRUSTED_PROXY_IPS`
through with an empty default. An empty value keeps socket-peer identity.
Verify the deployed Compose revision and effective container value; setting a
host or control-panel variable alone does not prove the running app received it.
If dotenvx supplies the same key, check its precedence before rollout. Do not
print or dump the container environment to inspect this single non-secret key.

Before setting addresses, inspect the actual ingress route to the server,
proxy container network attachments, header trust/append policy, and direct
server reachability. Trust only the proxy peers actually traversed, not a whole
Docker/private subnet. Dynamic container addresses must be reverified after
container recreation. A trusted proxy that accepts forged forwarding chains
can still defeat per-client identity.

After separate approval for runtime validation, use a staging instance with
mail delivery disabled to verify that two ordinary clients get distinct
identities and independent budgets. Confirm the deployed revision first.
Do not exercise real subscription endpoints merely to discover proxy identity.
If identity is uncertain, retain the empty setting. Clearing the setting and
restarting through the approved deployment workflow restores socket-peer mode.
