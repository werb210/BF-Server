import { createApp } from "../app";
import type { Deps } from "../system/deps";

export function createServer(deps: Deps) {
  return createApp(deps);
}

export default createServer;
