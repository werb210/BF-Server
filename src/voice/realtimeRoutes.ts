// BF_SERVER_BLOCK_v606 -- /api/realtime/stream (SSE; accepts ?token= query
// because EventSource cannot send custom headers).
import express, { type Response } from "express";
import { auth } from "../middleware/auth.js";
import { urlTicketOrHeaderAuth } from "../auth/urlTicket.js"; // BF_SERVER_v789_URL_TICKETS
import { subscribe, subscriberCount } from "./sseBus.js";

const router = express.Router();

// Dual-mode auth: Authorization header OR ?token= query.
// BF_SERVER_v789_URL_TICKETS - the query token must be a 60-second URL ticket from
// POST /api/auth/url-ticket; a full staff JWT in the query string is a 401. The
// header goes through the staff middleware (staff humans and services only,
// BF_SERVER_v784_STAFF_ONLY_AUTH), which also checks the user's account state.
const sseAuth = urlTicketOrHeaderAuth(auth);

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
