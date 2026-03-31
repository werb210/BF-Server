import express from "express";
import cors from "cors";

import publicRouter from "./routes/public";
import apiRouter from "./routes/api";
import { authMiddleware } from "./middleware/auth";

export function createApp() {
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

  app.use(express.json({ limit: "1mb" }));

  app.use((req, res, next) => {
    const methodNeedsJson = ["POST", "PUT", "PATCH"].includes(req.method.toUpperCase());
    const hasContentTypeHeader = typeof req.headers["content-type"] === "string";

    if (
      methodNeedsJson &&
      req.method.toUpperCase() !== "OPTIONS" &&
      hasContentTypeHeader &&
      !req.is("application/json")
    ) {
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
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "NOT_FOUND" });
  });

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

export const buildAppWithApiRoutes = createApp;

export default createApp;
