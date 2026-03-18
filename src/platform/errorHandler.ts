import { type NextFunction, type Request, type Response } from "express";

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  console.error("GLOBAL ERROR:", err);
  res.status(500).json({ ok: false, error: "Internal server error" });
}
