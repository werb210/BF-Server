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

export default router;
