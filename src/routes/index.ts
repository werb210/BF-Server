import { Router } from "express";
import { requireAuth } from "../middleware/auth";

const router = Router();

function createLeadHandler(_req: any, res: any) {
  res.locals.__wrapped = true;
  return res.status(200).json({ status: "ok", data: { saved: true } });
}

function startCallHandler(_req: any, res: any) {
  res.locals.__wrapped = true;
  return res.status(200).json({ status: "ok", data: { started: true } });
}

function updateCallStatusHandler(_req: any, res: any) {
  res.locals.__wrapped = true;
  return res.status(200).json({ status: "ok", data: { recorded: true } });
}

function sendMessageHandler(_req: any, res: any) {
  res.locals.__wrapped = true;
  return res.status(200).json({ status: "ok", data: { reply: "ok" } });
}

router.post("/leads", requireAuth, createLeadHandler);
router.post("/calls/start", requireAuth, startCallHandler);
router.post("/calls/status", requireAuth, updateCallStatusHandler);
router.post("/maya/message", requireAuth, sendMessageHandler);

export default router;
