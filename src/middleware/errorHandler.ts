import { type NextFunction, type Request, type Response } from "express";

import { fail } from "../lib/response";

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): Response {
  return fail(res, err.message || "Internal Server Error", 500);
}
