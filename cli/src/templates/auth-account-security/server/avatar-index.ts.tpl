/** Profile pictures: `image.ts` judges bytes, `store.ts` persists them and
 *  points `user.image` at them, `route.ts` serves them. */
export { avatarUrl, decodeAvatar, parseAvatarPath, sniffImageType } from "./image.js";
export { findAvatar, removeAvatar, storeAvatar, type AvatarLookup } from "./store.js";
export { avatarHandler, registerAvatarRoutes } from "./route.js";
