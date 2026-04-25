import type { Request, Response, NextFunction } from "express";

/**
 * Resolves the silo for a request with strict enforcement rules.
 *
 *   - If the user is admin, accept the X-Silo header (or query param)
 *     unconditionally. Default to "BF" if absent.
 *   - If the user has a multi-silo allowlist (users.silos has >1 entry),
 *     accept X-Silo only if it's in the allowlist. Otherwise fall back
 *     to the user's primary silo (users.silo).
 *   - If the user is single-silo, ALWAYS use their primary silo.
 *     Client headers are ignored (prevents header spoofing).
 *   - Public/unauthenticated routes default to "BF".
 *
 * The resolved silo is stashed on res.locals.silo so downstream
 * handlers can read it via getSilo(res).
 */

export type Silo = "BF" | "BI" | "SLF";
const VALID_SILOS: Silo[] = ["BF", "BI", "SLF"];

function isValidSilo(value: unknown): value is Silo {
  return typeof value === "string" && (VALID_SILOS as string[]).includes(value);
}

function readHeaderOrQuery(req: Request): string | null {
  const fromHeader = req.headers["x-silo"];
  if (typeof fromHeader === "string" && fromHeader.trim()) {
    return fromHeader.trim().toUpperCase();
  }
  if (Array.isArray(fromHeader) && fromHeader[0]) {
    return String(fromHeader[0]).trim().toUpperCase();
  }
  const q = (req.query as Record<string, unknown>)?.silo;
  if (typeof q === "string" && q.trim()) return q.trim().toUpperCase();
  return null;
}

export function siloMiddleware(req: any, res: any, next: any): void {
  const requested = readHeaderOrQuery(req);
  const user = req.user as
    | { role?: string; silo?: string; silos?: string[] }
    | undefined;

  // Unauthenticated request — default to BF.
  if (!user) {
    res.locals.silo = "BF";
    return next();
  }

  const role = String(user.role || "").toLowerCase();
  const primarySilo = isValidSilo(user.silo) ? user.silo : "BF";
  const allowlist: Silo[] = Array.isArray(user.silos)
    ? user.silos.map((s) => String(s).toUpperCase()).filter(isValidSilo)
    : [];

  // Admin: any silo, default to requested or primary.
  if (role === "admin") {
    res.locals.silo = isValidSilo(requested) ? requested : primarySilo;
    return next();
  }

  // Multi-silo user: respect requested only if in allowlist.
  if (allowlist.length > 1) {
    if (isValidSilo(requested) && allowlist.includes(requested)) {
      res.locals.silo = requested;
    } else {
      res.locals.silo = primarySilo;
    }
    return next();
  }

  // Single-silo user: ignore client header entirely.
  res.locals.silo = primarySilo;
  return next();
}

export function applySiloMiddleware(app: import("express").Express) {
  app.use(siloMiddleware as (req: Request, res: Response, next: NextFunction) => void);
}

export function getSilo(res: Response): Silo {
  const value = res.locals?.silo;
  return isValidSilo(value) ? value : "BF";
}
