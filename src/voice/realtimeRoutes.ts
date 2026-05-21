// BF_SERVER_BLOCK_v500 -- /api/realtime/stream (SSE, auth required)
import express, { type Response } from "express";
import { auth } from "../middleware/auth.js";
import { subscribe, subscriberCount } from "./sseBus.js";

const router = express.Router();

router.get("/stream", auth, (req: any, res: Response) => {
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
