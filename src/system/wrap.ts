import type { Request, Response } from "express";
import { fail, ok } from "./response";

export function wrap(handler: (req: Request, res: Response) => Promise<any> | any) {
  return async (req: Request, res: Response) => {
    try {
      const result = await handler(req, res);
      if (!res.headersSent) {
        res.json(ok(result));
      }
    } catch (err: any) {
      if (!res.headersSent) {
        res.status(err.status || 500).json(fail(err));
      }
    }
  };
}
