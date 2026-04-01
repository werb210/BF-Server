import { Request, Response, NextFunction, type RequestHandler } from "express";
import { verifyJwt } from "../auth/jwt";
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

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;

  if (!header) {
    return fail(res, 401, "Unauthorized");
  }

  const bearerMatch = header.match(/^Bearer(?:\s+(.+))?$/i);
  if (!bearerMatch) {
    return fail(res, 401, "Unauthorized");
  }

  const token = bearerMatch[1]?.trim();

  if (!token || token === "null" || token === "undefined") {
    return fail(res, 401, "Unauthorized");
  }

  try {
    req.user = verifyJwt(token) as Request["user"];
    return next();
  } catch {
    return fail(res, 401, "Unauthorized");
  }
}

export function createAuthMiddleware(): RequestHandler {
  return requireAuth;
}

export const authMiddleware: RequestHandler = requireAuth;
export const auth = authMiddleware;

export function requireAuthorization(options: AuthorizationOptions = {}): RequestHandler {
  const requiredRoles = options.roles ?? [];
  const requiredCapabilities = options.capabilities ?? [];

  return (req: Request, res: Response, next: NextFunction) => {
    const user = req.user as AppUser | undefined;

    if (!user) {
      return fail(res, 401, "Unauthorized");
    }

    if (requiredRoles.length > 0 && (!user.role || !requiredRoles.includes(user.role))) {
      return res.status(403).json({ success: false, error: "FORBIDDEN" });
    }

    if (requiredCapabilities.length > 0) {
      const userCapabilities = user.capabilities ?? [];
      const allowed = requiredCapabilities.some((capability) => userCapabilities.includes(capability));

      if (!allowed) {
        return res.status(403).json({ success: false, error: "FORBIDDEN" });
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
