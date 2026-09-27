/**
 * Whether a DEVELOPMENT build points at this machine or at the deployed
 * service.
 *
 * One exported boolean, alone in its own file, because the step that writes the
 * publishable copy rewrites exactly this line and nothing else. A store
 * reviewer runs the
 * extension with `ray develop`, which is a development build: with this left
 * `true` their first run would reach `http://localhost` — a port nothing is
 * serving on their machine — and the extension would look broken on review.
 *
 * A release build (`ray build -e dist`) ignores this and always uses the
 * deployed origins; see `preferences.ts`.
 */
export const USE_LOCAL_DEV_ORIGINS = true;
