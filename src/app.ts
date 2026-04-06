import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { corsMiddleware } from "./middleware/cors";
import { registerApiRouteMounts } from "./routes/routeRegistry";
import authRouter from "./routes/auth/otp";
import { notFound } from "./middleware/notFound";

export function createApp() {
  const app = express();
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
  });

  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.get("/api/_int/health", (_req, res) => res.json({ ok: true }));

  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use(helmet());
  app.use(express.json());
  app.use(corsMiddleware);

  app.use("/api/auth", limiter);
  app.use("/api/auth", authRouter);

  registerApiRouteMounts(app);

  app.use(notFound);

  return app;
}
