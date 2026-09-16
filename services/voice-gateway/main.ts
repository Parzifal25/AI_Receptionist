import { logger } from "@halo/platform/logger";
import { main } from "./index";

/** Process entry point: `npm run voice-gateway`. */
void main().catch((error) => {
  logger.child({ service: "voice-gateway" }).error("voice gateway failed to start", { error });
  process.exit(1);
});
