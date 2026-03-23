import { type NextFunction, type Request, type Response } from "express";
import { isDbConnectionFailure } from "../dbRuntime";
import { logError, logWarn } from "../observability/logger";
import { trackException } from "../observability/appInsights";
import { fetchStatus as errorStatusFor, isHttpishError } from "../helpers/errors";

export class AppError extends Error {
  status: number;
  code: string;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function isAppError(value: unknown): value is AppError {
  if (value instanceof AppError) {
    return true;
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const status = (value as { status?: unknown }).status;
  const code = (value as { code?: unknown }).code;
  const message = (value as { message?: unknown }).message;

  return (
    typeof status === "number" &&
    Number.isFinite(status) &&
    typeof code === "string" &&
    code.length > 0 &&
    typeof message === "string" &&
    message.length > 0
  );
}

export function forbiddenError(message = "Access denied."): AppError {
  return new AppError("forbidden", message, 403);
}

const AUTH_FAILURE_CODES = new Set([
  "invalid_credentials",
  "account_disabled",
  "invalid_token",
  "missing_token",
  "missing_fields",
  "invalid_phone",
  "validation_error",
  "otp_failed",
  "twilio_error",
  "twilio_auth_failed",
  "user_not_found",
  "locked",
  "user_disabled",
  "auth_unavailable",
  "service_unavailable",
]);

const CONSTRAINT_VIOLATION_CODES = new Set(["23502", "23503", "23505"]);

function isConstraintViolation(err: Error): boolean {
  const code = (err as { code?: string }).code;
  return typeof code === "string" && CONSTRAINT_VIOLATION_CODES.has(code);
}

function isTimeoutError(err: Error): boolean {
  const code = (err as { code?: string }).code?.toLowerCase() ?? "";
  const message = err.message.toLowerCase();
  return code === "etimedout" || message.includes("timeout");
}

function isAuthRoute(req: Request): boolean {
  const url = req.originalUrl ?? req.url ?? "";
  const path = url.split("?")[0] ?? "";
  return path.startsWith("/api/auth/");
}

function resolveFailureReason(err: Error): string {
  if (isAppError(err)) {
    return AUTH_FAILURE_CODES.has(err.code)
      ? "auth_failure"
      : "request_error";
  }
  if (isConstraintViolation(err)) return "constraint_violation";
  if (isDbConnectionFailure(err)) {
    return isTimeoutError(err) ? "db_timeout" : "db_unavailable";
  }
  return "server_error";
}

function normalizeAuthError(
  err: Error
): { status: number; code: string; message: string; details?: unknown } {
  if (isAppError(err)) {
    return {
      status: err.status,
      code: err.code,
      message: err.message,
      details: (err as { details?: unknown }).details,
    };
  }

  if (isDbConnectionFailure(err)) {
    return {
      status: 500,
      code: "db_unavailable",
      message: "Database unavailable.",
    };
  }

  if (isHttpishError(err)) {
    return {
      status: errorStatusFor(err),
      code: "auth_failed",
      message: "Authentication failed.",
    };
  }

  return {
    status: 500,
    code: "auth_failed",
    message: "Authentication failed.",
  };
}

export function notFoundHandler(req: Request, res: Response): void {
  const requestId = res.locals.requestId ?? "unknown";
  if (isAuthRoute(req)) {
    res.status(404).json({
      ok: false,
      data: null,
      error: {
        code: "not_found",
        message: "Not found",
      },
      requestId,
    });
    return;
  }

  res.status(404).json({
    code: "not_found",
    message: "Not found",
    requestId,
  });
}

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const requestId = res.locals.requestId ?? "unknown";
  const durationMs = res.locals.requestStart
    ? Date.now() - Number(res.locals.requestStart)
    : 0;

  const failureReason = resolveFailureReason(err);

  const logBase = {
    requestId,
    method: req.method,
    route: req.originalUrl,
    durationMs,
    failure_reason: failureReason,
  };

  // AUTH ROUTES — STRICT CONTRACT
  if (isAuthRoute(req)) {
    const normalized = normalizeAuthError(err);
    const status = normalized.status;
    const useRawMessage =
      typeof err.message === "string" &&
      err.message.toLowerCase().includes("accesstoken missing");
    const errorPayload = useRawMessage
      ? err.message
      : {
          code: normalized.code,
          message: normalized.message,
          ...(normalized.details ? { details: normalized.details } : {}),
        };

    logError("auth_request_failed", {
      ...logBase,
      status,
      code: normalized.code,
      message: normalized.message,
    });

    trackException({
      exception: err,
      properties: {
        requestId,
        route: req.originalUrl,
        status,
        code: normalized.code,
        failure_reason: "auth_failure",
      },
    });

    res.status(status).json({
      ok: false,
      data: null,
      error: errorPayload,
      requestId,
    });
    return;
  }

  // APPLICATION ERRORS
  if (isAppError(err)) {
    logWarn("request_error", {
      ...logBase,
      status: err.status,
      code: err.code,
      message: err.message,
    });

    trackException({
      exception: err,
      properties: {
        requestId,
        route: req.originalUrl,
        status: err.status,
        code: err.code,
        failure_reason: failureReason,
      },
    });

    const details = (err as { details?: unknown }).details;
    res.status(err.status).json({
      code: err.code,
      message: err.message,
      ...(details ? { details } : {}),
      requestId,
    });
    return;
  }

  // DB CONSTRAINTS
  if (isConstraintViolation(err)) {
    logWarn("request_error", {
      ...logBase,
      status: 409,
      code: "constraint_violation",
    });

    trackException({
      exception: err,
      properties: {
        requestId,
        route: req.originalUrl,
        status: 409,
        code: "constraint_violation",
        failure_reason: failureReason,
      },
    });

    res.status(409).json({
      code: "constraint_violation",
      message: "Constraint violation.",
      requestId,
    });
    return;
  }

  // DB CONNECTION ERRORS
  if (isDbConnectionFailure(err)) {
    logError("request_error", {
      ...logBase,
      status: 500,
      code: "db_unavailable",
    });

    trackException({
      exception: err,
      properties: {
        requestId,
        route: req.originalUrl,
        status: 500,
        code: "db_unavailable",
        failure_reason: failureReason,
      },
    });

    res.status(500).json({
      code: "db_unavailable",
      message: isTimeoutError(err) ? "Database timeout." : "Database unavailable.",
      requestId,
    });
    return;
  }

  // UNKNOWN
  logError("request_error", {
    ...logBase,
    status: 500,
    code: "internal_error",
    message: err.message,
  });

  trackException({
    exception: err,
    properties: {
      requestId,
      route: req.originalUrl,
      status: 500,
      code: "internal_error",
      failure_reason: failureReason,
    },
  });

  res.status(500).json({
    code: "internal_error",
    message: "Unexpected error",
    requestId,
  });
}
