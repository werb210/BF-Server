import { Router } from "express";
import { twilioClient, twilioEnabled, fromNumber, callerId } from "../lib/twilioClient";

const router = Router();

// SMS
router.post("/sms", async (req, res) => {
  const { to, body } = req.body;

  if (!to || !body) return res.status(400).json({ error: "to + body required" });
  if (!twilioEnabled || !twilioClient) {
    return res.status(503).json({ success: false, message: "twilio_not_configured" });
  }

  try {
    const msg = await twilioClient.messages.create({
      to,
      from: fromNumber,
      body,
    });

    res.json({ sid: msg.sid });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// CALL
router.post("/call", async (req, res) => {
  const { to, twimlUrl } = req.body;

  if (!to || !twimlUrl) {
    return res.status(400).json({ error: "to + twimlUrl required" });
  }
  if (!twilioEnabled || !twilioClient) {
    return res.status(503).json({ success: false, message: "twilio_not_configured" });
  }

  try {
    const call = await twilioClient.calls.create({
      to,
      from: callerId,
      url: twimlUrl,
    });

    res.json({ sid: call.sid });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
