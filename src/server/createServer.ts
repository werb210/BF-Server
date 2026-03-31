import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";

import authRoutes from "../routes/auth.routes";
import applicationRoutes from "../routes/applications.routes";
import documentRoutes from "../routes/documents";
import userRoutes from "../routes/users";
import { requireAuth } from "../middleware/auth";

export function createServer() {
  if (!process.env.JWT_SECRET) {
    console.error("MISSING ENV: JWT_SECRET");
    process.exit(1);
  }

  const app = express();

  app.set("trust proxy", 1);

  app.use((req, _res, next) => {
    console.log("[REQ]", req.method, req.url);
    next();
  });

  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true }));

  app.use(
    cors({
      origin: [
        "https://boreal-financial-portal.azurewebsites.net",
        "https://boreal-client.azurewebsites.net",
      ],
      methods: ["GET", "POST", "PUT", "DELETE"],
      allowedHeaders: ["Content-Type", "Authorization"],
    }),
  );

  const otpLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
  });

  app.get("/api/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.use("/api/auth/otp", otpLimiter);
  app.use("/api/auth", authRoutes);

  app.use("/api/applications", requireAuth);
  app.use("/api/documents", requireAuth);
  app.use("/api/users", requireAuth);

  app.use("/api/applications", applicationRoutes);
  app.use("/api/documents", documentRoutes);
  app.use("/api/users", userRoutes);

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[SERVER ERROR]", err);
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

export default createServer;
