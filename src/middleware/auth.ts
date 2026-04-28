import { Request, Response, NextFunction, type RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";
// BF_AGENT_AUTH_HYDRATE_v53
import { fetchCapabilitiesForRole } from "../auth/capabilities.js";
import { isRole } from "../auth/roles.js";

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

    if (requiredRoles.length > 0 && (!user.role || !requiredRoles.includes(user.role))) {
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
