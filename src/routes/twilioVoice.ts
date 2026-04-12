import express, { Router } from "express";
import { twilioWebhookValidation } from "../middleware/twilioWebhookValidation.js";
import { ok } from "../lib/respond.js";
import { safeImport } from "../utils/safeImport.js";

const router = Router();

type TwilioRuntime = {
  twiml: {
    VoiceResponse: new () => {
      dial: (attrs: {
        answerOnBridge: boolean;
        timeout: number;
      }) => { client: (identity: string) => void };
      toString: () => string;
    };
  };
};

const twilioRuntime = (await safeImport("twilio")) as TwilioRuntime | null;

router.post(
  "/twilio/voice",
  express.urlencoded({ extended: false }),
  twilioWebhookValidation,
  (_req: any, res: any) => {
  if (!twilioRuntime?.twiml?.VoiceResponse) {
    return res.status(503).json({ error: "twilio_unavailable" });
  }
  const VoiceResponse = twilioRuntime.twiml.VoiceResponse;
  const response = new VoiceResponse();

  const dial = response.dial({
    answerOnBridge: true,
    timeout: 20,
  });

  // Ring all staff endpoints simultaneously
  dial.client("staff_portal");
  dial.client("staff_mobile");

    return ok(res, response.toString());
  }
);

export default router;
