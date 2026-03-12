import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export interface AuthRequest extends Request {
  user?: any;
}

function getToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  if (!header.startsWith("Bearer ")) return null;
  return header.substring(7);
}

/*
Base auth middleware
*/
export function requireAuth(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  const token = getToken(req);

  if (!token) {
    return res.status(401).json({
      ok: false,
      error: "missing_token",
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET as string);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({
      ok: false,
      error: "invalid_token",
    });
  }
}

/*
Alias used in some routes
*/
export const requireAuthorization = requireAuth;

/*
Capability middleware
Accepts either string OR string[]
*/
export function requireCapability(capabilities: string | string[]) {
  const required = Array.isArray(capabilities) ? capabilities : [capabilities];

  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({
        ok: false,
        error: "unauthorized",
      });
    }

    const userCaps: string[] = req.user.capabilities || [];

    const allowed = required.some((cap) => userCaps.includes(cap));

    if (!allowed) {
      return res.status(403).json({
        ok: false,
        error: "forbidden",
      });
    }

    next();
  };
}
