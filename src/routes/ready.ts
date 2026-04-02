import { Request, Response } from "express";

export function readyHandler(req: Request, res: Response) {
  const deps = req.app.locals.deps;

  if (!deps || !deps.db) {
    return res.status(503).json({ status: "not_ready" });
  }

  if (deps.db.ready !== true) {
    return res.status(503).json({ status: "not_ready" });
  }

  return res.status(200).json({ status: "ok" });
}
