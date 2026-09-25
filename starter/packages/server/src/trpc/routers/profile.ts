import { router, protectedProcedure } from "../trpc.js";
import { updateProfileSchema } from "@starter/shared";
import { Profile } from "../../models/Profile.js";
// ── client-core ──────────────────────────────────────────────────
import { publishSync } from "../../sync/feed.js";
// ── end client-core ──────────────────────────────────────────────

export const profileRouter = router({
  get: protectedProcedure.query(async ({ ctx }) => {
    let profile = await Profile.findOne({ userId: ctx.user.id });
    if (!profile) {
      profile = await Profile.create({
        userId: ctx.user.id,
        preferences: { theme: "system", notifications: true },
      });
    }
    return {
      userId: profile.userId,
      avatarUrl: profile.avatarUrl,
      bio: profile.bio,
      preferences: profile.preferences,
    };
  }),

  update: protectedProcedure
    .input(updateProfileSchema)
    .mutation(async ({ ctx, input }) => {
      const update: Record<string, unknown> = {};
      if (input.bio !== undefined) update.bio = input.bio;
      if (input.avatarUrl !== undefined) update.avatarUrl = input.avatarUrl;
      if (input.preferences) {
        if (input.preferences.theme !== undefined) {
          update["preferences.theme"] = input.preferences.theme;
        }
        if (input.preferences.notifications !== undefined) {
          update["preferences.notifications"] = input.preferences.notifications;
        }
      }

      const profile = await Profile.findOneAndUpdate(
        { userId: ctx.user.id },
        { $set: update },
        { new: true, upsert: true },
      );

      // ── client-core ──────────────────────────────────────────────
      // `profile.changed` carries no id: there is one profile per account, so
      // the kind alone says everything a listener needs. Published with the
      // user id the mutation RAN AS, never a value off the input — the feed's
      // room is the authenticated user and nothing else (sync/feed.ts).
      publishSync(ctx.user.id, { kind: "profile.changed" });
      // ── end client-core ──────────────────────────────────────────

      return {
        userId: profile.userId,
        avatarUrl: profile.avatarUrl,
        bio: profile.bio,
        preferences: profile.preferences,
      };
    }),
});
