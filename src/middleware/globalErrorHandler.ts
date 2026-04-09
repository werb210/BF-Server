import { Request, Response, NextFunction } from "express";
import { AppError } from "../core/errors/AppError.js";

export function globalErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  if (err instanceof AppError) {
    return res.status(err.status).json({
      success: false,
      code: err.code,
      message: err.message,
      details: err.details ?? null
    });
  }

  console.error("UNHANDLED_ERROR", err);

  return res.status(500).json({
    success: false,
    code: "internal_error",
    message: "Internal server error",
    details: null
  });
}
