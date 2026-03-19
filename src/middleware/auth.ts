import { RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { getCapabilitiesForRole } from "../auth/capabilities";
import { verifyAccessToken } from "../auth/jwt";
import { DEFAULT_AUTH_SILO } from "../auth/silo";
import { isRole } from "../auth/roles";
import { type AuthenticatedUser } from "../types/auth";

type AuthorizationOptions = {
  roles?: string[];
  capabilities?: string[];
};

function resolveRequestId(req: Parameters<RequestHandler>[0]): string {
  return req.id ?? "unknown";
}

export const requireAuth: RequestHandler = (req, res, next) => {
  req.id = String(req.id);
  const token = resolveToken(req);
  if (!token) {
    req.log?.warn({
      event: "auth_missing_token",
      path: req.originalUrl,
      ip: req.ip,
    });
    return res.status(401).json({
      code: "UNAUTHORIZED",
      error: "missing_token",
      message: "Missing token",
      requestId: resolveRequestId(req),
    });
  }

  try {
    const decoded = verifyJwtPayload(token);
    const user = resolveAuthenticatedUser(decoded);
    if (!user) {
      return res.status(401).json({
        code: "UNAUTHORIZED",
        error: "invalid_token",
        message: "Invalid token",
        requestId: resolveRequestId(req),
      });
    }

    (req as any).user = user;
    next();
  } catch {
    return res.status(401).json({
      code: "UNAUTHORIZED",
      error: "invalid_token",
      message: "Invalid token",
      requestId: resolveRequestId(req),
    });
  }
};

function verifyJwtPayload(token: string): jwt.JwtPayload {
  try {
    const payload = verifyAccessToken(token);
    return payload as jwt.JwtPayload;
  } catch {
    const decoded = jwt.verify(token, process.env.JWT_SECRET as string, {
      algorithms: ["HS256"],
    });
    if (!decoded || typeof decoded !== "object") {
      throw new Error("invalid_token");
    }
    return decoded;
  }
}

function resolveToken(req: Parameters<RequestHandler>[0]): string | null {
  const header = req.headers.authorization;
  if (typeof header === "string") {
    const [scheme, rawToken] = header.split(/\s+/, 2);
    if (scheme?.toLowerCase() === "bearer" && rawToken) {
      return rawToken;
    }
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
      return res.status(401).json({
        code: "UNAUTHORIZED",
        error: "missing_token",
        message: "Missing token",
        requestId: resolveRequestId(req),
      });
    }

    if (requiredRoles.length > 0 && !requiredRoles.includes(user.role)) {
      return res.status(403).json({
        code: "FORBIDDEN",
        error: "forbidden",
        message: "Forbidden",
        requestId: resolveRequestId(req),
      });
    }

    if (requiredCapabilities.length > 0) {
      const userCapabilities: string[] = user.capabilities || [];
      const allowed = requiredCapabilities.some((capability) =>
        userCapabilities.includes(capability)
      );

      if (!allowed) {
        return res.status(403).json({
          code: "FORBIDDEN",
          error: "forbidden",
          message: "Forbidden",
          requestId: resolveRequestId(req),
        });
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
      return res.status(401).json({
        code: "UNAUTHORIZED",
        error: "missing_token",
        message: "Missing token",
        requestId: resolveRequestId(req),
      });
    }

    const userCaps: string[] = user.capabilities || [];

    const allowed = required.some((c) => userCaps.includes(c));

    if (!allowed) {
      return res.status(403).json({
        code: "FORBIDDEN",
        error: "forbidden",
        message: "Forbidden",
        requestId: resolveRequestId(req),
      });
    }

    next();
  };
}
