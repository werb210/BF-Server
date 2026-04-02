import { buildAppWithApiRoutes } from "../app";
import type { Deps } from "../system/deps";

export function createServer(deps: Deps) {
  return buildAppWithApiRoutes(deps);
}

export default createServer;
