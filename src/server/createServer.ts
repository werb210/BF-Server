import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import authRoutes from "../routes/auth.routes";
import applicationRoutes from "../routes/applications.routes";
import documentRoutes from "../routes/documents";

export function createServer() {
  const app = express();

  app.use(express.json());

  app.use(
    cors({
      origin: [
        "https://portal.boreal.financial",
        "https://client.boreal.financial",
        "http://localhost:3000",
        "http://localhost:5173",
      ],
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      credentials: false,
    }),
  );

  app.use((req, _res, next) => {
    console.log(`[REQ] ${req.method} ${req.url}`);
    next();
  });

  const otpLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
  });

  app.get("/health", (_req, res) => {
    res.status(200).send("ok");
  });

  app.use("/api/auth/otp", otpLimiter);
  app.use("/api/auth", authRoutes);
  app.use("/api/applications", applicationRoutes);
  app.use("/api/documents", documentRoutes);

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[ERROR]", err);
    res.status(500).json({
      error: "internal_error",
    });
  });

  return app;
}

export default createServer;
