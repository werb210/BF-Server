import { type NextFunction, type Request, type Response } from "express";
import { isAppError } from "./errors";
import { isDbConnectionFailure } from "../dbRuntime";
import { logError } from "../observability/logger";
import { getRequestContext } from "../observability/requestContext";

export type SafeRequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
) => void | Promise<void>;

export function safeHandler(handler: SafeRequestHandler): SafeRequestHandler {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (err) {
      // If response already started, never interfere
      if (res.headersSent) {
        next(err as Error);
        return;
      }

      const requestId = res.locals.requestId ?? "unknown";
      const requestContext = getRequestContext();
      const shouldLogStack = requestContext?.sqlTraceEnabled ?? false;

      logError("safe_handler_error", {
        requestId,
        route: req.originalUrl,
        userId: req.user?.userId ?? null,
        error:
          err instanceof Error
            ? { name: err.name, message: err.message }
            : "unknown_error",
        ...(shouldLogStack && err instanceof Error ? { stack: err.stack } : {}),
      });

      // Let canonical error handlers deal with known error types
      if (isAppError(err) || isDbConnectionFailure(err)) {
        next(err as Error);
        return;
      }

      // Delegate all other failures to the centralized error middleware.
      next(err as Error);
    }
  };
}
