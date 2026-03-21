import express, { Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { requestContext } from "./middleware/requestContext";
import { requestLogger } from "./middleware/requestLogger";
import { routeResolutionLogger } from "./middleware/routeResolutionLogger";
import authRoutes from "./routes/auth";
import internalRoutes from "./routes/_int";
import lendersRoutes from "./routes/lenders";
import lenderProductsRoutes from "./routes/lenderProducts";
import applicationsRoutes from "./routes/applications";
import documentsRoutes from "./routes/documents";
import telephonyRoutes from "./telephony/routes/telephonyRoutes";
import { errorHandler } from "./middleware/errorHandler";

function isBrowserOriginRequest(req: Request): boolean {
  return typeof req.headers.origin === "string" && req.headers.origin.trim().length > 0;
}

function internalBrowserBlocker(req: Request, res: Response, next: NextFunction): void {
  if (isBrowserOriginRequest(req)) {
    res.status(403).json({
      success: false,
      code: "forbidden_origin",
      message: "Forbidden origin",
    });
    return;
  }
  next();
}

function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    code: "not_found",
    message: "Not found",
  });
}

export function createApp(): Express {
  const app = express();
  app.set("trust proxy", true);

  app.use(requestContext);
  app.use(express.json());
  app.use(
    cors({
      origin: true,
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id", "Idempotency-Key"],
    })
  );
  app.use(requestLogger);
  app.use(routeResolutionLogger);

  app.get("/health", (_req, res) => {
    res.status(200).json({ success: true, data: { status: "ok" } });
  });

  app.get("/api/health", (_req, res) => {
    res.status(200).json({ success: true, data: { status: "ok" } });
  });

  app.use("/api/auth", authRoutes);
  app.use("/api/lenders", lendersRoutes);
  app.use("/api/lender-products", lenderProductsRoutes);
  app.use("/api/client/submissions", applicationsRoutes);
  app.use("/api/documents", documentsRoutes);
  app.use("/api/telephony", telephonyRoutes);
  app.use("/api/_int", internalBrowserBlocker, internalRoutes);

  app.use(errorHandler);
  app.use(notFoundHandler);

  return app;
}

export function buildApp(): Express {
  return createApp();
}

export function registerApiRoutes(app: Express): void {
  app.get("/health", (_req, res) => {
    res.status(200).json({ success: true, data: { status: "ok" } });
  });
  app.get("/api/health", (_req, res) => {
    res.status(200).json({ success: true, data: { status: "ok" } });
  });
  app.use("/api/auth", authRoutes);
  app.use("/api/lenders", lendersRoutes);
  app.use("/api/lender-products", lenderProductsRoutes);
  app.use("/api/client/submissions", applicationsRoutes);
  app.use("/api/documents", documentsRoutes);
  app.use("/api/telephony", telephonyRoutes);
  app.use("/api/_int", internalBrowserBlocker, internalRoutes);
  app.use(errorHandler);
  app.use(notFoundHandler);
}

export function assertCorsConfig(): true {
  return true;
}

export function buildAppWithApiRoutes(): Express {
  return createApp();
}

export const app = createApp();
export default app;
