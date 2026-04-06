import express from "express";
import helmet from "helmet";
import compression from "compression";
import routes from "./routes";
import rateLimit from "./middleware/rateLimit";
import { errorHandler } from "./middleware/error";
import { registerApiRouteMounts } from "./routes/routeRegistry";
import { resetOtpStateForTests as resetAuthState } from "./routes/auth.routes";

export function createApp() {
  const app = express();

  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(helmet());
  app.use(compression());
  app.use(express.json());
  app.use(rateLimit);

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.use("/api", routes);

  // Keep legacy route mount support during migration.
  registerApiRouteMounts(app);

  app.use(errorHandler);

  return app;
}

export function resetOtpStateForTests() {
  resetAuthState();
}
