import { z } from "zod";
import { API_PERMISSIONS, API_TOKEN_SCOPES } from "../../auth/api-permissions.js";
import {
  listApiTokens,
  mintApiToken,
  revokeApiToken,
} from "../../services/api-tokens/index.js";
import { protectedProcedure, router } from "../trpc.js";

/**
 * Minting API tokens is a SESSION operation, never a token one.
 *
 * There is deliberately no `/api/v1` route that mints a credential. A token
 * that can mint tokens is a token that can escape its own ceiling: mint a
 * child, mint another from that, and the frozen-ceiling rule holds at every
 * step while the chain as a whole outlives the revocation of its root. So the
 * only way to create one is to be signed in as the person it will act as.
 */
export const apiTokensRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    // The tenant is the user's own id — the single-tenant default the
    // starter's `Item.ownerId` already implies. An app with shared tenants
    // changes `scopeForSession` in `services/tenancy.ts` and this line.
    return listApiTokens(ctx.user.id, ctx.user.id);
  }),

  create: protectedProcedure
    .input(
      z.object({
        label: z.string().min(1).max(120),
        scopes: z.array(z.enum(API_TOKEN_SCOPES)).min(1),
        /**
         * The requested ceiling. Omitted means "everything I hold right now",
         * which is the honest default: it can never exceed the member, and it
         * is still frozen at this moment rather than tracking later grants.
         */
        permissions: z.array(z.enum(API_PERMISSIONS)).optional(),
        expiresAt: z.iso.datetime().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // The plaintext is in this response and in no other, ever. It is not
      // stored, so there is nothing to show a second time.
      return mintApiToken({
        tenantId: ctx.user.id,
        userId: ctx.user.id,
        label: input.label,
        scopes: input.scopes,
        permissions: input.permissions,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      });
    }),

  revoke: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return revokeApiToken(ctx.user.id, ctx.user.id, input.id);
    }),
});
