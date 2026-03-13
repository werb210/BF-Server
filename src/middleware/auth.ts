import { RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { getCapabilitiesForRole } from "../auth/capabilities";
import { DEFAULT_AUTH_SILO } from "../auth/silo";
import { isRole } from "../auth/roles";
import { type AuthenticatedUser } from "../types/auth";

type AuthorizationOptions = {
  roles?: string[];
  capabilities?: string[];
};

export const requireAuth: RequestHandler = (req, res, next) => {
  const token = resolveToken(req);
  if (!token) {
    res.status(401).json({ ok: false, error: "missing_token" });
    return;
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET as string);
    const user = resolveAuthenticatedUser(decoded);
    if (!user) {
      res.status(401).json({ ok: false, error: "invalid_token" });
      return;
    }

    (req as any).user = user;
    next();
  } catch {
    res.status(401).json({ ok: false, error: "invalid_token" });
  }
};

function resolveToken(req: Parameters<RequestHandler>[0]): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    return header.substring(7);
  }

  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) {
    return null;
  }

  const cookieEntries = cookieHeader.split(";");
  const cookieNames = ["token", "accessToken", "session"];

  for (const entry of cookieEntries) {
    const [rawName, ...rawValue] = entry.trim().split("=");
    if (!rawName || rawValue.length === 0) {
      continue;
    }

    if (!cookieNames.includes(rawName)) {
      continue;
    }

    const value = rawValue.join("=").trim();
    if (!value) {
      continue;
    }

    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  return null;
}

function resolveAuthenticatedUser(decoded: string | jwt.JwtPayload): AuthenticatedUser | null {
  if (!decoded || typeof decoded !== "object") {
    return null;
  }

  const userId = typeof decoded.sub === "string" ? decoded.sub : null;
  const role = typeof decoded.role === "string" && isRole(decoded.role) ? decoded.role : null;
  if (!userId || !role) {
    return null;
  }

  const silo = typeof decoded.silo === "string" && decoded.silo.trim().length > 0
    ? decoded.silo.trim()
    : DEFAULT_AUTH_SILO;

  return {
    userId,
    role,
    silo,
    siloFromToken: typeof decoded.silo === "string" && decoded.silo.trim().length > 0,
    lenderId: null,
    phone: typeof decoded.phone === "string" ? decoded.phone : null,
    capabilities: getCapabilitiesForRole(role),
  };
}

export function requireAuthorization(options: AuthorizationOptions = {}): RequestHandler {
  const requiredRoles = options.roles ?? [];
  const requiredCapabilities = options.capabilities ?? [];

  return (req, res, next) => {
    const user = (req as any).user;

    if (!user) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }

    if (requiredRoles.length > 0 && !requiredRoles.includes(user.role)) {
      res.status(403).json({ ok: false, error: "forbidden" });
      return;
    }

    if (requiredCapabilities.length > 0) {
      const userCapabilities: string[] = user.capabilities || [];
      const allowed = requiredCapabilities.some((capability) =>
        userCapabilities.includes(capability)
      );

      if (!allowed) {
        res.status(403).json({ ok: false, error: "forbidden" });
        return;
      }
    }

    next();
  };
}

export function requireCapability(cap: string | string[]): RequestHandler {
  const required = Array.isArray(cap) ? cap : [cap];

  return (req, res, next) => {
    const user = (req as any).user;

    if (!user) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }

    const userCaps: string[] = user.capabilities || [];

    const allowed = required.some((c) => userCaps.includes(c));

    if (!allowed) {
      res.status(403).json({ ok: false, error: "forbidden" });
      return;
    }

    next();
  };
}
