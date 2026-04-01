import type { Response } from "express";
import { ok as okPayload, fail as failPayload } from "../lib/apiResponse";

export function ok(res: Response, data: unknown = {}) {
  return res.json(okPayload(data));
}

export function fail(res: Response, status = 500, message = "error") {
  return res.status(status).json(failPayload(String(status), message));
}
