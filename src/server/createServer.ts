import { createApp } from "../app";

/**
 * Canonical server factory — NO ARGS
 */
export function createServer() {
  return createApp();
}

export default createServer;
