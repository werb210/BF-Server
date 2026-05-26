import { Router } from "express";
import { safeHandler } from "../middleware/safeHandler.js";
import { proxyMayaToAgent } from "./maya.js";

const router = Router();

// BF_SERVER_BLOCK_v638_MULTIFIX_v1 — pass req to the proxy so headers land at the agent.
router.post(
  "/message",
  safeHandler(async (req: any, res: any) => {
    await proxyMayaToAgent("/api/maya/message", "POST", req.body, res, req);
  })
);

router.post(
  "/chat",
  safeHandler(async (req: any, res: any) => {
    await proxyMayaToAgent("/api/maya/chat", "POST", req.body, res, req);
  })
);

router.post(
  "/escalate",
  safeHandler(async (req: any, res: any) => {
    await proxyMayaToAgent("/maya/escalate", "POST", req.body, res, req);
  })
);


// BF_SERVER_BLOCK_v651_MAYA_WEBSITE_CHAT_v1 — alias /maya/website-chat
// to the agent's /api/maya/message. The bf-website Maya widget
// (mayaService.ts) POSTs to /maya/website-chat; this proxy translates
// the wire shape (website sends { message, sessionId, attribution },
// agent expects { message, sessionId }) and forwards. Without this
// route, every chat call returned 404 and the widget showed the
// "I'm having trouble" fallback (see FloatingChat.tsx line 95).
router.post("/maya/website-chat", async (req, res) => {
  try {
    const websitePayload = req.body ?? {};
    const messageText: string = String(websitePayload.message ?? "").trim();
    if (!messageText) {
      return res.status(400).json({ error: "missing_message" });
    }
    // Translate to the agent /api/maya/message wire shape. The agent
    // doesn't need attribution; we drop it server-side.
    const agentPayload = {
      message: messageText,
      sessionId: websitePayload.sessionId ?? null,
      audience: "visitor",
    };
    await proxyMayaToAgent("/api/maya/message", "POST", agentPayload, res, req);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[maya website-chat] failed", message);
    return res.status(500).json({ error: "internal" });
  }
});

export default router;
