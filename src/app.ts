import dotenv from "dotenv";
import { createServer } from "./server/createServer";

dotenv.config();

export function buildAppWithApiRoutes() {
  return createServer();
}

export const app = buildAppWithApiRoutes();

export default app;
