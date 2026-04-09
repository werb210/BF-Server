import type { Request, Response } from "express";
import { fail, ok } from "./response.js";
import { ok as respondOk, error as respondError } from "../lib/respond.js";

export function wrap(handler: (req: Request, res: Response) => Promise<any> | any) {
  return async (req: Request, res: Response) => {
    try {
      const result = await handler(req, res);
      if (!res.headersSent) {
        respondOk(res, ok(result, (req as Request & { rid?: string }).rid));
      }
    } catch (err: any) {
      if (!res.headersSent) {
        const status = err.status || 500;
        if (status === 429) {
          res.setHeader("Retry-After", "1");
        }
        respondError(res, fail(err, (req as Request & { rid?: string }).rid).error, status);
      }
    }
  };
}
