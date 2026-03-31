import { Request, Response, NextFunction, type RequestHandler } from "express";
import jwt from "jsonwebtoken";

type AuthorizationOptions = {
  roles?: string[];
  capabilities?: string[];
};

type AppUser = NonNullable<Request["user"]> & {
  role?: string;
  capabilities?: string[];
};

export interface AuthRequest extends Request {
  user?: any;
}

export function extractToken(req: any): string | null {
  const header = req.headers.authorization;

  if (!header || typeof header !== "string") {
    return null;
  }

  if (!header.startsWith("Bearer ")) {
    return null;
  }

  const token = header.slice(7).trim();

  if (!token) {
    return null;
  }

  return token;
}

function verifyJwt(token: string): Request["user"] {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw new Error("JWT_SECRET NOT SET");
  }

  const decoded = jwt.verify(token, jwtSecret);
  if (!decoded) {
    throw new Error("invalid");
  }

  return decoded as Request["user"];
}

export const auth = (req: AuthRequest, res: Response, next: NextFunction) => {
  const token = extractToken(req);

  if (!token) {
    console.error("[AUTH FAIL] Missing token", req.method, req.url);
    return res.status(401).json({ error: "missing_token" });
  }

  try {
    req.user = verifyJwt(token);
    return next();
  } catch (err: any) {
    console.error("[AUTH FAIL] Invalid token", err?.message ?? err);
    return res.status(401).json({ error: "invalid_token" });
  }
};

export const requireAuth: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  const token = extractToken(req);

  if (!token) {
    console.error("[AUTH FAIL] Missing token", req.method, req.url);
    return res.status(401).json({ error: "missing_token" });
  }

  try {
    req.user = verifyJwt(token);
    return next();
  } catch (err: any) {
    console.error("[AUTH FAIL] Invalid token", err?.message ?? err);
    return res.status(401).json({ error: "invalid_token" });
  }
};

export function requireAuthorization(options: AuthorizationOptions = {}): RequestHandler {
  const requiredRoles = options.roles ?? [];
  const requiredCapabilities = options.capabilities ?? [];

  return (req: Request, res: Response, next: NextFunction) => {
    const user = req.user as AppUser | undefined;

    if (!user) {
      return res.status(401).json({ error: "unauthorized" });
    }

    if (requiredRoles.length > 0 && (!user.role || !requiredRoles.includes(user.role))) {
      return res.status(403).json({ error: "forbidden" });
    }

    if (requiredCapabilities.length > 0) {
      const userCapabilities = user.capabilities ?? [];
      const allowed = requiredCapabilities.some((capability) => userCapabilities.includes(capability));

      if (!allowed) {
        return res.status(403).json({ error: "forbidden" });
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
