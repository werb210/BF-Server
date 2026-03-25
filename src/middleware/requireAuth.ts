import jwt, { type JwtPayload } from "jsonwebtoken";

interface AuthenticatedRequest {
  headers: {
    authorization?: string;
  };
  user?: JwtPayload | string;
}

export function requireAuth(req: AuthenticatedRequest, res: any, next: any) {
  const auth = req.headers.authorization;

  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const token = auth.slice("Bearer ".length).trim();
  const jwtSecret = process.env.JWT_SECRET;

  if (!jwtSecret) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const decoded = jwt.verify(token, jwtSecret);
    req.user = decoded;
    return next();
  } catch {
    return res.status(401).json({ error: "unauthorized" });
  }
}
