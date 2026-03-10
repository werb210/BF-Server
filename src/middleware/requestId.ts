import { type NextFunction, type Request, type Response } from "express";
import { v4 as uuidv4 } from "uuid";

export function requestId(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const id = req.get("x-request-id")?.trim() || uuidv4();
  req.id = id;
  res.locals.requestId = id;
  res.setHeader("X-Request-Id", id);
  next();
}
