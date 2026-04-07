import express from "express";

import authRouter from "./routes/auth";
import routes from "./routes";
import { fail } from "./lib/response";
import { getEnv } from "./config/env";
import { registerApiRouteMounts } from "./routes/routeRegistry";

const allowedProductionHosts: string[] = ["server.boreal.financial"];

export function createApp() {
  const app = express();

  app.options("*", (req, res) => {
    const origin = req.headers.origin;

    if (!origin) {
      return res.status(410).json({
        status: "error",
        error: "LEGACY_ROUTE_DEPRECATED",
      });
    }

    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    return res.sendStatus(204);
  });

  app.use((req, res, next) => {
    const origin = req.headers.origin;

    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }

    next();
  });

  app.get("/health", (_req, res) => {
    res.status(200).json({
      status: "ok",
    });
  });

  app.get("/ready", (_req, res) => {
    res.status(200).json({
      status: "ready",
    });
  });

  app.get("/api/health", async (_req, res) => {
    let dbStatus = "ok";

    try {
      const { initDb } = require("./db/init");
      await initDb();
    } catch (_err) {
      dbStatus = "fail";
    }

    const statusCode = dbStatus === "ok" ? 200 : 503;

    return res.status(statusCode).json({
      status: dbStatus === "ok" ? "ok" : "error",
      data: {
        db: dbStatus,
      },
    });
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
      req.path === "/ready" ||
      req.path === "/api/health" ||
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

  app.get("/", (_req, res) => {
    res.status(200).send("OK");
  });

  app.use("/api/auth", authRouter);
  app.use("/api/v1", routes);
  registerApiRouteMounts(app);

  app.use((_req, res) => fail(res, "not_found", 404));

  app.use((err: any, _req: any, res: any, next: any) => {
    if (res.headersSent) {
      return next(err);
    }

    console.error("GLOBAL ERROR:", err);

    return res.status(500).json({
      status: "error",
      error: err?.message || "INTERNAL_SERVER_ERROR",
    });
  });

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
