import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";

import authRoutes from "./routes/auth.js";
import callRoutes from "./routes/call.js";
import healthRoutes from "./routes/health.js";
import applicationsRouter from "./routes/applications.js";
import documentsRouter from "./routes/documents.js";
import pipelineRouter from "./routes/pipeline.js";
import usersRouter from "./routes/users.js";
import crmRouter from "./routes/crm.js";
import { requireAuth } from "./middleware/auth.js";

export function createApp() {
  const app = express();
  const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  /**
   * CORE MIDDLEWARE
   */
  app.use(cors({
    origin: (origin, callback) => {
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  }));

  app.use(express.json({ limit: "10mb" }));
  app.use(cookieParser());

  /**
   * HEALTH (MUST NOT BE CAUGHT BY FRONTEND)
   */
  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/api/_int/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  /**
   * API ROUTES (LOCKED PREFIX)
   */
  app.use("/api/auth", authRoutes);
  app.use("/api/call", callRoutes);
  app.use("/api/health", healthRoutes);

  app.use("/api/applications", requireAuth, applicationsRouter);
  app.use("/api/client/applications", applicationsRouter);
  app.use("/api/documents", requireAuth, documentsRouter);
  app.use("/api/pipeline", requireAuth, pipelineRouter);
  app.use("/api/users", requireAuth, usersRouter);
  app.use("/api/crm", requireAuth, crmRouter);

  /**
   * 404 HANDLER
   */
  app.use((req, res) => {
    res.status(404).json({ error: "Route not found", path: req.originalUrl });
  });

  /**
   * GLOBAL ERROR HANDLER
   */
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("SERVER ERROR:", err);
    res.status(500).json({
      status: "error",
      message: err?.message ?? "Internal Server Error",
    });
  });

  return app;
}

const app = createApp();

export default app;

export function resetOtpStateForTests() {
  // no-op: current auth flow is route-local in-memory state
}
