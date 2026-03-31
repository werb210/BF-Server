import dotenv from "dotenv";
import express from "express";
import cors from "cors";

import publicRouter from "./routes/public";
import apiRouter from "./routes/api";
import { authMiddleware } from "./middleware/auth";

dotenv.config();

export function buildAppWithApiRoutes() {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET_MISSING");
  }

  const app = express();

  app.set("trust proxy", 1);

  app.use((req, res, next) => {
    console.log("[REQ]", req.method, req.path);
    console.log("[AUTH]", Boolean(req.headers.authorization));
    res.on("finish", () => {
      console.log("[STATUS]", res.statusCode);
    });
    next();
  });

  app.use((req, res, next) => {
    if (!req.path.startsWith("/")) {
      return res.status(400).json({ error: "INVALID_PATH" });
    }

    return next();
  });

  app.use(express.json({ limit: "1mb" }));

  app.use((req, res, next) => {
    const methodNeedsJson = ["POST", "PUT", "PATCH"].includes(req.method.toUpperCase());

    if (methodNeedsJson && !req.is("application/json")) {
      return res.status(400).json({ error: "INVALID_CONTENT_TYPE" });
    }

    return next();
  });

  app.use(cors({
    origin: true,
    credentials: false,
  }));

  app.use("/api/public", publicRouter);
  app.use("/api", authMiddleware, apiRouter);

  app.use((req, res) => {
    res.status(404).json({ error: "NOT_FOUND" });
  });

  app.use((err: any, _req: any, res: any, _next: any) => {
    console.error("[SERVER ERROR]", err);

    if (res.headersSent) {
      return;
    }

    res.status(500).json({
      error: "INTERNAL_ERROR",
    });
  });

  return app;
}

export const app = buildAppWithApiRoutes();

export default app;
