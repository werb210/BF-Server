import cors from "cors";
import express from "express";

import { createAuthMiddleware } from "./middleware/auth";
import { publicLimiter } from "./middleware/publicLimiter";
import { globalLimiter } from "./middleware/rateLimit";
import { requestLogger } from "./middleware/requestLogger";
import apiRouter from "./routes/api";
import publicRouter from "./routes/public";

export function createApp() {
  const app = express();

  app.use(requestLogger);
  app.use(globalLimiter);

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

  app.use("/api/public", publicLimiter, publicRouter);
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
