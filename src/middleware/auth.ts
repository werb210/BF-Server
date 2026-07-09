import { Request, Response, NextFunction, type RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";
// BF_AGENT_AUTH_HYDRATE_v53
import { fetchCapabilitiesForRole } from "../auth/capabilities.js";
import { isRole, ROLES } from "../auth/roles.js";
// BF_SERVER_BLOCK_BI_ROUND5_AUTH_SILO_REFRESH_v1 -- see comment by
// the call site below.
import { resolveSiloFromRequest } from "./silo.js";

type AuthorizationOptions = {
  roles?: string[];
  capabilities?: string[];
};

type AppUser = NonNullable<Request["user"]> & {
  role?: string;
  capabilities?: string[];
};

export interface AuthRequest extends Request {
  user?: Request["user"];
}

export async function auth(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token) {
    return res.status(401).json({ status: "error", message: "Unauthorized" });
  }

  try {
    const JWT_SECRET = process.env.JWT_SECRET;

    if (!JWT_SECRET) {
      return res.status(500).json({ status: "error", message: "Auth not configured" });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    const userId = (decoded as any).id ?? (decoded as any).sub ?? null;

    let dbUser: { id: string; email: string | null; role: string | null; silo: string | null; silos: string[] | null } | null = null;
    if (typeof userId === "string" && userId) {
      const result = await pool.query<{ id: string; email: string | null; role: string | null; silo: string | null; silos: string[] | null }>(
        `SELECT id, email, role, silo, silos FROM users WHERE id = $1 LIMIT 1`,
        [userId]
      ).catch(() => ({ rows: [] as any[] }));
      dbUser = result.rows[0] ?? null;
    }

    // BF_AGENT_AUTH_HYDRATE_v53 — derive capabilities from role when the
    // JWT didn't carry an explicit capabilities array. Mirrors what the
    // login flow (auth.service.ts) bakes into freshly-minted user tokens.
    // Service tokens (Maya, dialer) only include {id, role}; this lets them
    // pass the requireCapability gate. Tokens that already carry an explicit
    // capabilities array are honored exactly as-issued.
    const decodedAny = decoded as Record<string, unknown>;
    const explicitCaps = Array.isArray(decodedAny.capabilities)
      ? (decodedAny.capabilities as string[])
      : null;
    const effectiveRole = (dbUser?.role ?? (decodedAny.role as string | undefined)) ?? null;
    const hydratedCaps = explicitCaps
      ?? (effectiveRole && isRole(effectiveRole) ? fetchCapabilitiesForRole(effectiveRole) : []);

    (req as any).user = {
      ...(decoded as any),
      ...(dbUser ?? {}),
      userId,
      capabilities: hydratedCaps,
      silos: dbUser?.silos ?? (Array.isArray((decoded as any).silos) ? (decoded as any).silos : []),
    };

    // BF_SERVER_BLOCK_BI_ROUND5_AUTH_SILO_REFRESH_v1
    // The app-level siloMiddleware (applySiloMiddleware in app.ts)
    // runs BEFORE this auth handler. At that point req.user is
    // undefined, so it falls into the "Unauthenticated → BF" branch
    // and sets res.locals.silo = "BF". Authed routes then read
    // res.locals.silo (often via getSilo(res)) and always see "BF",
    // regardless of the X-Silo header, ?silo query, or user
    // allowlist -- which is why BI / SLF-silo users see BF data on
    // every endpoint that filters on res.locals.silo (portal.ts,
    // applications.routes.ts, portalLenderProducts.ts, crm.ts,
    // communications.ts, calls.ts, users.service.ts -- 46 call
    // sites total). Re-resolve here, now that req.user is set, so
    // every downstream getSilo(res) returns the correct value.
    res.locals.silo = resolveSiloFromRequest(req);

    next();
  } catch {
    return res.status(401).json({ status: "error", message: "Invalid token" });
  }
}

export const requireAuth: RequestHandler = auth;

export function createAuthMiddleware(): RequestHandler {
  return requireAuth;
}

export const authMiddleware: RequestHandler = requireAuth;

export function requireAuthorization(options: AuthorizationOptions = {}): RequestHandler {
  const requiredRoles = options.roles ?? [];
  const requiredCapabilities = options.capabilities ?? [];

  return (req: Request, res: Response, next: NextFunction) => {
    const user = req.user as AppUser | undefined;

    if (!user) {
      return res.status(401).json({ status: "error", error: "NO_TOKEN" });
    }

    // BF_SERVER_MARKETING_INHERITS_STAFF_v1 - a Marketing user has the same
    // access as a Staff user (Marketing-only surfaces are gated separately). Any
    // endpoint that admits Staff also admits Marketing, so Marketing staff are
    // not 403'd on the pipeline / CRM / communications endpoints (81 of which
    // gate on [ADMIN, STAFF]). Admin-only endpoints stay admin-only.
    const roleSatisfied =
      !!user.role &&
      (requiredRoles.includes(user.role) ||
        (user.role === ROLES.MARKETING && requiredRoles.includes(ROLES.STAFF)));
    if (requiredRoles.length > 0 && !roleSatisfied) {
      return res.status(403).json({ status: "error", error: "FORBIDDEN" });
    }

    if (requiredCapabilities.length > 0) {
      const userCapabilities = user.capabilities ?? [];
      const allowed = requiredCapabilities.some((capability) => userCapabilities.includes(capability));

      if (!allowed) {
        return res.status(403).json({ status: "error", error: "FORBIDDEN" });
      }
    }

    return next();
  };
}

export function requireCapability(capability: string | string[]): RequestHandler {
  return requireAuthorization({
    capabilities: Array.isArray(capability) ? capability : [capability],
  });
}
