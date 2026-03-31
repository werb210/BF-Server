import cors from "cors";
import express from "express";

import { createAuthMiddleware } from "./middleware/auth";
import apiRoutes from "./routes/api";
import authRoutes from "./routes/auth.routes";
import publicRoutes from "./routes/public";

export function createApp() {
  const app = express();

  // HEALTH (must be first, no auth)
  app.get("/health", (_req, res) => {
    return res.status(200).json({ status: "ok" });
  });

  app.use(express.json({ limit: "1mb" }));

  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err instanceof SyntaxError) {
      return res.status(400).json({ error: "INVALID_JSON" });
    }

    return next(err);
  });

  app.use(
    cors({
      origin: true,
      credentials: false,
    }),
  );

  // PUBLIC ROUTES FIRST
  app.use("/api/public", publicRoutes);

  // AUTH ROUTES (NO TOKEN REQUIRED)
  app.use("/api/auth", authRoutes);

  // AUTH GUARD
  app.use("/api", createAuthMiddleware(), apiRoutes);

  // 404
  app.use((_req, res) => {
    return res.status(404).json({ error: "NOT_FOUND" });
  });

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);

    return res.status(500).json({
      error: "INTERNAL_SERVER_ERROR",
    });
  });

  return app;
}

export const buildAppWithApiRoutes = createApp;

export const app = createApp();

export default createApp;
