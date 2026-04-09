import { Router } from "express";
import { twilioClient, twilioEnabled, fromNumber, callerId } from "../lib/twilioClient.js";
import { wrap } from "../lib/routeWrap.js";

const router = Router();

router.post(
  "/sms",
  wrap(async (req) => {
    const { to, body } = req.body;

    if (!to || !body) {
      throw Object.assign(new Error("INVALID_SMS_PAYLOAD"), { status: 400 });
    }
    if (!twilioEnabled || !twilioClient) {
      throw Object.assign(new Error("twilio_not_configured"), { status: 503 });
    }

    const msg = await twilioClient.messages.create({
      to,
      from: fromNumber,
      body,
    });

    return { sid: msg.sid };
  })
);

router.post(
  "/call",
  wrap(async (req) => {
    const { to, twimlUrl } = req.body;

    if (!to || !twimlUrl) {
      throw Object.assign(new Error("INVALID_CALL_PAYLOAD"), { status: 400 });
    }
    if (!twilioEnabled || !twilioClient) {
      throw Object.assign(new Error("twilio_not_configured"), { status: 503 });
    }

    const call = await twilioClient.calls.create({
      to,
      from: callerId,
      url: twimlUrl,
    });

    return { sid: call.sid };
  })
);

export default router;
