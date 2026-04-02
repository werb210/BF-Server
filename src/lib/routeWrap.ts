import { Request, Response } from "express";

export function routeWrap(handler: (req: Request, res: Response) => Promise<any>) {
  return async (req: Request, res: Response) => {
    try {
      const data = await handler(req, res);

      return res.json({
        status: "ok",
        data,
      });
    } catch (err: any) {
      console.error("ROUTE ERROR:", err);

      return res.status(500).json({
        status: "error",
        error: err?.message || "Internal error",
      });
    }
  };
}

export const wrap = routeWrap;
