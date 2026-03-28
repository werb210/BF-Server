import type { Response } from "express";

export function ok(res: Response, data?: unknown): Response {
  return res.json({ success: true, ...(data === undefined ? {} : { data }) });
}

export function fail(res: Response, error: string, code = 400): Response {
  return res.status(code).json({ success: false, error });
}
