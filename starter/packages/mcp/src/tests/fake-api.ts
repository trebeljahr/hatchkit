/*
 * A fake `/api/v1` for the fast test tier.
 *
 * It answers the shapes the real surface answers — the `{ data }` envelope,
 * the `{ data, nextCursor }` page, and RFC 9457 problem documents with the
 * real media type — because the client's three failure classes are decided
 * from the status and the content type, and a fake that always answered
 * `application/json` would let the "this is not the API" branch rot.
 */

export type FakeCall = {
  method: string;
  /** Path and query, relative to the base URL the client was built with. */
  target: string;
  headers: Record<string, string>;
  body: unknown;
};

export type FakeAnswer = {
  status?: number;
  /** Serialised as JSON unless `raw` is given. */
  json?: unknown;
  /** Verbatim body, for answering with something that is not this API. */
  raw?: string;
  contentType?: string;
};

export type FakeApi = {
  fetchImpl: typeof fetch;
  calls: FakeCall[];
};

/** `<METHOD> <path>` for the router below — the query string is not part of the key. */
export function routeKey(method: string, pathname: string): string {
  return `${method.toUpperCase()} ${pathname}`;
}

export function createFakeApi(
  baseUrl: string,
  answers: Record<string, FakeAnswer | ((call: FakeCall) => FakeAnswer)>,
): FakeApi {
  const calls: FakeCall[] = [];
  const base = new URL(baseUrl);

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    const call: FakeCall = {
      method: (init?.method ?? "GET").toUpperCase(),
      target: `${url.pathname}${url.search}`.slice(base.pathname.length),
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);

    const key = routeKey(call.method, url.pathname.slice(base.pathname.length));
    const entry = answers[key];
    if (entry === undefined) {
      return new Response(
        JSON.stringify({
          type: "https://example.invalid/problems/not-found",
          title: "Not Found",
          status: 404,
          detail: `The fake API has no answer for ${key}.`,
          instance: url.pathname,
        }),
        { status: 404, headers: { "content-type": "application/problem+json" } },
      );
    }
    const answer = typeof entry === "function" ? entry(call) : entry;
    const status = answer.status ?? 200;
    const contentType =
      answer.contentType ??
      (status >= 400 ? "application/problem+json" : "application/json; charset=utf-8");
    const body = answer.raw ?? JSON.stringify(answer.json ?? null);
    return new Response(body, { status, headers: { "content-type": contentType } });
  }) as typeof fetch;

  return { fetchImpl, calls };
}

/** A problem document with this API's shape. */
export function problemBody(slug: string, status: number, detail: string): unknown {
  return {
    type: `https://example.invalid/problems/${slug}`,
    title: "Refused",
    status,
    detail,
    instance: "/api/v1/test",
  };
}
