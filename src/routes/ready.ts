import type { Request, Response } from "express";

import { deps } from "../system/deps";

export function readyRoute(_req: Request, res: Response) {
  if (!deps.db.ready) {
    return res.status(503).json({ status: "not_ready" });
  }

  return res.status(200).json({ status: "ok" });
}

export const readyHandler = readyRoute;
