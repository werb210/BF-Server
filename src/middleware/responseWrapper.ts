import { Request, Response, NextFunction } from "express";

export function safeResponseWrapper(_req: Request, res: Response, next: NextFunction) {
  // Do not override the global response serializer here.
  next();
}
