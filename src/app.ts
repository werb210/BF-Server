import express from "express";
import cors from "cors";

import publicRouter from "./routes/public";
import apiRouter from "./routes/api";
import { createAuthMiddleware } from "./middleware/auth";

export function createApp() {
  const app = express();

  app.use(express.json({ limit: "1mb" }));

  app.use((req, res, next) => {
    if (
      ["POST", "PUT", "PATCH"].includes(req.method) &&
      req.headers["content-type"] &&
      !req.is("application/json")
    ) {
      return res.status(400).json({ error: "INVALID_CONTENT_TYPE" });
    }

    return next();
  });

  app.use(
    cors({
      origin: true,
      credentials: false,
    }),
  );

  app.use("/api/public", publicRouter);
  app.use("/api", createAuthMiddleware(process.env.JWT_SECRET!), apiRouter);

  app.use("/api", (_req, res) => {
    return res.status(404).json({ error: "NOT_FOUND" });
  });

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    return res.status(500).json({ error: "INTERNAL_ERROR" });
  });

  return app;
}

export const app = createApp();
export const buildAppWithApiRoutes = createApp;

export default createApp;
