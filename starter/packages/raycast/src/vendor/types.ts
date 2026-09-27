// GENERATED — DO NOT EDIT.
//
// A byte-for-byte copy of a file in the shared client core, with its import
// specifiers rewritten for this flat directory. Written by
// `scripts/vendor-core.mjs`; `npm test` fails when it is stale.
//
// Edit the source package and re-run the generator. An edit made here is
// silently overwritten on the next run, and until then this surface behaves
// differently from every other client.

/** Metadata about a room member. */
export type RoomMember = {
  userId: string;
  displayName: string;
  joinedAt: string;
};

/** Possible statuses for an Item. */
export type ItemStatus = "draft" | "published" | "archived";

/** User theme preference. */
export type ThemePreference = "light" | "dark" | "system";

/** Shape of a user profile (extends better-auth's User). */
export type UserProfile = {
  userId: string;
  avatarUrl?: string;
  bio?: string;
  preferences: {
    theme: ThemePreference;
    notifications: boolean;
  };
};

/** Shape of an Item (example CRUD entity). */
export type Item = {
  id: string;
  title: string;
  description?: string;
  status: ItemStatus;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
};
