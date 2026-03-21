import { Request, Response, NextFunction } from "express";

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction): void {
  res.status(500).json({
    error: err?.message || "Internal Server Error",
  });
}
