// The success envelope: `{ data }`, and `{ data, nextCursor }` for a list.
//
// Wrapping rather than returning the payload at the top level is what lets a
// list grow a sibling field — a cursor today, a total tomorrow — without every
// existing client's parser breaking. It also makes a success and a problem
// structurally distinguishable without reading the status code.
import type { Response } from "express";

/**
 * A single resource.
 *
 * 200 for a create as well as for a read, on purpose: the OpenAPI document is
 * generated from the route table and declares one success status per
 * operation, so a handler that answered 201 here would be answering something
 * the published spec does not mention — and a generated client only handles
 * the statuses its spec lists.
 */
export function sendData<T>(res: Response, data: T): void {
  res.status(200).json({ data });
}

/**
 * A page of resources.
 *
 * `nextCursor` is ALWAYS present and `null` on the last page. Omitting it when
 * there is nothing more would make "you have reached the end" and "the
 * serializer dropped a field" the same wire shape, and a paging client cannot
 * tell those apart — it stops early and reports a short total, with no error
 * anywhere.
 */
export function sendList<T>(res: Response, data: T[], nextCursor: string | null): void {
  res.status(200).json({ data, nextCursor });
}
