import { createApp, resetOtpStateForTests } from "../app";
import { globalState } from "../system/deps";

/**
 * Canonical server factory — NO ARGS
 */
export function createServer() {
  resetOtpStateForTests();
  globalState.metrics.requests = 0;
  globalState.metrics.errors = 0;
  globalState.rateLimit.window = 0;
  globalState.rateLimit.count = 0;
  return createApp({ includeResponseRid: false });
}

export default createServer;
