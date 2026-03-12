import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export interface AuthRequest extends Request {
  user?: any;
}

function extractToken(req: Request) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  return authHeader.replace("Bearer ", "");
}

export function requireAuthorization(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  const token = extractToken(req);

  if (!token) {
    return res.status(401).json({
      ok: false,
      error: "missing_token"
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET as string);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({
      ok: false,
      error: "invalid_token"
    });
  }
}

export function requireCapability(capability: string) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({
        ok: false,
        error: "unauthorized"
      });
    }

    const capabilities = req.user.capabilities || [];

    if (!capabilities.includes(capability)) {
      return res.status(403).json({
        ok: false,
        error: "forbidden"
      });
    }

    next();
  };
}
