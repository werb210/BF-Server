import { type NextFunction, type Request, type Response } from "express";
import { safeErr } from "../lib/safeErr.js";

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  console.error("GLOBAL ERROR:", safeErr(err));
  res.status(500).json({ ok: false, error: "Internal server error" });
}
