import { type NextFunction, type Request, type Response } from "express";
import { logger } from "../platform/logger";

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const message = err instanceof Error ? err.message : "internal_error";
  logger.error("request_failed", { error: message });
  res.status(500).json({ ok: false, error: { code: "INTERNAL_SERVER_ERROR", message } });
}
