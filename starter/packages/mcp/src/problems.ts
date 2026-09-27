/*
 * Turning a refusal into the one sentence a model can act on.
 *
 * A tool result is read by a model and paraphrased to a person. If the result
 * says only "403 Forbidden", the model has to guess whether the credential is
 * wrong, whether it is missing a scope, or whether the row belongs to somebody
 * else — three different fixes, and it will pick one and state it with
 * confidence. So every refusal this API can answer with is mapped here to
 * exactly one sentence that names what to change, and anything unmapped falls
 * back on its status family rather than on the server's prose.
 *
 * The slugs are the server's own: `problem.type` is
 * `<docs base>/problems/<slug>`, and the set below is what
 * `packages/server/src/api/v1/problem.ts` and `auth.ts` can produce. A slug
 * this table does not know still gets a usable answer — the fallback — so a
 * new refusal on the server degrades to a status-family sentence instead of
 * to nothing.
 */

/** RFC 9457 `application/problem+json`, as this API writes it. */
export type ApiProblem = {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
};

/** True for a body shaped like a problem document. */
export function isApiProblem(value: unknown): value is ApiProblem {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<ApiProblem>;
  return (
    typeof candidate.type === "string" &&
    typeof candidate.status === "number" &&
    typeof candidate.detail === "string"
  );
}

/**
 * The last path segment of a problem `type` URI.
 *
 * The base is a documentation URL the project chooses and may change; the slug
 * is the part that names the failure, so matching on the whole URI would make
 * every hint below stop applying the day somebody publishes their docs
 * somewhere else.
 */
export function problemSlug(type: string): string {
  const withoutQuery = type.split(/[?#]/)[0] ?? type;
  const segments = withoutQuery.split("/").filter((part) => part !== "");
  return segments[segments.length - 1] ?? "";
}

/** One sentence per refusal the API can answer with. */
const HINT_BY_SLUG: Readonly<Record<string, string>> = {
  "invalid-token": `The API credential was rejected. Check the token in your MCP host's configuration, or mint a new one and replace it.`,
  "insufficient-scope": `The token was minted without the scope this call needs. Mint a new token that carries it and replace the one in your host's configuration — scopes are frozen when a token is created.`,
  "tenant-not-addressable": `A token belongs to one tenant and cannot be pointed at another. Use a token minted in the tenant you mean.`,
  "rate-limited": `This token is over its per-minute request budget. Wait for the window named in the message and retry.`,
  "invalid-request": `The arguments were rejected by the server's own validation. The message names each field; correct them and call again.`,
  forbidden: `The row exists in this tenant but this member may not act on it. Ask an administrator for the permission the message names.`,
  "not-found": `No such record for this token. It may have been deleted, or it may belong to another tenant — a foreign id answers "not found" rather than admitting it exists.`,
  conflict: `The record changed underneath this call. Read it again and retry with the current state.`,
  "payload-too-large": `The request body is over the server's size limit. Send less in one call.`,
  "internal-error": `The server failed to complete the request and gave no reason. Retry once; if it persists, this is a server-side fault and the server's log has the cause.`,
};

/** What a status says when the slug is one this build has never heard of. */
function hintForStatus(status: number): string {
  if (status === 401) return HINT_BY_SLUG["invalid-token"] as string;
  if (status === 403) return HINT_BY_SLUG.forbidden as string;
  if (status === 404) return HINT_BY_SLUG["not-found"] as string;
  if (status === 429) return HINT_BY_SLUG["rate-limited"] as string;
  if (status >= 400 && status < 500) {
    return "The server rejected this request as malformed. The message above is the whole of what it said; correct the arguments and call again.";
  }
  if (status >= 500) return HINT_BY_SLUG["internal-error"] as string;
  return "The server answered with a status this client does not know how to interpret.";
}

/** The actionable sentence for one refusal. */
export function hintForProblem(problem: ApiProblem): string {
  return HINT_BY_SLUG[problemSlug(problem.type)] ?? hintForStatus(problem.status);
}

/** Every slug this build has a sentence for. Exported for the tests. */
export const KNOWN_PROBLEM_SLUGS: readonly string[] = Object.keys(HINT_BY_SLUG);
