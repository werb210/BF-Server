import type { NextFunction, Request, RequestHandler, Response } from "express";
import jwt from "jsonwebtoken";
import { getEnv } from "../config/env";
import { fail } from "../lib/response";

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

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const rid = req.id ?? req.rid;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json(fail("Unauthorized", rid));
  }

  const token = authHeader.split(" ")[1];
  if (!token) {
    return res.status(401).json(fail("Unauthorized", rid));
  }

  const { JWT_SECRET } = getEnv();
  if (!JWT_SECRET) {
    return res.status(401).json(fail("Unauthorized", rid));
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded as Request["user"];
    return next();
  } catch {
    return res.status(401).json(fail("Unauthorized", rid));
  }
}

export const auth: RequestHandler = requireAuth;
export const authMiddleware: RequestHandler = requireAuth;

export function requireAuthorization(options: AuthorizationOptions = {}): RequestHandler {
  const requiredRoles = options.roles ?? [];
  const requiredCapabilities = options.capabilities ?? [];

  return (req: Request, res: Response, next: NextFunction) => {
    const user = req.user as AppUser | undefined;

    if (!user) {
      return res.status(401).json(fail("NO_TOKEN", (req as any).rid));
    }

    if (requiredRoles.length > 0 && (!user.role || !requiredRoles.includes(user.role))) {
      return res.status(403).json(fail("FORBIDDEN", (req as any).rid));
    }

    if (requiredCapabilities.length > 0) {
      const userCapabilities = user.capabilities ?? [];
      const allowed = requiredCapabilities.some((capability) => userCapabilities.includes(capability));
      if (!allowed) {
        return res.status(403).json(fail("FORBIDDEN", (req as any).rid));
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

export default requireAuth;
