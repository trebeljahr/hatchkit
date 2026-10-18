/** An error's message plus the reason a network call failed.
 *
 *  undici's fetch throws `TypeError: fetch failed` and keeps the reason
 *  (`ECONNRESET`, `ENOTFOUND`, `UND_ERR_CONNECT_TIMEOUT`, …) on
 *  `err.cause`. Without it a transient network error reads exactly like
 *  a provider that is down. Walks the cause chain, so a wrapper that kept
 *  the original error as its `cause` still reports the code. */
export function errorDetail(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const reason = causeReason(err);
  return reason && !message.includes(reason) ? `${message} (${reason})` : message;
}

function causeReason(err: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current = (err as { cause?: unknown } | null | undefined)?.cause;
  let message: string | undefined;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const c = current as { code?: unknown; message?: unknown; errors?: unknown; cause?: unknown };
    if (typeof c.code === "string" && c.code) return c.code;
    // A host with several addresses fails with an AggregateError whose
    // own code is empty and whose members carry it.
    if (Array.isArray(c.errors)) {
      const code = c.errors
        .map((e) => (e as { code?: unknown } | null)?.code)
        .find((v): v is string => typeof v === "string" && v.length > 0);
      if (code) return code;
    }
    if (typeof c.message === "string" && c.message) message ??= c.message;
    current = c.cause;
  }
  return message;
}

const TRANSPORT_ERROR =
  /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|UND_ERR_\w+|AbortError|TimeoutError)\b|fetch failed|operation was aborted|timed out/i;

/** True when an `errorDetail` string says the request never got an
 *  answer: DNS, connect, reset, or a timeout. That says nothing about
 *  the credential, so a hint must not send the user off to replace a
 *  token that works. A Node `AbortSignal.timeout` reads "The operation
 *  was aborted due to timeout". */
export function isTransportError(detail: string): boolean {
  return TRANSPORT_ERROR.test(detail);
}
