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

function getAuthHeader(req: Request): string | null {
  return (
    req.headers.authorization
    || (req.headers as Record<string, string | string[] | undefined>).Authorization as string | undefined
    || req.get("authorization")
    || null
  );
}

function getBearerToken(req: Request): string | null {
  const authHeader = getAuthHeader(req);

  if (!authHeader) {
    return null;
  }

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    return null;
  }

  return parts[1];
}

export const auth = (req: AuthRequest, res: Response, next: NextFunction) => {
  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ error: "missing_auth_header" });
  }

  try {
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      return res.status(401).json({ error: "invalid_token" });
    }

    const decoded = jwt.verify(token, jwtSecret);
    req.user = decoded;
    return next();
  } catch (err) {
    console.error("[JWT ERROR]", err);
    return res.status(401).json({ error: "invalid_token" });
  }
};

export const requireAuth: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = getAuthHeader(req);

  if (!authHeader) {
    return res.status(401).json({ error: "missing_auth_header" });
  }

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    return res.status(401).json({ error: "invalid_auth_format" });
  }

  const token = parts[1];

  try {
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      return res.status(401).json({ error: "invalid_token" });
    }

    const decoded = jwt.verify(token, jwtSecret);
    req.user = decoded as Request["user"];

    if (!req.user) {
      return res.status(401).json({ error: "unauthorized" });
    }

    return next();
  } catch (err) {
    console.error("[JWT ERROR]", err);
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
