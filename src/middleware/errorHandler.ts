import { Request, Response, NextFunction } from "express";

export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
) {
  console.error(err);

  return res.status(err.status || 500).json({
    ok: false,
    error: err.message || "Internal server error"
  });
}
