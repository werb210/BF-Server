import type { NextFunction, Request, Response } from "express";

export function routeWrap(handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await handler(req, res, next);
    } catch (err: any) {
      console.error("ROUTE ERROR:", err);
      const status = err?.status || 500;

      if (!res.headersSent) {
        res.status(status).json({
          error: err?.message || "INTERNAL_ERROR",
        });
      }
    }
  };
}

export const wrap = routeWrap;
