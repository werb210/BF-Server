import { Request, Response, NextFunction } from "express";

type Handler = (req: Request, res: Response, next: NextFunction) => any;

export function routeWrap(handler: Handler) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const rid = (req as any).rid;

    try {
      const result = await handler(req, res, next);

      if (res.headersSent) return;

      res.status(200).json({
        status: "ok",
        rid,
        ...(result !== undefined ? { data: result } : {}),
      });
    } catch (err: any) {
      const status = err?.status ?? 500;

      res.status(status).json({
        status: "error",
        rid,
        error: err?.message || "Internal Server Error",
      });
    }
  };
}

export const wrap = routeWrap;
