import { Router } from "express";
import { createLead } from "../modules/lead/lead.service";
import { startCall, updateCallStatus } from "../modules/calls/calls.service";
import { sendMessage } from "../modules/messaging/service";
import { requireAuth } from "../middleware/auth";

const router = Router();

router.post("/lead", requireAuth, async (req, res) => {
  try {
    const result = await createLead(req.body);
    res.json(result);
  } catch (err) {
    console.error("createLead failed:", err);
    res.status(500).json({ status: "error", error: "create_lead_failed" });
  }
});

router.post("/call/start", requireAuth, async (req, res) => {
  try {
    const result = await startCall(req.body);
    res.json(result);
  } catch (err) {
    console.error("startCall failed:", err);
    res.status(500).json({ status: "error", error: "call_start_failed" });
  }
});

router.post("/call/status", requireAuth, async (req, res) => {
  try {
    const result = await updateCallStatus(req.body);
    res.json(result);
  } catch (err) {
    console.error("updateCallStatus failed:", err);
    res.status(500).json({ status: "error", error: "call_status_failed" });
  }
});

router.post("/message", requireAuth, async (req, res) => {
  try {
    const result = await sendMessage(req.body);
    res.json(result);
  } catch (err) {
    console.error("sendMessage failed:", err);
    res.status(500).json({ status: "error", error: "message_failed" });
  }
});

export default router;
