import type { Response } from "express";
import type { ApiResponse } from "../../contracts/index.js";

export function ok<T>(res: Response, data: T, status = 200): Response {
  const body: ApiResponse<T> = { status: "ok", data };
  res.locals.__wrapped = true;
  return res.status(status).json(body);
}

export function fail(
  res: Response,
  message: string,
  status = 400,
  _code?: string,
  _details?: unknown,
): Response {
  const body: ApiResponse<never> = {
    status: "error",
    error: message,
  };

  res.locals.__wrapped = true;
  return res.status(status).json(body);
}
