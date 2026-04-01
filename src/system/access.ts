import { type NextFunction, type Request, type Response } from "express";
import { log } from "./logger";
import { incErr } from "./metrics";

export function access() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const start = Date.now();

    res.on("finish", () => {
      if (res.statusCode >= 500) {
        incErr();
      }

      log("info", "request", {
        rid: (req as Request & { rid?: string }).rid,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        ms: Date.now() - start,
      });
    });

    next();
  };
}
