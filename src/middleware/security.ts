import { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { rateLimitKeyFromRequest } from "./clientIp.js";
import { config } from "../config/index.js";
import { logger } from "../server/utils/logger.js";

function isLoopback(req: Request): boolean {
  const ip = req.ip || "";
  return ip === "127.0.0.1" || ip === "::1" || ip.startsWith("::ffff:127.0.0.1");
}

function isCodespacesRuntime(): boolean {
  return (
    config.codespaces.enabled === "true" ||
    Boolean(config.codespaces.name) ||
    Boolean(config.codespaces.portForwardingDomain)
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
  if (!config.isProduction) return next();

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
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://sdk.twilio.com", "https://media.twiliocdn.com"],
      connectSrc: [
        "'self'",
        "https://server.boreal.financial",
        "https://voice-js.twilio.com",
        "wss://voice-js.roaming.twilio.com",
        "https://eventgw.twilio.com",
        "wss://eventgw.twilio.com",
        "https://media.twiliocdn.com",
        "https://sdk.twilio.com",
        "wss://chunderw-vpc-gll.twilio.com",
        "wss://*.twilio.com",
      ],
      imgSrc: ["'self'", "data:", "https:"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'", "data:", "https:"],
      mediaSrc: ["'self'", "https://media.twiliocdn.com"],
      frameSrc: ["'self'"],
    },
  },
});

export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKeyFromRequest,
  validate: {
    xForwardedForHeader: false,
    trustProxy: false,
  },
});

export function productionLogger(req: Request, _res: Response, next: NextFunction): void {
  if (config.env === "production") {
    logger.info("production_request", { method: req.method, url: req.originalUrl });
  }
  next();
}
