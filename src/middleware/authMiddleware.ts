import { type NextFunction, type Request, type Response } from "express";
import jwt from "jsonwebtoken";

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ ok: false });

  const token = auth.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET ?? "dev-secret");
    (req as any).user = decoded;
    next();
  } catch {
    return res.status(401).json({ ok: false });
  }
}
