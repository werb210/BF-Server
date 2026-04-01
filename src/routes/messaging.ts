import { Router } from "express";
import { twilioClient, twilioEnabled, fromNumber, callerId } from "../lib/twilioClient";
import { fail, ok } from "../lib/apiResponse";
import { wrap } from "../lib/routeWrap";

const router = Router();

// SMS
router.post("/sms", wrap(async (req, res) => {
  const { to, body } = req.body;

  if (!to || !body) return fail(res, "INVALID_SMS_PAYLOAD", "to + body required");
  if (!twilioEnabled || !twilioClient) {
    return fail(res, "twilio_not_configured");
  }

    const msg = await twilioClient.messages.create({
      to,
      from: fromNumber,
      body,
    });

    return ok({ sid: msg.sid });
}));

// CALL
router.post("/call", wrap(async (req, res) => {
  const { to, twimlUrl } = req.body;

  if (!to || !twimlUrl) {
    return fail(res, "INVALID_CALL_PAYLOAD", "to + twimlUrl required");
  }
  if (!twilioEnabled || !twilioClient) {
    return fail(res, "twilio_not_configured");
  }

    const call = await twilioClient.calls.create({
      to,
      from: callerId,
      url: twimlUrl,
    });

    return ok({ sid: call.sid });
}));

export default router;
