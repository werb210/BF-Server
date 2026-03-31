import cors from "cors";
import express from "express";

import { createAuthMiddleware } from "./middleware/auth";
import apiRoutes from "./routes/api";
import authRoutes from "./routes/auth.routes";
import publicRoutes from "./routes/public";

export function createApp() {
  const app = express();

  app.use(express.json({ limit: "1mb" }));

  // HEALTH (must be first, no auth)
  app.get("/health", (_req, res) => {
    return res.status(200).json({ status: "ok" });
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

  return app;
}

export const buildAppWithApiRoutes = createApp;

export const app = createApp();

export default createApp;
