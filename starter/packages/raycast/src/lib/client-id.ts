/**
 * What this surface calls itself to the server.
 *
 * The device-flow `client_id` is server-allowlisted: the generated
 * `validateClient` names one id per pairing client, and a pairing request
 * carrying anything else is refused with `invalid_client`. It is also carried
 * by every credential the server has already issued to this surface, so
 * changing it strands them. It is a project identifier, written once at
 * scaffold time from the manifest's `identifiers.clientIds` — never composed
 * here from the extension's name or from anything else on disk.
 *
 * It doubles as the value of the client-identification header, which is what
 * the account's device list shows and what per-surface revocation acts on.
 * Cosmetic there, load-bearing in the pairing request.
 */
export const CLIENT_ID = "starter-raycast";
