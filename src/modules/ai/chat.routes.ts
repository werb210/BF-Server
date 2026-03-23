import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { config } from "../../config";
import {
  closeChatSession,
  fetchHumanSessions,
  fetchSessionMessages,
  processChatMessage,
  requestHumanTakeover,
  startChatSession,
} from "./chat.service";

const router = Router();

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many chat requests" },
  skip: () => config.env === "test",
});

async function createSessionHandler(req: Request, res: Response): Promise<void> {
  const source = typeof req.body?.source === "string" ? req.body.source : "website";

  const session = await startChatSession({
    source,
    channel: typeof req.body?.channel === "string" ? req.body.channel : "text",
    lead: req.body?.lead,
  });

  res.status(201).json({ success: true, data: { sessionId: session.id, status: session.status } });
}

router.post("/chat/start", chatLimiter, createSessionHandler);
router.post("/chat/session", chatLimiter, createSessionHandler);

router.post("/chat/message", chatLimiter, async (req: any, res: any, next: any) => {
  const { sessionId, message, source } = req.body as {
    sessionId?: string;
    message?: string;
    source?: string;
  };

  if (!sessionId || !message) {
    res.status(400).json({ error: "sessionId and message are required" });
    return;
  }

  const result = await processChatMessage({ sessionId, message, source: source ?? "website" });

  res.json({ status: result.status, response: result.response });
});

async function transferChatHandler(req: Request, res: Response): Promise<void> {
  const { sessionId } = req.body as { sessionId?: string };
  if (!sessionId) {
    res.status(400).json({ error: "sessionId is required" });
    return;
  }
  try {
    await requestHumanTakeover(sessionId);
  } catch (error) {
    if (error instanceof Error && error.message === "chat_session_not_found") {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    throw error;
  }
  res.json({ status: "human" });
}

router.post("/chat/human", chatLimiter, transferChatHandler);
router.post("/chat/transfer", chatLimiter, transferChatHandler);

router.post("/chat/close", chatLimiter, async (req: any, res: any, next: any) => {
  const { sessionId } = req.body as { sessionId?: string };
  if (!sessionId) {
    res.status(400).json({ error: "sessionId is required" });
    return;
  }
  await closeChatSession(sessionId);
  res.json({ status: "closed" });
});

router.get("/chat/sessions", async (req: any, res: any, next: any) => {
  const status = req.query.status;
  if (status !== "human") {
    res.status(400).json({ error: "Only status=human is currently supported" });
    return;
  }

  const sessions = await fetchHumanSessions();
  res.json({ sessions });
});

router.get("/chat/:sessionId/messages", async (req: any, res: any, next: any) => {
  const messages = await fetchSessionMessages(req.params.sessionId);
  res.json({ messages });
});

export default router;
