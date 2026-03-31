import { Router } from "express";

import { twilioClient } from "../lib/twilioClient";

const router = Router();

const from = process.env.TWILIO_FROM_NUMBER;
if (!from) {
  throw new Error("Missing TWILIO_FROM_NUMBER");
}

router.post("/sms", async (req, res, next) => {
  try {
    const { to, body } = req.body;
    if (!to || !body) {
      return res.status(400).json({ error: "missing fields" });
    }

    const msg = await twilioClient.messages.create({ to, from, body });
    return res.json({ sid: msg.sid });
  } catch (error) {
    return next(error);
  }
});

router.post("/call", async (req, res, next) => {
  try {
    const { to, twimlUrl } = req.body;
    if (!to || !twimlUrl) {
      return res.status(400).json({ error: "missing fields" });
    }

    const call = await twilioClient.calls.create({
      to,
      from: process.env.TWILIO_CALLER_ID || from,
      url: twimlUrl,
    });

    return res.json({ sid: call.sid });
  } catch (error) {
    return next(error);
  }
});

export default router;
