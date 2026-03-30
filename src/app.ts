import { createServer } from "./server/createServer";

export function buildAppWithApiRoutes() {
  return createServer();
}

export const app = buildAppWithApiRoutes();
