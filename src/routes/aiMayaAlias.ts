import { Router } from "express";
import { safeHandler } from "../middleware/safeHandler.js";
import { proxyMayaToAgent } from "./maya.js";

const router = Router();

router.post(
  "/message",
  safeHandler(async (req, res) => {
    await proxyMayaToAgent("/api/maya/message", req.body, res);
  })
);

router.post(
  "/chat",
  safeHandler(async (req, res) => {
    await proxyMayaToAgent("/api/maya/chat", req.body, res);
  })
);

export default router;
