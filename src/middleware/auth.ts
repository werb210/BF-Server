import { RequestHandler } from "express";
import jwt from "jsonwebtoken";

type AuthorizationOptions = {
  roles?: string[];
  capabilities?: string[];
};

export const requireAuth: RequestHandler = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ ok: false, error: "missing_token" });
    return;
  }

  try {
    const token = header.substring(7);
    const decoded = jwt.verify(token, process.env.JWT_SECRET as string);
    (req as any).user = decoded;
    next();
  } catch {
    res.status(401).json({ ok: false, error: "invalid_token" });
  }
};

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
