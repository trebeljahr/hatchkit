// Errors, as RFC 9457 `application/problem+json`.
//
// The REST surface answers its OWN errors rather than calling `next(err)`.
// That is not tidiness: the global `errorHandler` in
// `src/middleware/error-handler.ts` returns `err.message` verbatim outside
// production, so a mongoose or driver message becomes part of an API response
// the moment somebody runs the server with NODE_ENV unset. Here a 5xx `detail`
// is the same fixed string in every environment and the real error goes to the
// log.
import { TRPCError } from "@trpc/server";
import type { Response } from "express";
import { ZodError } from "zod";

/**
 * Problem `type` URIs are documentation URLs, not endpoints — a client that
 * dereferences one should get prose about the failure, which is what the spec
 * intends. Keeping the base here means a call site only has to know the slug.
 * Point it at wherever this project publishes its API docs.
 */
export const PROBLEM_BASE = "https://example.invalid/problems/";

export type Problem = {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
};

/**
 * What a 5xx tells the caller. Always this, in every environment, never the
 * thrown message.
 *
 * A generic string is the point: an unexpected error is by definition one
 * nobody has vetted the wording of, and a database driver's message routinely
 * carries collection names, query shapes and occasionally values.
 */
export const INTERNAL_DETAIL = "The server could not complete this request.";

/** Human title per status, so two call sites cannot word one error twice. */
const TITLES: Readonly<Record<number, string>> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  413: "Payload Too Large",
  429: "Too Many Requests",
  500: "Internal Server Error",
};

/**
 * tRPC error codes to HTTP.
 *
 * Only the codes the extracted services actually throw are listed. Anything
 * else falls through to 500 deliberately: a code nobody mapped is a code
 * nobody decided the disclosure rules for, and guessing 400 would leak the
 * distinction between "you asked wrong" and "we broke".
 */
const STATUS_BY_TRPC_CODE: Readonly<Record<string, number>> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  TOO_MANY_REQUESTS: 429,
};

/** Default slug for a status, used when the caller has no better name. */
const SLUG_BY_STATUS: Readonly<Record<number, string>> = {
  400: "invalid-request",
  401: "invalid-token",
  403: "forbidden",
  404: "not-found",
  409: "conflict",
  413: "payload-too-large",
  429: "rate-limited",
  500: "internal-error",
};

/**
 * A refusal this layer raises itself, carrying its own problem `type` slug.
 *
 * The services throw `TRPCError`s, whose codes name only a STATUS — every
 * FORBIDDEN would otherwise become `problems/forbidden`, and a client could
 * not tell "wrong scope" from "not your row" without parsing prose. This class
 * is how a route names its own slug without a second error taxonomy:
 * `problemFrom` checks for it first and maps everything else exactly as
 * before.
 */
export class ApiProblemError extends Error {
  readonly slug: string;
  readonly status: number;

  constructor(slug: string, status: number, detail: string) {
    super(detail);
    this.name = "ApiProblemError";
    this.slug = slug;
    this.status = status;
  }
}

export function problem(args: {
  slug: string;
  status: number;
  detail: string;
  instance: string;
}): Problem {
  return {
    type: `${PROBLEM_BASE}${args.slug}`,
    title: TITLES[args.status] ?? "Error",
    status: args.status,
    detail: args.detail,
    instance: args.instance,
  };
}

/** Write a problem. Sets the media type RFC 9457 requires, not `application/json`. */
export function sendProblem(res: Response, value: Problem): void {
  res.status(value.status).type("application/problem+json").send(JSON.stringify(value));
}

/** One-liner for the common "known refusal" case. */
export function sendProblemFor(
  res: Response,
  args: { slug: string; status: number; detail: string; instance: string },
): void {
  sendProblem(res, problem(args));
}

/** Compact, one line per rejected field: `title: Too small`. */
export function formatZodError(err: ZodError): string {
  const lines = err.issues.map((issue) => {
    const path = issue.path.map((part) => String(part)).join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  return lines.length > 0 ? lines.join("; ") : "Invalid request.";
}

/**
 * Map anything a service threw onto a problem.
 *
 * Zod first, because a validation failure is the one error whose message is
 * safe to hand back in full — it describes the caller's own input and nothing
 * about the server. Everything unrecognised becomes a 500 with the fixed
 * detail, whatever it claims about itself.
 */
export function problemFrom(err: unknown, instance: string): Problem {
  if (err instanceof ApiProblemError) {
    return problem({
      slug: err.slug,
      status: err.status,
      detail: err.status >= 500 ? INTERNAL_DETAIL : err.message,
      instance,
    });
  }

  if (err instanceof ZodError) {
    return problem({
      slug: "invalid-request",
      status: 400,
      detail: formatZodError(err),
      instance,
    });
  }

  if (err instanceof TRPCError) {
    const status = STATUS_BY_TRPC_CODE[err.code] ?? 500;
    return problem({
      slug: SLUG_BY_STATUS[status] ?? "internal-error",
      status,
      // A 5xx never carries the thrown message, in any environment.
      detail: status >= 500 ? INTERNAL_DETAIL : err.message,
      instance,
    });
  }

  return problem({
    slug: "internal-error",
    status: 500,
    detail: INTERNAL_DETAIL,
    instance,
  });
}
