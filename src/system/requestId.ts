import { randomUUID } from "crypto";
import { type NextFunction, type Request, type Response } from "express";

export function requestId() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.headers["x-request-id"];
    const id = typeof incoming === "string" && incoming.trim().length > 0 ? incoming : randomUUID();
    (req as Request & { rid: string }).rid = id;
    req.requestId = id;
    req.id = id;
    res.locals.requestId = id;
    res.setHeader("x-request-id", id);
    next();
  };
}
