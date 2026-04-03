import { createApp, resetOtpStateForTests } from "../app";

/**
 * Canonical server factory — NO ARGS
 */
export function createServer() {
  resetOtpStateForTests();
  return createApp();
}

export default createServer;
