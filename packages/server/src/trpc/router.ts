import { router } from "./trpc.js";
import { healthRouter } from "./routers/health.js";
import { profileRouter } from "./routers/profile.js";
import { itemsRouter } from "./routers/items.js";

export const appRouter = router({
  health: healthRouter,
  profile: profileRouter,
  items: itemsRouter,
});

export type AppRouter = typeof appRouter;
