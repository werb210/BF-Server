// BF_SERVER_BLOCK_v606 -- /api/realtime/stream (SSE; accepts ?token= query
// because EventSource cannot send custom headers).
import express, { type Request, type Response, type NextFunction } from "express";
import jwt from "jsonwebtoken";
import { auth } from "../middleware/auth.js";
import { subscribe, subscriberCount } from "./sseBus.js";

const router = express.Router();

// Dual-mode auth: Authorization header OR ?token= query.
function sseAuth(req: Request, res: Response, next: NextFunction): void {
  const hdr = req.headers.authorization?.split(" ")[1];
  const qry = typeof req.query.token === "string" ? req.query.token : undefined;
  const token = hdr || qry;
  if (!token) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    res.status(500).json({ error: "auth_not_configured" });
    return;
  }
  try {
    const decoded = jwt.verify(token, secret) as any;
    (req as any).user = {
      ...decoded,
      userId: decoded.id ?? decoded.sub ?? null,
    };
    next();
  } catch {
    res.status(401).json({ error: "invalid_token" });
  }
}

router.get("/stream", sseAuth, (req: any, res: Response) => {
  const userId: string = req.user?.userId || req.user?.id || req.user?.sub;
  if (!userId) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  subscribe(userId, res);
});

router.get("/diag", auth, (_req, res) => {
  res.json({ ok: true, subscribers: subscriberCount() });
});

export default router;
