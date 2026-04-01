import type { Response } from "express";

export function ok(res: Response, data: unknown = {}, message = "ok") {
  return res.json({ success: true, data });
}

export function fail(res: Response, status = 500, message = "error") {
  return res.status(status).json({ success: false, error: message });
}
