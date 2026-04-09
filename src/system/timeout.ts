import type { NextFunction, Request, Response } from "express";
import { fail } from "../utils/http/respond.js";

export function timeout(ms = 15000) {
  return (_req: Request, res: Response, next: NextFunction) => {
    const id = setTimeout(() => {
      if (!res.headersSent) {
        fail(res, "Request timeout", 503, "TIMEOUT");
      }
    }, ms);

    res.on("finish", () => clearTimeout(id));
    res.on("close", () => clearTimeout(id));

    next();
  };
}
