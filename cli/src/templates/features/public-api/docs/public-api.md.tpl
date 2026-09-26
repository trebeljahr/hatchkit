# Public REST API and webhooks

`/api/v1` is the token-authenticated REST surface third parties integrate
against, with webhooks pushing the same events out. This file is the
maintainer's view; `docs-site/docs/api/reference.md` is the integrator's, and
it is generated.

```bash
pnpm run openapi:emit                 # regenerate the two committed artifacts
pnpm --filter __HATCHKIT_SERVER_PKG__ run test
```

## REST never enters tRPC

A request authenticates in `src/api/v1/auth.ts`, builds a `TenantScope`, and
calls the same extracted services (`src/services/items/`) the tRPC resolvers
call. There is no synthetic tRPC context and no token path through
`protectedProcedure`. That is what makes "a token can never name a tenant of
its own" structural rather than a rule repeated per handler: the request never
reaches a place where a tenant id is read from input, because on that path no
such place exists.

It also means a REST write publishes the same realtime event and enqueues the
same webhooks as a typed one — nothing under `src/api/v1/` re-implements a
business rule. If you add a rule, add it to the service.

## The rules, each of which fails quietly if broken

- **`API_ROUTES` in `src/api/v1/routes-table.ts` is the only source of truth.**
  Express mounts from it and `z.toJSONSchema` builds the OpenAPI document from
  the same shared zod schemas the handlers validate with — zod 4, native, and
  there is deliberately no zod-to-openapi dependency. A route not in the table
  is not mounted; a route in it with no handler throws AT BOOT rather than
  404-ing in production.
- **`docs-site/static/openapi.json` and `docs-site/docs/api/reference.md` are
  committed.** A spec regenerated at deploy time is a spec nobody reviews in a
  diff. `src/tests/openapi-document.test.ts` fails when either is stale.
- **A token's permissions are live, intersected with a frozen ceiling.** The
  ceiling is written onto the token at mint time and never widens. Revoking a
  permission narrows every existing token on its next request; granting one
  never widens a token minted earlier. A removed member's token is DEAD — 401,
  not 403, because there is nothing left for it to act as.
- **Cross-tenant and foreign ids answer 404, never 403.** A 403 confirms the id
  exists somewhere. 403 is only for a permission refusal on a resource this
  tenant genuinely owns and this caller can genuinely see — editing another
  member's item without `items:write-others`, or managing webhooks without
  `webhooks:manage`.
- **Every 5xx `detail` is the same fixed string in every environment.** The
  global `errorHandler` returns `err.message` verbatim outside production, so
  v1 answers its own errors instead of throwing into it. The real error goes to
  the log as one JSON line.

Errors are RFC 9457 `application/problem+json`. Successes are `{ data }`, with
`nextCursor` always present and `null` on a list's last page. Rate limiting is
a fixed 60-second window per token (`API_RATE_LIMIT_PER_MINUTE`, default 600),
Redis when there is one and per process when there is not; failed
authentications are metered separately, keyed on the source address AND the
presented token prefix so one revoked cron cannot refuse every other
integration behind the same NAT.

## Webhooks

Deliveries sign `HMAC-SHA256(secret, "<timestamp>.<rawBody>")` as `v1=<hex>`,
over a `rawBody` computed ONCE in `src/services/webhooks/delivery.ts` and
handed to `fetch` unchanged. Serialize it twice and every receiver doing its
job rejects the delivery as forged — there is exactly one serialization on that
path, and it should stay that way.

Deliveries are projected at send time against the subscription owner's LIVE
permissions (`src/services/webhooks/projection.ts`). Withheld reads as
`skipped_visibility`, which is a permission outcome and not a failure: it burns
no retry and counts towards no auto-disable.

`assertDeliverableUrl` re-resolves DNS before EVERY attempt, because a
create-time-only SSRF check is decorative against rebinding.
`WEBHOOK_ALLOW_PRIVATE_TARGETS=true` lifts the https and private-address rules
for a local listener and belongs nowhere else.

Six attempts over just under eight hours (`backoff.ts`), then the delivery is
`failed`. Fifteen consecutive dead deliveries disable the subscription.

## The tenant model

The starter has no tenancy of its own: an `Item` carries an `ownerId` and that
is the whole story. This feature adds the smallest thing that makes permissions
mean something:

- `ApiMember` — who belongs to a tenant and what they may do. For a single-user
  project the tenant id IS the user id and there is one row, created when the
  first token is minted.
- `services/tenancy.ts` — `scopeForSession` and `tenantMemberIds`. **These two
  functions are the whole tenancy model.** An app with shared tenants changes
  them and nothing else: every service reads the tenant off the scope and never
  off an argument.

## Wiring the fan-out

`services/items/events.ts` publishes to webhooks always, and to every listener
registered with `onItemEvent`. It imports neither the websocket layer nor the
sync feed: both are optional parts of this scaffold, and importing an optional
module from a service makes it a hard dependency of the public API — the
server stops booting in every project that declined it.

Two listeners matter:

- **The `client-core` sync feed.** `services/items/sync-bridge.ts` is written
  only when `src/sync/feed.ts` exists, and `src/index.ts` calls
  `registerItemSyncBridge()` at module scope. It publishes to
  `scope.actorId` — the user the write RAN AS, off the session or the token
  row and never off request input, which is the rule `sync/feed.ts` states.
  This is where the `publishSync` calls that used to sit in each tRPC resolver
  went; keeping them in the resolvers would have left every REST write silent.
- **The websocket layer**, if you want one. In `src/index.ts`:

  ```ts
  import { onItemEvent } from "./services/items/events.js";
  import { roomManager } from "./ws/handler.js";

  onItemEvent((event, data, scope) => {
    roomManager.broadcast(scope.tenantId, { type: "item-event", event, data });
  });
  ```

`onItemEvent` is a list, not a slot: registering a second listener does not
replace the first, and a listener that throws is logged and skipped rather
than failing the write that triggered it.

## The `client-core` blocks in the item router

`src/trpc/routers/items.ts` is rewritten by this feature to call
`services/items/`, and the `// ── client-core ──` blocks are kept so the
feature can still be stripped. What is inside them changed: the `update`
procedure now delegates like every other resolver, and the `publishSync` calls
moved to the sync bridge. If you later add `client-core` with `hatchkit
update`, it will not find its own anchors in the rewritten file and will write
`.hatchkit/post-client-core.md` instead — the block it wants is already here,
so the checklist is usually a no-op you can tick off.

## Minting a token

There is deliberately no REST route that mints a credential: a token that can
mint tokens escapes its own ceiling one child at a time. Use the
session-authenticated tRPC router:

```ts
const { plaintext } = await trpc.apiTokens.create.mutate({
  label: "CI",
  scopes: ["items:read"],
});
```

The plaintext is in that response and in no other, ever.
