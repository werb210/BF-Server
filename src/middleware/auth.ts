import { Request, Response, NextFunction, type RequestHandler } from "express";
import { verifyJwt } from "../auth/jwt";

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

export function createAuthMiddleware(): RequestHandler {
  return function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
    const header = req.headers.authorization;

    if (!header || !header.startsWith("Bearer ")) {
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }

    const token = header.slice(7);

    if (!token || token === "null" || token === "undefined") {
      return res.status(401).json({ error: "INVALID_TOKEN" });
    }

    try {
      const decoded = verifyJwt(token);
      req.user = decoded as Request["user"];
      return next();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "INVALID_TOKEN";

      if (msg === "SERVER_MISCONFIG") {
        return res.status(500).json({ error: "SERVER_MISCONFIG" });
      }

      return res.status(401).json({ error: "INVALID_TOKEN" });
    }
  };
}

export const authMiddleware: RequestHandler = (req, res, next) => {
  return createAuthMiddleware()(req, res, next);
};

export const auth = authMiddleware;
export const requireAuth: RequestHandler = authMiddleware;

export function requireAuthorization(options: AuthorizationOptions = {}): RequestHandler {
  const requiredRoles = options.roles ?? [];
  const requiredCapabilities = options.capabilities ?? [];

  return (req: Request, res: Response, next: NextFunction) => {
    const user = req.user as AppUser | undefined;

    if (!user) {
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }

    if (requiredRoles.length > 0 && (!user.role || !requiredRoles.includes(user.role))) {
      return res.status(403).json({ error: "FORBIDDEN" });
    }

    if (requiredCapabilities.length > 0) {
      const userCapabilities = user.capabilities ?? [];
      const allowed = requiredCapabilities.some((capability) => userCapabilities.includes(capability));

      if (!allowed) {
        return res.status(403).json({ error: "FORBIDDEN" });
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
