import { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { isProductionEnvironment } from "../server/config/env.compat";
import { logger } from "../server/utils/logger";

function isLoopback(req: Request): boolean {
  const ip = req.ip || "";
  return ip === "127.0.0.1" || ip === "::1" || ip.startsWith("::ffff:127.0.0.1");
}

function isCodespacesRuntime(): boolean {
  return (
    process.env.CODESPACES === "true" ||
    Boolean(process.env.CODESPACE_NAME) ||
    Boolean(process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN)
  );
}

function isPublicHealthPath(req: Request): boolean {
  const path = req.path;
  return (
    path === "/health" ||
    path === "/ready" ||
    path === "/api/health" ||
    path === "/api/ready" ||
    path.startsWith("/api/_int") ||
    path.startsWith("/_int")
  );
}

function isAzureHttps(req: Request): boolean {
  // Azure sets one or more of these when TLS is terminated upstream
  return (
    req.secure === true ||
    req.get("x-forwarded-proto") === "https" ||
    typeof req.get("x-arr-ssl") === "string"
  );
}

export function requireHttps(req: Request, res: Response, next: NextFunction): void {
  if (!isProductionEnvironment()) return next();

  // Always allow internal routes (health/ready) and loopback
  if (isPublicHealthPath(req) || isLoopback(req) || isCodespacesRuntime()) return next();

  if (!isAzureHttps(req)) {
    res.status(400).json({
      code: "https_required",
      message: "HTTPS is required.",
      requestId: res.locals.requestId ?? "unknown",
    });
    return;
  }
  next();
}

export const securityHeaders = helmet({
  contentSecurityPolicy: false,
});

export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  validate: {
    trustProxy: false,
  },
});

export function productionLogger(req: Request, _res: Response, next: NextFunction): void {
  if (process.env.NODE_ENV === "production") {
    logger.info("production_request", { method: req.method, url: req.originalUrl });
  }
  next();
}
