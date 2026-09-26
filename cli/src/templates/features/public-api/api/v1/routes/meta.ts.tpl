// Meta routes: who am I, and what does this API look like.
import type { ApiHandlers, PublicApiHandlers } from "../auth.js";
import { sendData } from "../envelope.js";
import { buildOpenApiDocument } from "../openapi.js";
import type { ApiIdentity } from "../routes-table.js";

export const metaHandlers: ApiHandlers = {
  /**
   * The token's own view of itself.
   *
   * The permissions are the EFFECTIVE ones — live membership intersected with
   * the ceiling the token was minted under — so a client can decide whether to
   * offer an action at all instead of discovering the answer from a 403 three
   * screens later. No secret is echoed: the plaintext exists only at mint time
   * and this endpoint has never seen it.
   */
  "get /me": (req, res) => {
    const { tokenId, tenantId, userId, scopes } = req.apiToken;
    const identity: ApiIdentity = {
      tokenId,
      tenantId,
      userId,
      scopes,
      permissions: [...req.apiScope.permissions],
    };
    sendData(res, identity);
  },
};

export const publicMetaHandlers: PublicApiHandlers = {
  /**
   * The spec, unauthenticated.
   *
   * Built from the route table on each request rather than cached: it is a
   * handful of milliseconds, and a stale cache after a deploy is a document
   * that describes the previous release.
   */
  "get /openapi.json": (_req, res) => {
    res.status(200).json(buildOpenApiDocument());
  },
};
