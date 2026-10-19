// Worker entry. The runtime accepts only handlers as exports from this
// module, so the logic and its testable helpers live in newsletter.ts.
import { handleRequest, handleScheduled } from "./newsletter";

export default { fetch: handleRequest, scheduled: handleScheduled };
