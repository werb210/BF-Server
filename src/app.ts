import express from "express";

import { corsMiddleware } from "./middleware/cors";
import routes from "./routes";
import authRouter from "./routes/auth";
import { fail } from "./lib/response";
import { getEnv } from "./config/env";

const allowedProductionHosts: string[] = ["server.boreal.financial"];

export function createApp() {
  const app = express();

  app.get("/health", (_req, res) => {
    res.status(200).send("healthy");
  });

  app.get("/api/_int/health", (_req, res) => {
    res.json({
      status: "ok",
      uptime: process.uptime(),
    });
  });

  app.use((req, res, next) => {
    if (
      req.path === "/" ||
      req.path === "/health" ||
      req.path === "/api/_int/health"
    ) {
      return next();
    }

    const raw = req.headers.host || "";
    const normalized = raw.split(":")[0];
    const { NODE_ENV } = getEnv();

    if (NODE_ENV !== "production") {
      if (normalized === "localhost" || normalized === "127.0.0.1") {
        return next();
      }
    }

    if (!allowedProductionHosts.includes(normalized)) {
      return res.status(403).send("Forbidden");
    }

    next();
  });

  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use(corsMiddleware);

  app.get("/", (_req, res) => {
    res.status(200).send("OK");
  });

  app.use("/api/auth", authRouter);
  app.use("/api/v1", routes);

  app.use((_req, res) => fail(res, "not_found", 404));

  return app;
}

export function resetOtpStateForTests() {
  // No in-process OTP store is used by this app.
}

const app = createApp();

if (require.main === module) {
  const port = Number(process.env.PORT) || 8080;

  app.listen(port, "0.0.0.0", () => {
    console.log(`SERVER STARTED ON ${port}`);
  });
}

export default app;
