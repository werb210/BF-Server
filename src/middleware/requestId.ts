import { randomUUID } from "crypto";
import { type NextFunction, type Request, type Response } from "express";

export function requestId(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const headerId = req.headers["x-request-id"];
  const id =
    typeof headerId === "string" && headerId.trim().length > 0
      ? headerId
      : randomUUID();

  req.id = id;
  res.locals.requestId = id;
  res.setHeader("X-Request-Id", id);

  next();
}
