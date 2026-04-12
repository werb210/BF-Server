import { Router } from "express";
import { config } from "../config/index.js";
import { ok } from "../lib/respond.js";
import { safeImport } from "../utils/safeImport.js";

const router = Router();

type TwilioRuntime = {
  twiml: {
    VoiceResponse: new () => {
      dial: (attrs: {
        timeout: number;
        callerId: string | undefined;
        statusCallback: string;
        statusCallbackEvent: string[];
        statusCallbackMethod: "POST";
      }) => { client: (identity: string) => void };
      toString: () => string;
    };
  };
};

const twilioRuntime = (await safeImport("twilio")) as TwilioRuntime | null;

router.post("/voice/incoming", (_req: any, res: any) => {
  if (!twilioRuntime?.twiml?.VoiceResponse) {
    return res.status(503).json({ error: "twilio_unavailable" });
  }
  const VoiceResponse = twilioRuntime.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  const dial = twiml.dial({
    timeout: 20,
    callerId: config.twilio.phoneNumber,
    statusCallback: "/api/voice/status",
    statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    statusCallbackMethod: "POST",
  });

  dial.client("staff_portal");
  dial.client("staff_mobile");

  return ok(res, twiml.toString());
});

export default router;
