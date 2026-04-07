import type { NextFunction, Request, Response } from "express";
import { fail } from "../lib/response";

export function timeout(ms = 15000) {
  return (_req: Request, res: Response, next: NextFunction) => {
    const id = setTimeout(() => {
      if (!res.headersSent) {
        res.status(503).json(fail("Request timeout", (_req as Request & { rid?: string }).rid));
      }
    }, ms);

    res.on("finish", () => clearTimeout(id));
    res.on("close", () => clearTimeout(id));

    next();
  };
}
