import { createServer, type Server } from "http";
import { buildAppWithApiRoutes } from "./app";

export async function startServer(): Promise<Server> {
  const app = buildAppWithApiRoutes();
  const port = Number(process.env.PORT || 4000);

  return await new Promise<Server>((resolve) => {
    const server = createServer(app);
    server.listen(port, "0.0.0.0", () => resolve(server));
  });
}

if (process.env.NODE_ENV !== "test") {
  void startServer();
}

export default buildAppWithApiRoutes();
