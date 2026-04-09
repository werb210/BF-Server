import { logError } from "./logger.js";
import { trackException } from "./appInsights.js";
import { isDbConnectionFailure } from "../dbRuntime.js";

let handlersInstalled = false;

export function installProcessHandlers(): void {
  if (handlersInstalled) {
    return;
  }
  handlersInstalled = true;

  process.on("unhandledRejection", (reason) => {
    const error =
      reason instanceof Error ? reason : new Error(String(reason));
    logError("unhandled_rejection", { error: error.message });
    const classification = isDbConnectionFailure(error)
      ? "db_unavailable"
      : "unknown";
    trackException({
      exception: error,
      properties: {
        event: "unhandled_rejection",
        classification,
      },
    });
  });
}
