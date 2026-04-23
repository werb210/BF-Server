import type { Request, Response, NextFunction } from "express";

function normalizeSilo(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized.toUpperCase() : null;
}

export function siloMiddleware(req: Request, res: Response, next: NextFunction): void {
  const silo =
    normalizeSilo(req.header("x-silo")) ??
    normalizeSilo(req.query.silo) ??
    normalizeSilo((req.body as Record<string, unknown>)?.silo) ??
    "BF";
  res.locals.silo = silo;
  next();
}

/**
 * Canonical silo accessor — every route handler that filters by silo MUST use this
 * helper rather than reading req.query.silo directly. The portal and iOS dialer
 * send silo as an X-Silo header; only siloMiddleware sees it.
 */
export function getSilo(res: Response): string {
  return typeof res.locals.silo === "string" ? res.locals.silo : "BF";
}
