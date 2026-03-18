import { Request, Response, NextFunction } from "express";

export function normalizeApiPath(req: Request, _res: Response, next: NextFunction) {
  if (req.url.startsWith("/api/api/")) {
    req.url = req.url.replace("/api/api/", "/api/");
  }

  if (req.url.startsWith("/auth/") || req.url === "/auth") {
    req.url = `/api${req.url}`;
  }

  next();
}
