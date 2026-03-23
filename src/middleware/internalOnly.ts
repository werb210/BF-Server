import { type NextFunction, type Request, type Response } from "express";
import { config } from "../config";

export function internalOnly(req: Request, res: Response, next: NextFunction): void {
  if (config.env === "test") {
    next();
    return;
  }

  const key = req.headers["x-internal-key"];
  const provided = Array.isArray(key) ? key[0] : key;
  const expected = config.internal.apiKey;

  if (provided !== expected) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  next();
}
