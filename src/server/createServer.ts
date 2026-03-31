import { buildAppWithApiRoutes } from "../app";

export function createServer() {
  return buildAppWithApiRoutes();
}

export default createServer;
