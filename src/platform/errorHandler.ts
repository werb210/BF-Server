import { type NextFunction, type Request, type Response } from "express";
import { logger } from "./logger";

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  logger.error({ err, requestId: req.id }, "Unhandled server error");

  res.status(500).json({
    success: false,
    error: "Internal server error",
    requestId: req.id,
  });
}
