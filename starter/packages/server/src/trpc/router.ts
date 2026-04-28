import { router } from "./trpc.js";
import { healthRouter } from "./routers/health.js";
import { profileRouter } from "./routers/profile.js";
import { itemsRouter } from "./routers/items.js";
import { mlRouter } from "./routers/ml.js";

export const appRouter = router({
  health: healthRouter,
  profile: profileRouter,
  items: itemsRouter,
  ml: mlRouter,
});

export type AppRouter = typeof appRouter;
