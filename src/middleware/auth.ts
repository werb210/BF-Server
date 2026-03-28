import { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config";

type AuthorizationOptions = {
  roles?: string[];
  capabilities?: string[];
};

type AppUser = NonNullable<Request["user"]> & {
  role?: string;
  capabilities?: string[];
};

export interface AuthRequest extends Request {
  user?: AppUser;
}

export function auth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;

  if (!header) {
    return res.status(401).json({ success: false, error: "No token" });
  }

  try {
    const token = header.split(" ")[1];
    if (!token) {
      return res.status(401).json({ success: false, error: "No token" });
    }
    req.user = jwt.verify(token, process.env.JWT_SECRET || config.jwt.secret) as Request["user"];
    return next();
  } catch {
    return res.status(401).json({ success: false, error: "Invalid token" });
  }
}

function authErrorBody(req: Request, code: string, message: string) {
  return {
    success: false,
    code,
    message,
    requestId: req.requestId ?? req.id ?? "unknown",
  };
}

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
  const auth = req.headers.authorization;

  let token: string | null = null;

  if (auth?.startsWith("Bearer ")) {
    token = auth.split(" ")[1] ?? null;
  }

  if (!token) {
    token = getCookieToken(req.headers.cookie);
  }

  if (!token) {
    return res.status(401).json({
      error: { message: "missing_token", code: "missing_token" },
    });
  }

  try {
    const decoded = jwt.verify(token, config.jwt.secret);
    req.user = decoded as Request["user"];
    return next();
  } catch (_err) {
    return res.status(401).json({
      error: { message: "invalid_token", code: "invalid_token" },
    });
  }
};

export function requireAuthorization(options: AuthorizationOptions = {}): RequestHandler {
  const requiredRoles = options.roles ?? [];
  const requiredCapabilities = options.capabilities ?? [];

  return (req: Request, res: Response, next: NextFunction) => {
    const user = req.user as AppUser | undefined;

    if (!user) {
      return res.status(401).json(authErrorBody(req, "missing_token", "Missing token"));
    }

    if (requiredRoles.length > 0 && (!user.role || !requiredRoles.includes(user.role))) {
      return res.status(403).json(authErrorBody(req, "forbidden", "Forbidden"));
    }

    if (requiredCapabilities.length > 0) {
      const userCapabilities = user.capabilities ?? [];
      const allowed = requiredCapabilities.some((capability) => userCapabilities.includes(capability));

      if (!allowed) {
        return res.status(403).json(authErrorBody(req, "forbidden", "Forbidden"));
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
