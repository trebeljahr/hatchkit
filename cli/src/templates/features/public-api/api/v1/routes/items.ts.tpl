// The item routes.
//
// Every handler here is a thin translation layer: read the request, validate
// with the shared schema, call the extracted service with `req.apiScope`,
// write the envelope. There is NO business rule in this file, and there must
// never be one — the moment a refusal is decided here rather than in
// `services/items/`, the REST surface and the typed one can disagree about it.
//
// Notice what none of these do: read a tenant id. `req.apiScope` was built in
// `../auth.ts` from the token's own row, and the services take the scope
// rather than an owner argument, so there is no parameter a caller could aim
// at somebody else's data.
import { createItemSchema, updateItemSchema } from "__HATCHKIT_SHARED_PKG__";
import {
  createItem,
  deleteItem,
  getItem,
  listItems,
  updateItem,
} from "../../../services/items/index.js";
import type { ApiHandlers } from "../auth.js";
import { sendData, sendList } from "../envelope.js";
import { asObject, coerceQuery, parseWith } from "../query.js";
import { idPathSchema, itemListSchema } from "../routes-table.js";

export const itemHandlers: ApiHandlers = {
  "get /items": async (req, res) => {
    const input = parseWith(itemListSchema, coerceQuery(req.apiQuery, itemListSchema));
    const page = await listItems(req.apiScope, input);
    sendList(res, page.items, page.nextCursor);
  },

  "get /items/:id": async (req, res) => {
    const { id } = parseWith(idPathSchema, req.params);
    sendData(res, await getItem(req.apiScope, id));
  },

  "post /items": async (req, res) => {
    const input = parseWith(createItemSchema, asObject(req.body));
    sendData(res, await createItem(req.apiScope, input));
  },

  "patch /items/:id": async (req, res) => {
    // The PATH id wins over anything in the body. The shared schema carries
    // `id` because tRPC has no path to put it in, and a body that disagreed
    // with the URL would otherwise let `PATCH /items/A` edit item B — which is
    // exactly the confused-deputy shape this whole layer exists to avoid.
    const input = parseWith(updateItemSchema, { ...asObject(req.body), id: req.params.id });
    sendData(res, await updateItem(req.apiScope, input));
  },

  "delete /items/:id": async (req, res) => {
    const { id } = parseWith(idPathSchema, req.params);
    sendData(res, await deleteItem(req.apiScope, id));
  },
};
