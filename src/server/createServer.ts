import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import authRoutes from "../routes/auth.routes";
import applicationRoutes from "../routes/applications.routes";
import documentRoutes from "../routes/documents";

export function createServer() {
  const requiredEnv = ["JWT_SECRET"];
  requiredEnv.forEach((key) => {
    if (!process.env[key]) {
      console.error(`MISSING ENV: ${key}`);
      process.exit(1);
    }
  });

  const app = express();
  const API_PREFIX = "/api";

  app.set("trust proxy", 1);

  // Azure App Service may send x-arr-ssl without x-forwarded-proto.
  // Ensure Express detects HTTPS so secure cookies are not dropped.
  app.use((req, _res, next) => {
    if (req.headers["x-arr-ssl"] && !req.headers["x-forwarded-proto"]) {
      req.headers["x-forwarded-proto"] = "https";
    }
    next();
  });

  app.use((req, _res, next) => {
    console.log(`[REQ] ${req.method} ${req.originalUrl}`);
    next();
  });

  app.use((req, _res, next) => {
    console.log("[AUTH HEADER]", req.headers.authorization || null);
    next();
  });

  app.use((req, _res, next) => {
    if (!req.headers.authorization) {
      console.warn("[NO AUTH HEADER]", req.method, req.originalUrl);
    }
    next();
  });

  // MUST remain first: bypasses middleware stack and guarantees probe completion.
  app.use((req, res, next) => {
    if (req.path === "/health") {
      res.status(200).type("text/plain").send("ok");
      return;
    }
    next();
  });

  // Explicit health route for direct GET semantics.
  app.get("/health", (_req, res) => {
    res.status(200).type("text/plain").send("ok");
  });

  app.get("/__test", (_req, res) => {
    res.status(200).json({
      ok: true,
      message: "server reachable",
      ts: Date.now(),
    });
  });

  app.use((req, res, next) => {
    res.setTimeout(10_000, () => {
      console.error(`[TIMEOUT] ${req.method} ${req.originalUrl}`);
      if (!res.headersSent) {
        res.status(504).json({ error: "timeout" });
      }
    });
    next();
  });

  app.use(express.json({ limit: "10mb", strict: false }));
  app.use(express.urlencoded({ extended: true }));

  const allowedOrigins = [
    "https://boreal-financial-portal.azurewebsites.net",
    "https://boreal-client.azurewebsites.net",
    "http://localhost:5173",
  ];

  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) {
          cb(null, true);
          return;
        }

        if (allowedOrigins.includes(origin)) {
          cb(null, true);
          return;
        }

        cb(new Error("CORS BLOCKED"));
      },
      credentials: true,
    }),
  );

  app.use((_req, res, next) => {
    res.header("Access-Control-Allow-Credentials", "true");
    next();
  });

  const otpLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
  });

  if (!authRoutes) {
    throw new Error("authRoutes failed to load");
  }

  if (!applicationRoutes) {
    throw new Error("applicationRoutes failed to load");
  }

  const apiRouter = express.Router();

  apiRouter.get("/__ping", (_req, res) => {
    res.json({ ok: true });
  });

  apiRouter.use("/auth/otp", otpLimiter);
  apiRouter.use("/auth", authRoutes);
  apiRouter.use("/applications", applicationRoutes);
  apiRouter.use("/documents", documentRoutes);

  app.use(API_PREFIX, apiRouter);
  console.log(`API PREFIX: ${API_PREFIX}`);

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[ERROR]", err);
    if (res.headersSent) {
      return;
    }

    const message = err instanceof Error ? err.message : "unknown";

    const statusCode = err instanceof SyntaxError ? 400 : 500;

    res.status(statusCode).json({
      error: statusCode === 400 ? "invalid_json" : "internal_error",
      message,
    });
  });

  app.use((req, res) => {
    console.warn(`[MISS] ${req.method} ${req.originalUrl}`);
    res.status(404).json({
      error: "not_found",
      path: req.originalUrl,
    });
  });

  return app;
}

export default createServer;
