import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";

import authRoutes from "./routes/auth.routes";
import publicRoutes from "./routes/public";
import applicationRoutes from "./routes/applications.routes";
import documentRoutes from "./routes/documents";
import userRoutes from "./routes/users";
import { requireAuth } from "./middleware/auth";

dotenv.config();

export function buildAppWithApiRoutes() {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET NOT SET");
  }

  const app = express();

  app.set("trust proxy", 1);

  app.use((req, _res, next) => {
    console.log("[REQ]", req.method, req.url);
    console.log("[AUTH HEADER]", req.headers.authorization || "NONE");
    next();
  });

  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true }));

  app.use(
    cors({
      origin: [
        "https://boreal-client.azurewebsites.net",
        "https://boreal-financial-portal.azurewebsites.net",
        "https://boreal.financial",
      ],
      allowedHeaders: ["Content-Type", "Authorization"],
      methods: ["GET", "POST", "PUT", "DELETE"],
    }),
  );

  const otpLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
  });

  app.get("/api/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.use("/api/public", publicRoutes);
  app.use("/api/auth/otp", otpLimiter);
  app.use("/api/auth", authRoutes);

  app.use("/api/applications", requireAuth, applicationRoutes);
  app.use("/api/documents", requireAuth, documentRoutes);
  app.use("/api/users", requireAuth, userRoutes);

  app.use((err: any, _req: any, res: any, _next: any) => {
    console.error("[SERVER ERROR]", err?.stack || err?.message || err);
    if (res.headersSent) {
      return;
    }

    res.status(500).json({ error: "internal_error" });
  });

  app.use((req, res) => {
    res.status(404).json({ error: "not_found", path: req.originalUrl });
  });

  return app;
}

export const app = buildAppWithApiRoutes();

export default app;
