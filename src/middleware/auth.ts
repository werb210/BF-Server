import { Request, Response, NextFunction, type RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { fail } from "../utils/response";

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

export const auth = (req: AuthRequest, res: Response, next: NextFunction) => {
  const header = req.headers.authorization;

  if (!header) {
    return res.status(401).json(fail("No token"));
  }

  const token = header.replace("Bearer ", "");

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json(fail("Invalid token"));
  }
};

function getCookieToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(";");
  for (const cookie of cookies) {
    const [rawName, ...rest] = cookie.trim().split("=");
    if (rawName !== "token") continue;
    const value = rest.join("=").trim();
    return value ? decodeURIComponent(value) : null;
  }

  return null;
}

export const requireAuth: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  const header = req.headers.authorization;

  let token: string | null = null;
  if (header?.startsWith("Bearer ")) {
    token = header.replace("Bearer ", "");
  }

  if (!token) {
    token = getCookieToken(req.headers.cookie);
  }

  if (!token) {
    return res.status(401).json(fail("No token"));
  }

  try {
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      return res.status(401).json(fail("Invalid token"));
    }

    const decoded = jwt.verify(token, jwtSecret);
    req.user = decoded as Request["user"];
    return next();
  } catch {
    return res.status(401).json(fail("Invalid token"));
  }
};

export function requireAuthorization(options: AuthorizationOptions = {}): RequestHandler {
  const requiredRoles = options.roles ?? [];
  const requiredCapabilities = options.capabilities ?? [];

  return (req: Request, res: Response, next: NextFunction) => {
    const user = req.user as AppUser | undefined;

    if (!user) {
      return res.status(401).json(fail("No token"));
    }

    if (requiredRoles.length > 0 && (!user.role || !requiredRoles.includes(user.role))) {
      return res.status(403).json(fail("Forbidden"));
    }

    if (requiredCapabilities.length > 0) {
      const userCapabilities = user.capabilities ?? [];
      const allowed = requiredCapabilities.some((capability) => userCapabilities.includes(capability));

      if (!allowed) {
        return res.status(403).json(fail("Forbidden"));
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
