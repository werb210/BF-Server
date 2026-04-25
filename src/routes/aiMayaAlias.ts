import { Router } from "express";
import { safeHandler } from "../middleware/safeHandler.js";
import { proxyMayaToAgent } from "./maya.js";

const router = Router();

router.post(
  "/message",
  safeHandler(async (req: any, res: any) => {
    await proxyMayaToAgent("/api/maya/message", "POST", req.body, res);
  })
);

router.post(
  "/chat",
  safeHandler(async (req: any, res: any) => {
    await proxyMayaToAgent("/api/maya/chat", "POST", req.body, res);
  })
);

router.post(
  "/escalate",
  safeHandler(async (req: any, res: any) => {
    await proxyMayaToAgent("/maya/escalate", "POST", req.body, res);
  })
);

export default router;
