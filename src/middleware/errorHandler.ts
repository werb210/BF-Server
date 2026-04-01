import type { NextFunction, Request, Response } from "express";

export function errorHandler(err: any, _req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) {
    return next(err);
  }

  res.locals.__wrapped = true;

  return res.status(500).json({
    status: "error",
    error: {
      code: "INTERNAL_ERROR",
      message: err?.message || "Internal server error",
    },
  });
}
